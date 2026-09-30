import { locationMap, RobotCommandError, type GoToOptions, type LocationMap, type RobotAdapter, type RobotEvent, type RobotMode, type RobotStatus, type SimFault, type Simulatable } from './adapter';
import { Emitter } from './emitter';

export interface SimOptions {
  /** Thời gian đi qua một đoạn giữa hai vạch dừng (ms). */
  segmentMs?: number;
  tickMs?: number;
  /** Nhịp trạng thái gửi về (ms) — Robot Gateway dùng để phát hiện mất kết nối. */
  heartbeatMs?: number;
  /** Pin tụt mỗi đoạn đường (%). */
  drainPerSegment?: number;
  /** Tốc độ sạc (% mỗi giây). */
  chargePerSecond?: number;
  /** Tự bấm "đã nhận" sau khoảng này khi tới bàn (0 = chờ khách/nhân viên). */
  autoConfirmMs?: number;
}

interface SimRobot {
  id: string;
  /** Vị trí trên vòng, đơn vị = vạch dừng (có phần lẻ khi đang giữa hai vạch). */
  pos: number;
  battery: number;
  online: boolean;
  mode: RobotMode;
  paused: boolean;
  taskId: string | null;
  target: number | null;
  purpose: GoToOptions['purpose'] | null;
  /** Robot đang đứng chờ ở bếp (đặt món) hay ở bàn (khách lấy món). */
  waitingAt: 'PICKUP' | 'TABLE' | null;
  /** Quãng đường (số đoạn) của lệnh hiện tại, để tính tiến độ. */
  leg: number;
  /** Vật cản kẹt hẳn: mọi lần đi tiếp đều bị chặn lại. */
  blocked: boolean;
  /** Số lệnh tiếp theo sẽ "quá thời gian" (-1 = mãi mãi). */
  apiFailures: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Robot giả lập chạy trong backend (MB-26 Phase 2): nhiều robot, pin, vật cản, mất kết nối, lỗi API.
 * Mô phỏng đúng sa bàn demo: một vòng chạy theo chiều kim đồng hồ, dừng ở các vạch.
 */
export class SimulatedAdapter implements RobotAdapter, Simulatable {
  readonly vendor = 'SIMULATED';
  private readonly robots = new Map<string, SimRobot>();
  private readonly events = new Emitter();
  private readonly o: Required<SimOptions>;
  private map: LocationMap = locationMap({ KITCHEN_PASS_01: 0, ROBOT_HOME: 0 });
  private hb: NodeJS.Timeout;

  constructor(opts: SimOptions = {}) {
    this.o = {
      segmentMs: opts.segmentMs ?? 1500,
      tickMs: opts.tickMs ?? 200,
      heartbeatMs: opts.heartbeatMs ?? 2000,
      drainPerSegment: opts.drainPerSegment ?? 0.5,
      chargePerSecond: opts.chargePerSecond ?? 5,
      autoConfirmMs: opts.autoConfirmMs ?? 0,
    };
    this.hb = setInterval(() => {
      for (const r of this.robots.values()) if (r.online) this.emit(r, { type: 'ROBOT_HEARTBEAT' });
    }, this.o.heartbeatMs);
    this.hb.unref?.();
  }

  setLocations(map: LocationMap) {
    this.map = map;
  }

  private emit(r: SimRobot, e: Omit<RobotEvent, 'at' | 'robotId' | 'battery' | 'batterySimulated'>) {
    if (!r.online) return;
    this.events.emit({ robotId: r.id, battery: Math.round(r.battery), batterySimulated: true, location: this.locationOf(r), ...e });
  }

  private locationOf(r: SimRobot): string | null {
    const stop = Math.round(r.pos) % this.map.stops;
    return Math.abs(r.pos - Math.round(r.pos)) < 1e-6 ? (this.map.codeAt(stop) ?? `STOP_${stop}`) : 'MOVING';
  }

  private get(robotId: string) {
    const r = this.robots.get(robotId);
    if (!r) throw new RobotCommandError(`Robot giả lập ${robotId} chưa kết nối`);
    return r;
  }

  /** Lệnh tới robot: mất kết nối hoặc đang giả lập lỗi API thì báo quá thời gian. */
  private command(robotId: string) {
    const r = this.get(robotId);
    if (!r.online) throw new RobotCommandError(`Robot ${robotId} mất kết nối`, true);
    if (r.apiFailures !== 0) {
      if (r.apiFailures > 0) r.apiFailures--;
      throw new RobotCommandError(`Robot ${robotId} không phản hồi lệnh (quá thời gian)`, true);
    }
    return r;
  }

  private halt(r: SimRobot) {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
  }

