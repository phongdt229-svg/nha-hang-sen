import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { DomainEvent, EventType } from '@nhs/types';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { EventsService, toDomainEvent } from './events.service';
import { RealtimeGateway } from './realtime.gateway';

/** Handler chạy trong cùng transaction với việc đánh dấu sự kiện đã phát, nên không bao giờ bị bỏ sót. */
export type EventHandler = (tx: Tx, event: DomainEvent) => Promise<void>;

const POLL_MS = 500;
const BATCH = 100;

@Injectable()
export class OutboxPublisher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private readonly handlers = new Map<EventType, EventHandler[]>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly gateway: RealtimeGateway,
  ) {}

  on(type: EventType, handler: EventHandler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  onApplicationBootstrap() {
    this.events.onWake(() => void this.drain());
    this.timer = setInterval(() => void this.drain(), POLL_MS);
    void this.drain();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  /** Phát hết sự kiện đang chờ. Gọi chồng nhau thì gộp lại thành một lượt chạy thêm. */
  async drain(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        while (!this.stopped && (await this.publishBatch()) === BATCH);
      } while (this.again && !this.stopped);
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : e);
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(): Promise<number> {
    const published = await this.prisma.$transaction(async (tx) => {
      // SKIP LOCKED để nhiều tiến trình API có thể chạy song song mà không phát trùng.
      const rows = await tx.$queryRaw<{ seq: bigint }[]>`
        SELECT seq FROM event_log WHERE published_at IS NULL ORDER BY seq LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      const events = await tx.eventLog.findMany({ where: { seq: { in: rows.map((r) => r.seq) } }, orderBy: { seq: 'asc' } });
      for (const row of events) {
        const event = toDomainEvent(row);
        for (const handler of this.handlers.get(event.type) ?? []) await handler(tx, event);
      }
      await tx.eventLog.updateMany({ where: { seq: { in: rows.map((r) => r.seq) } }, data: { publishedAt: new Date() } });
      return events;
    });

    // Gửi WebSocket sau commit. Mất gói thì client tự bắt kịp bằng lastEventId.
    for (const row of published) this.gateway.emit(toDomainEvent(row), row.rooms);
    if (published.length > 0 && published.some((r) => this.handlers.has(r.type as EventType))) this.again = true;
    return published.length;
  }
}
