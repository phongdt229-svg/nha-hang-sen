import { RobotCommandError, type RobotAdapter, type RobotEvent, type RobotStatus, type TripCommand } from './adapter';
import { Emitter } from './emitter';

/**
 * Các lệnh cần gọi tới OrionStar Robot OpenAPI (mục 7.3). Đường dẫn, tham số và cách ký
 * phụ thuộc tài liệu OpenAPI do OrionStar/nhà phân phối cấp kèm appid/secret, nên được tách
 * thành interface: khi có tài liệu chỉ cần hiện thực lớp này, không sửa bộ điều phối.
 */
export interface OrionStarClient {
  goToPosition(robotSn: string, positionName: string, taskId: string): Promise<void>;
  cancelMove(robotSn: string, taskId: string): Promise<void>;
  playTts(robotSn: string, text: string): Promise<void>;
  goCharge(robotSn: string): Promise<void>;
  getRobotStatus(robotSn: string): Promise<{ online: boolean; battery: number; position: string; busy: boolean }>;
}

/** Callback sự kiện tác vụ từ OrionStar sau khi đã chuẩn hóa ở webhook. */
export interface OrionStarCallback {
  robotSn: string;
  taskId: string;
  state: 'ARRIVED' | 'DELIVERED' | 'FAILED' | 'RETURNED';
  battery?: number;
  reason?: string;
}

/** LuckiBot Pro qua Cloud OpenAPI + webhook callback (mức tích hợp 2). */
export class OrionStarAdapter implements RobotAdapter {
  readonly vendor = 'ORIONSTAR';
  private readonly events = new Emitter();
  private readonly pickupPoint: string;

  constructor(
    private readonly client: OrionStarClient | null,
    opts: { pickupPoint?: string } = {},
  ) {
    this.pickupPoint = opts.pickupPoint ?? 'Bếp';
  }

  private api() {
    if (!this.client) throw new RobotCommandError('Chưa cấu hình OrionStar OpenAPI (cần appid/secret và tài liệu API từ nhà phân phối)');
    return this.client;
  }

  async denDiemLayMon(robotId: string, tripId: string) {
    await this.api().goToPosition(robotId, this.pickupPoint, `${tripId}-pickup`);
    // LuckiBot không báo "đã tới bếp" riêng trong mọi cấu hình; điều phối coi như đang chờ quét khay.
    this.events.emit({ robotId, tripId, type: 'AT_PICKUP' });
  }

  async giaoMon(robotId: string, trip: TripCommand) {
    const ban = `Bàn ${trip.banDich.replace(/\D/g, '').padStart(2, '0')}`;
    await this.api().goToPosition(robotId, ban, trip.tripId);
    this.events.emit({ robotId, tripId: trip.tripId, type: 'MOVING' });
  }

  async huyChuyen(robotId: string, tripId: string) {
    await this.api().cancelMove(robotId, tripId);
  }

  async xacNhanDaNhan(robotId: string, tripId: string) {
    this.events.emit({ robotId, tripId, type: 'DELIVERED' });
  }

  async diSac(robotId: string) {
    await this.api().goCharge(robotId);
  }

  async layTrangThai(robotId: string): Promise<RobotStatus> {
    const s = await this.api().getRobotStatus(robotId);
    return { robotId, online: s.online, battery: s.battery, location: s.position, busy: s.busy };
  }

  /** Gọi từ webhook /webhooks/robots/orionstar sau khi đã xác thực chữ ký. */
  handleCallback(cb: OrionStarCallback) {
    const map: Record<OrionStarCallback['state'], RobotEvent['type']> = { ARRIVED: 'ARRIVED', DELIVERED: 'DELIVERED', FAILED: 'FAILED', RETURNED: 'DONE' };
    this.events.emit({ robotId: cb.robotSn, tripId: cb.taskId.replace(/-pickup$/, ''), type: map[cb.state], battery: cb.battery, reason: cb.reason });
  }

  onSuKien(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }
}
