import { RobotCommandError, type RobotAdapter, type RobotEvent, type RobotStatus, type TripCommand } from './adapter';
import { Emitter } from './emitter';

export type SimFault = 'bi_ket' | 'pin_yeu' | 'mat_ket_noi' | 'phuc_hoi';

export interface SimOptions {
  /** Thời gian đi từ bếp tới bàn (ms), tính theo mã bàn. */
  travelMs?: (banDich: string) => number;
  toPickupMs?: number;
  returnMs?: number;
  /** Tự xác nhận đã nhận món sau khoảng này nếu khách không bấm (0 = không tự xác nhận). */
  autoConfirmMs?: number;
  tickMs?: number;
  batteryPerTrip?: number;
}

interface SimRobot {
  id: string;
  battery: number;
  location: string;
  online: boolean;
  tripId: string | null;
  phase: 'IDLE' | 'TO_PICKUP' | 'AT_PICKUP' | 'MOVING' | 'ARRIVED' | 'RETURNING' | 'CHARGING' | 'STUCK';
  target: string | null;
  timers: NodeJS.Timeout[];
}

/**
 * Robot giả lập chạy trong backend (mục 3.5): dùng khi phát triển và trình diễn không cần phần cứng.
 * Có thể gây lỗi có chủ đích (kẹt, pin yếu, mất kết nối) để kiểm thử luồng fallback.
 */
export class SimulatedAdapter implements RobotAdapter {
  readonly vendor = 'SIMULATED';
  private readonly robots = new Map<string, SimRobot>();
  private readonly events = new Emitter();
  private readonly o: Required<SimOptions>;

  constructor(opts: SimOptions = {}) {
    this.o = {
      travelMs: opts.travelMs ?? ((ban) => 4000 + (Number(ban.replace(/\D/g, '')) % 12) * 400),
      toPickupMs: opts.toPickupMs ?? 2500,
      returnMs: opts.returnMs ?? 3000,
      autoConfirmMs: opts.autoConfirmMs ?? 0,
      tickMs: opts.tickMs ?? 500,
      batteryPerTrip: opts.batteryPerTrip ?? 3,
    };
  }

  /** Đăng ký robot giả lập (gọi lúc khởi động từ danh sách robot trong DB). */
  register(id: string, battery = 100) {
    if (!this.robots.has(id)) this.robots.set(id, { id, battery, location: 'CHO', online: true, tripId: null, phase: 'IDLE', target: null, timers: [] });
  }

  private robot(id: string) {
    const r = this.robots.get(id);
    if (!r) throw new RobotCommandError(`Robot giả lập ${id} chưa đăng ký`);
    if (!r.online) throw new RobotCommandError(`Robot ${id} mất kết nối`);
    return r;
  }

  private clear(r: SimRobot) {
    r.timers.forEach(clearTimeout);
    r.timers = [];
  }

  private emit(r: SimRobot, e: Omit<RobotEvent, 'at' | 'robotId' | 'battery' | 'location'>) {
    if (!r.online) return;
    this.events.emit({ robotId: r.id, battery: Math.round(r.battery), location: r.location, ...e });
  }

  /** Di chuyển có báo tiến độ để vẽ trên sơ đồ, xong thì gọi `done`. */
  private travel(r: SimRobot, ms: number, location: string, done: () => void) {
    const started = Date.now();
    const tick = () => {
      if (r.phase === 'STUCK' || !r.online) return;
      const progress = Math.min(1, (Date.now() - started) / ms);
      this.emit(r, { type: 'STATUS', tripId: r.tripId ?? undefined, progress });
      if (progress >= 1) {
        r.location = location;
        done();
      } else r.timers.push(setTimeout(tick, this.o.tickMs));
    };
    r.location = 'DI_CHUYEN';
    r.timers.push(setTimeout(tick, this.o.tickMs));
  }

  async denDiemLayMon(robotId: string, tripId: string) {
    const r = this.robot(robotId);
    if (r.phase !== 'IDLE') throw new RobotCommandError(`Robot ${robotId} đang bận`);
    r.tripId = tripId;
    r.phase = 'TO_PICKUP';
    this.travel(r, this.o.toPickupMs, 'BEP', () => {
      r.phase = 'AT_PICKUP';
      this.emit(r, { type: 'AT_PICKUP', tripId });
    });
  }

