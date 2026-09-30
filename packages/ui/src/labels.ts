import type { DeliveryProblem, DeliveryStatus, OrderItemStatus, RobotState, TableStatus } from '@nhs/types';

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

/** Trạng thái Delivery Task (RD-11) cho nhân viên đọc. */
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  PENDING: 'Chờ robot',
  ASSIGNING: 'Đang gán robot',
  ASSIGNED: 'Đã gán robot',
  ROBOT_ACCEPTED: 'Robot nhận việc',
  GOING_TO_PICKUP: 'Robot tới bếp',
  ARRIVED_PICKUP: 'Chờ đặt món lên robot',
  LOADING: 'Đã đặt món',
  GOING_TO_TABLE: 'Đang giao',
  ARRIVED_TABLE: 'Đã tới bàn',
  WAITING_CUSTOMER: 'Chờ khách nhận',
  DELIVERED: 'Khách đã nhận',
  RETURNING: 'Robot quay về',
  COMPLETED: 'Hoàn tất',
  FAILED: 'Lỗi – cần xử lý',
  CANCELLED: 'Đã hủy',
  MANUAL_TAKEOVER: 'Nhân viên giao',
};

export const DELIVERY_STATUS_TONE: Record<DeliveryStatus, Tone> = {
  PENDING: 'neutral',
  ASSIGNING: 'neutral',
  ASSIGNED: 'info',
  ROBOT_ACCEPTED: 'info',
  GOING_TO_PICKUP: 'info',
  ARRIVED_PICKUP: 'warn',
  LOADING: 'accent',
  GOING_TO_TABLE: 'accent',
  ARRIVED_TABLE: 'good',
  WAITING_CUSTOMER: 'good',
  DELIVERED: 'good',
  RETURNING: 'muted',
  COMPLETED: 'muted',
  FAILED: 'danger',
  CANCELLED: 'muted',
  MANUAL_TAKEOVER: 'muted',
};

export const DELIVERY_PROBLEM_LABEL: Record<DeliveryProblem, string> = {
  OBSTACLE: 'Vật cản',
  OFFLINE: 'Robot mất kết nối',
  LOW_BATTERY: 'Pin yếu',
  API_TIMEOUT: 'Robot không nhận lệnh',
  CUSTOMER_ABSENT: 'Khách chưa nhận',
  RESTART: 'Máy chủ khởi động lại',
  STOPPED: 'Dừng khẩn cấp',
  ROBOT_ERROR: 'Robot báo lỗi',
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