  async connect(robotId: string, opts: { battery?: number; location?: string | null } = {}) {
    if (this.robots.has(robotId)) return;
    const stop = opts.location ? this.map.stopOf(opts.location) : undefined;
    const r: SimRobot = {
      id: robotId,
      pos: stop ?? 0,
      battery: opts.battery ?? 100,
      online: true,
      mode: 'IDLE',
      paused: false,
      taskId: null,
      target: null,
      purpose: null,
      waitingAt: null,
      leg: 0,
      blocked: false,
      apiFailures: 0,
      timer: null,
    };
    this.robots.set(robotId, r);
    this.emit(r, { type: 'ROBOT_ONLINE' });
  }

  async disconnect(robotId: string) {
    const r = this.robots.get(robotId);
    if (r) this.halt(r);
    this.robots.delete(robotId);
  }

  async goTo(robotId: string, destination: string, opts: GoToOptions) {
    const r = this.command(robotId);
    const target = this.map.stopOf(destination);
    if (target === undefined) throw new RobotCommandError(`Robot giả lập không biết vị trí ${destination}`);
    this.halt(r);
    const newTask = r.taskId !== opts.taskId;
    r.taskId = opts.taskId;
    r.target = target;
    r.purpose = opts.purpose;
    r.paused = false;
    r.mode = 'MOVING';
    r.waitingAt = null;
    const stops = this.map.stops;
    r.leg = (target - (((r.pos % stops) + stops) % stops) + stops) % stops;
    if (newTask && opts.taskId) this.emit(r, { type: 'ROBOT_TASK_ACCEPTED', taskId: opts.taskId });
    this.step(r);
  }

  /** Đi tiếp một nhịp trên vòng chạy (một chiều, theo chiều kim đồng hồ). */
  private step(r: SimRobot) {
    if (r.target === null || r.paused || r.mode !== 'MOVING') return;
    const stops = this.map.stops;
    const here = ((r.pos % stops) + stops) % stops;
    let remaining = (r.target - here + stops) % stops;
    if (remaining < 1e-6) return this.arrive(r);
    if (r.blocked && remaining < stops) {
      // Vật cản kẹt hẳn: đi được một chút rồi bị chặn.
      r.mode = 'OBSTACLE';
      return this.emit(r, { type: 'ROBOT_OBSTACLE', taskId: r.taskId, target: this.map.codeAt(r.target), reason: 'Vật cản trên đường chạy' });
    }
    const delta = Math.min(remaining, this.o.tickMs / this.o.segmentMs);
    const before = Math.floor(r.pos + 1e-9);
    r.pos = (r.pos + delta) % stops;
    if (Math.floor(r.pos + 1e-9) !== before || remaining - delta < 1e-6) r.battery = Math.max(0, r.battery - this.o.drainPerSegment);
    remaining -= delta;
    this.emit(r, { type: 'ROBOT_LOCATION_CHANGED', taskId: r.taskId, target: this.map.codeAt(r.target), progress: r.leg > 0 ? Math.min(1, 1 - remaining / r.leg) : 1 });
    if (remaining < 1e-6) {
      r.pos = r.target;
      return this.arrive(r);
    }
    r.timer = setTimeout(() => this.step(r), this.o.tickMs);
  }

  private arrive(r: SimRobot) {
    const location = this.map.codeAt(r.target!) ?? null;
    const taskId = r.taskId;
    this.halt(r);
    switch (r.purpose) {
      case 'PICKUP':
        r.mode = 'WAITING';
        r.waitingAt = 'PICKUP';
        this.emit(r, { type: 'ROBOT_ARRIVED_PICKUP', taskId, location });
        break;
      case 'DELIVERY':
        r.mode = 'WAITING';
        r.waitingAt = 'TABLE';
        this.emit(r, { type: 'ROBOT_ARRIVED_TABLE', taskId, location });
        if (this.o.autoConfirmMs > 0) r.timer = setTimeout(() => this.emit(r, { type: 'ROBOT_CUSTOMER_CONFIRMED', taskId }), this.o.autoConfirmMs);
        break;
      case 'HOME':
        r.mode = 'IDLE';
        r.taskId = null;
        this.emit(r, { type: 'ROBOT_ARRIVED_HOME', taskId, location });
        if (taskId) this.emit(r, { type: 'ROBOT_TASK_COMPLETED', taskId, location });
        break;
      case 'CHARGE':
        r.mode = 'CHARGING';
        r.taskId = null;
        this.emit(r, { type: 'ROBOT_ARRIVED_CHARGER', taskId, location });
        if (taskId) this.emit(r, { type: 'ROBOT_TASK_COMPLETED', taskId, location });
        this.charge(r);
        break;
    }
    r.target = null;
    r.purpose = null;
  }

