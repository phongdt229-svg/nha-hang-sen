/** Danh sách sự kiện chính (mục 6 tài liệu công nghệ). */
export const EVENT_TYPES = [
  'session.opened',
  'session.moved',
  'session.closed',
  'session.merged',
  'order.confirmed',
  'order.cancelled',
  'kitchen.sent',
  'kitchen.ack',
  'kitchen.fallback',
  'kitchen.preparing',
  'kitchen.ready',
  'order.delivered',
  'menu.soldout',
  'menu.available',
  'table.status',
  'bill.locked',
  'bill.unlocked',
  'bill.split',
  'bill.paid',
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'shift.closed',
  'business_day.closed',
  'stock.received',
  'stock.consumed',
  'stock.wasted',
  'stock.adjusted',
  'stock.low',
  'stock.expiring',
  'einvoice.requested',
  'einvoice.issued',
  'einvoice.failed',
  'einvoice.adjusted',
  'print.queued',
  'print.failed',
  'print.done',
  // Giao món bằng robot (RD-24)
  'delivery.task.created',
  'delivery.task.assigned',
  'delivery.task.ready_for_pickup',
  'delivery.task.picked_up',
  'delivery.robot.arrived',
  'delivery.customer.confirmed',
  'delivery.customer.timeout',
  'delivery.task.updated',
  'delivery.task.completed',
  'delivery.task.failed',
  'delivery.task.manual_takeover',
  'delivery.task.cancelled',
  'robot.status',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Sự kiện phát qua WebSocket; `seq` tăng dần để client bắt kịp bằng lastEventId. */
export interface DomainEvent<T = unknown> {
  seq: number;
  type: EventType;
  aggregate: string;
  aggregateId: string;
  data: T;
  createdAt: string;
}

/** Phòng WebSocket theo vai trò (mục 8). */
export const rooms = {
  table: (tableId: string) => `table:${tableId}`,
  session: (sessionId: string) => `session:${sessionId}`,
  kitchen: (station: string) => `kitchen:${station}`,
  pos: 'pos',
  dispatch: 'dispatch',
  dashboard: 'dashboard',
} as const;
