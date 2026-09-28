import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { assertTransition, ORDER_ITEM_TRANSITIONS, type OrderDto, type OrderSource } from '@nhs/types';
import { z } from 'zod';
import { actorId, Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { isUniqueViolation } from '../common/errors.filter';
import { ZodPipe } from '../common/zod.pipe';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertSessionOpen, assertTabletOwnsSession, currentTables, lockSession } from '../sessions/session.helpers';
import { toOrderDto, toOrderItemDto } from './order.mapper';

const CreateOrderSchema = z.object({
  items: z
    .array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1).max(50), note: z.string().max(200).optional() }))
    .min(1)
    .max(100),
});
const CancelSchema = z.object({ reason: z.string().min(1).max(200) });
const KeySchema = z.string().min(8).max(100);

const withRelations = { items: { orderBy: { name: 'asc' as const } }, tickets: true };

@Controller()
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  @Get('sessions/:id/orders')
  async list(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<OrderDto[]> {
    await assertTabletOwnsSession(this.prisma, p, id);
    const orders = await this.prisma.order.findMany({ where: { sessionId: id }, include: withRelations, orderBy: { number: 'asc' } });
    return orders.map(toOrderDto);
  }

  /**
   * Xác nhận order (mục 6.1–6.2):
   * - Idempotency-Key UNIQUE: bấm 2 lần / mạng gửi lại → trả order cũ, không tạo mới.
   * - Order và sự kiện order.confirmed ghi trong cùng transaction (outbox).
   */
  @Allow('TABLET', 'WAITER', 'MANAGER', 'CASHIER')
  @Post('sessions/:id/orders')
  async create(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) sessionId: string,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body(new ZodPipe(CreateOrderSchema)) body: z.infer<typeof CreateOrderSchema>,
  ): Promise<OrderDto> {
    const parsedKey = KeySchema.safeParse(rawKey);
    if (!parsedKey.success) throw new BadRequestException('Thiếu header Idempotency-Key hợp lệ');
    const key = parsedKey.data;

    const existing = await this.findByKey(key, sessionId);
    if (existing) return existing;

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        await assertTabletOwnsSession(tx, p, sessionId);
        assertSessionOpen(await lockSession(tx, sessionId));

        const ids = [...new Set(body.items.map((i) => i.menuItemId))];
        const menu = await tx.menuItem.findMany({ where: { id: { in: ids } } });
        const byId = new Map(menu.map((m) => [m.id, m]));
        const unavailable = ids.filter((id) => !byId.get(id)?.available);
        if (unavailable.length > 0) {
          throw new ConflictException({
            error: 'ITEM_UNAVAILABLE',
            message: 'Có món vừa hết hoặc không tồn tại',
            menuItemIds: unavailable,
          });
        }

        const source: OrderSource = p.kind === 'device' ? 'TABLET' : 'POS';
        const lines = body.items.map((i) => {
          const m = byId.get(i.menuItemId)!;
          return { menuItemId: m.id, name: m.name, qty: i.qty, note: i.note, unitPrice: m.price, taxGroup: m.taxGroup, station: m.station };
        });
        const created = await tx.order.create({
          data: {
            sessionId,
            idempotencyKey: key,
            source,
            createdBy: actorId(p),
            total: lines.reduce((a, l) => a + l.qty * l.unitPrice, 0),
            items: { create: lines },
          },
          include: withRelations,
        });
        const tables = await currentTables(tx, sessionId);
        await this.events.append(tx, 'order.confirmed', 'order', created.id, {
          sessionId,
          tableIds: tables.map((t) => t.id),
          order: toOrderDto(created),
        });
        return created;
      });
      this.events.wake();
      return toOrderDto(order);
    } catch (e) {
      // Hai yêu cầu cùng khóa chạy song song: yêu cầu thua trả về order của yêu cầu thắng.
      if (isUniqueViolation(e)) {
        const winner = await this.findByKey(key, sessionId);
        if (winner) return winner;
      }
      throw e;
    }
  }

  /** Hủy món: chỉ trước Preparing; món đã gửi bếp cần quyền quản lý và ghi audit (mục 5.1, 9). */
  @Allow('MANAGER', 'WAITER', 'CASHIER')
  @Post('order-items/:id/cancel')
  async cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CancelSchema)) body: z.infer<typeof CancelSchema>,
  ) {
    const item = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM order_items WHERE id = ${id} FOR UPDATE`;
      if (!row) throw new BadRequestException('Không tìm thấy món');
      const before = await tx.orderItem.findUniqueOrThrow({ where: { id }, include: { order: true } });
      assertSessionOpen(await lockSession(tx, before.order.sessionId));
      assertTransition('món', ORDER_ITEM_TRANSITIONS, before.status, 'CANCELLED');
      const sentToKitchen = before.status !== 'CONFIRMED';
      if (sentToKitchen && !(p.kind === 'user' && (p.role === 'MANAGER' || p.role === 'ADMIN'))) {
        throw new ConflictException({ error: 'NEED_MANAGER', message: 'Món đã gửi bếp, cần quản lý hủy' });
      }
      const item = await tx.orderItem.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: body.reason } });
      await this.audit.record(tx, {
        actorId: actorId(p),
        action: 'order_item.cancel',
        entity: 'order_item',
        entityId: id,
        before: { status: before.status },
        after: { status: 'CANCELLED' },
        reason: body.reason,
      });
      const tables = await currentTables(tx, before.order.sessionId);
      await this.events.append(tx, 'order.cancelled', 'order_item', id, {
        sessionId: before.order.sessionId,
        tableIds: tables.map((t) => t.id),
        station: item.station,
        orderId: item.orderId,
        item: toOrderItemDto(item),
      });
      return item;
    });
    this.events.wake();
    return toOrderItemDto(item);
  }

  private async findByKey(key: string, sessionId: string): Promise<OrderDto | null> {
    const found = await this.prisma.order.findUnique({ where: { idempotencyKey: key }, include: withRelations });
    if (!found) return null;
    if (found.sessionId !== sessionId) throw new ConflictException('Idempotency-Key đã dùng cho phiên khác');
    return toOrderDto(found);
  }
}
