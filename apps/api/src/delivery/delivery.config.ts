const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' ? v : fallback;
};

export type BatchPolicy = 'IMMEDIATE' | 'BATCH_BY_TABLE' | 'WAIT_X_SECONDS';

/**
 * Cấu hình giao món bằng robot (RD-04, RD-18, MB-15): không hard-code ngưỡng trong code nghiệp vụ.
 * Đọc lại mỗi lần dùng để test/đổi cấu hình không cần khởi động lại.
 */
export const deliveryConfig = () => ({
  tickMs: num('DISPATCH_TICK_MS', 2000),
  /** IMMEDIATE: món xong là giao; BATCH_BY_TABLE: chờ cả bàn xong; WAIT_X_SECONDS: chờ tối đa batchWindowMs để gom. */
  batchPolicy: (['IMMEDIATE', 'BATCH_BY_TABLE', 'WAIT_X_SECONDS'].includes(process.env.DELIVERY_BATCH_POLICY ?? '') ? process.env.DELIVERY_BATCH_POLICY : 'WAIT_X_SECONDS') as BatchPolicy,
  batchWindowMs: num('BATCH_WINDOW_MS', 20_000),
  maxTaskItems: num('MAX_TASK_ITEMS', 6),
  /** Pin tối thiểu để nhận task mới (MB-15: 30%). */
  batteryAccept: num('ROBOT_BATTERY_ACCEPT', 30),
  /** Pin nguy hiểm: đang giao cũng phải về, chuyển nhân viên (MB-15: 15%). */
  batteryCritical: num('ROBOT_BATTERY_CRITICAL', 15),
  /** Không nghe robot quá lâu → OFFLINE (RD-16 heartbeat timeout). */
  heartbeatTimeoutMs: num('ROBOT_HEARTBEAT_TIMEOUT_MS', 10_000),
  /** Robot đứng chờ ở bàn quá lâu mà khách chưa xác nhận → báo nhân viên (RD-14: 60 giây). */
  customerWaitMs: num('CUSTOMER_WAIT_TIMEOUT_MS', 60_000),
  /** RD-18 retry policy. */
  maxAssignRetry: num('MAX_ROBOT_ASSIGNMENT_RETRY', 3),
  maxNavRetry: num('MAX_NAVIGATION_RETRY', 2),
  maxApiRetry: num('MAX_API_RETRY', 3),
  navRetryDelayMs: num('NAVIGATION_RETRY_DELAY_MS', 3000),
  apiRetryDelayMs: num('API_RETRY_DELAY_MS', 500),
  /** Sau khi server khởi động lại, chờ robot báo trạng thái rồi mới đối chiếu task dở dang (MB-21 Scenario 6). */
  reconcileDelayMs: num('DELIVERY_RECONCILE_DELAY_MS', 3000),
  pickupLocation: process.env.ROBOT_PICKUP_LOCATION ?? 'KITCHEN_PASS_01',
});

export const tableLocation = (tableCode: string) => `TABLE_${tableCode}`;