  async giaoMon(robotId: string, trip: TripCommand) {
    const r = this.robot(robotId);
    if (r.tripId !== trip.tripId || (r.phase !== 'AT_PICKUP' && r.phase !== 'MOVING')) {
      throw new RobotCommandError(`Robot ${robotId} chưa sẵn sàng giao chuyến ${trip.tripId}`);
    }
    this.clear(r);
    r.phase = 'MOVING';
    r.target = trip.banDich;
    this.emit(r, { type: 'MOVING', tripId: trip.tripId });
    this.travel(r, this.o.travelMs(trip.banDich), trip.banDich, () => {
      r.phase = 'ARRIVED';
      this.emit(r, { type: 'ARRIVED', tripId: trip.tripId });
      if (this.o.autoConfirmMs > 0) r.timers.push(setTimeout(() => void this.xacNhanDaNhan(r.id, trip.tripId), this.o.autoConfirmMs));
    });
  }

  async xacNhanDaNhan(robotId: string, tripId: string) {
    const r = this.robot(robotId);
    if (r.tripId !== tripId || r.phase !== 'ARRIVED') return;
    this.clear(r);
    this.emit(r, { type: 'DELIVERED', tripId });
    this.goHome(r);
  }

  private goHome(r: SimRobot) {
    const tripId = r.tripId ?? undefined;
    r.phase = 'RETURNING';
    r.battery = Math.max(0, r.battery - this.o.batteryPerTrip);
    this.emit(r, { type: 'RETURNING', tripId });
    this.travel(r, this.o.returnMs, 'CHO', () => {
      r.phase = 'IDLE';
      r.tripId = null;
      r.target = null;
      this.emit(r, { type: 'DONE', tripId });
      if (r.battery < 20) this.emit(r, { type: 'LOW_BATTERY' });
    });
  }

  async huyChuyen(robotId: string, tripId: string) {
    const r = this.robots.get(robotId);
    if (!r || r.tripId !== tripId) return;
    this.clear(r);
    if (r.phase === 'STUCK') return;
    this.goHome(r);
  }

  async diSac(robotId: string) {
    const r = this.robot(robotId);
    this.clear(r);
    r.phase = 'CHARGING';
    r.location = 'SAC';
    const charge = () => {
      r.battery = Math.min(100, r.battery + 5);
      this.emit(r, { type: 'STATUS' });
      if (r.battery < 100 && r.phase === 'CHARGING') r.timers.push(setTimeout(charge, 1000));
      else if (r.phase === 'CHARGING') {
        r.phase = 'IDLE';
        r.location = 'CHO';
        this.emit(r, { type: 'DONE' });
      }
    };
    r.timers.push(setTimeout(charge, 1000));
  }

  async layTrangThai(robotId: string): Promise<RobotStatus> {
    const r = this.robots.get(robotId);
    if (!r) return { robotId, online: false, battery: 0, location: '?', busy: false, error: 'Chưa đăng ký' };
    return {
      robotId,
      online: r.online,
      battery: Math.round(r.battery),
      location: r.location,
      busy: r.phase !== 'IDLE',
      error: r.phase === 'STUCK' ? 'Robot bị kẹt' : undefined,
    };
  }

  onSuKien(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }

  /** Gây lỗi có chủ đích để kiểm thử (mục 15: robot kẹt / hết pin / mất kết nối). */
  inject(robotId: string, fault: SimFault) {
    const r = this.robots.get(robotId);
    if (!r) throw new RobotCommandError(`Robot giả lập ${robotId} chưa đăng ký`);
    const tripId = r.tripId ?? undefined;
    if (fault === 'bi_ket') {
      this.clear(r);
      r.phase = 'STUCK';
      this.emit(r, { type: 'FAILED', tripId, reason: 'Robot bị kẹt' });
    } else if (fault === 'pin_yeu') {
      this.clear(r);
      r.battery = 5;
      r.phase = 'STUCK';
      this.emit(r, { type: 'FAILED', tripId, reason: 'Pin yếu, robot dừng' });
    } else if (fault === 'mat_ket_noi') {
      this.clear(r);
      r.online = false;
    } else {
      this.clear(r);
      r.online = true;
      r.phase = 'IDLE';
      r.tripId = null;
      r.location = 'CHO';
      this.emit(r, { type: 'DONE' });
    }
  }

  async close() {
    for (const r of this.robots.values()) this.clear(r);
  }
}
