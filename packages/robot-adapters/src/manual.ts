import type { GoToOptions, RobotAdapter, RobotEvent, RobotStatus } from './adapter';
import { Emitter } from './emitter';

/**
 * Robot điều khiển tay (mục 7.2 mức 1): nhân viên chọn bàn trên màn hình robot; hệ thống chỉ
 * ghi nhận các bước khi nhân viên bấm báo trên màn hình điều phối.
 */
export class ManualAdapter implements RobotAdapter {
  readonly vendor = 'MANUAL';
  private readonly events = new Emitter();
  private readonly current = new Map<string, { taskId: string | null; target: string; purpose: GoToOptions['purpose'] }>();

  async connect(robotId: string) {
    this.events.emit({ robotId, type: 'ROBOT_ONLINE', battery: 100, batterySimulated: true });
  }
  async disconnect() {}
  async goTo(robotId: string, destination: string, opts: GoToOptions) {
    const prev = this.current.get(robotId);
    this.current.set(robotId, { taskId: opts.taskId, target: destination, purpose: opts.purpose });
    if (opts.taskId && prev?.taskId !== opts.taskId) this.events.emit({ robotId, type: 'ROBOT_TASK_ACCEPTED', taskId: opts.taskId });
  }
  async stop() {}
  async pause() {}
  async resume() {}
  async returnHome(robotId: string, opts: { taskId?: string | null } = {}) {
    this.current.delete(robotId);
    this.events.emit({ robotId, type: 'ROBOT_ARRIVED_HOME', taskId: opts.taskId ?? null, location: 'ROBOT_HOME' });
    if (opts.taskId) this.events.emit({ robotId, type: 'ROBOT_TASK_COMPLETED', taskId: opts.taskId, location: 'ROBOT_HOME' });
  }
  async cancelTask(robotId: string) {
    this.current.delete(robotId);
  }
  async getStatus(robotId: string): Promise<RobotStatus> {
    const c = this.current.get(robotId);
    return { robotId, online: true, battery: 100, batterySimulated: true, location: null, mode: c ? 'MOVING' : 'IDLE', taskId: c?.taskId ?? null, target: c?.target ?? null, error: null };
  }
  async getLocation() {
    return null;
  }
  async getBattery() {
    return 100;
  }
  /** Nhân viên báo robot đã tới điểm đang đi tới. */
  reportArrived(robotId: string) {
    const c = this.current.get(robotId);
    if (!c) return false;
    const type: RobotEvent['type'] = c.purpose === 'PICKUP' ? 'ROBOT_ARRIVED_PICKUP' : c.purpose === 'DELIVERY' ? 'ROBOT_ARRIVED_TABLE' : 'ROBOT_ARRIVED_HOME';
    this.events.emit({ robotId, type, taskId: c.taskId, location: c.target });
    return true;
  }
  onEvent(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }
}
