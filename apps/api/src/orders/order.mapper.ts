import type { KitchenTicket, Order, OrderItem } from '@prisma/client';
import type { OrderDto, OrderItemDto } from '@nhs/types';

export const orderNumber = (n: number) => `#${String(n).padStart(3, '0')}`;

export function toOrderItemDto(i: OrderItem): OrderItemDto {
  return { id: i.id, menuItemId: i.menuItemId, name: i.name, qty: i.qty, note: i.note, unitPrice: i.unitPrice, status: i.status, station: i.station };
}

export function toOrderDto(o: Order & { items: OrderItem[]; tickets: KitchenTicket[] }): OrderDto {
  return {
    id: o.id,
    number: orderNumber(o.number),
    sessionId: o.sessionId,
    source: o.source,
    total: o.total,
    createdAt: o.createdAt.toISOString(),
    // Tablet chỉ hiện "Bếp đã nhận" khi mọi phiếu của order đã được ACK (mục 6.3).
    kitchenAcked: o.tickets.length > 0 && o.tickets.every((t) => t.status === 'ACKED'),
    items: o.items.map(toOrderItemDto),
  };
}
