import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConflictException, Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { businessDay } from '@nhs/pricing';
import type { Job, Queue } from 'bullmq';
import { actorId, type Principal } from '../auth/principal';
import { cutoffHour } from '../billing/billing.service';
import { Notifier } from '../common/notifier';
import { EventsService } from '../events/events.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';
import { n } from './table';

export const REPORTS_QUEUE = 'reports';
const vnd = (v: number) => `${new Intl.NumberFormat('vi-VN').format(v)}đ`;

@Injectable()
export class BusinessDayService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly outbox: OutboxPublisher,
    private readonly reports: ReportsService,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit() {
    // Cập nhật bảng tổng hợp ngay khi bill được thanh toán đủ (mục 10.5).
    this.outbox.on('bill.paid', async (tx, e) => {
      const bill = await tx.bill.findUnique({ where: { id: (e.data as { billId: string }).billId } });
      if (bill?.businessDay) await this.recompute(tx, bill.businessDay);
    });
  }

  /** Tính lại toàn bộ bảng tổng hợp của một ngày từ dữ liệu gốc — chạy lại bao nhiêu lần cũng cho cùng kết quả. */
  async recompute(tx: Tx, day: string) {
    await tx.dailySalesSummary.deleteMany({ where: { day } });
    await tx.hourlySalesSummary.deleteMany({ where: { day } });
    await tx.$executeRaw`
      INSERT INTO daily_sales_summary (day, menu_item_id, name, category, qty, revenue, discount, cogs)
      SELECT ${day}, m.id, m.name, c.name, SUM(l.qty), SUM(l.amount), SUM(l.discount), 0
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      JOIN order_items oi ON oi.id = l.order_item_id JOIN menu_items m ON m.id = oi.menu_item_id
      JOIN menu_categories c ON c.id = m.category_id
      WHERE b.status IN ('PAID', 'CLOSED') AND b.business_day = ${day}
      GROUP BY m.id, m.name, c.name`;
    await tx.$executeRaw`
      INSERT INTO hourly_sales_summary (day, hour, bills, guests, revenue)
      SELECT ${day}, EXTRACT(HOUR FROM (b.paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::int, COUNT(*),
             COALESCE(SUM(s.guests), 0), SUM(b.total)
      FROM bills b JOIN dining_sessions s ON s.id = b.session_id
      WHERE b.status IN ('PAID', 'CLOSED') AND b.business_day = ${day}
      GROUP BY 2`;
  }

  currentDay() {
    return businessDay(new Date(), cutoffHour());
  }

  /** Chốt ngày (mục 10.3): khóa số liệu, tạo bảng tổng hợp, gửi báo cáo tóm tắt cho chủ. */
  async close(day: string, by: Principal | 'system') {
    if (day >= this.currentDay()) throw new ConflictException('Chỉ chốt được ngày kinh doanh đã kết thúc');
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.businessDay.findUnique({ where: { day } });
      if (existing) return { closed: existing, already: true };
      await this.recompute(tx, day);
      const revenue = await this.reports.revenue(day, day, 'day', tx);
      const byMethod = await this.reports.revenue(day, day, 'method', tx);
      const unpaid = await tx.bill.count({ where: { status: 'LOCKED', lockedAt: { lt: new Date() } } });
      const summary = {
        revenue: revenue.totals?.revenue ?? 0,
        refund: revenue.totals?.refund ?? 0,
        net: revenue.totals?.net ?? 0,
        bills: revenue.totals?.bills ?? 0,
        byMethod: Object.fromEntries(byMethod.rows.map((r) => [r.key as string, n(r.net as number)])),
        openShifts: await tx.shift.count({ where: { status: { not: 'CLOSED' } } }),
        lockedBillsUnpaid: unpaid,
      };
      const closed = await tx.businessDay.create({
        data: { day, closedAt: new Date(), closedBy: by === 'system' ? 'system' : actorId(by), summary: summary as Prisma.InputJsonValue },
      });
      await this.events.append(tx, 'business_day.closed', 'business_day', day, { day, summary });
      return { closed, already: false };
    });
    this.events.wake();
    if (!result.already) {
      const s = result.closed.summary as Record<string, number>;
      await this.notifier.send(
        `Nhà hàng Sen – chốt ngày ${day}`,
        `Doanh thu thuần: ${vnd(s.net)} (${s.bills} bill, hoàn ${vnd(s.refund)}).`,
      );
    }
    return result.closed;
  }

  list() {
    return this.prisma.businessDay.findMany({ orderBy: { day: 'desc' }, take: 60 });
  }

  /** Tác vụ đêm: tự chốt ngày hôm trước nếu chưa chốt, và tính lại 7 ngày gần nhất để tự sửa sai lệch. */
  async nightly() {
    const today = this.currentDay();
    const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
    await this.close(yesterday, 'system');
    for (let i = 1; i <= 7; i++) {
      const day = new Date(Date.parse(today) - i * 86_400_000).toISOString().slice(0, 10);
      await this.prisma.$transaction((tx) => this.recompute(tx, day));
    }
  }
}

@Processor(REPORTS_QUEUE)
export class ReportsProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly days: BusinessDayService,
    @InjectQueue(REPORTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    const hour = (Number(process.env.BUSINESS_DAY_CUTOFF_HOUR ?? 4) + 1) % 24;
    await this.queue.upsertJobScheduler('nightly', { pattern: `30 ${hour} * * *`, tz: 'Asia/Ho_Chi_Minh' }, { name: 'nightly' });
  }

  async process(job: Job) {
    if (job.name === 'nightly') await this.days.nightly();
  }
}
