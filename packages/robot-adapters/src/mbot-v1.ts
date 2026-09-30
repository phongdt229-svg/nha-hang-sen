import { locationMap, RobotCommandError, type GoToOptions, type LocationMap, type RobotAdapter, type RobotEvent, type RobotMode, type RobotStatus, type SimFault, type Simulatable } from './adapter';
import { Emitter } from './emitter';

/**
 * Giao thức giữa MbotV1Adapter và tầng giao tiếp mBot (MB-19). Adapter chỉ biết "vạch dừng" trên
 * sa bàn; USB/Bluetooth/serial do robot bridge đảm nhiệm, không lọt vào Delivery Service.
 */
export type MbotCommand =
  | { id: string; cmd: 'GOTO'; stop: number; taskId: string | null; purpose: GoToOptions['purpose'] }
  | { id: string; cmd: 'STOP' | 'PAUSE' | 'RESUME' | 'PING' }
  | { id: string; cmd: 'CANCEL'; taskId: string }
  /** Lỗi giả lập (MB-16) — bridge tự mô phỏng, không cần firmware hỗ trợ. */
  | { id: string; cmd: 'SIM'; fault: SimFault };

export type MbotMessage =
  /** Robot (qua bridge) xác nhận đã nhận lệnh; không có ack trong thời hạn = lỗi API timeout. */
  | { type: 'ack'; id: string; ok: boolean; error?: string }
  | { type: 'event'; ev: 'ARRIVED'; stop: number; taskId: string | null; purpose: GoToOptions['purpose'] | null }
  | { type: 'event'; ev: 'OBSTACLE' | 'CLEAR' | 'BUTTON' | 'ERROR' | 'PASSED'; stop?: number; reason?: string; taskId?: string | null }
  | {
      type: 'status';
      online: boolean;
      /** Vạch gần nhất robot đã qua/đang đứng. */
      stop: number | null;
      mode: RobotMode;
      battery: number;
      batterySimulated: boolean;
      taskId: string | null;
      target: number | null;
      /** Tiến độ giữa vạch hiện tại và vạch đích 0..1 nếu firmware ước lượng được. */
      progress?: number;
      firmware?: string;
    };

/** Kênh truyền lệnh/sự kiện với một hoặc nhiều mBot (MQTT tới robot bridge, hoặc bộ nhớ khi test). */
export interface MbotLink {
  send(robotId: string, cmd: MbotCommand): Promise<void>;
  onMessage(handler: (robotId: string, msg: MbotMessage) => void): void;
  close?(): Promise<void>;
}

export interface MbotV1Options {
  /** Chờ ack của robot tối đa (ms) trước khi coi là API timeout (RD-18 max_api_retry). */
  ackTimeoutMs?: number;
}

interface MbotState {
  status: Extract<MbotMessage, { type: 'status' }> | null;
  seenAt: number;
}

let seq = 0;
const nextId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * mBot v1 (Makeblock mCore) chạy dò line trên sa bàn demo (MB-04, MB-05): đích đến là số vạch dừng.
 * Không chứa business rule về order — chỉ dịch lệnh và sự kiện.
 */
export class MbotV1Adapter implements RobotAdapter, Simulatable {
  readonly vendor = 'MAKEBLOCK';
  private readonly events = new Emitter();
  private readonly robots = new Map<string, MbotState>();
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private map: LocationMap = locationMap({ KITCHEN_PASS_01: 0, ROBOT_HOME: 0 });
  private readonly ackTimeoutMs: number;

