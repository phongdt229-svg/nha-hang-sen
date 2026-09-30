import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Robot, RobotVendor } from '@prisma/client';
import {
  isSimulatable,
  locationMap,
  LuckiBotProAdapter,
  ManualAdapter,
  MbotV1Adapter,
  MqttMbotLink,
  RobotCommandError,
  SimulatedAdapter,
  type LocationMap,
  type RobotAdapter,
  type RobotEvent,
  type SimFault,
} from '@nhs/robot-adapters';
import { PrismaService } from '../prisma/prisma.service';
import { deliveryConfig } from './delivery.config';

/** Hệ số tốc độ robot giả lập: 1 = như sa bàn thật, nhỏ hơn để test chạy nhanh. */
const speed = () => Number(process.env.SIM_SPEED ?? 1);

/**
 * Robot Gateway (RD-25, MB-02): Delivery Service chỉ gọi gateway, không biết robot dùng MQTT, serial hay SDK.
 * Gateway lo: chọn adapter theo hãng, dịch vị trí, thử lại lệnh (RD-18 max_api_retry), gom sự kiện chuẩn hóa.
 */
@Injectable()
export class RobotGateway implements OnModuleDestroy {
  private readonly logger = new Logger('RobotGateway');
  readonly sim = new SimulatedAdapter({
    segmentMs: 1500 * speed(),
    tickMs: Math.max(20, 200 * speed()),
    heartbeatMs: Math.max(50, 2000 * speed()),
    autoConfirmMs: Number(process.env.SIM_AUTO_CONFIRM_MS ?? 0),
    drainPerSegment: Number(process.env.SIM_DRAIN_PER_SEGMENT ?? 0.5),
    chargePerSecond: Number(process.env.SIM_CHARGE_PER_SECOND ?? 5),
  });
  readonly manual = new ManualAdapter();
  readonly luckibot = new LuckiBotProAdapter(null);
  /** mBot v1 qua robot bridge (MQTT). Không có MQTT_URL thì robot MAKEBLOCK luôn OFFLINE. */
  readonly mbot: MbotV1Adapter | null;
  private readonly handlers: ((vendor: RobotVendor, e: RobotEvent) => void)[] = [];

  constructor(private readonly prisma: PrismaService) {
    this.sim.onEvent((e) => this.dispatch('SIMULATED', e));
    this.manual.onEvent((e) => this.dispatch('MANUAL', e));
    this.luckibot.onEvent((e) => this.dispatch('ORIONSTAR', e));
    if (process.env.MQTT_URL) {
      this.mbot = new MbotV1Adapter(new MqttMbotLink(process.env.MQTT_URL, process.env.BRANCH_CODE ?? '001'), {
        ackTimeoutMs: Number(process.env.MBOT_ACK_TIMEOUT_MS ?? 3000),
      });
      this.mbot.onEvent((e) => this.dispatch('MAKEBLOCK', e));
      this.logger.log(`mBot v1 qua robot bridge: ${process.env.MQTT_URL}`);
    } else this.mbot = null;
  }

  private dispatch(vendor: RobotVendor, e: RobotEvent) {
    for (const h of this.handlers) h(vendor, e);
  }

  onEvent(h: (vendor: RobotVendor, e: RobotEvent) => void) {
    this.handlers.push(h);
  }

  adapter(vendor: RobotVendor): RobotAdapter {
    switch (vendor) {
      case 'SIMULATED':
        return this.sim;
      case 'MANUAL':
        return this.manual;
      case 'ORIONSTAR':
        return this.luckibot;
      case 'MAKEBLOCK':
        if (!this.mbot) throw new RobotCommandError('Chưa cấu hình MQTT_URL tới robot bridge cho mBot', true);
        return this.mbot;
    }
  }

