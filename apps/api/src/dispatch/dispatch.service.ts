import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { DeliveryTrip, Robot, RobotVendor } from '@prisma/client';
import type { RobotEvent } from '@nhs/robot-adapters';
import { assertTransition, rooms as R, TRIP_TRANSITIONS, type ReadyGroupDto, type RobotDto, type RobotTelemetry, type TripDto, type TripStage } from '@nhs/types';
import { actorId, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../events/events.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { RealtimeGateway } from '../events/realtime.gateway';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { currentTables } from '../sessions/session.helpers';
import { RobotRegistry } from './robot.registry';

const cfg = () => ({
  tickMs: Number(process.env.DISPATCH_TICK_MS ?? 2000),
  /** Chờ tối đa bao lâu để gom thêm món cùng bàn trước khi giao. */
  batchWindowMs: Number(process.env.BATCH_WINDOW_MS ?? 20_000),
  maxTripItems: Number(process.env.MAX_TRIP_ITEMS ?? 6),
  minBattery: Number(process.env.ROBOT_MIN_BATTERY ?? 20),
});

const ACTIVE_STAGES: TripStage[] = ['CREATED', 'ASSIGNED', 'AT_PICKUP', 'MOVING', 'ARRIVED'];
const COOKING = ['CONFIRMED', 'SENT', 'FALLBACK', 'KDS_ACK', 'PREPARING'] as const;

type TripWithRelations = DeliveryTrip & { robot: Robot | null; items: { orderItemId: string }[] };

@Injectable()
export class DispatchService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Dispatch');
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Xử lý sự kiện robot tuần tự để không có hai sự kiện cùng sửa một chuyến. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly outbox: OutboxPublisher,
    private readonly gateway: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly robots: RobotRegistry,
  ) {}

  onModuleInit() {
    this.robots.onEvent((vendor, e) => {
      this.chain = this.chain.then(() => this.onRobotEvent(vendor, e)).catch((err) => this.logger.error(err instanceof Error ? err.stack : err));
    });
    // Món vừa xong → thử điều phối ngay, không chờ nhịp kế tiếp.
    this.outbox.on('kitchen.ready', async () => {
      setImmediate(() => void this.tick());
    });
    // Khách chuyển bàn giữa lúc robot đang chở món → đổi bàn đích (mục 15).
    this.outbox.on('session.moved', async (tx, e) => {
      const sessionId = (e.data as { sessionId: string }).sessionId;
      const reroutes = await this.retarget(tx, sessionId);
      if (reroutes.length) setImmediate(() => void this.reroute(reroutes));
    });
    this.outbox.on('session.merged', async (tx, e) => {
      const d = e.data as { sessionId: string; sourceSessionId: string };
      await tx.deliveryTrip.updateMany({ where: { sessionId: d.sourceSessionId, stage: { in: ACTIVE_STAGES } }, data: { sessionId: d.sessionId } });
    });
  }

  async onApplicationBootstrap() {
    const sims = await this.prisma.robot.findMany({ where: { vendor: 'SIMULATED' } });
    for (const r of sims) this.robots.sim.register(r.externalId, r.battery);
    // Chuyến dở dang từ lần chạy trước (server khởi động lại): robot giả lập đã mất trạng thái → trả món về hàng chờ.
    const stale = await this.prisma.deliveryTrip.findMany({ where: { stage: { in: ACTIVE_STAGES }, robot: { vendor: 'SIMULATED' } } });
    for (const t of stale) await this.fail(t.id, 'Máy chủ khởi động lại giữa chuyến');
    await this.prisma.robot.updateMany({ where: { vendor: 'SIMULATED', state: { in: ['BUSY', 'OFFLINE'] } }, data: { state: 'IDLE', location: 'CHO' } });
    if (process.env.DISPATCH_AUTO !== 'false') this.timer = setInterval(() => void this.tick(), cfg().tickMs);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ---------- Hàng chờ & điều phối ----------

  async readyQueue(): Promise<ReadyGroupDto[]> {
    const items = await this.prisma.orderItem.findMany({
      where: {
        status: 'READY',
        order: { session: { status: { not: 'CLOSED' } } },
        NOT: { id: { in: (await this.activeTripItemIds()) } },
      },
      include: { order: { select: { sessionId: true } } },
      orderBy: { readyAt: 'asc' },
    });
    const bySession = new Map<string, typeof items>();
    for (const i of items) bySession.set(i.order.sessionId, [...(bySession.get(i.order.sessionId) ?? []), i]);
    const groups: ReadyGroupDto[] = [];
    for (const [sessionId, list] of bySession) {
      const [table] = await currentTables(this.prisma, sessionId);
      const cooking = await this.prisma.orderItem.count({ where: { order: { sessionId }, status: { in: [...COOKING] } } });
      const oldest = list[0].readyAt ?? list[0].updatedAt;
      groups.push({
        sessionId,
        tableId: table?.id ?? null,
        tableCode: table?.code ?? null,
        oldestReadyAt: oldest.toISOString(),
        waitingSeconds: Math.floor((Date.now() - oldest.getTime()) / 1000),
        stillCooking: cooking,
        items: list.map((i) => ({ id: i.id, name: i.name, qty: i.qty, station: i.station, deliveryMode: i.deliveryMode })),
      });
    }
    // Ưu tiên SLA: nhóm chờ lâu nhất đi trước.
    return groups.sort((a, b) => b.waitingSeconds - a.waitingSeconds);
  }

  private async activeTripItemIds() {
    const rows = await this.prisma.tripItem.findMany({ where: { trip: { stage: { in: ACTIVE_STAGES } } }, select: { orderItemId: true } });
    return rows.map((r) => r.orderItemId);
  }

  /** Một nhịp điều phối: cập nhật trạng thái robot, rồi ghép nhóm món sẵn sàng với robot rảnh. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pollRobots();
      const { batchWindowMs, maxTripItems } = cfg();
      for (const g of await this.readyQueue()) {
        const robotItems = g.items.filter((i) => i.deliveryMode === 'ROBOT');
        if (robotItems.length === 0 || !g.tableId) continue;
        // Gom món: giao ngay nếu bàn không còn món đang nấu, hoặc đã chờ quá cửa sổ gom.
        const due = g.stillCooking === 0 || g.waitingSeconds * 1000 >= batchWindowMs || robotItems.length >= maxTripItems;
        if (!due) continue;
        const robot = await this.pickRobot();
        if (!robot) break;
        await this.createTrip(g.sessionId, robotItems.slice(0, maxTripItems).map((i) => i.id), robot);
      }
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : e);
    } finally {
      this.ticking = false;
    }
  }

  private async pickRobot() {
    const candidates = await this.prisma.robot.findMany({ where: { state: 'IDLE', battery: { gte: cfg().minBattery } }, orderBy: [{ battery: 'desc' }, { code: 'asc' }] });
    return candidates[0] ?? null;
  }

  private async createTrip(sessionId: string, orderItemIds: string[], robot: Robot) {
    let trip: DeliveryTrip;
    try {
      trip = await this.prisma.$transaction(async (tx) => {
        // Khóa robot để hai nhịp điều phối không giao cùng một robot.
        const [locked] = await tx.$queryRaw<{ state: string }[]>`SELECT state FROM robots WHERE id = ${robot.id} FOR UPDATE`;
        if (locked?.state !== 'IDLE') throw new ConflictException('Robot vừa được giao việc khác');
        const items = await tx.orderItem.findMany({ where: { id: { in: orderItemIds }, status: 'READY', deliveryMode: 'ROBOT' } });
        if (items.length === 0) throw new ConflictException('Món đã được xử lý');
        const [table] = await currentTables(tx, sessionId);
        const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('delivery_trips_seq_no_seq') AS n`;
        const trip = await tx.deliveryTrip.create({
          data: {
            seqNo: Number(n),
            code: `TR${String(n).padStart(3, '0')}`,
            robotId: robot.id,
            sessionId,
            tableId: table.id,
            tableCode: table.code,
            stage: 'ASSIGNED',
            assignedAt: new Date(),
            items: { create: items.map((i) => ({ orderItemId: i.id })) },
          },
        });
        await tx.orderItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { status: 'ASSIGNED' } });
        await tx.robot.update({ where: { id: robot.id }, data: { state: 'BUSY' } });
        await this.emitTrip(tx, 'trip.assigned', trip.id);
        return trip;
      });
    } catch (e) {
      if (e instanceof ConflictException) return;
      throw e;
    }
    this.events.wake();
    try {
      await this.robots.adapter(robot.vendor).denDiemLayMon(robot.externalId, trip.code);
    } catch (e) {
      await this.fail(trip.id, `Không gửi được lệnh: ${e instanceof Error ? e.message : e}`, 'ERROR');
    }
  }

  // ---------- Thao tác của nhân viên ----------

  /** Xác thực pickup: mã QR trên khay phải khớp chuyến, sai khay thì chặn (mục 15). */
  async pickup(p: Principal, tripId: string, trayCode: string) {
    const trip = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTrip(tx, tripId);
      if (t.stage !== 'AT_PICKUP' && t.stage !== 'ASSIGNED') throw new ConflictException('Chuyến không ở bước lấy món');
      if (trayCode.trim().toUpperCase() !== t.code) {
        await this.audit.record(tx, { actorId: actorId(p), action: 'trip.pickup_rejected', entity: 'trip', entityId: t.id, after: { trayCode } });
        throw new ConflictException({ error: 'WRONG_TRAY', message: `Sai khay: quét ${trayCode}, chuyến này là ${t.code}` });
      }
      const [table] = await currentTables(tx, t.sessionId);
      await tx.deliveryTrip.update({
        where: { id: t.id },
        data: { stage: 'MOVING', pickedUpAt: new Date(), tableId: table?.id ?? t.tableId, tableCode: table?.code ?? t.tableCode, version: { increment: 1 } },
      });
      await tx.orderItem.updateMany({ where: { id: { in: t.items.map((i) => i.orderItemId) }, status: 'ASSIGNED' }, data: { status: 'PICKED_UP' } });
      await this.emitTrip(tx, 'trip.picked_up', t.id);
      return tx.deliveryTrip.findUniqueOrThrow({ where: { id: t.id }, include: { robot: true, items: true } });
    });
    this.events.wake();
    await this.sendGo(trip);
    return this.tripDto(trip.id);
  }

  private async sendGo(trip: TripWithRelations) {
    if (!trip.robot) return;
    const names = await this.prisma.orderItem.findMany({ where: { id: { in: trip.items.map((i) => i.orderItemId) } }, select: { name: true, qty: true } });
    try {
      await this.robots.adapter(trip.robot.vendor).giaoMon(trip.robot.externalId, {
        tripId: trip.code,
        banDich: trip.tableCode,
        mon: names.map((n) => `${n.qty} ${n.name}`),
        hienThi: `Bàn ${trip.tableCode.replace(/\D/g, '').padStart(2, '0')} – mời quý khách lấy món`,
      });
    } catch (e) {
      await this.fail(trip.id, `Không gửi được lệnh giao: ${e instanceof Error ? e.message : e}`, 'ERROR');
    }
  }

  /** Khách bấm "Đã nhận món" trên tablet, hoặc nhân viên xác nhận thay. */
  async confirmDelivered(p: Principal, tripId: string) {
    const trip = await this.prisma.deliveryTrip.findUnique({ where: { id: tripId }, include: { robot: true } });
    if (!trip) throw new NotFoundException('Không tìm thấy chuyến');
    if (p.kind === 'device' && p.tableId !== trip.tableId) throw new ForbiddenException('Chuyến không thuộc bàn này');
    if (trip.stage !== 'ARRIVED') throw new ConflictException('Robot chưa tới bàn');
    if (!trip.robot) throw new ConflictException('Chuyến không có robot');
    await this.robots.adapter(trip.robot.vendor).xacNhanDaNhan(trip.robot.externalId, trip.code);
    await this.chain;
    return this.tripDto(tripId);
  }

  /** Robot trục trặc hoặc quá tải: hủy chuyến, chuyển món cho nhân viên mang ra. */
  async fallbackStaff(p: Principal, tripId: string, reason: string) {
    const { trip, robot } = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTrip(tx, tripId);
      assertTransition('chuyến', TRIP_TRANSITIONS, t.stage, 'CANCELLED');
      await tx.deliveryTrip.update({ where: { id: t.id }, data: { stage: 'CANCELLED', failReason: `Chuyển nhân viên: ${reason}`, endedAt: new Date(), version: { increment: 1 } } });
      await tx.orderItem.updateMany({
        where: { id: { in: t.items.map((i) => i.orderItemId) }, status: { in: ['ASSIGNED', 'PICKED_UP', 'READY'] } },
        data: { status: 'READY', deliveryMode: 'STAFF' },
      });
      await this.audit.record(tx, { actorId: actorId(p), action: 'trip.fallback_staff', entity: 'trip', entityId: t.id, reason });
      await this.emitTrip(tx, 'trip.cancelled', t.id);
      return { trip: t, robot: t.robot };
    });
    this.events.wake();
    if (robot && robot.state !== 'OFFLINE') {
      await this.robots
        .adapter(robot.vendor)
        .huyChuyen(robot.externalId, trip.code)
        .catch(() => undefined);
    }
    return this.tripDto(tripId);
  }

  /** Chuyển thẳng các món trong hàng chờ cho nhân viên giao. */
  async itemsToStaff(p: Principal, orderItemIds: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.orderItem.updateMany({ where: { id: { in: orderItemIds }, status: 'READY' }, data: { deliveryMode: 'STAFF' } });
      if (r.count === 0) throw new ConflictException('Không có món nào đang chờ giao');
      await this.audit.record(tx, { actorId: actorId(p), action: 'dispatch.items_to_staff', entity: 'order_item', entityId: orderItemIds.join(','), reason: 'Nhân viên giao' });
    });
    return { ok: true };
  }

  // ---------- Sự kiện từ robot ----------

  private async onRobotEvent(vendor: RobotVendor, e: RobotEvent) {
    const robot = await this.prisma.robot.findFirst({ where: { vendor, externalId: e.robotId } });
    if (!robot) return;
    const patch: Partial<Robot> = { lastSeenAt: new Date() };
    if (e.battery !== undefined) patch.battery = e.battery;
    if (e.location) patch.location = e.location;
    if (robot.state === 'OFFLINE') patch.state = 'IDLE';

    const trip = e.tripId ? await this.prisma.deliveryTrip.findUnique({ where: { code: e.tripId } }) : await this.activeTripOf(robot.id);
    if (e.type === 'STATUS') {
      await this.prisma.robot.update({ where: { id: robot.id }, data: patch });
      this.telemetry({ ...robot, ...patch } as Robot, trip, e.progress ?? null);
      return;
    }

    switch (e.type) {
      case 'AT_PICKUP':
        if (trip) await this.advance(trip.id, 'AT_PICKUP', {}, 'trip.at_pickup');
        break;
      case 'MOVING':
        break;
      case 'ARRIVED':
        if (trip) await this.advance(trip.id, 'ARRIVED', { arrivedAt: new Date() }, 'trip.arrived');
        break;
      case 'DELIVERED':
        if (trip && (await this.advance(trip.id, 'DELIVERED', { deliveredAt: new Date() }, 'trip.delivered'))) {
          const items = await this.prisma.tripItem.findMany({ where: { tripId: trip.id } });
          await this.prisma.orderItem.updateMany({ where: { id: { in: items.map((i) => i.orderItemId) }, status: 'PICKED_UP' }, data: { status: 'DELIVERED' } });
        }
        break;
      case 'RETURNING':
        if (trip) await this.advance(trip.id, 'RETURNING', {}, null);
        break;
      case 'DONE':
        if (trip && (trip.stage === 'DELIVERED' || trip.stage === 'RETURNING')) await this.advance(trip.id, 'DONE', { endedAt: new Date() }, 'trip.done');
        patch.state = robot.state === 'DISABLED' ? 'DISABLED' : 'IDLE';
        patch.error = null;
        if ((patch.battery ?? robot.battery) < cfg().minBattery && robot.state !== 'DISABLED') {
          patch.state = 'CHARGING';
          await this.robots.adapter(vendor).diSac(robot.externalId).catch(() => undefined);
        }
        break;
      case 'LOW_BATTERY':
        if (robot.state === 'IDLE') {
          patch.state = 'CHARGING';
          await this.robots.adapter(vendor).diSac(robot.externalId).catch(() => undefined);
        }
        break;
      case 'FAILED':
        patch.state = 'ERROR';
        patch.error = e.reason ?? 'Robot báo lỗi';
        if (trip) await this.fail(trip.id, e.reason ?? 'Robot báo lỗi');
        break;
    }
    await this.prisma.robot.update({ where: { id: robot.id }, data: patch });
    await this.emitRobot(robot.id);
  }

  private async activeTripOf(robotId: string) {
    return this.prisma.deliveryTrip.findFirst({ where: { robotId, stage: { in: ACTIVE_STAGES } }, orderBy: { createdAt: 'desc' } });
  }

  /** Chuyển bước chuyến theo bảng trạng thái; bỏ qua sự kiện đến trễ/lặp. */
  private async advance(tripId: string, to: TripStage, data: Partial<DeliveryTrip>, event: Parameters<EventsService['append']>[1] | null) {
    const ok = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTrip(tx, tripId);
      if (t.stage === to || !TRIP_TRANSITIONS[t.stage].includes(to)) return false;
      await tx.deliveryTrip.update({ where: { id: tripId }, data: { ...data, stage: to, version: { increment: 1 } } });
      if (event) await this.emitTrip(tx, event, tripId);
      return true;
    });
    this.events.wake();
    return ok;
  }

  /** Chuyến lỗi: món quay lại hàng chờ Ready để giao bằng robot khác (mục 5.3, 15). */
  async fail(tripId: string, reason: string, robotState?: 'ERROR' | 'OFFLINE') {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTrip(tx, tripId);
      if (!TRIP_TRANSITIONS[t.stage].includes('FAILED')) return;
      await tx.deliveryTrip.update({ where: { id: tripId }, data: { stage: 'FAILED', failReason: reason, endedAt: new Date(), version: { increment: 1 } } });
      await tx.orderItem.updateMany({ where: { id: { in: t.items.map((i) => i.orderItemId) }, status: { in: ['ASSIGNED', 'PICKED_UP'] } }, data: { status: 'READY' } });
      if (t.robot && robotState) await tx.robot.update({ where: { id: t.robot.id }, data: { state: robotState, error: reason } });
      await this.emitTrip(tx, 'trip.failed', tripId);
    });
    this.events.wake();
    setImmediate(() => void this.tick());
  }

  /** Hỏi trạng thái robot; im lặng quá lâu → mất kết nối, chuyến dở dang chuyển lỗi. */
  private async pollRobots() {
    const list = await this.prisma.robot.findMany({ where: { state: { not: 'DISABLED' }, vendor: { in: ['SIMULATED', 'MQTT'] } } });
    for (const r of list) {
      let online = false;
      let battery = r.battery;
      try {
        const s = await this.robots.adapter(r.vendor).layTrangThai(r.externalId);
        online = s.online;
        battery = s.battery;
      } catch {
        online = false;
      }
      if (online && r.state === 'OFFLINE') {
        await this.prisma.robot.update({ where: { id: r.id }, data: { state: 'IDLE', error: null, lastSeenAt: new Date(), battery } });
        await this.emitRobot(r.id);
      } else if (online) {
        if (battery !== r.battery) await this.prisma.robot.update({ where: { id: r.id }, data: { battery, lastSeenAt: new Date() } });
      } else if (r.state !== 'OFFLINE') {
        await this.prisma.robot.update({ where: { id: r.id }, data: { state: 'OFFLINE', error: 'Mất kết nối' } });
        const trip = await this.activeTripOf(r.id);
        if (trip) await this.fail(trip.id, 'Robot mất kết nối');
        await this.emitRobot(r.id);
      }
    }
  }

  /** Chuyển bàn: cập nhật bàn đích của chuyến đang chạy; chuyến đang đi thì gửi lại lệnh giao. */
  private async retarget(tx: Tx, sessionId: string) {
    const [table] = await currentTables(tx, sessionId);
    if (!table) return [];
    const trips = await tx.deliveryTrip.findMany({ where: { sessionId, stage: { in: ['ASSIGNED', 'AT_PICKUP', 'MOVING'] } } });
    const moving: string[] = [];
    for (const t of trips) {
      if (t.tableId === table.id) continue;
      await tx.deliveryTrip.update({ where: { id: t.id }, data: { tableId: table.id, tableCode: table.code, version: { increment: 1 } } });
      await this.emitTrip(tx, 'trip.assigned', t.id);
      if (t.stage === 'MOVING') moving.push(t.id);
    }
    return moving;
  }

  private async reroute(tripIds: string[]) {
    for (const id of tripIds) {
      const trip = await this.prisma.deliveryTrip.findUnique({ where: { id }, include: { robot: true, items: true } });
      if (trip?.stage === 'MOVING') await this.sendGo(trip);
    }
  }

  // ---------- Robot admin ----------

  async setRobotEnabled(p: Principal, id: string, enabled: boolean) {
    const r = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    if (!enabled && r.state === 'BUSY') throw new ConflictException('Robot đang giao, hãy chờ xong chuyến hoặc chuyển nhân viên');
    await this.prisma.robot.update({ where: { id }, data: { state: enabled ? 'IDLE' : 'DISABLED', error: null } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actorId: actorId(p), action: enabled ? 'robot.enable' : 'robot.disable', entity: 'robot', entityId: id }));
    if (enabled && r.vendor === 'SIMULATED') this.robots.sim.inject(r.externalId, 'phuc_hoi');
    await this.emitRobot(id);
    return this.robotDto(id);
  }

  async charge(id: string) {
    const r = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    if (r.state === 'BUSY') throw new ConflictException('Robot đang giao');
    await this.robots.adapter(r.vendor).diSac(r.externalId);
    await this.prisma.robot.update({ where: { id }, data: { state: 'CHARGING' } });
    await this.emitRobot(id);
    return this.robotDto(id);
  }

  async simulate(id: string, fault: 'bi_ket' | 'pin_yeu' | 'mat_ket_noi' | 'phuc_hoi') {
    const r = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    if (r.vendor !== 'SIMULATED') throw new ConflictException('Chỉ gây lỗi được trên robot giả lập');
    this.robots.sim.inject(r.externalId, fault);
    if (fault === 'phuc_hoi') await this.prisma.robot.update({ where: { id }, data: { state: 'IDLE', error: null, location: 'CHO' } });
    await this.chain;
    await this.tick();
    return this.robotDto(id);
  }

  /** Nhân viên báo bước của robot thủ công (mức tích hợp 1). */
  async manualReport(tripId: string, type: 'AT_PICKUP' | 'ARRIVED' | 'DELIVERED') {
    const trip = await this.prisma.deliveryTrip.findUnique({ where: { id: tripId }, include: { robot: true } });
    if (!trip?.robot || trip.robot.vendor !== 'MANUAL') throw new ConflictException('Chỉ dùng cho robot thủ công');
    this.robots.manual.report(trip.robot.externalId, trip.code, type);
    if (type === 'DELIVERED') this.robots.manual.report(trip.robot.externalId, trip.code, 'DONE');
    await this.chain;
    return this.tripDto(tripId);
  }

  // ---------- DTO & phát sự kiện ----------

  private async lockTrip(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM delivery_trips WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException('Không tìm thấy chuyến');
    return tx.deliveryTrip.findUniqueOrThrow({ where: { id }, include: { robot: true, items: true } });
  }

  async tripDto(id: string, db: Tx = this.prisma): Promise<TripDto> {
    const t = await db.deliveryTrip.findUniqueOrThrow({ where: { id }, include: { robot: true, items: true } });
    const items = await db.orderItem.findMany({ where: { id: { in: t.items.map((i) => i.orderItemId) } } });
    return {
      id: t.id,
      code: t.code,
      robotId: t.robotId,
      robotCode: t.robot?.code ?? null,
      sessionId: t.sessionId,
      tableId: t.tableId,
      tableCode: t.tableCode,
      stage: t.stage,
      failReason: t.failReason,
      createdAt: t.createdAt.toISOString(),
      assignedAt: t.assignedAt?.toISOString() ?? null,
      pickedUpAt: t.pickedUpAt?.toISOString() ?? null,
      arrivedAt: t.arrivedAt?.toISOString() ?? null,
      deliveredAt: t.deliveredAt?.toISOString() ?? null,
      items: items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, station: i.station, status: i.status })),
    };
  }

  async trips(active: boolean) {
    const rows = await this.prisma.deliveryTrip.findMany({
      where: active ? { stage: { in: ACTIVE_STAGES } } : { createdAt: { gt: new Date(Date.now() - 6 * 3600_000) } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(rows.map((r) => this.tripDto(r.id)));
  }

  async robotDto(id: string): Promise<RobotDto> {
    const r = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    const trip = await this.activeTripOf(id);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      vendor: r.vendor,
      state: r.state,
      battery: r.battery,
      location: r.location,
      error: r.error,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      tripId: trip?.id ?? null,
    };
  }

  async robotList() {
    const rows = await this.prisma.robot.findMany({ orderBy: { code: 'asc' } });
    return Promise.all(rows.map((r) => this.robotDto(r.id)));
  }

  private async emitTrip(tx: Tx, type: Parameters<EventsService['append']>[1], tripId: string) {
    const trip = await this.tripDto(tripId, tx);
    await this.events.append(tx, type, 'trip', tripId, {
      sessionId: trip.sessionId,
      tableIds: [trip.tableId],
      stations: [...new Set(trip.items.map((i) => i.station))],
      trip,
    });
  }

  private async emitRobot(id: string) {
    const robot = await this.robotDto(id);
    await this.prisma.$transaction((tx) => this.events.append(tx, 'robot.status', 'robot', id, { robot }));
    this.events.wake();
  }

  private telemetry(robot: Robot, trip: DeliveryTrip | null, progress: number | null) {
    const t: RobotTelemetry = {
      robotId: robot.id,
      code: robot.code,
      battery: robot.battery,
      location: robot.location,
      progress,
      tripCode: trip?.code ?? null,
      tableCode: trip?.tableCode ?? null,
      stage: trip?.stage ?? null,
    };
    this.gateway.emitVolatile('robot.telemetry', t, [R.dispatch, R.dashboard, ...(trip ? [R.table(trip.tableId)] : [])]);
  }
}
