import { RobotCommandError, type GoToOptions, type RobotAdapter, type RobotEvent, type RobotStatus } from './adapter';
import { Emitter } from './emitter';

/**
 * Lệnh tới OrionStar (LB-04, LB-23). Đường dẫn, tham số, cách ký phụ thuộc tài liệu OpenAPI do
 * OrionStar/nhà phân phối cấp (LB-29) nên tách thành interface: khi có tài liệu chỉ hiện thực lớp này.
 */
export interface OrionStarClient {
  navigate(robotSn: string, positionName: string, vendorTaskId: string): Promise<void>;
  cancel(robotSn: string, vendorTaskId: string): Promise<void>;
  pause(robotSn: string): Promise<void>;
  resume(robotSn: string): Promise<void>;
  goHome(robotSn: string): Promise<void>;
  goCharge(robotSn: string): Promise<void>;
  getStatus(robotSn: string): Promise<{ online: boolean; battery: number; position: string | null; busy: boolean; vendorTaskId?: string | null }>;
}

/** Callback đã chuẩn hóa ở webhook /webhooks/robots/orionstar (sau khi kiểm tra chữ ký). */
export interface OrionStarCallback {
  robotSn: string;
  taskId: string;
  state: 'ACCEPTED' | 'ARRIVED' | 'OBSTACLE' | 'ERROR' | 'DELIVERED' | 'RETURNED';
  position?: string;
  battery?: number;
  reason?: string;
}

/** LuckiBot Pro (production, LB-03). Chưa nối thật: cần appid/secret + tài liệu OpenAPI. */
export class LuckiBotProAdapter implements RobotAdapter {
  readonly vendor = 'ORIONSTAR';
  private readonly events = new Emitter();
  /** Mã vị trí Nha Hang Sen → tên điểm trên bản đồ robot (LB-06), lấy từ robot_locations.vendor_mapping. */
  private positions: Record<string, string> = {};
  private readonly purposes = new Map<string, GoToOptions['purpose']>();

  constructor(private readonly client: OrionStarClient | null) {}

  setPositions(positions: Record<string, string>) {
    this.positions = positions;
  }

  private api() {
    if (!this.client) throw new RobotCommandError('Chưa cấu hình OrionStar OpenAPI (cần appid/secret và tài liệu API từ nhà phân phối)');
    return this.client;
  }

  async connect() {}
  async disconnect() {}

  async goTo(robotId: string, destination: string, opts: GoToOptions) {
    const position = this.positions[destination];
    if (!position) throw new RobotCommandError(`Chưa khớp vị trí ${destination} với bản đồ LuckiBot`);
    const vendorTaskId = `${opts.taskId ?? 'nhs'}-${opts.purpose}`;
    this.purposes.set(vendorTaskId, opts.purpose);
    await this.api().navigate(robotId, position, vendorTaskId);
  }
  stop(robotId: string) {
    return this.api().pause(robotId);
  }
  pause(robotId: string) {
    return this.api().pause(robotId);
  }
  resume(robotId: string) {
    return this.api().resume(robotId);
  }
  returnHome(robotId: string, opts: { charge?: boolean } = {}) {
    return opts.charge ? this.api().goCharge(robotId) : this.api().goHome(robotId);
  }
  cancelTask(robotId: string, taskId: string) {
    return this.api().cancel(robotId, taskId);
  }
  async getStatus(robotId: string): Promise<RobotStatus> {
    const s = await this.api().getStatus(robotId);
    return { robotId, online: s.online, battery: s.battery, batterySimulated: false, location: s.position, mode: s.busy ? 'MOVING' : 'IDLE', taskId: s.vendorTaskId?.replace(/-[A-Z]+$/, '') ?? null, target: null, error: null };
  }
  async getLocation(robotId: string) {
    return (await this.getStatus(robotId)).location;
  }
  async getBattery(robotId: string) {
    return (await this.getStatus(robotId)).battery;
  }

  /** Chuẩn hóa sự kiện của hãng về dạng chung (LB-24). */
  handleCallback(cb: OrionStarCallback) {
    const purpose = this.purposes.get(cb.taskId);
    const taskId = cb.taskId.replace(/-(PICKUP|DELIVERY|HOME|CHARGE)$/, '');
    const map: Record<OrionStarCallback['state'], RobotEvent['type']> = {
      ACCEPTED: 'ROBOT_TASK_ACCEPTED',
      ARRIVED: purpose === 'PICKUP' ? 'ROBOT_ARRIVED_PICKUP' : purpose === 'DELIVERY' ? 'ROBOT_ARRIVED_TABLE' : 'ROBOT_ARRIVED_HOME',
      OBSTACLE: 'ROBOT_OBSTACLE',
      ERROR: 'ROBOT_ERROR',
      DELIVERED: 'ROBOT_CUSTOMER_CONFIRMED',
      RETURNED: 'ROBOT_TASK_COMPLETED',
    };
    this.events.emit({ robotId: cb.robotSn, taskId, type: map[cb.state], battery: cb.battery, reason: cb.reason, location: cb.position });
  }

  onEvent(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }
}
