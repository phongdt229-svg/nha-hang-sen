import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { n, type ReportTable } from './table';

export const GROUP_BY = ['day', 'hour', 'item', 'category', 'method', 'source', 'shift'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

const METHOD_LABEL: Record<string, string> = { CASH: 'Tiền mặt', QR: 'QR ngân hàng', CARD: 'Thẻ', EWALLET: 'Ví điện tử' };
const SOURCE_LABEL: Record<string, string> = { TABLET: 'Khách tự gọi (tablet)', POS: 'Nhân viên gọi hộ', AI: 'Gọi qua trợ lý AI' };
const PAID = Prisma.sql`b.status IN ('PAID', 'CLOSED')`;

/**
 * Báo cáo doanh thu (mục 10). Nguồn sự thật là bills / bill_lines / payments / refunds;
 * doanh thu tính theo ngày kinh doanh lúc thanh toán, hoàn tiền tính theo ngày hoàn.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  checkRange(from: string, to: string) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(from) || !re.test(to) || from > to) throw new BadRequestException('Khoảng ngày không hợp lệ (YYYY-MM-DD)');
  }

  async revenue(from: string, to: string, groupBy: GroupBy, db: Tx = this.prisma): Promise<ReportTable> {
    this.checkRange(from, to);
    const inRange = Prisma.sql`b.business_day BETWEEN ${from} AND ${to}`;
    switch (groupBy) {
      case 'day': {
        const rows = await db.$queryRaw<{ day: string; bills: bigint; revenue: bigint; discount: bigint; tax: bigint }[]>`
          SELECT b.business_day AS day, COUNT(*) AS bills, SUM(b.total) AS revenue,
                 COALESCE(SUM((SELECT SUM(l.discount) FROM bill_lines l WHERE l.bill_id = b.id)), 0) AS discount,
                 COALESCE(SUM((SELECT SUM(l.tax) FROM bill_lines l WHERE l.bill_id = b.id)), 0) AS tax
          FROM bills b WHERE ${PAID} AND ${inRange} GROUP BY b.business_day`;
        const refunds = await db.$queryRaw<{ day: string; amount: bigint }[]>`
          SELECT business_day AS day, SUM(amount) AS amount FROM refunds WHERE business_day BETWEEN ${from} AND ${to} GROUP BY business_day`;
        const days = [...new Set([...rows.map((r) => r.day), ...refunds.map((r) => r.day)])].sort();
        const out = days.map((day) => {
          const r = rows.find((x) => x.day === day);
          const refund = n(refunds.find((x) => x.day === day)?.amount);
          return { key: day, label: day, bills: n(r?.bills), revenue: n(r?.revenue), discount: n(r?.discount), tax: n(r?.tax), refund, net: n(r?.revenue) - refund };
        });
        return this.withTotals('Doanh thu theo ngày kinh doanh', out, [
          ['bills', 'Số bill', 'number'],
          ['revenue', 'Doanh thu', 'money'],
          ['discount', 'Giảm giá', 'money'],
          ['tax', 'Thuế GTGT', 'money'],
          ['refund', 'Hoàn tiền', 'money'],
          ['net', 'Doanh thu thuần', 'money'],
        ]);
      }
      case 'hour': {
        const rows = await db.$queryRaw<{ hour: number; bills: bigint; revenue: bigint }[]>`
          SELECT EXTRACT(HOUR FROM (b.paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour, COUNT(*) AS bills, SUM(b.total) AS revenue
          FROM bills b WHERE ${PAID} AND ${inRange} GROUP BY 1 ORDER BY 1`;
        return this.withTotals(
          'Doanh thu theo giờ',
          rows.map((r) => ({ key: String(r.hour), label: `${String(r.hour).padStart(2, '0')}:00`, bills: n(r.bills), revenue: n(r.revenue) })),
          [
            ['bills', 'Số bill', 'number'],
            ['revenue', 'Doanh thu', 'money'],
          ],
        );
      }
      case 'item':
      case 'category': {
        const key = groupBy === 'item' ? Prisma.sql`m.id` : Prisma.sql`c.id`;
        const label = groupBy === 'item' ? Prisma.sql`m.name` : Prisma.sql`c.name`;
        const rows = await db.$queryRaw<{ key: string; label: string; qty: bigint; revenue: bigint; discount: bigint }[]>`
          SELECT ${key} AS key, ${label} AS label, SUM(l.qty) AS qty, SUM(l.amount) AS revenue, SUM(l.discount) AS discount
          FROM bill_lines l JOIN bills b ON b.id = l.bill_id
          JOIN order_items oi ON oi.id = l.order_item_id JOIN menu_items m ON m.id = oi.menu_item_id
          JOIN menu_categories c ON c.id = m.category_id
          WHERE ${PAID} AND ${inRange} GROUP BY 1, 2 ORDER BY revenue DESC`;
        const total = rows.reduce((a, r) => a + n(r.revenue), 0);
        return this.withTotals(
          groupBy === 'item' ? 'Doanh thu theo món' : 'Doanh thu theo danh mục',
          rows.map((r) => ({ key: r.key, label: r.label, qty: n(r.qty), revenue: n(r.revenue), discount: n(r.discount), share: total ? n(r.revenue) / total : 0 })),
          [
            ['qty', 'Số lượng', 'number'],
            ['revenue', 'Doanh thu', 'money'],
            ['discount', 'Giảm giá', 'money'],
            ['share', 'Tỷ trọng', 'percent'],
          ],
        );
      }
      case 'method': {
        const rows = await db.$queryRaw<{ method: string; count: bigint; amount: bigint }[]>`
          SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS amount
          FROM payments p JOIN bills b ON b.id = p.bill_id
          WHERE p.status = 'SUCCEEDED' AND ${PAID} AND ${inRange} GROUP BY p.method`;
        const refunds = await db.$queryRaw<{ method: string; amount: bigint }[]>`
          SELECT method, SUM(amount) AS amount FROM refunds WHERE business_day BETWEEN ${from} AND ${to} GROUP BY method`;
        const methods = [...new Set([...rows.map((r) => r.method), ...refunds.map((r) => r.method)])];
        return this.withTotals(
          'Doanh thu theo phương thức thanh toán',
          methods.map((m) => {
            const amount = n(rows.find((r) => r.method === m)?.amount);
            const refund = n(refunds.find((r) => r.method === m)?.amount);
            return { key: m, label: METHOD_LABEL[m] ?? m, count: n(rows.find((r) => r.method === m)?.count), amount, refund, net: amount - refund };
          }),
          [
            ['count', 'Số giao dịch', 'number'],
            ['amount', 'Đã thu', 'money'],
            ['refund', 'Hoàn tiền', 'money'],
            ['net', 'Thực thu', 'money'],
          ],
        );
      }
      case 'source': {
        const rows = await db.$queryRaw<{ source: string; orders: bigint; revenue: bigint }[]>`
          SELECT o.source, COUNT(DISTINCT o.id) AS orders, SUM(l.amount) AS revenue
          FROM bill_lines l JOIN bills b ON b.id = l.bill_id
          JOIN order_items oi ON oi.id = l.order_item_id JOIN orders o ON o.id = oi.order_id
          WHERE ${PAID} AND ${inRange} GROUP BY o.source`;
        return this.withTotals(
          'Doanh thu theo nguồn order',
          rows.map((r) => ({ key: r.source, label: SOURCE_LABEL[r.source] ?? r.source, orders: n(r.orders), revenue: n(r.revenue) })),
          [
            ['orders', 'Số order', 'number'],
            ['revenue', 'Doanh thu', 'money'],
          ],
        );
      }
      case 'shift': {
        const rows = await db.$queryRaw<{ shift_id: string | null; cashier: string | null; opened_at: Date | null; amount: bigint }[]>`
          SELECT p.shift_id, u.name AS cashier, s.opened_at, SUM(p.amount) AS amount
          FROM payments p JOIN bills b ON b.id = p.bill_id
          LEFT JOIN shifts s ON s.id = p.shift_id LEFT JOIN users u ON u.id = s.cashier_id
          WHERE p.status = 'SUCCEEDED' AND ${PAID} AND ${inRange} GROUP BY 1, 2, 3 ORDER BY 3`;
        return this.withTotals(
          'Doanh thu theo ca',
          rows.map((r) => ({
            key: r.shift_id ?? 'none',
            label: r.shift_id ? `${r.cashier} · ${r.opened_at?.toISOString().slice(0, 16).replace('T', ' ')}` : 'Không thuộc ca',
            amount: n(r.amount),
          })),
          [['amount', 'Đã thu', 'money']],
        );
      }
    }
  }

  /** Chỉ số vận hành gắn doanh thu (mục 10.2). */
  async kpis(from: string, to: string) {
    this.checkRange(from, to);
    const [row] = await this.prisma.$queryRaw<
      { bills: bigint; revenue: bigint; sessions: bigint; guests: bigint; tables: bigint; avg_minutes: number | null }[]
    >`
      WITH paid AS (SELECT * FROM bills b WHERE ${PAID} AND b.business_day BETWEEN ${from} AND ${to}),
           sess AS (SELECT DISTINCT s.* FROM dining_sessions s JOIN paid ON paid.session_id = s.id)
      SELECT (SELECT COUNT(*) FROM paid) AS bills,
             (SELECT COALESCE(SUM(total), 0) FROM paid) AS revenue,
             (SELECT COUNT(*) FROM sess) AS sessions,
             (SELECT COALESCE(SUM(guests), 0) FROM sess) AS guests,
             (SELECT COUNT(*) FROM tables) AS tables,
             (SELECT AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 60) FROM sess WHERE closed_at IS NOT NULL) AS avg_minutes`;
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const bills = n(row.bills);
    const revenue = n(row.revenue);
    const guests = n(row.guests);
    const tables = n(row.tables) || 1;
    return {
      from,
      to,
      bills,
      revenue,
      guests,
      avgPerBill: bills ? Math.round(revenue / bills) : 0,
      revenuePerGuest: guests ? Math.round(revenue / guests) : 0,
      revenuePerTable: Math.round(revenue / tables / days),
      tableTurnover: Number((n(row.sessions) / tables / days).toFixed(2)),
      avgDiningMinutes: row.avg_minutes ? Math.round(Number(row.avg_minutes)) : 0,
    };
  }

  /** Giảm giá, hủy món, hoàn tiền, mở khóa bill: ai làm, lý do, số tiền. */
  async adjustments(from: string, to: string): Promise<ReportTable> {
    this.checkRange(from, to);
    const rows = await this.prisma.$queryRaw<{ created_at: Date; action: string; actor: string | null; reason: string | null; after: unknown; entity_id: string }[]>`
      SELECT a.created_at, a.action, u.name AS actor, a.reason, a.after, a.entity_id
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action IN ('order_item.cancel', 'bill.discount', 'payment.refund', 'bill.unlock', 'bill.unsplit', 'shift.approve')
        AND ((a.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date
      ORDER BY a.created_at`;
    const ACTION: Record<string, string> = {
      'order_item.cancel': 'Hủy món',
      'bill.discount': 'Giảm giá',
      'payment.refund': 'Hoàn tiền',
      'bill.unlock': 'Mở khóa bill',
      'bill.unsplit': 'Hủy tách bill',
      'shift.approve': 'Duyệt chênh lệch ca',
    };
    return {
      title: 'Giảm giá, hủy món, hoàn tiền',
      columns: [
        { key: 'time', label: 'Thời điểm' },
        { key: 'action', label: 'Thao tác' },
        { key: 'actor', label: 'Người thực hiện' },
        { key: 'amount', label: 'Số tiền', kind: 'money' },
        { key: 'reason', label: 'Lý do' },
      ],
      rows: rows.map((r) => {
        const after = (r.after ?? {}) as { amount?: number; discount?: number };
        return {
          time: r.created_at.toISOString(),
          action: ACTION[r.action] ?? r.action,
          actor: r.actor ?? 'Thiết bị',
          amount: after.amount ?? after.discount ?? null,
          reason: r.reason,
        };
      }),
    };
  }

  private withTotals(title: string, rows: ({ key: string; label: string } & Record<string, number | string>)[], cols: [string, string, 'money' | 'number' | 'percent'][]): ReportTable {
    const totals: Record<string, number> = {};
    for (const [key, , kind] of cols) if (kind !== 'percent') totals[key] = rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
    return {
      title,
      columns: [{ key: 'label', label: '' }, ...cols.map(([key, label, kind]) => ({ key, label, kind }))],
      rows,
      totals,
    };
  }
}
