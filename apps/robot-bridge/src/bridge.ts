import type { GoToOptions, MbotCommand, MbotMessage, RobotMode } from '@nhs/robot-adapters';
import { encode, parse, shortId, type LinePort, type RobotLineMode } from './protocol';

/** Phía API của bridge: nhận MbotCommand, gửi MbotMessage (MQTT thật, hoặc bộ nhớ khi test). */
export interface BridgeLink {
  publish(msg: MbotMessage): void;
  onCommand(handler: (cmd: MbotCommand) => void): void;
  close?(): Promise<void>;
}

export interface BridgeOptions {
  /** Chu kỳ gửi trạng thái lên API (ms). */
  statusMs?: number;
  /** Không nghe robot quá lâu (rút cáp, hết pin, mất Bluetooth) → báo offline. */
  serialTimeoutMs?: number;
  /** Pin giả lập khi firmware không đo được (MB-15 SIMULATED_TELEMETRY). */
  drainPerStop?: number;
  chargePerSecond?: number;
  /** Quy đổi điện áp → % khi firmware có đo (mV). */
  mvFull?: number;
  mvEmpty?: number;
  log?: (msg: string) => void;
}

/**
 * Robot bridge (MB-19 mBot Communication Layer): chạy trên laptop cạnh sa bàn, giữ cổng serial
 * (USB/Bluetooth) của mBot, nối với API qua MQTT. Protocol phần cứng không lọt vào Delivery Service.
 */
