import type { RobotAdapter, RobotEvent, RobotStatus } from './adapter';
import { Emitter } from './emitter';

/**
 * Mức 1 – thủ công (mục 7.2): nhân viên chọn bàn trên màn hình robot, app chỉ ghi nhận
 * các bước bằng nút bấm trên màn hình điều phối.
 */
export class ManualAdapter implements RobotAdapter {
  readonly vendor = 'MANUAL';
  private readonly events = new Emitter();

  async denDiemLayMon(robotId: string, tripId: string) {
    this.events.emit({ robotId, tripId, type: 'AT_PICKUP' });
  }
  async giaoMon(robotId: string, trip: { tripId: string }) {
    this.events.emit({ robotId, tripId: trip.tripId, type: 'MOVING' });
  }
  async huyChuyen() {}
  async xacNhanDaNhan(robotId: string, tripId: string) {
    this.events.emit({ robotId, tripId, type: 'DELIVERED' });
    this.events.emit({ robotId, tripId, type: 'DONE' });
  }
  async diSac() {}
  async layTrangThai(robotId: string): Promise<RobotStatus> {
    return { robotId, online: true, battery: 100, location: '?', busy: false };
  }
  /** Nhân viên báo robot đã tới bàn. */
  report(robotId: string, tripId: string, type: RobotEvent['type']) {
    this.events.emit({ robotId, tripId, type });
  }
  onSuKien(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }
}
