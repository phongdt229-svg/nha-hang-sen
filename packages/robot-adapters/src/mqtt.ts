import mqtt, { type MqttClient } from 'mqtt';
import { RobotCommandError, type RobotAdapter, type RobotEvent, type RobotEventType, type RobotStatus, type TripCommand } from './adapter';
import { Emitter } from './emitter';

/** Giá trị `event` robot demo gửi về (mục 7.4) → sự kiện chuẩn. */
const EVENT_MAP: Record<string, RobotEventType> = {
  da_toi_bep: 'AT_PICKUP',
  da_nhan_lenh: 'MOVING',
  dang_di: 'MOVING',
  da_toi: 'ARRIVED',
  khach_da_nhan: 'DELIVERED',
  bi_ket: 'FAILED',
  pin_yeu: 'LOW_BATTERY',
  ve_vi_tri: 'DONE',
};

/**
 * Robot demo qua MQTT: Makeblock mBot2 (MicroPython) và xe ESP32 tự lắp (Arduino) — mục 7.4.
 * Topic: nhs/{chi_nhanh}/robot/{robot_id}/cmd | status | event
 */
export class MqttToyAdapter implements RobotAdapter {
  readonly vendor = 'MQTT';
  private readonly client: MqttClient;
  private readonly events = new Emitter();
  private readonly status = new Map<string, RobotStatus & { seenAt: number }>();

  constructor(
    url: string,
    private readonly branch = process.env.BRANCH_CODE ?? '001',
    options: mqtt.IClientOptions = {},
  ) {
    this.client = mqtt.connect(url, { reconnectPeriod: 2000, ...options });
    this.client.on('connect', () => this.client.subscribe([`nhs/${branch}/robot/+/status`, `nhs/${branch}/robot/+/event`], { qos: 1 }));
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
  }

  private topic(robotId: string, kind: 'cmd' | 'status' | 'event') {
    return `nhs/${this.branch}/robot/${robotId}/${kind}`;
  }

  private onMessage(topic: string, payload: Buffer) {
    const m = /robot\/([^/]+)\/(status|event)$/.exec(topic);
    if (!m) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }
    const robotId = m[1];
    const battery = typeof data.pin === 'number' ? data.pin : undefined;
    if (m[2] === 'status') {
      const st = {
        robotId,
        online: true,
        battery: battery ?? 0,
        location: String(data.vi_tri ?? data.ban ?? '?'),
        busy: data.trang_thai !== 'ranh',
        seenAt: Date.now(),
      };
      this.status.set(robotId, st);
      this.events.emit({ robotId, type: 'STATUS', battery: st.battery, location: st.location });
      return;
    }
    const type = EVENT_MAP[String(data.event)];
    if (!type) return;
    const e: Omit<RobotEvent, 'at'> = {
      robotId,
      type,
      tripId: typeof data.trip_id === 'string' ? data.trip_id : undefined,
      battery,
      location: data.ban !== undefined ? `T${String(data.ban).padStart(2, '0')}` : undefined,
      reason: type === 'FAILED' ? 'Robot bị kẹt (vật cản)' : undefined,
    };
    this.events.emit(e);
  }

  private send(robotId: string, cmd: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      if (!this.client.connected) return reject(new RobotCommandError('Mất kết nối MQTT broker'));
      this.client.publish(this.topic(robotId, 'cmd'), JSON.stringify(cmd), { qos: 1 }, (err) => (err ? reject(new RobotCommandError(err.message)) : resolve()));
    });
  }

  denDiemLayMon(robotId: string, tripId: string) {
    return this.send(robotId, { cmd: 've_bep', trip_id: tripId });
  }

  giaoMon(robotId: string, trip: TripCommand) {
    const ban = Number(trip.banDich.replace(/\D/g, ''));
    return this.send(robotId, { cmd: 'giao', trip_id: trip.tripId, ban, hien_thi: trip.hienThi ?? `Bàn ${String(ban).padStart(2, '0')} – mời quý khách lấy món` });
  }

  huyChuyen(robotId: string, tripId: string) {
    return this.send(robotId, { cmd: 'huy', trip_id: tripId });
  }

  xacNhanDaNhan(robotId: string, tripId: string) {
    return this.send(robotId, { cmd: 'da_nhan', trip_id: tripId });
  }

  diSac(robotId: string) {
    return this.send(robotId, { cmd: 'sac' });
  }

  async layTrangThai(robotId: string): Promise<RobotStatus> {
    const s = this.status.get(robotId);
    // Robot báo trạng thái mỗi 2 giây; quá 10 giây im lặng coi như mất kết nối.
    if (!s || Date.now() - s.seenAt > 10_000) return { robotId, online: false, battery: s?.battery ?? 0, location: s?.location ?? '?', busy: false };
    return s;
  }

  onSuKien(handler: (e: RobotEvent) => void) {
    this.events.on(handler);
  }

  async close() {
    await this.client.endAsync();
  }
}
