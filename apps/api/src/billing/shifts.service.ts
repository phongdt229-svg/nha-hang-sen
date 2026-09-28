import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { actorId, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../events/events.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';

const diffThreshold = () => Number(process.env.SHIFT_DIFF_THRESHOLD ?? 50_000);

export interface ShiftTotals {
  byMethod: Record<string, number>;
  refundsByMethod: Record<string, number>;
  payments: number;
}

/** Kết ca (mục 10.3): tổng thu theo phương thức, tiền mặt hệ thống so với tiền đếm thực tế. */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  async open(p: Principal, openingCash: number) {
    if (p.kind !== 'user') throw new ForbiddenException();
    return this.prisma.$transaction(async (tx) => {
      // Khóa theo thu ngân để hai lần bấm "Mở ca" không tạo hai ca.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shift:' + p.sub}))`;
      const existing = await tx.shift.findFirst({ where: { cashierId: p.sub, status: 'OPEN' } });
      if (existing) return existing;
      return tx.shift.create({ data: { cashierId: p.sub, openingCash } });
    });
  }

  current(p: Principal) {
    if (p.kind !== 'user') return null;
    return this.prisma.shift.findFirst({ where: { cashierId: p.sub, status: 'OPEN' } });
  }

  async totals(tx: Tx, shiftId: string): Promise<ShiftTotals> {
    const [pays, refunds] = await Promise.all([
      tx.payment.groupBy({ by: ['method'], where: { shiftId, status: 'SUCCEEDED' }, _sum: { amount: true }, _count: true }),
      tx.refund.groupBy({ by: ['method'], where: { shiftId }, _sum: { amount: true } }),
    ]);
    return {
      byMethod: Object.fromEntries(pays.map((x) => [x.method, x._sum.amount ?? 0])),
      refundsByMethod: Object.fromEntries(refunds.map((x) => [x.method, x._sum.amount ?? 0])),
      payments: pays.reduce((a, x) => a + x._count, 0),
    };
  }

  async close(p: Principal, id: string, countedCash: number, note?: string) {
    const shift = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM shifts WHERE id = ${id} FOR UPDATE`;
      if (!row) throw new NotFoundException('Không tìm thấy ca');
      const s = await tx.shift.findUniqueOrThrow({ where: { id } });
      if (s.status !== 'OPEN') throw new ConflictException('Ca đã kết');
      if (p.kind !== 'user' || (s.cashierId !== p.sub && p.role !== 'MANAGER' && p.role !== 'ADMIN')) {
        throw new ForbiddenException('Chỉ thu ngân của ca hoặc quản lý được kết ca');
      }
      const totals = await this.totals(tx, id);
      const expectedCash = s.openingCash + (totals.byMethod.CASH ?? 0) - (totals.refundsByMethod.CASH ?? 0);
      const difference = countedCash - expectedCash;
      const needsApproval = Math.abs(difference) > diffThreshold();
      const closed = await tx.shift.update({
        where: { id },
        data: {
          status: needsApproval ? 'PENDING_APPROVAL' : 'CLOSED',
          countedCash,
          expectedCash,
          difference,
          totals: totals as unknown as Prisma.InputJsonValue,
          note,
          closedAt: new Date(),
        },
      });
      await this.audit.record(tx, { actorId: actorId(p), action: 'shift.close', entity: 'shift', entityId: id, after: { countedCash, expectedCash, difference } });
      await this.events.append(tx, 'shift.closed', 'shift', id, { shiftId: id, difference, needsApproval });
      return closed;
    });
    this.events.wake();
    return shift;
  }

  /** Chênh lệch vượt ngưỡng: quản lý duyệt kèm lý do. */
  async approve(p: Principal, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.shift.updateMany({ where: { id, status: 'PENDING_APPROVAL' }, data: { status: 'CLOSED', approvedBy: actorId(p) } });
      if (r.count === 0) throw new ConflictException('Ca không chờ duyệt');
      await this.audit.record(tx, { actorId: actorId(p), action: 'shift.approve', entity: 'shift', entityId: id, reason });
      return tx.shift.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Z-report của ca. */
  async report(id: string) {
    const s = await this.prisma.shift.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Không tìm thấy ca');
    const cashier = await this.prisma.user.findUnique({ where: { id: s.cashierId }, select: { name: true } });
    const totals = s.totals ?? (await this.totals(this.prisma, id));
    return { ...s, cashierName: cashier?.name ?? null, totals };
  }

  list(status?: 'OPEN' | 'PENDING_APPROVAL' | 'CLOSED') {
    return this.prisma.shift.findMany({ where: status ? { status } : undefined, orderBy: { openedAt: 'desc' }, take: 50 });
  }
}