export class RobotBridge {
  private readonly o: Required<Omit<BridgeOptions, 'log'>> & { log: (m: string) => void };
  private stop = 0;
  private lineMode: RobotLineMode = 'I';
  private waiting = false;
  private charging = false;
  private taskId: string | null = null;
  private target: number | null = null;
  private purpose: GoToOptions['purpose'] | null = null;
  private battery = 100;
  private batterySimulated = true;
  private lastSerialAt = 0;
  private announcedOnline = false;
  private firmware = '?';
  /** cid ngắn gửi xuống robot → id lệnh gốc của API, cùng việc cần làm khi robot xác nhận. */
  private readonly pending = new Map<string, { id: string; apply?: () => void }>();
  // Lỗi giả lập (MB-16) — làm ở bridge nên chạy được với cả mBot thật.
  private simOffline = false;
  private apiFailures = 0;
  private blocked = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly link: BridgeLink,
    private readonly port: LinePort,
    opts: BridgeOptions = {},
  ) {
    this.o = {
      statusMs: opts.statusMs ?? 1000,
      serialTimeoutMs: opts.serialTimeoutMs ?? 3500,
      drainPerStop: opts.drainPerStop ?? 0.5,
      chargePerSecond: opts.chargePerSecond ?? 5,
      mvFull: opts.mvFull ?? 4200,
      mvEmpty: opts.mvEmpty ?? 3400,
      log: opts.log ?? (() => {}),
    };
    port.onLine((line) => this.onLine(line));
    link.onCommand((cmd) => this.onCommand(cmd));
    this.timer = setInterval(() => this.onTick(), this.o.statusMs);
  }

  private get online() {
    return !this.simOffline && Date.now() - this.lastSerialAt < this.o.serialTimeoutMs;
  }

  private mode(): RobotMode {
    switch (this.lineMode) {
      case 'M':
        return 'MOVING';
      case 'P':
        return 'PAUSED';
      case 'O':
        return 'OBSTACLE';
      case 'S':
        return 'STOPPED';
      default:
        return this.charging ? 'CHARGING' : this.waiting ? 'WAITING' : 'IDLE';
    }
  }

  private publish(msg: MbotMessage) {
    if (this.simOffline) return;
    this.link.publish(msg);
  }

  private status() {
    this.link.publish({
      type: 'status',
      online: this.online,
      stop: this.stop,
      mode: this.mode(),
      battery: Math.round(this.battery),
      batterySimulated: this.batterySimulated,
      taskId: this.taskId,
      target: this.target,
      firmware: this.firmware,
    });
  }

  private onTick() {
    if (this.charging && this.batterySimulated) this.battery = Math.min(100, this.battery + (this.o.chargePerSecond * this.o.statusMs) / 1000);
    if (this.simOffline) return;
    const online = this.online;
    if (online || this.announcedOnline) this.status();
    this.announcedOnline = online;
  }

  // ── Robot → bridge ──

  private onLine(raw: string) {
    if (this.simOffline) return;
    const m = parse(raw);
    if (!m) return;
    this.lastSerialAt = Date.now();
    switch (m.op) {
      case 'HELLO':
        this.firmware = `${m.model} ${m.firmware}`;
        this.stop = 0;
        this.o.log(`Robot sẵn sàng: ${this.firmware}`);
        break;
      case 'OK':
      case 'ERR': {
        const p = this.pending.get(m.cid);
        if (!p) return;
        this.pending.delete(m.cid);
        if (m.op === 'OK') p.apply?.();
        this.publish({ type: 'ack', id: p.id, ok: m.op === 'OK', error: m.op === 'ERR' ? m.reason : undefined });
        break;
      }
      case 'PASS':
        this.stop = m.stop;
        this.drain();
        this.publish({ type: 'event', ev: 'PASSED', stop: m.stop, taskId: this.taskId });
        break;
      case 'ARR': {
        if (m.stop !== this.stop) this.drain(); // tới ngay chỗ đang đứng thì không tốn pin
        this.stop = m.stop;
        this.lineMode = 'I';
        const { taskId, purpose } = this;
        this.target = null;
        this.purpose = null;
        this.waiting = purpose === 'PICKUP' || purpose === 'DELIVERY';
        this.charging = purpose === 'CHARGE';
        if (purpose === 'HOME' || purpose === 'CHARGE') this.taskId = null;
        this.publish({ type: 'event', ev: 'ARRIVED', stop: m.stop, taskId, purpose });
        break;
      }
      case 'OBS':
        this.lineMode = 'O';
        this.publish({ type: 'event', ev: 'OBSTACLE', taskId: this.taskId, reason: 'Cảm biến siêu âm phát hiện vật cản' });
        break;
      case 'CLR':
        if (this.lineMode === 'O') this.lineMode = 'I';
        this.publish({ type: 'event', ev: 'CLEAR', taskId: this.taskId });
        break;
      case 'BTN':
        if (this.waiting) this.publish({ type: 'event', ev: 'BUTTON', taskId: this.taskId });
        break;
      case 'LOST':
        this.lineMode = 'S';
        this.publish({ type: 'event', ev: 'ERROR', taskId: this.taskId, reason: 'mBot mất đường line, đã tự dừng — đặt robot lại lên sa bàn' });
        break;
      case 'ST':
        this.stop = m.stop;
        if (!(this.lineMode === 'O' && m.mode === 'I')) this.lineMode = m.mode;
        if (m.mv >= 0) {
          this.batterySimulated = false;
          this.battery = Math.max(0, Math.min(100, ((m.mv - this.o.mvEmpty) / (this.o.mvFull - this.o.mvEmpty)) * 100));
        }
        break;
    }
  }

  private drain() {
    if (this.batterySimulated) this.battery = Math.max(0, this.battery - this.o.drainPerStop);
  }

  // ── API → bridge ──

  private send(id: string, line: Parameters<typeof encode>[0] & { cid?: string }, apply?: () => void) {
    if ('cid' in line && line.cid) this.pending.set(line.cid, { id, apply });
    this.port.write(encode(line));
  }

  private onCommand(cmd: MbotCommand) {
    if (cmd.cmd === 'SIM') return this.simulate(cmd.fault);
    if (this.simOffline) return; // mất kết nối giả lập: lệnh không tới robot
    if (this.apiFailures !== 0) {
      if (this.apiFailures > 0) this.apiFailures--;
      return; // lệnh "rơi" → API không nhận được ack → timeout, Robot Gateway thử lại
    }
    const cid = shortId(cmd.id);
    switch (cmd.cmd) {
      case 'PING':
        return this.publish({ type: 'ack', id: cmd.id, ok: true });
      case 'GOTO': {
        const apply = () => {
          this.taskId = cmd.taskId;
          this.target = cmd.stop;
          this.purpose = cmd.purpose;
          this.waiting = false;
          this.charging = false;
          this.lineMode = 'M';
        };
        if (this.blocked) {
          apply();
          this.publish({ type: 'ack', id: cmd.id, ok: true });
          this.lineMode = 'O';
          setTimeout(() => this.publish({ type: 'event', ev: 'OBSTACLE', taskId: this.taskId, reason: 'Vật cản trên đường chạy (giả lập)' }), 50);
          return;
        }
        return this.send(cmd.id, { op: 'G', stop: cmd.stop, cid }, apply);
      }
      case 'STOP':
        return this.send(cmd.id, { op: 'S', cid }, () => (this.lineMode = 'S'));
      case 'PAUSE':
        return this.send(cmd.id, { op: 'P', cid });
      case 'RESUME':
        return this.send(cmd.id, { op: 'R', cid });
      case 'CANCEL':
        if (cmd.taskId !== this.taskId) return this.publish({ type: 'ack', id: cmd.id, ok: true });
        return this.send(cmd.id, { op: 'C', cid }, () => {
          this.taskId = null;
          this.target = null;
          this.purpose = null;
          this.waiting = false;
          this.lineMode = 'I';
        });
    }
  }

  private simulate(fault: Extract<MbotCommand, { cmd: 'SIM' }>['fault']) {
    this.o.log(`Giả lập: ${fault}`);
    switch (fault) {
      case 'OBSTACLE':
      case 'OBSTACLE_PERSISTENT':
        this.blocked = fault === 'OBSTACLE_PERSISTENT';
        if (this.lineMode === 'M') {
          this.port.write(encode({ op: 'S', cid: 'sim' }));
          this.lineMode = 'O';
          this.publish({ type: 'event', ev: 'OBSTACLE', taskId: this.taskId, reason: 'Vật cản trên đường chạy (giả lập)' });
        }
        break;
      case 'OFFLINE':
        this.simOffline = true;
        break;
      case 'LOW_BATTERY':
        this.battery = 12;
        this.batterySimulated = true;
        this.status();
        break;
      case 'API_TIMEOUT':
        this.apiFailures = 1;
        break;
      case 'API_TIMEOUT_PERSISTENT':
        this.apiFailures = -1;
        break;
      case 'BUTTON':
        if (this.waiting) this.publish({ type: 'event', ev: 'BUTTON', taskId: this.taskId });
        break;
      case 'RECOVER':
        this.simOffline = false;
        this.apiFailures = 0;
        if (this.blocked || this.lineMode === 'O') {
          this.blocked = false;
          this.lineMode = 'I';
          this.publish({ type: 'event', ev: 'CLEAR', taskId: this.taskId });
        }
        this.status();
        break;
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.port.close();
    await this.link.close?.();
  }
}
