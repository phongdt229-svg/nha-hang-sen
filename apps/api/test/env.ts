/** Test chạy trên database và tiền tố hàng đợi riêng, không đụng dữ liệu dev. */
export const TEST_ENV = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://nhs:nhs@localhost:5432/nhs_test?schema=public',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  QUEUE_PREFIX: `nhs-test-${process.pid}`,
  JWT_SECRET: 'test-secret',
  KDS_ACK_TIMEOUT_MS: '150',
  KDS_MAX_RETRY: '3',
  RECONCILE_AFTER_MS: '0',
  SIM_SPEED: '0.03',
  DISPATCH_TICK_MS: '100',
  BATCH_WINDOW_MS: '1500',
  EINVOICE_RETRY_AFTER_MS: '0',
  EINVOICE_SWEEP_MS: '1000',
  PRINT_LEASE_MS: '400',
  // Giao món bằng robot (v0.7): nhịp, hẹn giờ ngắn để test chạy nhanh.
  ROBOT_HEARTBEAT_TIMEOUT_MS: '1200',
  CUSTOMER_WAIT_TIMEOUT_MS: '1500',
  DELIVERY_RECONCILE_DELAY_MS: '300',
  NAVIGATION_RETRY_DELAY_MS: '150',
  API_RETRY_DELAY_MS: '30',
  SIM_DRAIN_PER_SEGMENT: '0.01',
  SIM_CHARGE_PER_SECOND: '60',
};
