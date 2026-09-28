import type { OrderItemStatus, RobotState, TableStatus, TripStage } from '@nhs/types';

export const TABLE_STATUS_LABEL: Record<TableStatus, string> = {
  AVAILABLE: 'Trống',
  DINING: 'Đang dùng',
  PAYMENT: 'Thanh toán',
  CLEANING: 'Cần dọn',
  RESERVED: 'Đặt trước',
};

export const TABLE_STATUS_STYLE: Record<TableStatus, string> = {
  AVAILABLE: 'bg-white border-stone-200 text-stone-700',
  DINING: 'bg-sen-50 border-sen-400 text-sen-700',
  PAYMENT: 'bg-amber-50 border-amber-400 text-amber-800',
  CLEANING: 'bg-sky-50 border-sky-300 text-sky-800',
  RESERVED: 'bg-violet-50 border-violet-300 text-violet-800',
};

export const ITEM_STATUS_LABEL: Record<OrderItemStatus, string> = {
  CONFIRMED: 'Đã gọi',
  SENT: 'Đang gửi bếp',
  KDS_ACK: 'Bếp đã nhận',
  FALLBACK: 'Chờ bếp xác nhận',
  PREPARING: 'Đang nấu',
  READY: 'Món đã xong',
  ASSIGNED: 'Chờ giao',
  PICKED_UP: 'Đang mang ra',
  DELIVERED: 'Đã phục vụ',
  CANCELLED: 'Đã hủy',
};

export const ITEM_STATUS_TONE: Record<OrderItemStatus, Tone> = {
  CONFIRMED: 'neutral',
  SENT: 'neutral',
  KDS_ACK: 'info',
  FALLBACK: 'warn',
  PREPARING: 'accent',
  READY: 'good',
  ASSIGNED: 'good',
  PICKED_UP: 'good',
  DELIVERED: 'muted',
  CANCELLED: 'muted',
};

export type Tone = 'neutral' | 'info' | 'warn' | 'accent' | 'good' | 'muted' | 'danger';

export const TAG_LABEL: Record<string, string> = { chay: 'Chay', cay: 'Cay', 'tre-em': 'Trẻ em', 'dac-biet': 'Đặc biệt' };

export const TRIP_STAGE_LABEL: Record<TripStage, string> = {
  CREATED: 'Mới tạo',
  ASSIGNED: 'Robot đang tới bếp',
  AT_PICKUP: 'Chờ đặt khay',
  MOVING: 'Đang giao',
  ARRIVED: 'Đã tới bàn',
  DELIVERED: 'Khách đã nhận',
  RETURNING: 'Đang quay về',
  DONE: 'Hoàn tất',
  FAILED: 'Lỗi',
  CANCELLED: 'Chuyển nhân viên',
};

export const ROBOT_STATE_LABEL: Record<RobotState, string> = {
  IDLE: 'Rảnh',
  BUSY: 'Đang giao',
  CHARGING: 'Đang sạc',
  ERROR: 'Lỗi',
  OFFLINE: 'Mất kết nối',
  DISABLED: 'Tạm ngưng',
};

export const ROBOT_STATE_TONE: Record<RobotState, Tone> = {
  IDLE: 'good',
  BUSY: 'accent',
  CHARGING: 'info',
  ERROR: 'danger',
  OFFLINE: 'danger',
  DISABLED: 'muted',
};
