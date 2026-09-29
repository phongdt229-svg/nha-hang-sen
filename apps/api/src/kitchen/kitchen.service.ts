import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { KitchenTicket, Order, OrderItem } from '@prisma/client';
import type { DomainEvent, KitchenTicketDto, OrderDto } from '@nhs/types';
import type { Queue } from 'bullmq';
import { EventsService } from '../events/events.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { currentTables } from '../sessions/session.helpers';
import { orderNumber, toOrderDto, toOrderItemDto } from '../orders/order.mapper';
import { metrics } from '../observability/metrics';
import { KITCHEN_QUEUE, kitchenConfig, retryDelay } from './kitchen.config';

export interface AckCheckJob {
  ticketId: string;
  attempt: number;
}

type TicketWithOrder = KitchenTicket & { order: Order & { items: OrderItem[]; tickets: KitchenTicket[] } };

@Injectable()
export class KitchenService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly outbox: OutboxPublisher,
    @InjectQueue(KITCHEN_QUEUE) private readonly queue: Queue<AckCheckJob>,
  ) {}

  onModuleInit() {
    // Tiến trình outbox đọc order.confirmed và gửi phiếu tới KDS (mục 6.2).
    this.outbox.on('order.confirmed', (tx, e) => this.dispatchOrder(tx, e as DomainEvent<{ order: OrderDto }>));
  }

  async toTicketDto(tx: Tx, t: TicketWithOrder): Promise<KitchenTicketDto> {
    const tables = await currentTables(tx, t.order.sessionId);
    return {
      id: t.id,
      orderId: t.orderId,
      orderNumber: orderNumber(t.order.number),
      station: t.station,
      status: t.status,
      attempts: t.attempts,
      tableCodes: tables.map((x) => x.code),
      createdAt: t.createdAt.toISOString(),
      items: t.order.items.filter((i) => i.station === t.station).map(toOrderItemDto),
    };
  }

  /** Phiếu bếp đầy đủ (bàn hiện tại, món của trạm) — dùng cho KDS và in phiếu giấy. */
  async ticketDto(id: string): Promise<KitchenTicketDto> {
    const t = await this.prisma.kitchenTicket.findUnique({ where: { id }, include: { order: { include: { items: { orderBy: { name: 'asc' } }, tickets: true } } } });
    if (!t) throw new NotFoundException('Không tìm thấy phiếu bếp');
    return this.toTicketDto(this.prisma, t);
  }

  private loadTicket(tx: Tx, id: string): Promise<TicketWithOrder> {
    return tx.kitchenTicket.findUniqueOrThrow({
      where: { id },
      include: { order: { include: { items: { orderBy: { name: 'asc' } }, tickets: true } } },
    });
  }

  /** Tạo một phiếu cho mỗi trạm bếp. Chạy lại (outbox phát trùng) không tạo phiếu thứ hai. */
  private async dispatchOrder(tx: Tx, e: DomainEvent<{ order: OrderDto }>) {
    const orderId = e.data.order.id;
    const items = await tx.orderItem.findMany({ where: { orderId, status: 'CONFIRMED' } });
    const stations = [...new Set(items.map((i) => i.station))];
    for (const station of stations) {
      const exists = await tx.kitchenTicket.findUnique({ where: { orderId_station: { orderId, station } } });
      if (exists) continue;
      const ticket = await tx.kitchenTicket.create({ data: { orderId, station } });
      await tx.orderItem.updateMany({ where: { orderId, station, status: 'CONFIRMED' }, data: { status: 'SENT' } });
      await this.emitSent(tx, ticket.id);
      await this.queue.add('ack-check', { ticketId: ticket.id, attempt: 1 }, {
        delay: retryDelay(1),
        jobId: `ack-${ticket.id}-1`,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    }
  }

  private async emitSent(tx: Tx, ticketId: string) {
    const t = await this.loadTicket(tx, ticketId);
    const dto = await this.toTicketDto(tx, t);
    const tables = await currentTables(tx, t.order.sessionId);
    await this.events.append(tx, 'kitchen.sent', 'kitchen_ticket', t.id, {
      sessionId: t.order.sessionId,
      tableIds: tables.map((x) => x.id),
      station: t.station,
      ticket: dto,
    });
  }

  private async lockTicket(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM kitchen_tickets WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException('Không tìm thấy phiếu bếp');
    return this.loadTicket(tx, id);
  }

  /**
   * Chưa có ACK sau thời gian chờ: gửi lại, tối đa `maxRetry` lần, giãn cách tăng dần;
   * hết lượt → FALLBACK, cảnh báo POS để in phiếu giấy (mục 6.4).
   */
  async checkAck(job: AckCheckJob) {
    const { maxRetry } = kitchenConfig();
    const next = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, job.ticketId).catch(() => null);
      if (!t || t.status !== 'SENT' || t.attempts !== job.attempt) return null; // đã ACK hoặc job cũ

      if (t.attempts <= maxRetry) {
        await tx.kitchenTicket.update({ where: { id: t.id }, data: { attempts: { increment: 1 }, lastSentAt: new Date() } });
        await this.emitSent(tx, t.id);
        return t.attempts + 1;
      }

      await tx.kitchenTicket.update({ where: { id: t.id }, data: { status: 'FALLBACK' } });
      await tx.orderItem.updateMany({ where: { orderId: t.orderId, station: t.station, status: 'SENT' }, data: { status: 'FALLBACK' } });
      const fresh = await this.loadTicket(tx, t.id);
      const tables = await currentTables(tx, t.order.sessionId);
      await this.events.append(tx, 'kitchen.fallback', 'kitchen_ticket', t.id, {
        sessionId: t.order.sessionId,
        tableIds: tables.map((x) => x.id),
        station: t.station,
        ticket: await this.toTicketDto(tx, fresh),
      });
      return null;
    });
    this.events.wake();
    if (next) {
      await this.queue.add('ack-check', { ticketId: job.ticketId, attempt: next }, {
        delay: retryDelay(next),
        jobId: `ack-${job.ticketId}-${next}`,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    }
  }

  /**
   * Lưới an toàn khi Redis mất job: phiếu SENT quá lâu mà không có ACK thì xử lý như job ack-check.
   */
  async sweepStale() {
    const cutoff = new Date(Date.now() - retryDelay(kitchenConfig().maxRetry + 1) * 2);
    const stale = await this.prisma.kitchenTicket.findMany({ where: { status: 'SENT', lastSentAt: { lt: cutoff } }, take: 50 });
    for (const t of stale) await this.checkAck({ ticketId: t.id, attempt: t.attempts });
  }

  /** ACK từ KDS; gọi lại nhiều lần vẫn an toàn. Cũng dùng khi bếp nhập tay phiếu fallback. */
  async ack(ticketId: string) {
    const dto = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, ticketId);
      if (t.status === 'ACKED') return this.toTicketDto(tx, t);
      const ackedAt = new Date();
      await tx.kitchenTicket.update({ where: { id: t.id }, data: { status: 'ACKED', ackedAt } });
      // Từ lúc xác nhận order đến khi bếp nhận (mục 17.2); phiếu fallback nhập tay tính riêng.
      metrics.kdsAckLatency.observe((ackedAt.getTime() - t.order.createdAt.getTime()) / 1000, { station: t.station, via: t.status === 'FALLBACK' ? 'manual' : 'kds' });
      await tx.orderItem.updateMany({
        where: { orderId: t.orderId, station: t.station, status: { in: ['SENT', 'FALLBACK'] } },
        data: { status: 'KDS_ACK' },
      });
      const fresh = await this.loadTicket(tx, t.id);
      const ticket = await this.toTicketDto(tx, fresh);
      const tables = await currentTables(tx, t.order.sessionId);
      await this.events.append(tx, 'kitchen.ack', 'kitchen_ticket', t.id, {
        sessionId: t.order.sessionId,
        tableIds: tables.map((x) => x.id),
        station: t.station,
        ticket,
        order: toOrderDto(fresh.order),
      });
      return ticket;
    });
    this.events.wake();
    return dto;
  }

  /** Phiếu hết lượt gửi lại mà bếp chưa xác nhận, mọi trạm — POS dùng để cảnh báo và in phiếu giấy. */
  async fallbackTickets(): Promise<KitchenTicketDto[]> {
    const tickets = await this.prisma.kitchenTicket.findMany({
      where: { status: 'FALLBACK', order: { session: { status: { not: 'CLOSED' } } } },
      include: { order: { include: { items: { orderBy: { name: 'asc' } }, tickets: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(tickets.map((t) => this.toTicketDto(this.prisma, t)));
  }

  /** Phiếu còn đang xử lý của một trạm, cho KDS tải lúc mở màn hình. */
  async activeTickets(station: string): Promise<KitchenTicketDto[]> {
    const tickets = await this.prisma.kitchenTicket.findMany({
      where: {
        station,
        order: { items: { some: { station, status: { in: ['SENT', 'FALLBACK', 'KDS_ACK', 'PREPARING', 'READY'] } } } },
      },
      include: { order: { include: { items: { orderBy: { name: 'asc' } }, tickets: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(tickets.map((t) => this.toTicketDto(this.prisma, t)));
  }
}
