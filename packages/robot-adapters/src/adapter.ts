/**
 * Robot Adapter (MB-03, RD-25): Delivery Service không gọi trực tiếp mBot hay OrionStar.
 * Mỗi loại robot có một adapter theo cùng hợp đồng này; đổi mBot v1 → LuckiBot Pro chỉ đổi adapter,
 * không đụng tới order, KDS, bàn, thanh toán, báo cáo (MB-25).
 *
 * Điểm đến là **mã vị trí trừu tượng** (robot_locations: KITCHEN_PASS_01, TABLE_T01, ROBOT_HOME,
 * CHARGER_01); adapter tự dịch sang cách riêng của robot (số vạch dừng trên sa bàn, tên điểm trên bản đồ hãng…).
 */

/** Mục đích của lệnh di chuyển — quyết định sự kiện chuẩn khi robot tới nơi. */
export type GoToPurpose = 'PICKUP' | 'DELIVERY' | 'HOME' | 'CHARGE';

export interface GoToOptions {
  /** Mã delivery task (để đối chiếu sự kiện tới trễ / lệnh cũ). */
  taskId: string | null;
  purpose: GoToPurpose;
  /** Chữ hiện trên màn hình robot nếu có (LuckiBot). */
  display?: string;
}

export type RobotMode = 'IDLE' | 'MOVING' | 'PAUSED' | 'WAITING' | 'OBSTACLE' | 'CHARGING' | 'STOPPED';

export interface RobotStatus {
  robotId: string;
  online: boolean;
  battery: number;
  /** Pin không đo được từ phần cứng, phần mềm tự giả lập (MB-15: SIMULATED_TELEMETRY). */
  batterySimulated: boolean;
  /** Mã vị trí gần nhất robot đang đứng/vừa đi qua; null khi chưa biết. */
  location: string | null;
  mode: RobotMode;
  taskId: string | null;
  /** Nơi robot đang đi tới. */
  target: string | null;
  error: string | null;
}

/** Sự kiện chuẩn hóa từ mọi loại robot (LB-24). */
export type RobotEventType =
  | 'ROBOT_ONLINE'
  | 'ROBOT_OFFLINE'
  /** Nhịp trạng thái định kỳ (để phát hiện mất kết nối). */
  | 'ROBOT_HEARTBEAT'
  | 'ROBOT_LOCATION_CHANGED'
  | 'ROBOT_BATTERY_CHANGED'
  | 'ROBOT_TASK_ACCEPTED'
  | 'ROBOT_ARRIVED_PICKUP'
  | 'ROBOT_ARRIVED_TABLE'
  | 'ROBOT_ARRIVED_HOME'
  | 'ROBOT_ARRIVED_CHARGER'
  | 'ROBOT_OBSTACLE'
  | 'ROBOT_OBSTACLE_CLEARED'
  | 'ROBOT_ERROR'
  | 'ROBOT_TASK_COMPLETED'
  /** Khách bấm nút "đã nhận" ngay trên robot (nút trên mBot, màn hình LuckiBot). */
  | 'ROBOT_CUSTOMER_CONFIRMED';

export interface RobotEvent {
  robotId: string;
  type: RobotEventType;
  taskId?: string | null;
  location?: string | null;
  target?: string | null;
  battery?: number;
  batterySimulated?: boolean;
  /** Tiến độ quãng đường đang đi 0..1 (vẽ trên sa bàn). */
  progress?: number;
  reason?: string;
  at: number;
}

export interface RobotAdapter {
  readonly vendor: string;
  /** Bắt đầu theo dõi robot (đăng ký robot giả lập, mở kết nối…). */
  connect(robotId: string, opts?: { battery?: number; location?: string | null }): Promise<void>;
  disconnect(robotId: string): Promise<void>;
  getStatus(robotId: string): Promise<RobotStatus>;
  getLocation(robotId: string): Promise<string | null>;
  getBattery(robotId: string): Promise<number>;
  goTo(robotId: string, destination: string, opts: GoToOptions): Promise<void>;
  /** Dừng khẩn cấp: robot đứng yên, task chờ nhân viên quyết định. */
  stop(robotId: string): Promise<void>;
  pause(robotId: string): Promise<void>;
  resume(robotId: string): Promise<void>;
  returnHome(robotId: string, opts?: { taskId?: string | null; charge?: boolean }): Promise<void>;
  cancelTask(robotId: string, taskId: string): Promise<void>;
  onEvent(handler: (e: RobotEvent) => void): void;
  /** Nạp bảng vị trí ↔ vạch dừng cho robot chạy theo vạch (giả lập, mBot). */
  setLocations?(map: LocationMap): void;
  close?(): Promise<void>;
}

/**
 * Lỗi giả lập có chủ đích cho demo (MB-16): [SIMULATE OBSTACLE] [SIMULATE OFFLINE]
 * [SIMULATE LOW BATTERY] [SIMULATE API TIMEOUT]; BUTTON = khách bấm nút trên robot.
 */
export type SimFault = 'OBSTACLE' | 'OBSTACLE_PERSISTENT' | 'OFFLINE' | 'LOW_BATTERY' | 'API_TIMEOUT' | 'API_TIMEOUT_PERSISTENT' | 'BUTTON' | 'RECOVER';

export interface Simulatable {
  simulate(robotId: string, fault: SimFault): Promise<void>;
}

export function isSimulatable(a: RobotAdapter): a is RobotAdapter & Simulatable {
  return typeof (a as Partial<Simulatable>).simulate === 'function';
}

/** Lệnh không tới được robot / robot từ chối: Robot Gateway sẽ thử lại (max_api_retry). */
export class RobotCommandError extends Error {
  constructor(
    message: string,
    readonly timeout = false,
  ) {
    super(message);
    this.name = 'RobotCommandError';
  }
}

/**
 * Tra mã vị trí ↔ cách gọi riêng của một loại robot (MB-06), lấy từ robot_locations.vendor_mapping.
 * Ví dụ mBot trên sa bàn: KITCHEN_PASS_01 → vạch 0, TABLE_T01 → vạch 1, CHARGER_01 → vạch 5.
 */
export interface LocationMap {
  stopOf(code: string): number | undefined;
  codeAt(stop: number): string | undefined;
  /** Số vạch dừng trên vòng chạy (vạch 0 = bếp/vị trí gốc). */
  readonly stops: number;
}

export function locationMap(entries: Record<string, number>, prefer: string[] = []): LocationMap {
  const byStop = new Map<number, string>();
  // Nhiều mã chung một vạch (bếp = vị trí gốc): ưu tiên mã trong `prefer` khi dịch ngược.
  for (const [code, stop] of Object.entries(entries)) if (!byStop.has(stop) || prefer.includes(code)) byStop.set(stop, code);
  const stops = Math.max(0, ...Object.values(entries)) + 1;
  return {
    stopOf: (code) => entries[code],
    codeAt: (stop) => byStop.get(stop),
    stops,
  };
}
