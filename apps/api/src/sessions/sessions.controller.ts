import { BadRequestException, Body, ConflictException, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { TableDto } from '@nhs/types';
import { z } from 'zod';
import { actorId, Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { ZodPipe } from '../common/zod.pipe';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertTabletOwnsSession, currentTables, loadSessionDto, lockSession, setTableStatus } from './session.helpers';

const OpenSchema = z.object({ tableId: z.string().uuid(), guests: z.number().int().min(1).max(100), note: z.string().max(200).optional() });
const MoveSchema = z.object({ toTableId: z.string().uuid() });
const MergeSchema = z.object({ sourceSessionId: z.string().uuid() });

@Controller()
export class SessionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  @Allow('MANAGER', 'WAITER', 'CASHIER')
  @Get('tables')
  async tables(): Promise<TableDto[]> {
    const tables = await this.prisma.table.findMany({
      orderBy: { code: 'asc' },
      include: { assignments: { where: { toAt: null }, select: { sessionId: true } } },
    });
    return tables.map((t) => ({
      id: t.id,
      code: t.code,
      seats: t.seats,
      zone: t.zone,
      status: t.status,
      sessionId: t.assignments[0]?.sessionId ?? null,
    }));
  }

  /** Gợi ý bàn trống vừa đủ ghế: ưu tiên bàn ít ghế thừa nhất. */
  @Allow('MANAGER', 'WAITER')
  @Get('tables/suggest')
  async suggest(@Query('guests') guests: string) {
    const n = Number(guests);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException('Số khách không hợp lệ');
    const free = await this.prisma.table.findMany({ where: { status: 'AVAILABLE', seats: { gte: n } }, orderBy: [{ seats: 'asc' }, { code: 'asc' }], take: 3 });
    return free.map((t) => ({ id: t.id, code: t.code, seats: t.seats, zone: t.zone }));
  }

  @Allow('MANAGER', 'WAITER')
  @Post('tables/:id/cleaned')
  async cleaned(@Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.$transaction((tx) => setTableStatus(tx, this.events, id, 'AVAILABLE'));
    this.events.wake();
    return { ok: true };
  }

  @Allow('MANAGER', 'WAITER')
  @Post('sessions')
  async open(@Body(new ZodPipe(OpenSchema)) body: z.infer<typeof OpenSchema>) {
    const session = await this.prisma.$transaction(async (tx) => {
      await setTableStatus(tx, this.events, body.tableId, 'DINING');
      const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('dining_sessions_seq_no_seq') AS n`;
      const code = `DS-${new Date().getFullYear()}-${String(n).padStart(3, '0')}`;
      const s = await tx.diningSession.create({ data: { seqNo: Number(n), code, guests: body.guests, note: body.note } });
      await tx.tableAssignment.create({ data: { sessionId: s.id, tableId: body.tableId } });
      await tx.bill.create({ data: { sessionId: s.id } });
      const dto = await loadSessionDto(tx, s.id);
      await this.events.append(tx, 'session.opened', 'session', s.id, { sessionId: s.id, tableIds: dto.tableIds, session: dto });
      return dto;
    });
    this.events.wake();
    return session;
  }

  @Get('sessions/:id')
  async get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await assertTabletOwnsSession(this.prisma, p, id);
    return loadSessionDto(this.prisma, id);
  }

  /** Tablet hỏi phiên đang mở ở bàn của mình (sau khi mở bàn hoặc chuyển bàn). */
  @Allow('TABLET')
  @Get('devices/me/session')
  async mySession(@CurrentPrincipal() p: Principal) {
    if (p.kind !== 'device' || !p.tableId) return null;
    const a = await this.prisma.tableAssignment.findFirst({ where: { tableId: p.tableId, toAt: null }, include: { session: true } });
    if (!a || a.session.status === 'CLOSED') return null;
    return loadSessionDto(this.prisma, a.sessionId);
  }

  /** Chuyển bàn: phiên giữ nguyên, lịch sử table_assignments ghi đủ, bàn cũ chuyển CLEANING. */
  @Allow('MANAGER', 'WAITER')
  @Post('sessions/:id/move')
  async move(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MoveSchema)) body: z.infer<typeof MoveSchema>) {
    const dto = await this.prisma.$transaction(async (tx) => {
      const status = await lockSession(tx, id);
      if (status === 'CLOSED') throw new ConflictException('Phiên đã đóng');
      const from = await currentTables(tx, id);
      if (from.some((t) => t.id === body.toTableId)) throw new BadRequestException('Phiên đang ở bàn này');
      await setTableStatus(tx, this.events, body.toTableId, 'DINING');
      if (status === 'PAYMENT') await setTableStatus(tx, this.events, body.toTableId, 'PAYMENT');
      const now = new Date();
      await tx.tableAssignment.updateMany({ where: { sessionId: id, toAt: null }, data: { toAt: now } });
      await tx.tableAssignment.create({ data: { sessionId: id, tableId: body.toTableId, fromAt: now } });
      for (const t of from) await setTableStatus(tx, this.events, t.id, 'CLEANING');
      const session = await loadSessionDto(tx, id);
      await this.events.append(tx, 'session.moved', 'session', id, {
        sessionId: id,
        tableIds: [...from.map((t) => t.id), ...session.tableIds],
        fromTableIds: from.map((t) => t.id),
        session,
      });
      return session;
    });
    this.events.wake();
    return dto;
  }

  /**
   * Gộp phiên nguồn vào phiên đích (mục 17.4 Sprint 5): order giữ nguyên số và giờ gọi,
   * ghi lại phiên gốc; bàn của phiên nguồn chuyển sang phiên đích; một bill chung.
   */
  @Allow('MANAGER', 'WAITER')
  @Post('sessions/:id/merge')
  async merge(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(MergeSchema)) body: z.infer<typeof MergeSchema>,
  ) {
    if (id === body.sourceSessionId) throw new BadRequestException('Không thể gộp phiên với chính nó');
    const dto = await this.prisma.$transaction(async (tx) => {
      // Khóa theo thứ tự id cố định để hai thao tác gộp ngược chiều không deadlock.
      const [first, second] = [id, body.sourceSessionId].sort();
      const statuses = { [first]: await lockSession(tx, first), [second]: await lockSession(tx, second) };
      if (statuses[id] !== 'OPEN' || statuses[body.sourceSessionId] !== 'OPEN') {
        throw new ConflictException('Chỉ gộp được hai phiên đang mở (chưa khóa bill)');
      }
      const sourceBills = await tx.bill.findMany({ where: { sessionId: body.sourceSessionId, status: { not: 'VOID' } } });
      if (sourceBills.some((b) => b.status !== 'OPEN')) throw new ConflictException('Bill của phiên nguồn không còn mở');

      const source = await tx.diningSession.findUniqueOrThrow({ where: { id: body.sourceSessionId } });
      const target = await tx.diningSession.findUniqueOrThrow({ where: { id } });
      const sourceTables = await currentTables(tx, body.sourceSessionId);
      const now = new Date();

      await tx.order.updateMany({ where: { sessionId: body.sourceSessionId, originSessionId: null }, data: { originSessionId: body.sourceSessionId } });
      await tx.order.updateMany({ where: { sessionId: body.sourceSessionId }, data: { sessionId: id } });
      await tx.tableAssignment.updateMany({ where: { sessionId: body.sourceSessionId, toAt: null }, data: { toAt: now } });
      for (const t of sourceTables) await tx.tableAssignment.create({ data: { sessionId: id, tableId: t.id, fromAt: now } });
      await tx.bill.updateMany({ where: { id: { in: sourceBills.map((b) => b.id) } }, data: { status: 'VOID', version: { increment: 1 } } });
      const discount = sourceBills.reduce((a, b) => a + b.discount, 0);
      if (discount > 0) await tx.bill.updateMany({ where: { sessionId: id, status: 'OPEN' }, data: { discount: { increment: discount }, version: { increment: 1 } } });
      await tx.diningSession.update({
        where: { id: body.sourceSessionId },
        data: { status: 'CLOSED', closedAt: now, note: `Đã gộp vào ${target.code}`, version: { increment: 1 } },
      });
      await tx.diningSession.update({ where: { id }, data: { guests: target.guests + source.guests, version: { increment: 1 } } });
      await this.audit.record(tx, {
        actorId: actorId(p),
        action: 'session.merge',
        entity: 'session',
        entityId: id,
        after: { sourceSessionId: body.sourceSessionId, sourceCode: source.code },
      });
      const session = await loadSessionDto(tx, id);
      await this.events.append(tx, 'session.merged', 'session', id, {
        sessionId: id,
        tableIds: session.tableIds,
        sourceSessionId: body.sourceSessionId,
        session,
      });
      return session;
    });
    this.events.wake();
    return dto;
  }
}