  private charge(r: SimRobot) {
    if (r.mode !== 'CHARGING') return;
    r.battery = Math.min(100, r.battery + this.o.chargePerSecond);
    this.emit(r, { type: 'ROBOT_BATTERY_CHANGED' });
    if (r.battery >= 100) r.mode = 'IDLE';
    else r.timer = setTimeout(() => this.charge(r), 1000);
  }

  async stop(robotId: string) {
    const r = this.command(robotId);
    this.halt(r);
    r.mode = 'STOPPED';
  }

  async pause(robotId: string) {
    const r = this.command(robotId);
    this.halt(r);
    r.paused = true;
  }

  async resume(robotId: string) {
    const r = this.command(robotId);
    if (r.blocked) {
      r.mode = 'OBSTACLE';
      return this.emit(r, { type: 'ROBOT_OBSTACLE', taskId: r.taskId, reason: 'Vẫn còn vật cản' });
    }
    r.paused = false;
    if (r.target !== null) {
      r.mode = 'MOVING';
      this.step(r);
    }
  }

  async returnHome(robotId: string, opts: { taskId?: string | null; charge?: boolean } = {}) {
    const dest = opts.charge ? 'CHARGER_01' : 'ROBOT_HOME';
    await this.goTo(robotId, dest, { taskId: opts.taskId ?? this.get(robotId).taskId, purpose: opts.charge ? 'CHARGE' : 'HOME' });
  }

  async cancelTask(robotId: string, taskId: string) {
    const r = this.command(robotId);
    if (r.taskId !== taskId) return;
    this.halt(r);
    r.taskId = null;
    r.target = null;
    r.purpose = null;
    r.waitingAt = null;
    r.mode = 'IDLE';
  }

  async getStatus(robotId: string): Promise<RobotStatus> {
    const r = this.robots.get(robotId);
    if (!r || !r.online) return { robotId, online: false, battery: r ? Math.round(r.battery) : 0, batterySimulated: true, location: r ? this.locationOf(r) : null, mode: 'IDLE', taskId: null, target: null, error: 'Mất kết nối' };
    return {
      robotId,
      online: true,
      battery: Math.round(r.battery),
      batterySimulated: true,
      location: this.locationOf(r),
      mode: r.paused ? 'PAUSED' : r.mode,
      taskId: r.taskId,
      target: r.target === null ? null : (this.map.codeAt(r.target) ?? null),
      error: r.mode === 'OBSTACLE' ? 'Vật cản' : null,
    };
  }

  async getLocation(robotId: string) {
    return (await this.getStatus(robotId)).location;
  }

  async getBattery(robotId: string) {
    return (await this.getStatus(robotId)).battery;
  }

  onEvent(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }

  /** Lỗi giả lập (MB-16) để diễn tập retry, reassign, manual takeover. */
  async simulate(robotId: string, fault: SimFault) {
    const r = this.get(robotId);
    switch (fault) {
      case 'OBSTACLE':
      case 'OBSTACLE_PERSISTENT':
        r.blocked = fault === 'OBSTACLE_PERSISTENT';
        if (r.mode === 'MOVING') {
          this.halt(r);
          r.mode = 'OBSTACLE';
          this.emit(r, { type: 'ROBOT_OBSTACLE', taskId: r.taskId, reason: 'Vật cản trên đường chạy (giả lập)' });
        }
        break;
      case 'OFFLINE':
        this.halt(r);
        r.online = false;
        break;
      case 'LOW_BATTERY':
        r.battery = 12;
        this.emit(r, { type: 'ROBOT_BATTERY_CHANGED' });
        break;
      case 'API_TIMEOUT':
        r.apiFailures = 1;
        break;
      case 'API_TIMEOUT_PERSISTENT':
        r.apiFailures = -1;
        break;
      case 'BUTTON':
        if (r.mode === 'WAITING' && r.waitingAt === 'TABLE' && r.taskId) this.emit(r, { type: 'ROBOT_CUSTOMER_CONFIRMED', taskId: r.taskId });
        break;
      case 'RECOVER': {
        const wasOffline = !r.online;
        r.online = true;
        r.blocked = false;
        r.apiFailures = 0;
        if (r.mode === 'OBSTACLE') this.emit(r, { type: 'ROBOT_OBSTACLE_CLEARED', taskId: r.taskId });
        if (wasOffline) this.emit(r, { type: 'ROBOT_ONLINE' });
        break;
      }
    }
  }

  async close() {
    clearInterval(this.hb);
    for (const r of this.robots.values()) this.halt(r);
  }
}
