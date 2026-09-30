/**
 * Bảng chuyển trạng thái tập trung (mục 5 & 13.1 tài liệu công nghệ).
 * Mọi chuyển trạng thái không có trong bảng đều bị từ chối.
 */

export const TABLE_STATUSES = ['AVAILABLE', 'DINING', 'PAYMENT', 'CLEANING', 'RESERVED'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const ORDER_ITEM_STATUSES = [
  'CONFIRMED',
  'SENT',
  'KDS_ACK',
  'FALLBACK',
  'PREPARING',
  'READY',
  'ASSIGNED',
  'PICKED_UP',
  'DELIVERED',
  'CANCELLED',
] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const TICKET_STATUSES = ['SENT', 'ACKED', 'FALLBACK'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const BILL_STATUSES = ['OPEN', 'LOCKED', 'PAID', 'CLOSED', 'SPLIT', 'VOID'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const SESSION_STATUSES = ['OPEN', 'PAYMENT', 'CLOSED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Trạng thái Delivery Task (RD-02, RD-11, MB-11) — dùng chung cho mọi robot (mBot demo, LuckiBot Pro),
 * tách riêng khỏi trạng thái order.
 */
export const DELIVERY_STATUSES = [
  'PENDING',
  'ASSIGNING',
  'ASSIGNED',
  'ROBOT_ACCEPTED',
  'GOING_TO_PICKUP',
  'ARRIVED_PICKUP',
  'LOADING',
  'GOING_TO_TABLE',
  'ARRIVED_TABLE',
  'WAITING_CUSTOMER',
  'DELIVERED',
  'RETURNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'MANUAL_TAKEOVER',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Task còn giữ món và robot (chưa kết thúc, chưa giao xong). */
export const DELIVERY_ACTIVE: readonly DeliveryStatus[] = [
  'PENDING',
  'ASSIGNING',
  'ASSIGNED',
  'ROBOT_ACCEPTED',
  'GOING_TO_PICKUP',
  'ARRIVED_PICKUP',
  'LOADING',
  'GOING_TO_TABLE',
  'ARRIVED_TABLE',
  'WAITING_CUSTOMER',
  'FAILED',
];

/** Các bước robot đang thực hiện nhiệm vụ — được phép retry về lại sau khi FAILED. */
export const DELIVERY_RESUMABLE: readonly DeliveryStatus[] = [
  'ASSIGNED',
  'ROBOT_ACCEPTED',
  'GOING_TO_PICKUP',
  'ARRIVED_PICKUP',
  'LOADING',
  'GOING_TO_TABLE',
  'ARRIVED_TABLE',
  'WAITING_CUSTOMER',
];

type TransitionMap<S extends string> = Record<S, readonly S[]>;

export const TABLE_TRANSITIONS: TransitionMap<TableStatus> = {
  AVAILABLE: ['DINING', 'RESERVED'],
  RESERVED: ['DINING', 'AVAILABLE'],
  DINING: ['PAYMENT', 'CLEANING'],
  PAYMENT: ['CLEANING', 'DINING'],
  CLEANING: ['AVAILABLE'],
};

export const ORDER_ITEM_TRANSITIONS: TransitionMap<OrderItemStatus> = {
  CONFIRMED: ['SENT', 'CANCELLED'],
  SENT: ['KDS_ACK', 'FALLBACK', 'CANCELLED'],
  FALLBACK: ['KDS_ACK', 'CANCELLED'],
  KDS_ACK: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['ASSIGNED', 'DELIVERED'],
  ASSIGNED: ['PICKED_UP', 'READY'],
  PICKED_UP: ['DELIVERED', 'READY'],
  DELIVERED: [],
  CANCELLED: [],
};

export const BILL_TRANSITIONS: TransitionMap<BillStatus> = {
  OPEN: ['LOCKED', 'SPLIT', 'VOID'],
  LOCKED: ['OPEN', 'PAID', 'VOID'],
  PAID: ['CLOSED'],
  CLOSED: [],
  SPLIT: ['OPEN'],
  VOID: [],
};

const TAKEOVER = ['FAILED', 'CANCELLED', 'MANUAL_TAKEOVER'] as const;

/**
 * Delivery Task (RD-11). Nhánh lỗi: FAILED chờ nhân viên quyết định — retry (về lại bước đang dở),
 * reassign (về PENDING để giao robot khác), giao tay (MANUAL_TAKEOVER) hoặc hủy (CANCELLED).
 * ARRIVED_TABLE không được tự chuyển DELIVERED khi chưa có xác nhận (MB-14): chỉ đi qua WAITING_CUSTOMER.
 */
export const DELIVERY_TRANSITIONS: TransitionMap<DeliveryStatus> = {
  PENDING: ['ASSIGNING', 'ASSIGNED', 'CANCELLED', 'MANUAL_TAKEOVER'],
  ASSIGNING: ['ASSIGNED', 'PENDING', ...TAKEOVER],
  ASSIGNED: ['ROBOT_ACCEPTED', 'GOING_TO_PICKUP', 'ARRIVED_PICKUP', 'PENDING', ...TAKEOVER],
  ROBOT_ACCEPTED: ['GOING_TO_PICKUP', 'ARRIVED_PICKUP', ...TAKEOVER],
  GOING_TO_PICKUP: ['ARRIVED_PICKUP', ...TAKEOVER],
  ARRIVED_PICKUP: ['LOADING', 'GOING_TO_TABLE', ...TAKEOVER],
  LOADING: ['GOING_TO_TABLE', ...TAKEOVER],
  GOING_TO_TABLE: ['ARRIVED_TABLE', ...TAKEOVER],
  ARRIVED_TABLE: ['WAITING_CUSTOMER', 'FAILED', 'MANUAL_TAKEOVER'],
  WAITING_CUSTOMER: ['DELIVERED', 'FAILED', 'MANUAL_TAKEOVER'],
  DELIVERED: ['RETURNING', 'COMPLETED'],
  RETURNING: ['COMPLETED'],
  COMPLETED: [],
  FAILED: ['PENDING', ...DELIVERY_RESUMABLE, 'CANCELLED', 'MANUAL_TAKEOVER'],
  CANCELLED: [],
  MANUAL_TAKEOVER: [],
};

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return map[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Không thể chuyển ${entity} từ ${from} sang ${to}`);
  }
}

export function assertTransition<S extends string>(entity: string, map: TransitionMap<S>, from: S, to: S): void {
  if (!canTransition(map, from, to)) throw new InvalidTransitionError(entity, from, to);
}