  /**
   * Nạp bảng vị trí (robot_locations.vendor_mapping) vào từng adapter. Bàn chưa có vị trí thì tự thêm
   * (robot thật chỉ tới được khi đã khai báo mapping cho bàn đó). Robot giả lập chạy một vòng:
   * bếp (0) → các bàn theo mã → trạm sạc → bếp.
   */
  async loadLocations() {
    const tables = await this.prisma.table.findMany({ orderBy: { code: 'asc' } });
    const known = new Set((await this.prisma.robotLocation.findMany({ select: { code: true } })).map((r) => r.code));
    for (const [i, t] of tables.entries()) {
      if (known.has(`TABLE_${t.code}`)) continue;
      await this.prisma.robotLocation.create({ data: { code: `TABLE_${t.code}`, kind: 'TABLE', name: `Bàn ${t.code}`, tableId: t.id, sort: 10 + i } }).catch(() => undefined);
    }
    for (const base of [
      { code: 'KITCHEN_PASS_01', kind: 'KITCHEN_PASS' as const, name: 'Điểm lấy món (bếp)', sort: 0 },
      { code: 'ROBOT_HOME', kind: 'HOME' as const, name: 'Vị trí gốc', sort: 1 },
      { code: 'CHARGER_01', kind: 'CHARGER' as const, name: 'Trạm sạc', sort: 999 },
    ]) {
      if (!known.has(base.code)) await this.prisma.robotLocation.create({ data: base }).catch(() => undefined);
    }
    const rows = await this.prisma.robotLocation.findMany();
    const simStops: Record<string, number> = { KITCHEN_PASS_01: 0, ROBOT_HOME: 0 };
    tables.forEach((t, i) => (simStops[`TABLE_${t.code}`] = i + 1));
    simStops.CHARGER_01 = tables.length + 1;
    const stops = (vendor: string) => {
      const entries: Record<string, number> = {};
      for (const r of rows) {
        const m = (r.vendorMapping as Record<string, { stop?: number }>)[vendor];
        if (typeof m?.stop === 'number') entries[r.code] = m.stop;
      }
      return entries;
    };
    const prefer = rows.filter((r) => r.kind === 'KITCHEN_PASS').map((r) => r.code);
    this.sim.setLocations(locationMap(simStops, prefer));
    this.mbot?.setLocations(locationMap(stops('MAKEBLOCK'), prefer));
    const positions: Record<string, string> = {};
    for (const r of rows) {
      const m = (r.vendorMapping as Record<string, { position?: string }>).ORIONSTAR;
      if (m?.position) positions[r.code] = m.position;
    }
    this.luckibot.setPositions(positions);
    this.locations = new Map(rows.map((r) => [r.code, r.vendorMapping as Record<string, unknown>]));
  }

  private locations = new Map<string, Record<string, unknown>>();

  /** Robot có đi tới được vị trí này không (mBot chỉ tới được các vạch có trên sa bàn). */
  supports(robot: Pick<Robot, 'vendor'>, location: string) {
    if (robot.vendor === 'MANUAL') return true;
    const mapping = this.locations.get(location);
    if (!mapping) return false;
    if (robot.vendor === 'SIMULATED') return true;
    return mapping[robot.vendor] !== undefined;
  }

  async connect(robot: Robot) {
    await this.adapter(robot.vendor).connect(robot.externalId, { battery: robot.battery, location: robot.location === 'MOVING' ? null : robot.location });
  }

  /**
   * Gửi lệnh tới robot; lệnh không tới / không được xác nhận (timeout) thì thử lại tối đa
   * max_api_retry lần. Hết lượt thì ném lỗi cho Delivery Service chuyển task sang FAILED.
   */
  async command<T>(robot: Pick<Robot, 'vendor' | 'externalId' | 'code'>, label: string, fn: (a: RobotAdapter, id: string) => Promise<T>): Promise<T> {
    const { maxApiRetry, apiRetryDelayMs } = deliveryConfig();
    let last: unknown;
    for (let attempt = 0; attempt <= maxApiRetry; attempt++) {
      try {
        return await fn(this.adapter(robot.vendor), robot.externalId);
      } catch (e) {
        last = e;
        const retriable = e instanceof RobotCommandError && e.timeout;
        this.logger.warn(`Robot ${robot.code} ${label} lần ${attempt + 1}: ${e instanceof Error ? e.message : e}`);
        if (!retriable) break;
        if (attempt < maxApiRetry) await new Promise((r) => setTimeout(r, apiRetryDelayMs));
      }
    }
    throw last;
  }

  async simulate(robot: Robot, fault: SimFault) {
    const a = this.adapter(robot.vendor);
    if (!isSimulatable(a)) throw new RobotCommandError(`Robot ${robot.vendor} không hỗ trợ giả lập lỗi`);
    await a.simulate(robot.externalId, fault);
  }

  async onModuleDestroy() {
    await this.sim.close();
    await this.mbot?.close();
  }
}
