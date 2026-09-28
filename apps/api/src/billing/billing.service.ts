import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Bill, PaymentMethod } from '@prisma/client';
import { businessDay } from '@nhs/pricing';
import { assertTransition, BILL_TRANSITIONS, type BillDto } from '@nhs/types';
import { actorId, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { isUniqueViolation } from '../common/errors.filter';
import { EventsService } from '../events/events.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { currentTables, lockSession, setTableStatus } from '../sessions/session.helpers';
import { splitBill } from '@nhs/pricing';
import { billNumber, fromSnapshot, pricingConfig, priceLive, toBillDto } from './bill.calc';

export const cutoffHour = () => Number(process.env.BUSINESS_DAY_CUTOFF_HOUR ?? 4);

/** Bill còn hiệu lực của phiên (bỏ bill gốc đã tách và bill của phiên đã gộp). */
const ACTIVE_BILL = { status: { notIn: ['SPLIT', 'VOID'] as ('SPLIT' | 'VOID')[] } };

export interface SplitGroup {
  label: string;
  orderItemIds: string[];
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  async paidAmount(tx: Tx, billId: string) {
    const r = await tx.payment.aggregate({ where: { billId, status: 'SUCCEEDED' }, _sum: { amount: true } });
    return r._sum.amount ?? 0;
  }

  async refundedAmount(tx: Tx, billId: string) {
    const r = await tx.refund.aggregate({ where: { billId }, _sum: { amount: true } });
    return r._sum.amount ?? 0;
  }

  async dto(tx: Tx, bill: Bill): Promise<BillDto> {
    const priced =
      bill.status === 'OPEN' || bill.status === 'SPLIT' || bill.status === 'VOID'
        ? await priceLive(tx, bill)
        : fromSnapshot(await tx.billLine.findMany({ where: { billId: bill.id } }));
    return toBillDto(bill, priced, await this.paidAmount(tx, bill.id), await this.refundedAmount(tx, bill.id));
  }

  /** Bill chính của phiên: bill đang mở, hoặc bill còn hiệu lực mới nhất. */
  async forSession(sessionId: string): Promise<BillDto> {
    const bill =
      (await this.prisma.bill.findFirst({ where: { sessionId, status: 'OPEN' } })) ??
      (await this.prisma.bill.findFirst({ where: { sessionId, ...ACTIVE_BILL }, orderBy: { createdAt: 'desc' } }));
    if (!bill) throw new NotFoundException('Phiên chưa có bill');
    return this.dto(this.prisma, bill);
  }

  /** Mọi bill còn hiệu lực của phiên (sau khi tách bill có nhiều bill con). */
  async listForSession(sessionId: string): Promise<BillDto[]> {
    const bills = await this.prisma.bill.findMany({ where: { sessionId, ...ACTIVE_BILL }, orderBy: [{ createdAt: 'asc' }, { number: 'asc' }] });
    return Promise.all(bills.map((b) => this.dto(this.prisma, b)));
  }

  async byId(id: string): Promise<BillDto> {
    return this.dto(this.prisma, await this.prisma.bill.findUniqueOrThrow({ where: { id } }));
  }

  /** Khóa dòng bill; kiểm tra version để hai thu ngân không ghi đè nhau (optimistic locking). */
  async lockBill(tx: Tx, id: string, expectedVersion?: number) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bills WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException('Không tìm thấy bill');
    const bill = await tx.bill.findUniqueOrThrow({ where: { id } });
    if (expectedVersion !== undefined && bill.version !== expectedVersion) {
      throw new ConflictException({ error: 'VERSION_CONFLICT', message: 'Bill vừa được người khác thay đổi, vui lòng tải lại' });
    }
    return bill;
  }

  async setDiscount(p: Principal, id: string, amount: number, reason: string, version: number) {
    const dto = await this.prisma.$transaction(async (tx) => {
      const bill = await this.lockBill(tx, id, version);
      if (bill.status !== 'OPEN') throw new ConflictException('Chỉ giảm giá khi bill đang mở');
      const updated = await tx.bill.update({ where: { id }, data: { discount: amount, version: { increment: 1 } } });
      await priceLive(tx, updated); // kiểm tra giảm giá không vượt tổng bill
      await this.audit.record(tx, { actorId: actorId(p), action: 'bill.discount', entity: 'bill', entityId: id, before: { discount: bill.discount }, after: { discount: amount }, reason });
      return this.dto(tx, updated);
    });
    return dto;
  }

  /** OPEN → LOCKED: chụp lại số liệu vào bill_lines; phiên và bàn chuyển PAYMENT, tablet ngừng nhận order. */
  async lock(p: Principal, id: string, version: number) {
    const dto = await this.prisma.$transaction(async (tx) => {
      const bill = await this.lockBill(tx, id, version);
      assertTransition('bill', BILL_TRANSITIONS, bill.status, 'LOCKED');
      await lockSession(tx, bill.sessionId);
      const priced = await priceLive(tx, bill);
      if (priced.lines.length === 0) throw new ConflictException('Bill chưa có món');
      await tx.billLine.createMany({
        data: priced.lines.map((l) => ({
          billId: id,
          orderItemId: l.id,
          name: l.name,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discount: l.discount,
          taxGroup: l.taxGroup,
          rateBp: l.rateBp,
          base: l.base,
          tax: l.tax,
          amount: l.amount,
        })),
      });
      const locked = await tx.bill.update({
        where: { id },
        data: { status: 'LOCKED', lockedAt: new Date(), total: priced.total, version: { increment: 1 } },
      });
      await tx.diningSession.update({ where: { id: bill.sessionId }, data: { status: 'PAYMENT', version: { increment: 1 } } });
      const tables = await currentTables(tx, bill.sessionId);
      for (const t of tables) await setTableStatus(tx, this.events, t.id, 'PAYMENT');
      await this.events.append(tx, 'bill.locked', 'bill', id, {
        sessionId: bill.sessionId,
        tableIds: tables.map((t) => t.id),
        billId: id,
        number: billNumber(bill.number),
        total: priced.total,
        by: actorId(p),
      });
      return this.dto(tx, locked);
    });
    this.events.wake();
    return dto;
  }

  /** LOCKED → OPEN: cần quyền quản lý, ghi audit; không cho mở khi đã thu một phần tiền. */
  async unlock(p: Principal, id: string, version: number, reason: string) {
    const dto = await this.prisma.$transaction(async (tx) => {
      const bill = await this.lockBill(tx, id, version);
      assertTransition('bill', BILL_TRANSITIONS, bill.status, 'OPEN');
      if (bill.parentId) throw new ConflictException('Bill con sau khi tách: dùng "Hủy tách bill" trên bill gốc');
      if ((await this.paidAmount(tx, id)) > 0) throw new ConflictException('Bill đã thu tiền một phần, không thể mở khóa');
      await tx.payment.updateMany({ where: { billId: id, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.billLine.deleteMany({ where: { billId: id } });
      const opened = await tx.bill.update({ where: { id }, data: { status: 'OPEN', lockedAt: null, total: 0, version: { increment: 1 } } });
      await tx.diningSession.update({ where: { id: bill.sessionId }, data: { status: 'OPEN', version: { increment: 1 } } });
      const tables = await currentTables(tx, bill.sessionId);
      for (const t of tables) await setTableStatus(tx, this.events, t.id, 'DINING');
      await this.audit.record(tx, { actorId: actorId(p), action: 'bill.unlock', entity: 'bill', entityId: id, before: { status: 'LOCKED' }, after: { status: 'OPEN' }, reason });
      await this.events.append(tx, 'bill.unlocked', 'bill', id, { sessionId: bill.sessionId, tableIds: tables.map((t) => t.id), billId: id });
      return this.dto(tx, opened);
    });
    this.events.wake();
    return dto;
  }

  /**
   * Tạo thanh toán. Tiền mặt ghi nhận ngay; QR/thẻ/ví ở trạng thái PENDING chờ xác nhận.
   * Idempotency-Key tránh ghi 2 lần khi bấm lặp hoặc mạng gửi lại.
   */
  async pay(p: Principal, billId: string, key: string, method: PaymentMethod, received?: number) {
    const found = await this.prisma.payment.findUnique({ where: { idempotencyKey: key } });
    if (found) return this.paymentResult(found.id);

    try {
      const paymentId = await this.prisma.$transaction(async (tx) => {
        const bill = await this.lockBill(tx, billId);
        // Yêu cầu trùng khóa chạy song song: yêu cầu đến sau chờ khóa bill rồi thấy thanh toán của yêu cầu trước.
        const raced = await tx.payment.findUnique({ where: { idempotencyKey: key } });
        if (raced) return raced.id;
        if (bill.status !== 'LOCKED') throw new ConflictException('Cần khóa bill trước khi thu tiền');
        const remaining = bill.total - (await this.paidAmount(tx, billId));
        if (remaining <= 0) throw new ConflictException('Bill đã thu đủ');
        const shift = await this.openShiftOf(tx, p);
        if (method === 'CASH' && !shift) {
          throw new ConflictException({ error: 'SHIFT_REQUIRED', message: 'Mở ca trước khi thu tiền mặt' });
        }

        if (method === 'CASH') {
          if (received === undefined || received <= 0) throw new ConflictException('Nhập số tiền khách đưa');
          const amount = Math.min(received, remaining);
          const payment = await tx.payment.create({
            data: { billId, method, amount, received, status: 'SUCCEEDED', idempotencyKey: key, cashierId: actorId(p), shiftId: shift?.id, confirmedAt: new Date() },
          });
          await this.audit.record(tx, { actorId: actorId(p), action: 'payment.cash', entity: 'payment', entityId: payment.id, after: { amount, received } });
          await this.settle(tx, bill, payment.id);
          return payment.id;
        }

        const payment = await tx.payment.create({
          data: { billId, method, amount: remaining, status: 'PENDING', idempotencyKey: key, cashierId: actorId(p), shiftId: shift?.id },
        });
        return payment.id;
      });
      this.events.wake();
      return this.paymentResult(paymentId);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const winner = await this.prisma.payment.findUnique({ where: { idempotencyKey: key } });
        if (winner) return this.paymentResult(winner.id);
      }
      throw e;
    }
  }

  /** Thu ngân xác nhận thủ công đã nhận tiền QR/thẻ (Sprint 4); webhook cổng thanh toán sẽ gọi cùng luồng. */
  async confirm(p: Principal | null, paymentId: string, providerTxnId?: string) {
    const changed = await this.confirmOnly(p, paymentId, providerTxnId);
    return { ...(await this.paymentResult(paymentId)), changed };
  }

  /** Ghi nhận thanh toán; trả về false nếu đã được ghi nhận trước đó (webhook/xác nhận lặp). */
  async confirmOnly(p: Principal | null, paymentId: string, providerTxnId?: string): Promise<boolean> {
    const changed = await this.prisma.$transaction(async (tx) => {
      const pay = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!pay) throw new NotFoundException('Không tìm thấy thanh toán');
      const bill = await this.lockBill(tx, pay.billId);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (current.status === 'SUCCEEDED') return false; // xác nhận lặp: bỏ qua
      if (current.status !== 'PENDING') throw new ConflictException('Thanh toán không còn chờ xác nhận');
      await tx.payment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED', confirmedAt: new Date(), providerTxnId } });
      await this.audit.record(tx, {
        actorId: p ? actorId(p) : `provider:${providerTxnId ?? 'unknown'}`,
        action: p ? 'payment.confirm' : 'payment.webhook',
        entity: 'payment',
        entityId: paymentId,
        before: { status: 'PENDING' },
        after: { status: 'SUCCEEDED', providerTxnId },
      });
      await this.settle(tx, bill, paymentId);
      return true;
    });
    this.events.wake();
    return changed;
  }

  async cancelPending(p: Principal, paymentId: string) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.payment.updateMany({ where: { id: paymentId, status: 'PENDING' }, data: { status: 'FAILED' } });
      if (r.count === 0) throw new ConflictException('Thanh toán không còn chờ xác nhận');
      await this.audit.record(tx, { actorId: actorId(p), action: 'payment.cancel', entity: 'payment', entityId: paymentId });
    });
    return this.paymentResult(paymentId);
  }

  /** Thu đủ tiền: bill PAID theo ngày kinh doanh, đóng phiên, bàn chuyển CLEANING. */
  private async settle(tx: Tx, bill: Bill, paymentId: string) {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const paid = await this.paidAmount(tx, bill.id);
    const tables = await currentTables(tx, bill.sessionId);
    const route = { sessionId: bill.sessionId, tableIds: tables.map((t) => t.id) };
    await this.events.append(tx, 'payment.succeeded', 'payment', paymentId, {
      ...route,
      billId: bill.id,
      method: payment.method,
      amount: payment.amount,
      paid,
      total: bill.total,
    });
    if (paid < bill.total) return;

    const now = new Date();
    assertTransition('bill', BILL_TRANSITIONS, bill.status, 'PAID');
    await tx.bill.update({ where: { id: bill.id }, data: { status: 'PAID', paidAt: now, businessDay: businessDay(now, cutoffHour()), version: { increment: 1 } } });
    await tx.payment.updateMany({ where: { billId: bill.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    await this.events.append(tx, 'bill.paid', 'bill', bill.id, { ...route, billId: bill.id, total: bill.total });

    // Tách bill: phiên chỉ đóng khi mọi bill con đã thu đủ.
    const unpaid = await tx.bill.count({ where: { sessionId: bill.sessionId, ...ACTIVE_BILL, status: { in: ['OPEN', 'LOCKED'] } } });
    if (unpaid > 0) return;
    await tx.diningSession.update({ where: { id: bill.sessionId }, data: { status: 'CLOSED', closedAt: now, version: { increment: 1 } } });
    await tx.tableAssignment.updateMany({ where: { sessionId: bill.sessionId, toAt: null }, data: { toAt: now } });
    for (const t of tables) await setTableStatus(tx, this.events, t.id, 'CLEANING');
    await this.events.append(tx, 'session.closed', 'session', bill.sessionId, route);
  }

  async openShiftOf(tx: Tx, p: Principal) {
    if (p.kind !== 'user') return null;
    return tx.shift.findFirst({ where: { cashierId: p.sub, status: 'OPEN' } });
  }

  /**
   * Tách bill theo món hoặc theo nhóm khách (mục 17.4 Sprint 5): bill gốc chuyển SPLIT,
   * mỗi nhóm thành một bill con đã khóa, thanh toán riêng. Tổng các bill con = bill gốc.
   */
  async split(p: Principal, id: string, version: number, groups: SplitGroup[]) {
    const dtos = await this.prisma.$transaction(async (tx) => {
      const bill = await this.lockBill(tx, id, version);
      assertTransition('bill', BILL_TRANSITIONS, bill.status, 'SPLIT');
      if (groups.length < 2) throw new ConflictException('Cần ít nhất 2 phần để tách bill');
      await lockSession(tx, bill.sessionId);
      const priced = await priceLive(tx, bill);
      const parts = splitBill(priced, groups.map((g) => g.orderItemIds), pricingConfig());
      const now = new Date();
      const children: Bill[] = [];
      for (const [i, part] of parts.entries()) {
        const child = await tx.bill.create({
          data: { sessionId: bill.sessionId, parentId: id, label: groups[i].label, status: 'LOCKED', lockedAt: now, total: part.total },
        });
        await tx.billLine.createMany({
          data: part.lines.map((l) => ({
            billId: child.id,
            orderItemId: l.id,
            name: l.name,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discount: l.discount,
            taxGroup: l.taxGroup,
            rateBp: l.rateBp,
            base: l.base,
            tax: l.tax,
            amount: l.amount,
          })),
        });
        children.push(child);
      }
      await tx.bill.update({ where: { id }, data: { status: 'SPLIT', total: priced.total, version: { increment: 1 } } });
      await tx.diningSession.update({ where: { id: bill.sessionId }, data: { status: 'PAYMENT', version: { increment: 1 } } });
      const tables = await currentTables(tx, bill.sessionId);
      for (const t of tables) await setTableStatus(tx, this.events, t.id, 'PAYMENT');
      await this.audit.record(tx, { actorId: actorId(p), action: 'bill.split', entity: 'bill', entityId: id, after: { groups } });
      await this.events.append(tx, 'bill.split', 'bill', id, {
        sessionId: bill.sessionId,
        tableIds: tables.map((t) => t.id),
        billId: id,
        childBillIds: children.map((c) => c.id),
      });
      return Promise.all(children.map((c) => this.dto(tx, c)));
    });
    this.events.wake();
    return dtos;
  }

  /** Hủy tách: chỉ khi chưa bill con nào thu tiền; bill con chuyển VOID, bill gốc mở lại. */
  async unsplit(p: Principal, id: string, reason: string) {
    const dto = await this.prisma.$transaction(async (tx) => {
      const bill = await this.lockBill(tx, id);
      assertTransition('bill', BILL_TRANSITIONS, bill.status, 'OPEN');
      const children = await tx.bill.findMany({ where: { parentId: id, status: { not: 'VOID' } } });
      for (const c of children) {
        await this.lockBill(tx, c.id);
        if ((await this.paidAmount(tx, c.id)) > 0) throw new ConflictException('Đã có bill con thu tiền, không thể hủy tách');
      }
      await tx.payment.updateMany({ where: { billId: { in: children.map((c) => c.id) }, status: 'PENDING' }, data: { status: 'FAILED' } });
      await tx.bill.updateMany({ where: { id: { in: children.map((c) => c.id) } }, data: { status: 'VOID', version: { increment: 1 } } });
      const opened = await tx.bill.update({ where: { id }, data: { status: 'OPEN', total: 0, version: { increment: 1 } } });
      await tx.diningSession.update({ where: { id: bill.sessionId }, data: { status: 'OPEN', version: { increment: 1 } } });
      const tables = await currentTables(tx, bill.sessionId);
      for (const t of tables) await setTableStatus(tx, this.events, t.id, 'DINING');
      await this.audit.record(tx, { actorId: actorId(p), action: 'bill.unsplit', entity: 'bill', entityId: id, reason });
      await this.events.append(tx, 'bill.unlocked', 'bill', id, { sessionId: bill.sessionId, tableIds: tables.map((t) => t.id), billId: id });
      return this.dto(tx, opened);
    });
    this.events.wake();
    return dto;
  }

  /**
   * Hoàn tiền: không sửa bill đã thanh toán, ghi bút toán âm vào ngày kinh doanh lúc hoàn,
   * nên báo cáo ngày cũ không đổi (mục 10.1).
   */
  async refund(p: Principal, id: string, amount: number, method: PaymentMethod, reason: string) {
    const refund = await this.prisma.$transaction(async (tx) => {
      const bill = await this.lockBill(tx, id);
      if (bill.status !== 'PAID' && bill.status !== 'CLOSED') throw new ConflictException('Chỉ hoàn tiền bill đã thanh toán');
      const refunded = await this.refundedAmount(tx, id);
      if (amount > bill.total - refunded) throw new ConflictException('Số tiền hoàn vượt số đã thu');
      const shift = await this.openShiftOf(tx, p);
      if (method === 'CASH' && !shift) throw new ConflictException({ error: 'SHIFT_REQUIRED', message: 'Mở ca trước khi hoàn tiền mặt' });
      const r = await tx.refund.create({
        data: { billId: id, method, amount, reason, createdBy: actorId(p), shiftId: shift?.id, businessDay: businessDay(new Date(), cutoffHour()) },
      });
      await this.audit.record(tx, { actorId: actorId(p), action: 'payment.refund', entity: 'bill', entityId: id, after: { amount, method }, reason });
      await this.events.append(tx, 'payment.refunded', 'bill', id, { sessionId: bill.sessionId, billId: id, refundId: r.id, amount, method });
      return r;
    });
    this.events.wake();
    return { refund, bill: await this.byId(id) };
  }

  async paymentResult(paymentId: string) {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { bill: true } });
    const bill = await this.dto(this.prisma, p.bill);
    return {
      payment: {
        id: p.id,
        method: p.method,
        amount: p.amount,
        received: p.received,
        change: p.received !== null ? p.received - p.amount : 0,
        status: p.status,
        qrUrl: p.status === 'PENDING' && p.method === 'QR' ? vietQrUrl(p.amount, bill.number) : null,
      },
      bill,
    };
  }
}

/** Ảnh mã VietQR đúng số tiền, nội dung là mã bill (mục 3.6). Chưa cấu hình tài khoản thì trả null. */
export function vietQrUrl(amount: number, content: string): string | null {
  const bank = process.env.VIETQR_BANK_BIN;
  const account = process.env.VIETQR_ACCOUNT_NO;
  if (!bank || !account) return null;
  const q = new URLSearchParams({ amount: String(amount), addInfo: content, accountName: process.env.VIETQR_ACCOUNT_NAME ?? '' });
  return `https://img.vietqr.io/image/${bank}-${account}-compact2.png?${q}`;
}