  constructor(
    private readonly link: MbotLink,
    opts: MbotV1Options = {},
  ) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 3000;
    link.onMessage((robotId, msg) => this.onMessage(robotId, msg));
  }

  setLocations(map: LocationMap) {
    this.map = map;
  }

  private code(stop: number | null | undefined) {
    return stop === null || stop === undefined ? null : (this.map.codeAt(stop) ?? `STOP_${stop}`);
  }

  private onMessage(robotId: string, msg: MbotMessage) {
    if (msg.type === 'ack') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve();
      else p.reject(new RobotCommandError(msg.error ?? 'mBot từ chối lệnh'));
      return;
    }
    const st = this.robots.get(robotId) ?? { status: null, seenAt: 0 };
    this.robots.set(robotId, st);
    const base = { robotId, battery: st.status?.battery, batterySimulated: st.status?.batterySimulated };

    if (msg.type === 'status') {
      const wasOnline = st.status?.online ?? false;
      st.status = msg;
      st.seenAt = Date.now();
      const location = msg.mode === 'MOVING' ? 'MOVING' : this.code(msg.stop);
      if (!msg.online) {
        if (wasOnline) this.events.emit({ robotId, type: 'ROBOT_OFFLINE', reason: 'Robot bridge báo mất kết nối' });
        return;
      }
      if (!wasOnline) this.events.emit({ robotId, type: 'ROBOT_ONLINE', battery: msg.battery, batterySimulated: msg.batterySimulated, location });
      this.events.emit({
        robotId,
        type: msg.mode === 'MOVING' && msg.target !== null ? 'ROBOT_LOCATION_CHANGED' : 'ROBOT_HEARTBEAT',
        battery: msg.battery,
        batterySimulated: msg.batterySimulated,
        location,
        taskId: msg.taskId,
        target: this.code(msg.target),
        progress: msg.progress,
      });
      return;
    }

    st.seenAt = Date.now();
    switch (msg.ev) {
      case 'ARRIVED': {
        const location = this.code(msg.stop);
        const type: RobotEvent['type'] =
          msg.purpose === 'PICKUP' ? 'ROBOT_ARRIVED_PICKUP' : msg.purpose === 'DELIVERY' ? 'ROBOT_ARRIVED_TABLE' : msg.purpose === 'CHARGE' ? 'ROBOT_ARRIVED_CHARGER' : 'ROBOT_ARRIVED_HOME';
        this.events.emit({ ...base, type, taskId: msg.taskId, location });
        if ((msg.purpose === 'HOME' || msg.purpose === 'CHARGE') && msg.taskId) this.events.emit({ ...base, type: 'ROBOT_TASK_COMPLETED', taskId: msg.taskId, location });
        break;
      }
      case 'OBSTACLE':
        this.events.emit({ ...base, type: 'ROBOT_OBSTACLE', taskId: msg.taskId, reason: msg.reason ?? 'Cảm biến siêu âm phát hiện vật cản' });
        break;
      case 'CLEAR':
        this.events.emit({ ...base, type: 'ROBOT_OBSTACLE_CLEARED', taskId: msg.taskId });
        break;
      case 'BUTTON':
        // Nút trên mBot: khách xác nhận "đã nhận món" khi robot đứng chờ ở bàn.
        this.events.emit({ ...base, type: 'ROBOT_CUSTOMER_CONFIRMED', taskId: msg.taskId ?? st.status?.taskId ?? null });
        break;
      case 'PASSED':
        this.events.emit({ ...base, type: 'ROBOT_LOCATION_CHANGED', location: this.code(msg.stop), taskId: msg.taskId });
        break;
      case 'ERROR':
        this.events.emit({ ...base, type: 'ROBOT_ERROR', taskId: msg.taskId, reason: msg.reason ?? 'mBot báo lỗi' });
        break;
    }
  }

  /** Gửi lệnh và chờ robot xác nhận; quá hạn → RobotCommandError(timeout) để gateway thử lại. */
  private send(robotId: string, cmd: MbotCommand) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cmd.id);
        reject(new RobotCommandError(`mBot ${robotId} không xác nhận lệnh ${cmd.cmd} sau ${this.ackTimeoutMs} ms`, true));
      }, this.ackTimeoutMs);
      this.pending.set(cmd.id, { resolve, reject, timer });
      this.link.send(robotId, cmd).catch((e: Error) => {
        clearTimeout(timer);
        this.pending.delete(cmd.id);
        reject(new RobotCommandError(e.message, true));
      });
    });
  }

  async connect(robotId: string) {
    if (!this.robots.has(robotId)) this.robots.set(robotId, { status: null, seenAt: 0 });
  }

  async disconnect(robotId: string) {
    this.robots.delete(robotId);
  }

  async goTo(robotId: string, destination: string, opts: GoToOptions) {
    const stop = this.map.stopOf(destination);
    if (stop === undefined) throw new RobotCommandError(`Vị trí ${destination} chưa có vạch dừng trên sa bàn mBot`);
    await this.send(robotId, { id: nextId(), cmd: 'GOTO', stop, taskId: opts.taskId, purpose: opts.purpose });
  }

  stop(robotId: string) {
    return this.send(robotId, { id: nextId(), cmd: 'STOP' });
  }

  pause(robotId: string) {
    return this.send(robotId, { id: nextId(), cmd: 'PAUSE' });
  }

  resume(robotId: string) {
    return this.send(robotId, { id: nextId(), cmd: 'RESUME' });
  }

  returnHome(robotId: string, opts: { taskId?: string | null; charge?: boolean } = {}) {
    return this.goTo(robotId, opts.charge ? 'CHARGER_01' : 'ROBOT_HOME', { taskId: opts.taskId ?? null, purpose: opts.charge ? 'CHARGE' : 'HOME' });
  }

  cancelTask(robotId: string, taskId: string) {
    return this.send(robotId, { id: nextId(), cmd: 'CANCEL', taskId });
  }

  async simulate(robotId: string, fault: SimFault) {
    await this.link.send(robotId, { id: nextId(), cmd: 'SIM', fault });
  }

  async getStatus(robotId: string): Promise<RobotStatus> {
    const st = this.robots.get(robotId)?.status;
    if (!st || !st.online) return { robotId, online: false, battery: st?.battery ?? 0, batterySimulated: st?.batterySimulated ?? true, location: this.code(st?.stop), mode: 'IDLE', taskId: null, target: null, error: 'Mất kết nối' };
    return {
      robotId,
      online: true,
      battery: st.battery,
      batterySimulated: st.batterySimulated,
      location: st.mode === 'MOVING' ? 'MOVING' : this.code(st.stop),
      mode: st.mode,
      taskId: st.taskId,
      target: this.code(st.target),
      error: st.mode === 'OBSTACLE' ? 'Vật cản' : null,
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

  async close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await this.link.close?.();
  }
}

/** Hai đầu nối trong bộ nhớ (test, demo không cần MQTT broker). */
export function memoryMbotLinkPair() {
  const toRobot: ((robotId: string, cmd: MbotCommand) => void)[] = [];
  const toAdapter: ((robotId: string, msg: MbotMessage) => void)[] = [];
  const adapterSide: MbotLink = {
    async send(robotId, cmd) {
      setImmediate(() => toRobot.forEach((h) => h(robotId, cmd)));
    },
    onMessage: (h) => void toAdapter.push(h),
  };
  const robotSide = {
    publish(robotId: string, msg: MbotMessage) {
      setImmediate(() => toAdapter.forEach((h) => h(robotId, msg)));
    },
    onCommand: (h: (robotId: string, cmd: MbotCommand) => void) => void toRobot.push(h),
  };
  return { adapterSide, robotSide };
}
