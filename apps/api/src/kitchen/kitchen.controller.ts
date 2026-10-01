import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { assertTransition, ORDER_ITEM_TRANSITIONS, type EventType } from '@nhs/types';
import { z } from 'zod';
import { Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { EventsService } from '../events/events.service';
import { toOrderItemDto } from '../orders/order.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { currentTables } from '../sessions/session.helpers';
import { KitchenService } from './kitchen.service';
import { InventoryService } from '../inventory/inventory.service';

const StatusSchema = z.object({ status: z.enum(['PREPARING', 'READY', 'DELIVERED']) });

const EVENT_BY_STATUS: Record<z.infer<typeof StatusSchema>['status'], EventType> = {
  PREPARING: 'kitchen.preparing',
  READY: 'kitchen.ready',
  DELIVERED: 'order.delivered',
};

@Controller()
export class KitchenController {
  constructor(
    private readonly kitchen: KitchenService,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly inventory: InventoryService,
  ) {}

  @Allow('KDS', 'KITCHEN', 'MANAGER', 'CASHIER', 'WAITER')
  @Get('kitchen/tickets')
  tickets(@CurrentPrincipal() p: Principal, @Query('station') station?: string) {
    const s = p.kind === 'device' ? p.station : station;
    if (!s) throw new BadRequestException('Thiếu trạm bếp');
    return this.kitchen.activeTickets(s);
  }

  @Allow('MANAGER', 'CASHIER', 'WAITER')
  @Get('kitchen/fallback')
  fallback() {
    return this.kitchen.fallbackTickets();
  }

  @Allow('KDS', 'KITCHEN', 'MANAGER')
  @Post('kitchen/tickets/:id/ack')
  ack(@Param('id', ParseUUIDPipe) id: string) {
    return this.kitchen.ack(id);
  }

  /** Bếp cập nhật Đang nấu / Xong; phục vụ báo đã đưa món tới bàn. */
  @Allow('KDS', 'KITCHEN', 'MANAGER', 'WAITER')
  @Patch('order-items/:id/status')
  async status(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(StatusSchema)) body: z.infer<typeof StatusSchema>,
    @CurrentPrincipal() principal: Principal,
  ) {
    const item = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM order_items WHERE id = ${id} FOR UPDATE`;
      if (!row) throw new BadRequestException('Không tìm thấy món');
      const before = await tx.orderItem.findUniqueOrThrow({ where: { id }, include: { order: true } });
      if (before.status === body.status) return before;
      assertTransition('món', ORDER_ITEM_TRANSITIONS, before.status, body.status);

      // Sprint 2: Auto-deduct stock when transitioning to PREPARING
      if (body.status === 'PREPARING' && before.status !== 'PREPARING') {
        try {
          await this.inventory.deductStockForPreparation(tx, {
            menuItemId: before.menuItemId,
            qty: before.qty,
            orderItemId: id,
            createdBy: principal.userId || 'system',
          });

          // Recompute menu availability for all ingredients used
          const menuItem = await tx.menuItem.findUniqueOrThrow({ where: { id: before.menuItemId } });
          const recipeLines = await tx.recipeLine.findMany({
            where: { menuItemId: before.menuItemId },
          });
          for (const line of recipeLines) {
            await this.inventory.recomputeMenuAvailability(tx, line.ingredientId);
          }
        } catch (err) {
          throw new BadRequestException(`Insufficient stock: ${err.message}`);
        }
      }

      const item = await tx.orderItem.update({ where: { id }, data: { status: body.status, readyAt: body.status === 'READY' ? new Date() : undefined } });
      const tables = await currentTables(tx, before.order.sessionId);
      await this.events.append(tx, EVENT_BY_STATUS[body.status], 'order_item', id, {
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
}
