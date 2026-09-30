import { encode, parse, type LinePort, type RobotLineMode } from './protocol';

export interface VirtualMbotOptions {
  /** Số vạch dừng trên vòng (sa bàn A1: 0 = bếp/gốc, 1–4 bàn, 5 trạm sạc → 6). */
  stops?: number;
  /** Thời gian chạy giữa hai vạch (ms). */
  segmentMs?: number;
  /** Chu kỳ gửi dòng ST (ms). */
  statusMs?: number;
}

/**
 * mBot ảo nói đúng giao thức serial của firmware (MB-26 Phase 2): chạy một chiều quanh sa bàn,
 * báo PASS/ARR, OK cho mỗi lệnh. Dùng để demo/kiểm thử bridge khi chưa có robot thật.
 */
export class VirtualMbot implements LinePort {
  private readonly handlers: ((line: string) => void)[] = [];
  private readonly o: Required<VirtualMbotOptions>;
  private stop = 0;
  private target: number | null = null;
  private mode: RobotLineMode = 'I';
  private timer: NodeJS.Timeout | null = null;
  private status: NodeJS.Timeout;
  private obstacle = false;

  constructor(opts: VirtualMbotOptions = {}) {
    this.o = { stops: opts.stops ?? 6, segmentMs: opts.segmentMs ?? 1500, statusMs: opts.statusMs ?? 1000 };
    this.status = setInterval(() => this.say(`ST ${this.stop} ${this.mode} -1`), this.o.statusMs);
    setImmediate(() => this.say('HELLO MBOT_V1 virtual'));
  }

  private say(line: string) {
    for (const h of this.handlers) h(line);
  }

  private halt() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Nhận lệnh từ bridge (như firmware đọc Serial). */
  write(line: string) {
    const [op, a, b] = line.trim().split(/\s+/);
    switch (op) {
      case 'G': {
        const stop = Number(a);
        if (!Number.isInteger(stop) || stop < 0 || stop >= this.o.stops) return this.say(`ERR ${b} vach-khong-hop-le`);
        this.say(`OK ${b}`);
        this.target = stop;
        this.go();
        break;
      }
      case 'S':
      case 'C':
        this.halt();
        this.target = op === 'C' ? null : this.target;
        this.mode = op === 'S' ? 'S' : 'I';
        this.say(`OK ${a}`);
        break;
      case 'P':
        this.halt();
        if (this.mode === 'M') this.mode = 'P';
        this.say(`OK ${a}`);
        break;
      case 'R':
        this.say(`OK ${a}`);
        if (this.target !== null) this.go();
        break;
      case 'Q':
        this.say(`ST ${this.stop} ${this.mode} -1`);
        break;
    }
  }

  private go() {
    this.halt();
    if (this.target === null) return;
    if (this.obstacle) {
      this.mode = 'O';
      return this.say('OBS');
    }
    if (this.stop === this.target) {
      this.mode = 'I';
      this.target = null;
      return this.say(`ARR ${this.stop}`);
    }
    this.mode = 'M';
    this.timer = setTimeout(() => {
      this.stop = (this.stop + 1) % this.o.stops;
      if (this.stop === this.target) {
        this.mode = 'I';
        this.target = null;
        this.say(`ARR ${this.stop}`);
      } else {
        this.say(`PASS ${this.stop}`);
        this.go();
      }
    }, this.o.segmentMs);
  }

  /** Đặt vật cản thật trước siêu âm (demo): robot dừng, báo OBS; bỏ vật cản thì báo CLR và đứng chờ lệnh. */
  setObstacle(on: boolean) {
    this.obstacle = on;
    if (on && this.mode === 'M') {
      this.halt();
      this.mode = 'O';
      this.say('OBS');
    } else if (!on && this.mode === 'O') {
      this.mode = 'I';
      this.say('CLR');
    }
  }

  /** Nút trên mCore. */
  pressButton() {
    this.say('BTN');
  }

  onLine(handler: (line: string) => void) {
    this.handlers.push(handler);
  }

  async close() {
    this.halt();
    clearInterval(this.status);
  }
}

export { encode, parse };
