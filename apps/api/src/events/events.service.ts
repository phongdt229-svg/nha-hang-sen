import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { rooms as R, type DomainEvent, type EventType } from '@nhs/types';
import type { Tx } from '../prisma/prisma.service';

export interface RoutedPayload {
  sessionId?: string;
  tableIds?: string[];
  station?: string;
  stations?: string[];
  [key: string]: unknown;
}

export const BROADCAST = '*';

/** Tính phòng WebSocket nhận sự kiện từ dữ liệu của nó. */
export function roomsFor(type: EventType, data: RoutedPayload): string[] {
  if (type.startsWith('menu.')) return [BROADCAST];
  const rooms = new Set<string>([R.pos, R.dashboard]);
  if (data.sessionId) rooms.add(R.session(data.sessionId));
  for (const t of data.tableIds ?? []) rooms.add(R.table(t));
  if (data.station) rooms.add(R.kitchen(data.station));
  for (const s of data.stations ?? []) rooms.add(R.kitchen(s));
  if (type.startsWith('trip.') || type === 'robot.status') rooms.add(R.dispatch);
  return [...rooms];
}

export function toDomainEvent(row: {
  seq: bigint;
  type: string;
  aggregate: string;
  aggregateId: string;
  data: Prisma.JsonValue;
  createdAt: Date;
}): DomainEvent {
  return {
    seq: Number(row.seq),
    type: row.type as EventType,
    aggregate: row.aggregate,
    aggregateId: row.aggregateId,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class EventsService {
  private readonly wakeListeners = new Set<() => void>();

  /**
   * Ghi sự kiện vào event_log trong CÙNG transaction với thay đổi nghiệp vụ (outbox pattern).
   * Bộ phát đọc các dòng chưa phát và gửi đi sau khi commit.
   */
  async append(tx: Tx, type: EventType, aggregate: string, aggregateId: string, data: RoutedPayload) {
    await tx.eventLog.create({
      data: { type, aggregate, aggregateId, data: data as Prisma.InputJsonValue, rooms: roomsFor(type, data) },
    });
  }

  /** Báo bộ phát có sự kiện mới để gửi ngay, không phải chờ vòng quét kế tiếp. */
  wake() {
    for (const fn of this.wakeListeners) fn();
  }

  onWake(fn: () => void) {
    this.wakeListeners.add(fn);
  }
}
