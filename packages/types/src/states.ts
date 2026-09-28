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

export const TRIP_STAGES = ['CREATED', 'ASSIGNED', 'AT_PICKUP', 'MOVING', 'ARRIVED', 'DELIVERED', 'RETURNING', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type TripStage = (typeof TRIP_STAGES)[number];

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

/** Chuyến giao robot (mục 5.3). */
export const TRIP_TRANSITIONS: TransitionMap<TripStage> = {
  CREATED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['AT_PICKUP', 'MOVING', 'FAILED', 'CANCELLED'],
  AT_PICKUP: ['MOVING', 'FAILED', 'CANCELLED'],
  MOVING: ['ARRIVED', 'FAILED', 'CANCELLED'],
  ARRIVED: ['DELIVERED', 'FAILED', 'CANCELLED'],
  DELIVERED: ['RETURNING', 'DONE'],
  RETURNING: ['DONE'],
  DONE: [],
  FAILED: [],
  CANCELLED: [],
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
