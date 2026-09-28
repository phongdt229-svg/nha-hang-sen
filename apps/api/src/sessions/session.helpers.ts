import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { assertTransition, TABLE_TRANSITIONS, type SessionDto, type TableStatus } from '@nhs/types';
import type { Principal } from '../auth/principal';
import type { EventsService } from '../events/events.service';
import type { Tx } from '../prisma/prisma.service';

/** Bàn hiện tại của phiên (các dòng assignment chưa đóng). */
export async function currentTables(tx: Tx, sessionId: string) {
  const rows = await tx.tableAssignment.findMany({
    where: { sessionId, toAt: null },
    include: { table: true },
    orderBy: { table: { code: 'asc' } },
  });
  return rows.map((r) => r.table);
}

export async function loadSessionDto(tx: Tx, sessionId: string): Promise<SessionDto> {
  const s = await tx.diningSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new NotFoundException('Không tìm thấy phiên');
  const tables = await currentTables(tx, sessionId);
  return {
    id: s.id,
    code: s.code,
    guests: s.guests,
    status: s.status,
    openedAt: s.openedAt.toISOString(),
    tableIds: tables.map((t) => t.id),
    tableCodes: tables.map((t) => t.code),
  };
}

/** Khóa dòng bàn rồi chuyển trạng thái theo bảng chuyển trạng thái; phát sự kiện table.status. */
export async function setTableStatus(tx: Tx, events: EventsService, tableId: string, to: TableStatus) {
  const [row] = await tx.$queryRaw<{ status: TableStatus }[]>`SELECT status FROM tables WHERE id = ${tableId} FOR UPDATE`;
  if (!row) throw new NotFoundException('Không tìm thấy bàn');
  if (row.status === to) return;
  assertTransition('bàn', TABLE_TRANSITIONS, row.status, to);
  const t = await tx.table.update({ where: { id: tableId }, data: { status: to, version: { increment: 1 } } });
  await events.append(tx, 'table.status', 'table', t.id, { tableIds: [t.id], tableId: t.id, code: t.code, status: to });
}

/** Tablet chỉ được thao tác trên phiên đang ngồi ở đúng bàn đã ghép. */
export async function assertTabletOwnsSession(tx: Tx, p: Principal, sessionId: string) {
  if (p.kind !== 'device') return;
  if (p.deviceKind !== 'TABLET' || !p.tableId) throw new ForbiddenException('Thiết bị không được phép');
  const a = await tx.tableAssignment.findFirst({ where: { sessionId, tableId: p.tableId, toAt: null } });
  if (!a) throw new ForbiddenException('Phiên này không thuộc bàn của tablet');
}

export async function lockSession(tx: Tx, sessionId: string) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM dining_sessions WHERE id = ${sessionId} FOR UPDATE`;
  if (!row) throw new NotFoundException('Không tìm thấy phiên');
  return row.status as 'OPEN' | 'PAYMENT' | 'CLOSED';
}

export function assertSessionOpen(status: string) {
  if (status !== 'OPEN') throw new ConflictException({ error: 'SESSION_NOT_OPEN', message: 'Phiên đang thanh toán hoặc đã đóng, không nhận thêm món' });
}
