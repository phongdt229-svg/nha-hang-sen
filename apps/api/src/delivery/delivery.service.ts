import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { DeliveryTask, Prisma, Robot, RobotVendor } from '@prisma/client';
import type { RobotEvent, SimFault } from '@nhs/robot-adapters';
import {
  assertTransition,
  DELIVERY_ACTIVE,
  DELIVERY_TRANSITIONS,
  rooms as R,
  type DeliveryEventDto,
  type DeliveryProblem,
  type DeliveryStatus,
  type DeliveryTaskDto,
  type EventType,
  type ReadyGroupDto,
  type RobotDto,
  type RobotLocationDto,
  type RobotTelemetry,
} from '@nhs/types';
import { actorId, type Principal } from '../auth/principal';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../events/events.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { RealtimeGateway } from '../events/realtime.gateway';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { currentTables } from '../sessions/session.helpers';
import { deliveryConfig, tableLocation } from './delivery.config';
import { RobotGateway } from './robot-gateway';

type TaskFull = DeliveryTask & { robot: Robot | null; items: { orderItemId: string }[] };

/** Luồng chính (RD-11). Sự kiện robot chỉ được "đi tiếp" dọc luồng này, không vượt qua cổng cần người xác nhận. */
const HAPPY: DeliveryStatus[] = ['PENDING', 'ASSIGNING', 'ASSIGNED', 'ROBOT_ACCEPTED', 'GOING_TO_PICKUP', 'ARRIVED_PICKUP', 'LOADING', 'GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER', 'DELIVERED', 'RETURNING', 'COMPLETED'];
/** Chỉ nhân viên/khách mới mở được các cổng này: đã đặt món lên robot (MB-13), đã nhận món (MB-14). */
const GATES: DeliveryStatus[] = ['LOADING', 'DELIVERED'];
const TO_PICKUP: DeliveryStatus[] = ['ASSIGNING', 'ASSIGNED', 'ROBOT_ACCEPTED', 'GOING_TO_PICKUP'];
const BEFORE_LOADED: DeliveryStatus[] = ['PENDING', ...TO_PICKUP, 'ARRIVED_PICKUP'];
/** Robot đang mang nhiệm vụ (bị giữ, không nhận task khác). */
const ROBOT_HELD: DeliveryStatus[] = [...TO_PICKUP, 'ARRIVED_PICKUP', 'LOADING', 'GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER', 'DELIVERED', 'RETURNING', 'FAILED'];
/** Robot đang chạy trên đường (gặp vật cản / pin cạn thì task lỗi). */
const MOVING: DeliveryStatus[] = [...TO_PICKUP, 'LOADING', 'GOING_TO_TABLE'];
const TERMINAL: DeliveryStatus[] = ['COMPLETED', 'CANCELLED', 'MANUAL_TAKEOVER'];
const COOKING = ['CONFIRMED', 'SENT', 'FALLBACK', 'KDS_ACK', 'PREPARING'] as const;

const STATUS_EVENT: Partial<Record<DeliveryStatus, EventType>> = {
  ASSIGNING: 'delivery.task.assigned',
  ARRIVED_PICKUP: 'delivery.task.ready_for_pickup',
  LOADING: 'delivery.task.picked_up',
  ARRIVED_TABLE: 'delivery.robot.arrived',
  DELIVERED: 'delivery.customer.confirmed',
  COMPLETED: 'delivery.task.completed',
  FAILED: 'delivery.task.failed',
  MANUAL_TAKEOVER: 'delivery.task.manual_takeover',
  CANCELLED: 'delivery.task.cancelled',
};

/** Tên sự kiện nhật ký (RD-15) khi task đi vào từng trạng thái. */
const STATUS_LOG: Partial<Record<DeliveryStatus, string>> = {
  ASSIGNING: 'ROBOT_ASSIGNED',
  ASSIGNED: 'COMMAND_SENT',
  ROBOT_ACCEPTED: 'ROBOT_ACCEPTED',
  GOING_TO_PICKUP: 'GOING_TO_PICKUP',
  ARRIVED_PICKUP: 'ARRIVED_PICKUP',
  LOADING: 'ITEMS_LOADED',
  GOING_TO_TABLE: 'DEPARTED_PICKUP',
  ARRIVED_TABLE: 'ARRIVED_TABLE',
  WAITING_CUSTOMER: 'CUSTOMER_NOTIFIED',
  DELIVERED: 'DELIVERED',
  RETURNING: 'RETURN_STARTED',
  COMPLETED: 'TASK_COMPLETED',
  FAILED: 'TASK_FAILED',
  MANUAL_TAKEOVER: 'MANUAL_TAKEOVER',
  CANCELLED: 'TASK_CANCELLED',
  PENDING: 'REASSIGNED',
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Delivery Service (RD, MB): tạo task khi món READY, gán robot, theo dõi sự kiện robot,
 * xử lý lỗi (retry, reassign, giao tay), xác nhận của nhân viên/khách. Không biết loại robot.
 */
@Injectable()
export class DeliveryService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Delivery');
  private timer?: NodeJS.Timeout;
  private reconcileTimer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private bootedAt = Date.now();
  /** Xử lý sự kiện robot tuần tự để không có hai sự kiện cùng sửa một task. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly outbox: OutboxPublisher,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly gateway: RobotGateway,
  ) {}

  onModuleInit() {
    this.gateway.onEvent((vendor, e) => {
      if (this.stopped) return;
      this.chain = this.chain.then(() => (this.stopped ? undefined : this.onRobotEvent(vendor, e))).catch((err) => this.logger.error(err instanceof Error ? err.stack : err));
    });
    // Món vừa xong → điều phối ngay, không chờ nhịp kế tiếp.
    this.outbox.on('kitchen.ready', async () => {
      setImmediate(() => void this.tick());
    });
    // Khách chuyển bàn khi robot đang giao → đổi bàn đích (mục 15).
    this.outbox.on('session.moved', async (tx, e) => {
      const reroute = await this.retarget(tx, (e.data as { sessionId: string }).sessionId);
      if (reroute.length) setImmediate(() => void this.resend(reroute));
    });
    this.outbox.on('session.merged', async (tx, e) => {
      const d = e.data as { sessionId: string; sourceSessionId: string };
      await tx.deliveryTask.updateMany({ where: { sessionId: d.sourceSessionId, status: { in: [...DELIVERY_ACTIVE] } }, data: { sessionId: d.sessionId } });
    });
  }

  async onApplicationBootstrap() {
    this.bootedAt = Date.now();
    await this.gateway.loadLocations();
    for (const r of await this.prisma.robot.findMany()) {
      await this.gateway.connect(r).catch((e) => this.logger.warn(`Không kết nối robot ${r.code}: ${errMsg(e)}`));
    }
    // Chờ robot báo trạng thái rồi đối chiếu task dở dang từ lần chạy trước (MB-21 Scenario 6).
    this.reconcileTimer = setTimeout(() => void this.reconcile(), deliveryConfig().reconcileDelayMs);
    if (process.env.DISPATCH_AUTO !== 'false') this.timer = setInterval(() => void this.tick(), deliveryConfig().tickMs);
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconcileTimer);
    await this.chain.catch(() => undefined);
    while (this.ticking) await new Promise((r) => setTimeout(r, 20));
  }

  // ───────────── Hàng chờ & tạo task ─────────────

  async readyQueue(): Promise<ReadyGroupDto[]> {
    const items = await this.prisma.orderItem.findMany({
      where: { status: 'READY', order: { session: { status: { not: 'CLOSED' } } }, NOT: { id: { in: await this.activeItemIds(this.prisma) } } },
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
    return groups.sort((a, b) => b.waitingSeconds - a.waitingSeconds);
  }

  private async activeItemIds(db: Tx) {
    const rows = await db.deliveryTaskItem.findMany({ where: { task: { status: { in: [...DELIVERY_ACTIVE, 'DELIVERED', 'RETURNING'] } } }, select: { orderItemId: true } });
    return rows.map((r) => r.orderItemId);
  }

  /**
   * Tạo Delivery Task cho các món READY (RD-03). Chạy lại với món đã nằm trong task khác thì trả về
   * task đó — POST trùng không tạo hai task cho cùng món (MB-21 Scenario 5).
   */
  private async createTaskTx(tx: Tx, orderItemIds: string[], priority: number, actor?: string): Promise<{ task: DeliveryTask; created: boolean }> {
    await tx.$queryRaw`SELECT id FROM order_items WHERE id = ANY(${orderItemIds}::text[]) ORDER BY id FOR UPDATE`;
    const existing = await tx.deliveryTaskItem.findFirst({
      where: { orderItemId: { in: orderItemIds }, task: { status: { in: [...DELIVERY_ACTIVE, 'DELIVERED', 'RETURNING'] } } },
      include: { task: true },
    });
    if (existing) return { task: existing.task, created: false };
    const items = await tx.orderItem.findMany({ where: { id: { in: orderItemIds }, status: 'READY' }, include: { order: { select: { sessionId: true } } } });
    if (items.length === 0) throw new ConflictException('Món chưa sẵn sàng hoặc đã được giao');
    const sessionIds = [...new Set(items.map((i) => i.order.sessionId))];
    if (sessionIds.length > 1) throw new ConflictException('Một chuyến robot chỉ giao cho một bàn');
    const [table] = await currentTables(tx, sessionIds[0]);
    if (!table) throw new ConflictException('Phiên không còn bàn để giao');
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('delivery_tasks_seq_no_seq') AS n`;
    const task = await tx.deliveryTask.create({
      data: {
        seqNo: Number(n),
        code: `DT${String(n).padStart(4, '0')}`,
        sessionId: sessionIds[0],
        tableId: table.id,
        tableCode: table.code,
        priority,
        pickupLocation: deliveryConfig().pickupLocation,
        deliveryLocation: tableLocation(table.code),
        items: { create: items.map((i) => ({ orderItemId: i.id })) },
      },
    });
    await tx.orderItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { status: 'ASSIGNED', deliveryMode: 'ROBOT' } });
    await this.log(tx, task.id, 'TASK_CREATED', null, null, { items: items.map((i) => `${i.qty} ${i.name}`), by: actor ?? 'system' });
    await this.emitTask(tx, 'delivery.task.created', task.id);
    return { task, created: true };
  }

  /** Bếp/phục vụ bấm "Giao bằng robot" (RD-20 SEND_TO_ROBOT): tạo task ngay, bỏ qua thời gian gom món. */
  async create(p: Principal, orderItemIds: string[]) {
    const { task, created } = await this.prisma.$transaction((tx) => this.createTaskTx(tx, orderItemIds, 1, actorId(p)));
    this.events.wake();
    if (created) setImmediate(() => void this.tick());
    return this.taskDto(task.id);
  }

  // ───────────── Nhịp điều phối ─────────────

  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.checkHeartbeats();
      await this.checkCustomerWait();
      await this.retryDue();
      await this.createFromQueue();
      await this.assignPending();
      await this.checkIdleBatteries();
    } catch (e) {
      this.logger.error(e instanceof Error ? e.stack : e);
    } finally {
      this.ticking = false;
    }
  }

  private async createFromQueue() {
    const { batchPolicy, batchWindowMs, maxTaskItems } = deliveryConfig();
    for (const g of await this.readyQueue()) {
      const robotItems = g.items.filter((i) => i.deliveryMode === 'ROBOT');
      if (robotItems.length === 0 || !g.tableId) continue;
      const due =
        batchPolicy === 'IMMEDIATE' ||
        g.stillCooking === 0 ||
        robotItems.length >= maxTaskItems ||
        (batchPolicy === 'WAIT_X_SECONDS' && g.waitingSeconds * 1000 >= batchWindowMs);
      if (!due) continue;
      try {
        await this.prisma.$transaction((tx) => this.createTaskTx(tx, robotItems.slice(0, maxTaskItems).map((i) => i.id), 0));
        this.events.wake();
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
      }
    }
  }

  private async assignPending() {
    const pending = await this.prisma.deliveryTask.findMany({ where: { status: 'PENDING' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
    for (const t of pending) {
      const robot = await this.pickRobot(t);
      if (robot) await this.assign(t.id, robot.id, null);
    }
  }

  /** FIFO + robot gần nhất (RD-19 MVP): ưu tiên robot đang ở bếp/vị trí gốc, rồi pin cao. */
  private async pickRobot(task: DeliveryTask) {
    const { batteryAccept, heartbeatTimeoutMs } = deliveryConfig();
    const fresh = new Date(Date.now() - heartbeatTimeoutMs);
    const busy = await this.prisma.deliveryTask.findMany({ where: { status: { in: ROBOT_HELD }, robotId: { not: null } }, select: { robotId: true } });
    const candidates = (
      await this.prisma.robot.findMany({
        where: {
          state: { in: ['IDLE', 'CHARGING'] },
          paused: false,
          battery: { gte: batteryAccept },
          id: { notIn: busy.map((b) => b.robotId!) },
          OR: [{ vendor: 'MANUAL' }, { lastSeenAt: { gte: fresh } }],
        },
      })
    ).filter((r) => this.gateway.supports(r, task.pickupLocation) && this.gateway.supports(r, task.deliveryLocation));
    if (candidates.length === 0) return null;
    // Robot đã hỏng với task này thì để sau cùng (reassign phải sang robot khác nếu có).
    const tried = new Set(
      (await this.prisma.deliveryEvent.findMany({ where: { taskId: task.id, type: { in: ['ASSIGN_FAILED', 'REASSIGNED'] } }, select: { robotId: true } })).map((e) => e.robotId),
    );
    const home = (r: Robot) => (r.location === task.pickupLocation || r.location === 'ROBOT_HOME' ? 0 : 1);
    return candidates.sort((a, b) => Number(tried.has(a.id)) - Number(tried.has(b.id)) || home(a) - home(b) || b.battery - a.battery || a.code.localeCompare(b.code))[0];
  }

  /**
   * Gán robot (RD-09). Gọi lại nhiều lần / đồng thời vẫn chỉ một robot một task (MB-21 Scenario 5):
   * task bị khóa dòng, chỉ PENDING mới được gán.
   */
  async assign(taskId: string, robotId: string | null, p: Principal | null) {
    const r = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (t.status !== 'PENDING') {
        if (robotId && t.robotId && t.robotId !== robotId) throw new ConflictException(`Task đã giao cho robot khác (${t.robot?.code})`);
        return null;
      }
      const robot = robotId ? await this.lockRobot(tx, robotId) : null;
      if (!robot) throw new NotFoundException('Không tìm thấy robot');
      const holding = await tx.deliveryTask.count({ where: { robotId: robot.id, status: { in: ROBOT_HELD } } });
      if (holding > 0 || !['IDLE', 'CHARGING'].includes(robot.state) || robot.paused) throw new ConflictException(`Robot ${robot.code} đang bận hoặc không sẵn sàng`);
      if (robot.battery < deliveryConfig().batteryAccept) throw new ConflictException(`Robot ${robot.code} pin ${robot.battery}% dưới ngưỡng nhận task`);
      if (!this.gateway.supports(robot, t.pickupLocation) || !this.gateway.supports(robot, t.deliveryLocation)) {
        throw new ConflictException(`Robot ${robot.code} không tới được ${t.deliveryLocation}`);
      }
      await this.move(tx, t, 'ASSIGNING', { robotId: robot.id, assignAttempts: { increment: 1 }, assignedAt: new Date() }, { robotId: robot.id, by: p ? actorId(p) : 'scheduler' });
      await tx.robot.update({ where: { id: robot.id }, data: { state: 'BUSY', error: null } });
      if (p) await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.assign', entity: 'delivery_task', entityId: t.id, after: { robot: robot.code } });
      return robot;
    });
    this.events.wake();
    if (!r) return this.taskDto(taskId);
    await this.emitRobot(r.id);
    const t = await this.prisma.deliveryTask.findUniqueOrThrow({ where: { id: taskId } });
    try {
      await this.gateway.command(r, 'goTo(pickup)', (a, id) => a.goTo(id, t.pickupLocation, { taskId: t.code, purpose: 'PICKUP' }));
      await this.walkTo(taskId, 'ASSIGNED', {});
    } catch (e) {
      await this.assignFailed(taskId, r, errMsg(e));
    }
    return this.taskDto(taskId);
  }

  /** Lệnh gán không tới được robot: trả task về PENDING để thử robot khác; quá max_robot_assignment_retry thì FAILED. */
  private async assignFailed(taskId: string, robot: Robot, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (t.status !== 'ASSIGNING') return;
      await tx.robot.update({ where: { id: robot.id }, data: { state: robot.state === 'BUSY' ? 'IDLE' : robot.state, error: reason, lastErrorAt: new Date() } });
      if (t.assignAttempts >= deliveryConfig().maxAssignRetry) {
        await this.failTx(tx, t, 'API_TIMEOUT', `Không giao được lệnh cho robot sau ${t.assignAttempts} lần: ${reason}`);
      } else {
        await this.log(tx, t.id, 'ASSIGN_FAILED', robot.id, null, { reason });
        await this.move(tx, t, 'PENDING', { robotId: null }, null, 'delivery.task.updated', false);
      }
    });
    this.events.wake();
    await this.emitRobot(robot.id);
  }

  // ───────────── Sự kiện từ robot ─────────────

  private async onRobotEvent(vendor: RobotVendor, e: RobotEvent) {
    const robot = await this.prisma.robot.findFirst({ where: { vendor, externalId: e.robotId } });
    if (!robot) return;
    const { batteryCritical, batteryAccept } = deliveryConfig();
    const patch: Prisma.RobotUpdateInput = { lastSeenAt: new Date() };
    if (e.battery !== undefined) patch.battery = e.battery;
    if (e.batterySimulated !== undefined) patch.telemetrySimulated = e.batterySimulated;
    if (e.location) patch.location = e.location;
    if (robot.state === 'OFFLINE' && e.type !== 'ROBOT_OFFLINE') {
      patch.state = (await this.heldTask(robot.id)) ? 'BUSY' : 'IDLE';
      patch.error = null;
    }

    let task = e.taskId ? await this.prisma.deliveryTask.findUnique({ where: { code: e.taskId } }) : await this.heldTask(robot.id);
    if (task && task.robotId !== robot.id) task = null; // sự kiện của task cũ đã chuyển robot khác

    switch (e.type) {
      case 'ROBOT_OFFLINE':
        patch.state = 'OFFLINE';
        patch.error = e.reason ?? 'Mất kết nối';
        patch.lastErrorAt = new Date();
        if (task && MOVING.concat(['ARRIVED_PICKUP', 'ARRIVED_TABLE', 'WAITING_CUSTOMER']).includes(task.status)) await this.fail(task.id, 'OFFLINE', patch.error as string);
        break;
      case 'ROBOT_TASK_ACCEPTED':
        if (task) await this.walkTo(task.id, 'ROBOT_ACCEPTED', {});
        break;
      case 'ROBOT_LOCATION_CHANGED':
        if (task && TO_PICKUP.includes(task.status)) await this.walkTo(task.id, 'GOING_TO_PICKUP', { startedAt: new Date() });
        if (task?.problem === 'OBSTACLE') await this.prisma.deliveryTask.update({ where: { id: task.id }, data: { problem: null, nextRetryAt: null } });
        break;
      case 'ROBOT_ARRIVED_PICKUP':
        if (task) await this.walkTo(task.id, 'ARRIVED_PICKUP', { problem: null, retryCount: 0 });
        break;
      case 'ROBOT_ARRIVED_TABLE':
        if (task && (await this.walkTo(task.id, 'ARRIVED_TABLE', { arrivedAt: new Date(), problem: null, retryCount: 0 }))) {
          await this.walkTo(task.id, 'WAITING_CUSTOMER', {});
        }
        break;
      case 'ROBOT_CUSTOMER_CONFIRMED':
        if (task?.status === 'WAITING_CUSTOMER') await this.deliver(task.id, 'ROBOT_BUTTON', null);
        break;
      case 'ROBOT_OBSTACLE':
        patch.error = e.reason ?? 'Vật cản';
        patch.lastErrorAt = new Date();
        if (task && MOVING.includes(task.status)) await this.obstacle(task.id, patch.error as string);
        else if (task?.status === 'RETURNING') patch.state = 'ERROR';
        break;
      case 'ROBOT_OBSTACLE_CLEARED':
        patch.error = null;
        if (task && task.problem === 'OBSTACLE' && task.status !== 'FAILED') await this.prisma.deliveryTask.update({ where: { id: task.id }, data: { nextRetryAt: new Date() } });
        break;
      case 'ROBOT_ERROR':
        patch.state = 'ERROR';
        patch.error = e.reason ?? 'Robot báo lỗi';
        patch.lastErrorAt = new Date();
        if (task && !['FAILED', 'DELIVERED', 'RETURNING'].includes(task.status)) await this.fail(task.id, 'ROBOT_ERROR', patch.error as string);
        break;
      case 'ROBOT_TASK_COMPLETED':
        if (task && (task.status === 'RETURNING' || task.status === 'DELIVERED')) await this.walkTo(task.id, 'COMPLETED', { completedAt: new Date() });
        if (!(await this.heldTask(robot.id)) && !['DISABLED', 'OFFLINE', 'CHARGING'].includes(robot.state)) patch.state = 'IDLE';
        break;
      case 'ROBOT_ARRIVED_HOME':
        if (!(await this.heldTask(robot.id)) && robot.state === 'BUSY') patch.state = 'IDLE';
        break;
      case 'ROBOT_ARRIVED_CHARGER':
        patch.state = 'CHARGING';
        break;
    }

    // Pin (MB-15): dưới ngưỡng nguy hiểm khi đang giao → dừng, về sạc, chuyển nhân viên.
    const battery = (patch.battery as number | undefined) ?? robot.battery;
    const held = await this.heldTask(robot.id);
    if (battery < batteryCritical && held && (MOVING.includes(held.status) || ['ARRIVED_PICKUP', 'ARRIVED_TABLE', 'WAITING_CUSTOMER'].includes(held.status))) {
      await this.fail(held.id, 'LOW_BATTERY', `Pin robot còn ${battery}%, dưới ngưỡng ${batteryCritical}%`);
      setImmediate(() => void this.gateway.command(robot, 'returnHome(charge)', (a, id) => a.returnHome(id, { charge: true })).catch(() => undefined));
    }
    if (robot.state === 'CHARGING' && battery >= 100 && !patch.state) patch.state = 'IDLE';
    if (battery < batteryAccept && robot.state === 'IDLE' && !held && patch.state === undefined) {
      // Pin dưới ngưỡng nhận việc: về trạm sạc (vạch 5 trên sa bàn).
      patch.state = 'CHARGING';
      setImmediate(() => void this.gateway.command(robot, 'returnHome(charge)', (a, id) => a.returnHome(id, { charge: true })).catch(() => undefined));
    }

    const updated = await this.prisma.robot.update({ where: { id: robot.id }, data: patch });
    const changed = updated.state !== robot.state || updated.error !== robot.error || updated.battery !== robot.battery || updated.paused !== robot.paused || (updated.location !== robot.location && updated.location !== 'MOVING');
    if (changed) await this.emitRobot(robot.id);
    this.telemetry(updated, held, e);
  }

  private heldTask(robotId: string) {
    return this.prisma.deliveryTask.findFirst({ where: { robotId, status: { in: ROBOT_HELD } }, orderBy: { createdAt: 'desc' } });
  }

  /** Vật cản (RD-16 Case 3): tự thử lại tối đa max_navigation_retry lần, vẫn kẹt thì FAILED chờ nhân viên. */
  private async obstacle(taskId: string, reason: string) {
    const { maxNavRetry, navRetryDelayMs } = deliveryConfig();
    let exhausted = false;
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (!MOVING.includes(t.status)) return;
      await this.log(tx, t.id, 'ROBOT_OBSTACLE', t.robotId, null, { reason, retry: t.retryCount + 1 });
      if (t.retryCount >= maxNavRetry) {
        exhausted = true;
        return this.failTx(tx, t, 'OBSTACLE', `${reason} — đã thử lại ${t.retryCount} lần`);
      }
      await tx.deliveryTask.update({ where: { id: t.id }, data: { problem: 'OBSTACLE', retryCount: { increment: 1 }, nextRetryAt: new Date(Date.now() + navRetryDelayMs), version: { increment: 1 } } });
      await this.emitTask(tx, 'delivery.task.updated', t.id);
    });
    this.events.wake();
    if (exhausted) this.logger.warn(`Task ${taskId}: vật cản, hết lượt thử lại`);
  }

  // ───────────── Kiểm tra định kỳ ─────────────

  /** Robot im lặng quá heartbeat timeout → OFFLINE; task đang chạy chuyển FAILED chờ nhân viên (RD-16 Case 1). */
  private async checkHeartbeats() {
    const { heartbeatTimeoutMs, reconcileDelayMs } = deliveryConfig();
    if (Date.now() - this.bootedAt < Math.max(heartbeatTimeoutMs, reconcileDelayMs)) return;
    const stale = await this.prisma.robot.findMany({
      where: {
        vendor: { not: 'MANUAL' },
        state: { notIn: ['OFFLINE', 'DISABLED'] },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(Date.now() - heartbeatTimeoutMs) } }],
      },
    });
    for (const r of stale) {
      await this.prisma.robot.update({ where: { id: r.id }, data: { state: 'OFFLINE', error: 'Mất kết nối (không nhận được nhịp)', lastErrorAt: new Date() } });
      const t = await this.heldTask(r.id);
      if (t && !['FAILED', 'DELIVERED', 'RETURNING'].includes(t.status)) await this.fail(t.id, 'OFFLINE', `Robot ${r.code} mất kết nối`);
      await this.emitRobot(r.id);
    }
  }

  /** Khách không có mặt (RD-14): quá customer_wait_timeout thì báo nhân viên, không tự coi là đã giao. */
  private async checkCustomerWait() {
    const due = await this.prisma.deliveryTask.findMany({
      where: { status: 'WAITING_CUSTOMER', customerNotifiedAt: null, arrivedAt: { lte: new Date(Date.now() - deliveryConfig().customerWaitMs) } },
    });
    for (const t of due) {
      await this.prisma.$transaction(async (tx) => {
        await tx.deliveryTask.update({ where: { id: t.id }, data: { problem: 'CUSTOMER_ABSENT', customerNotifiedAt: new Date(), version: { increment: 1 } } });
        await this.log(tx, t.id, 'CUSTOMER_TIMEOUT', t.robotId, t.deliveryLocation, { waitedSeconds: Math.round((Date.now() - (t.arrivedAt?.getTime() ?? Date.now())) / 1000) });
        await this.emitTask(tx, 'delivery.customer.timeout', t.id);
      });
      this.events.wake();
    }
  }

  /** Đến giờ thử lại sau vật cản: gửi lại lệnh của bước đang dở. */
  private async retryDue() {
    const due = await this.prisma.deliveryTask.findMany({ where: { nextRetryAt: { lte: new Date() }, status: { in: MOVING } }, include: { robot: true, items: true } });
    for (const t of due) {
      await this.prisma.deliveryTask.update({ where: { id: t.id }, data: { nextRetryAt: null } });
      await this.log(this.prisma, t.id, 'NAVIGATION_RETRY', t.robotId, null, { attempt: t.retryCount });
      await this.sendPhaseCommand(t);
    }
  }

  private async checkIdleBatteries() {
    const low = await this.prisma.robot.findMany({ where: { state: 'IDLE', battery: { lt: deliveryConfig().batteryAccept }, vendor: { in: ['SIMULATED', 'MAKEBLOCK'] } } });
    for (const r of low) {
      if (await this.heldTask(r.id)) continue;
      try {
        await this.gateway.command(r, 'returnHome(charge)', (a, id) => a.returnHome(id, { charge: true }));
        await this.prisma.robot.update({ where: { id: r.id }, data: { state: 'CHARGING' } });
        await this.emitRobot(r.id);
      } catch {
        /* lần sau thử lại */
      }
    }
  }

  /**
   * Sau khi server khởi động lại (MB-21 Scenario 6): khôi phục task từ DB, hỏi robot đang làm gì;
   * robot vẫn giữ đúng nhiệm vụ thì chạy tiếp, không thì FAILED để nhân viên retry/giao tay.
   */
  async reconcile() {
    const tasks = await this.prisma.deliveryTask.findMany({ where: { status: { in: [...TO_PICKUP, 'ARRIVED_PICKUP', 'LOADING', 'GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER', 'RETURNING'] }, robotId: { not: null } }, include: { robot: true } });
    for (const t of tasks) {
      if (!t.robot || t.robot.vendor === 'MANUAL') continue;
      let status: Awaited<ReturnType<ReturnType<RobotGateway['adapter']>['getStatus']>> | null = null;
      try {
        status = await this.gateway.adapter(t.robot.vendor).getStatus(t.robot.externalId);
      } catch {
        status = null;
      }
      if (status?.online && status.taskId === t.code) {
        await this.log(this.prisma, t.id, 'RECONCILED', t.robotId, status.location, { mode: status.mode, target: status.target });
        if (t.status === 'ASSIGNING') await this.walkTo(t.id, 'ASSIGNED', {});
        // Robot đã tới nơi trong lúc server tắt (sự kiện "đã tới" bị lỡ): theo trạng thái robot mà đi tiếp.
        if (status.mode === 'WAITING' && status.location === t.deliveryLocation && ['LOADING', 'GOING_TO_TABLE'].includes(t.status)) {
          if (await this.walkTo(t.id, 'ARRIVED_TABLE', { arrivedAt: new Date() })) await this.walkTo(t.id, 'WAITING_CUSTOMER', {});
        } else if (status.mode === 'WAITING' && status.location === t.pickupLocation && TO_PICKUP.includes(t.status)) {
          await this.walkTo(t.id, 'ARRIVED_PICKUP', {});
        }
      } else if (t.status === 'RETURNING') {
        await this.walkTo(t.id, 'COMPLETED', { completedAt: new Date() });
      } else {
        await this.fail(t.id, 'RESTART', status?.online ? 'Máy chủ khởi động lại, robot không còn giữ nhiệm vụ' : 'Máy chủ khởi động lại, chưa liên lạc được robot');
      }
    }
    const robots = await this.prisma.robot.findMany({ where: { state: 'BUSY' } });
    for (const r of robots) if (!(await this.heldTask(r.id))) await this.prisma.robot.update({ where: { id: r.id }, data: { state: 'IDLE' } });
  }

  // ───────────── Thao tác của nhân viên / khách ─────────────

  /** Nhân viên đã đặt món lên robot (MB-13). Có mã khay thì phải khớp mã task (mục 15: quét sai khay bị chặn). */
  async confirmLoaded(p: Principal, taskId: string, trayCode?: string) {
    const current = await this.prisma.deliveryTask.findUnique({ where: { id: taskId } });
    if (!current) throw new NotFoundException('Không tìm thấy delivery task');
    if (trayCode && trayCode.trim().toUpperCase() !== current.code) {
      // Ghi nhận ngoài transaction để lần quét sai vẫn còn trong nhật ký dù thao tác bị từ chối.
      await this.prisma.$transaction(async (tx) => {
        await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.wrong_tray', entity: 'delivery_task', entityId: current.id, after: { trayCode } });
        await this.log(tx, current.id, 'WRONG_TRAY', current.robotId, current.pickupLocation, { trayCode, by: actorId(p) });
      });
      throw new ConflictException({ error: 'WRONG_TRAY', message: `Sai khay: quét ${trayCode}, task này là ${current.code}` });
    }
    const task = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (t.status === 'LOADING' || t.status === 'GOING_TO_TABLE') return null;
      if (t.status !== 'ARRIVED_PICKUP') throw new ConflictException('Robot chưa tới điểm lấy món');
      const [table] = await currentTables(tx, t.sessionId);
      await this.move(
        tx,
        t,
        'LOADING',
        { loadedAt: new Date(), ...(table && table.id !== t.tableId ? { tableId: table.id, tableCode: table.code, deliveryLocation: tableLocation(table.code) } : {}) },
        { by: actorId(p) },
      );
      await tx.orderItem.updateMany({ where: { id: { in: t.items.map((i) => i.orderItemId) }, status: 'ASSIGNED' }, data: { status: 'PICKED_UP' } });
      return tx.deliveryTask.findUniqueOrThrow({ where: { id: t.id }, include: { robot: true, items: true } });
    });
    this.events.wake();
    if (task) await this.sendPhaseCommand(task);
    return this.taskDto(taskId);
  }

  /** Khách bấm "Đã nhận món" trên tablet, hoặc nhân viên xác nhận thay (RD-13, MB-14). */
  async confirmDelivered(p: Principal, taskId: string) {
    const t = await this.prisma.deliveryTask.findUnique({ where: { id: taskId } });
    if (!t) throw new NotFoundException('Không tìm thấy task');
    if (p.kind === 'device' && p.tableId !== t.tableId) throw new ForbiddenException('Task không thuộc bàn này');
    if (t.status === 'DELIVERED' || t.status === 'RETURNING' || t.status === 'COMPLETED') return this.taskDto(taskId);
    if (t.status !== 'ARRIVED_TABLE' && t.status !== 'WAITING_CUSTOMER') throw new ConflictException('Robot chưa tới bàn');
    await this.deliver(taskId, p.kind === 'device' ? 'CUSTOMER' : 'STAFF', p);
    return this.taskDto(taskId);
  }

  private async deliver(taskId: string, by: 'CUSTOMER' | 'STAFF' | 'ROBOT_BUTTON', p: Principal | null) {
    const task = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (t.status === 'ARRIVED_TABLE') await this.move(tx, t, 'WAITING_CUSTOMER', {}, null);
      else if (t.status !== 'WAITING_CUSTOMER') return null;
      await this.log(tx, t.id, by === 'STAFF' ? 'STAFF_CONFIRMED' : 'CUSTOMER_CONFIRMED', t.robotId, t.deliveryLocation, { via: by, by: p ? actorId(p) : null });
      const fresh = await this.lockTask(tx, taskId);
      await this.move(tx, fresh, 'DELIVERED', { deliveredAt: new Date(), confirmedBy: by, problem: null }, null);
      await tx.orderItem.updateMany({ where: { id: { in: t.items.map((i) => i.orderItemId) }, status: { in: ['ASSIGNED', 'PICKED_UP'] } }, data: { status: 'DELIVERED' } });
      return tx.deliveryTask.findUniqueOrThrow({ where: { id: t.id }, include: { robot: true, items: true } });
    });
    this.events.wake();
    if (!task?.robot) return;
    try {
      await this.gateway.command(task.robot, 'returnHome', (a, id) => a.returnHome(id, { taskId: task.code }));
      await this.walkTo(task.id, 'RETURNING', {});
    } catch (e) {
      // Món đã tới khách: task xong; robot cần người đưa về.
      await this.prisma.$transaction(async (tx) => {
        const t = await this.lockTask(tx, task.id);
        await this.log(tx, t.id, 'RETURN_FAILED', t.robotId, null, { reason: errMsg(e) });
        if (t.status === 'DELIVERED') await this.move(tx, t, 'COMPLETED', { completedAt: new Date() }, null);
        await tx.robot.update({ where: { id: task.robot!.id }, data: { state: 'ERROR', error: `Không gọi được robot về: ${errMsg(e)}`, lastErrorAt: new Date() } });
      });
      this.events.wake();
      await this.emitRobot(task.robot.id);
    }
  }

  /** RETRY (MB-17): quay lại bước đang dở trước khi lỗi và gửi lại lệnh cho cùng robot. */
  async retry(p: Principal, taskId: string) {
    const task = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (t.status !== 'FAILED') throw new ConflictException('Chỉ thử lại task đang lỗi');
      if (!t.robot) throw new ConflictException('Task chưa có robot, hãy gán robot');
      if (t.robot.state === 'OFFLINE') throw new ConflictException(`Robot ${t.robot.code} vẫn mất kết nối — chọn "Giao robot khác" hoặc "Nhân viên giao"`);
      const back: DeliveryStatus = !t.failedFrom || t.failedFrom === 'ASSIGNING' ? 'ASSIGNED' : t.failedFrom;
      await this.move(tx, t, back, { problem: null, failureReason: null, retryCount: 0, failedFrom: null, nextRetryAt: null }, { by: actorId(p) }, 'delivery.task.updated', false);
      await this.log(tx, t.id, 'RETRY', t.robotId, null, { to: back, by: actorId(p) });
      if (t.robot.state === 'ERROR') await tx.robot.update({ where: { id: t.robot.id }, data: { state: 'BUSY', error: null } });
      await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.retry', entity: 'delivery_task', entityId: t.id });
      return tx.deliveryTask.findUniqueOrThrow({ where: { id: t.id }, include: { robot: true, items: true } });
    });
    this.events.wake();
    if (task.robot && task.robot.state === 'ERROR') await this.emitRobot(task.robot.id);
    await this.sendPhaseCommand(task);
    return this.taskDto(taskId);
  }

  /** REASSIGN (MB-17): chỉ khi món chưa đặt lên robot; task về PENDING để giao robot khác. */
  async reassign(p: Principal, taskId: string) {
    const prev = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      const phase = t.status === 'FAILED' ? (t.failedFrom ?? 'PENDING') : t.status;
      if (!BEFORE_LOADED.includes(phase)) throw new ConflictException('Món đã ở trên robot — chọn "Nhân viên giao" thay vì giao robot khác');
      await this.log(tx, t.id, 'REASSIGNED', t.robotId, null, { by: actorId(p) });
      await this.move(tx, t, 'PENDING', { robotId: null, problem: null, failureReason: null, failedFrom: null, retryCount: 0, nextRetryAt: null }, null, 'delivery.task.updated', false);
      if (t.robot?.state === 'BUSY') await tx.robot.update({ where: { id: t.robot.id }, data: { state: 'IDLE' } });
      await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.reassign', entity: 'delivery_task', entityId: t.id, before: { robot: t.robot?.code } });
      return t;
    });
    this.events.wake();
    await this.releaseRobot(prev);
    setImmediate(() => void this.tick());
    return this.taskDto(taskId);
  }

  /** STAFF DELIVERY / Take Delivery (RD-17): nhân viên mang món ra; robot (nếu còn liên lạc) về vị trí gốc. */
  async manualTakeover(p: Principal, taskId: string, reason: string) {
    const prev = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      if (TERMINAL.includes(t.status) || t.status === 'DELIVERED' || t.status === 'RETURNING') throw new ConflictException('Task đã kết thúc');
      await this.move(tx, t, 'MANUAL_TAKEOVER', { failureReason: reason, completedAt: new Date() }, { reason, by: actorId(p) });
      await tx.orderItem.updateMany({ where: { id: { in: t.items.map((i) => i.orderItemId) }, status: { in: ['ASSIGNED', 'PICKED_UP'] } }, data: { status: 'READY', deliveryMode: 'STAFF' } });
      if (t.robot?.state === 'BUSY') await tx.robot.update({ where: { id: t.robot.id }, data: { state: 'IDLE' } });
      await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.manual_takeover', entity: 'delivery_task', entityId: t.id, reason });
      return t;
    });
    this.events.wake();
    await this.releaseRobot(prev);
    return this.taskDto(taskId);
  }

  /** CANCEL (MB-17): hủy nhiệm vụ robot trước khi đặt món; món quay lại hàng chờ giao. */
  async cancel(p: Principal, taskId: string, reason: string) {
    const prev = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      const phase = t.status === 'FAILED' ? (t.failedFrom ?? 'PENDING') : t.status;
      if (!BEFORE_LOADED.includes(phase) || TERMINAL.includes(t.status)) throw new ConflictException('Món đã ở trên robot hoặc task đã kết thúc — dùng "Nhân viên giao"');
      await this.move(tx, t, 'CANCELLED', { failureReason: reason, completedAt: new Date() }, { reason, by: actorId(p) });
      await tx.orderItem.updateMany({ where: { id: { in: t.items.map((i) => i.orderItemId) }, status: 'ASSIGNED' }, data: { status: 'READY' } });
      if (t.robot?.state === 'BUSY') await tx.robot.update({ where: { id: t.robot.id }, data: { state: 'IDLE' } });
      await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.cancel', entity: 'delivery_task', entityId: t.id, reason });
      return t;
    });
    this.events.wake();
    await this.releaseRobot(prev);
    return this.taskDto(taskId);
  }

  /** Nhả robot khỏi task: hủy lệnh và gọi về vị trí gốc nếu robot còn liên lạc. */
  private async releaseRobot(t: TaskFull) {
    if (!t.robot) return;
    const robot = t.robot;
    await this.emitRobot(robot.id);
    if (robot.state === 'OFFLINE') return;
    const charge = robot.battery < deliveryConfig().batteryAccept;
    setImmediate(async () => {
      await this.gateway.command(robot, 'cancelTask', (a, id) => a.cancelTask(id, t.code)).catch(() => undefined);
      await this.gateway.command(robot, 'returnHome', (a, id) => a.returnHome(id, { taskId: null, charge })).catch(() => undefined);
    });
  }

  /** Chuyển thẳng các món trong hàng chờ cho nhân viên giao. */
  async itemsToStaff(p: Principal, orderItemIds: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.orderItem.updateMany({ where: { id: { in: orderItemIds }, status: 'READY' }, data: { deliveryMode: 'STAFF' } });
      if (r.count === 0) throw new ConflictException('Không có món nào đang chờ giao');
      await this.audit.record(tx, { actorId: actorId(p), action: 'delivery.items_to_staff', entity: 'order_item', entityId: orderItemIds.join(','), reason: 'Nhân viên giao' });
    });
    return { ok: true };
  }

  /** Gửi lại lệnh của bước hiện tại (sau retry, vật cản đã thông, đổi bàn). */
  private async sendPhaseCommand(t: TaskFull) {
    if (!t.robot) return;
    const robot = t.robot;
    try {
      if (TO_PICKUP.includes(t.status)) {
        await this.gateway.command(robot, 'goTo(pickup)', (a, id) => a.goTo(id, t.pickupLocation, { taskId: t.code, purpose: 'PICKUP' }));
        if (t.status === 'ASSIGNING') await this.walkTo(t.id, 'ASSIGNED', {});
      } else if (t.status === 'LOADING' || t.status === 'GOING_TO_TABLE') {
        await this.gateway.command(robot, 'goTo(table)', (a, id) => a.goTo(id, t.deliveryLocation, { taskId: t.code, purpose: 'DELIVERY', display: `Bàn ${t.tableCode} – mời quý khách lấy món` }));
        await this.walkTo(t.id, 'GOING_TO_TABLE', { problem: null });
      } else if (t.status === 'RETURNING') {
        await this.gateway.command(robot, 'returnHome', (a, id) => a.returnHome(id, { taskId: t.code }));
      }
    } catch (e) {
      await this.fail(t.id, 'API_TIMEOUT', `Không gửi được lệnh tới robot ${robot.code}: ${errMsg(e)}`);
    }
  }

  // ───────────── Điều khiển robot (MB-20) ─────────────

  async robotStop(p: Principal, robotId: string) {
    const robot = await this.prisma.robot.findUniqueOrThrow({ where: { id: robotId } });
    await this.gateway.command(robot, 'stop', (a, id) => a.stop(id));
    const t = await this.heldTask(robot.id);
    if (t && MOVING.includes(t.status)) await this.fail(t.id, 'STOPPED', `Nhân viên dừng khẩn cấp robot ${robot.code}`);
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actorId: actorId(p), action: 'robot.stop', entity: 'robot', entityId: robot.id }));
    return this.robotDto(robot.id);
  }

  async robotPause(p: Principal, robotId: string, paused: boolean) {
    const robot = await this.prisma.robot.findUniqueOrThrow({ where: { id: robotId } });
    await this.gateway.command(robot, paused ? 'pause' : 'resume', (a, id) => (paused ? a.pause(id) : a.resume(id)));
    await this.prisma.robot.update({ where: { id: robotId }, data: { paused } });
    const t = await this.heldTask(robot.id);
    if (t) await this.log(this.prisma, t.id, paused ? 'ROBOT_PAUSED' : 'ROBOT_RESUMED', robot.id, null, { by: actorId(p) });
    await this.emitRobot(robotId);
    return this.robotDto(robotId);
  }

  async robotReturnHome(p: Principal, robotId: string, charge: boolean) {
    const robot = await this.prisma.robot.findUniqueOrThrow({ where: { id: robotId } });
    const t = await this.heldTask(robot.id);
    if (t && t.status !== 'RETURNING') throw new ConflictException(`Robot đang giữ task ${t.code} — xử lý task trước (giao robot khác / nhân viên giao / hủy)`);
    await this.gateway.command(robot, 'returnHome', (a, id) => a.returnHome(id, { taskId: t?.code ?? null, charge }));
    await this.prisma.robot.update({ where: { id: robotId }, data: { state: charge ? 'CHARGING' : robot.state === 'ERROR' ? 'IDLE' : robot.state, error: null, paused: false } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actorId: actorId(p), action: charge ? 'robot.charge' : 'robot.return_home', entity: 'robot', entityId: robot.id }));
    await this.emitRobot(robotId);
    return this.robotDto(robotId);
  }

  async setRobotEnabled(p: Principal, id: string, enabled: boolean) {
    const r = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    if (!enabled && (await this.heldTask(id))) throw new ConflictException('Robot đang giữ task, hãy xử lý task trước');
    await this.prisma.robot.update({ where: { id }, data: { state: enabled ? (r.state === 'DISABLED' ? 'IDLE' : r.state) : 'DISABLED', error: null } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, { actorId: actorId(p), action: enabled ? 'robot.enable' : 'robot.disable', entity: 'robot', entityId: id }));
    await this.emitRobot(id);
    return this.robotDto(id);
  }

  /** Giả lập lỗi cho demo (MB-16): OBSTACLE, OFFLINE, LOW_BATTERY, API_TIMEOUT, BUTTON, RECOVER. */
  async simulate(p: Principal, robotId: string, fault: SimFault) {
    const robot = await this.prisma.robot.findUniqueOrThrow({ where: { id: robotId } });
    await this.gateway.simulate(robot, fault);
    const t = await this.heldTask(robot.id);
    if (t) await this.log(this.prisma, t.id, 'SIMULATED_FAULT', robot.id, null, { fault, by: actorId(p) });
    await this.chain;
    return this.robotDto(robotId);
  }

  /** Robot điều khiển tay: nhân viên báo robot đã tới nơi. */
  async manualArrived(robotId: string) {
    const robot = await this.prisma.robot.findUniqueOrThrow({ where: { id: robotId } });
    if (robot.vendor !== 'MANUAL') throw new ConflictException('Chỉ dùng cho robot điều khiển tay');
    if (!this.gateway.manual.reportArrived(robot.externalId)) throw new ConflictException('Robot không có lệnh đang chạy');
    await this.chain;
    return this.robotDto(robotId);
  }

  // ───────────── Chuyển trạng thái & nhật ký ─────────────

  private async lockTask(tx: Tx, id: string): Promise<TaskFull> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM delivery_tasks WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException('Không tìm thấy delivery task');
    return tx.deliveryTask.findUniqueOrThrow({ where: { id }, include: { robot: true, items: true } });
  }

  private async lockRobot(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM robots WHERE id = ${id} FOR UPDATE`;
    return row ? tx.robot.findUniqueOrThrow({ where: { id } }) : null;
  }

  /** Một bước chuyển theo bảng RD-11 + nhật ký + sự kiện; sai bảng thì báo lỗi. */
  private async move(
    tx: Tx,
    t: DeliveryTask,
    to: DeliveryStatus,
    data: Prisma.DeliveryTaskUncheckedUpdateInput,
    payload: Record<string, unknown> | null,
    domain: EventType = STATUS_EVENT[to] ?? 'delivery.task.updated',
    withLog = true,
  ) {
    assertTransition('delivery task', DELIVERY_TRANSITIONS, t.status, to);
    await tx.deliveryTask.update({ where: { id: t.id }, data: { ...data, status: to, version: { increment: 1 } } });
    if (withLog) await this.log(tx, t.id, STATUS_LOG[to] ?? to, (data.robotId as string | undefined) ?? t.robotId, null, payload);
    await this.emitTask(tx, domain, t.id);
  }

  /**
   * Đi tiếp dọc luồng chính tới `to`, ghi từng bước (sự kiện robot có thể tới dồn/đảo thứ tự).
   * Không đi lùi, không vượt cổng cần người xác nhận; trả về false nếu không làm gì.
   */
  private async walkTo(taskId: string, to: DeliveryStatus, data: Prisma.DeliveryTaskUncheckedUpdateInput) {
    const moved = await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      const from = HAPPY.indexOf(t.status);
      const target = HAPPY.indexOf(to);
      if (from < 0 || target <= from) return false;
      const path = HAPPY.slice(from + 1, target + 1);
      if (path.some((step) => GATES.includes(step))) return false;
      let cur: DeliveryTask = t;
      for (const step of path) {
        await this.move(tx, cur, step, step === to ? data : {}, null);
        cur = { ...cur, status: step };
      }
      return true;
    });
    if (moved) this.events.wake();
    return moved;
  }

  private async fail(taskId: string, problem: DeliveryProblem, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTask(tx, taskId);
      await this.failTx(tx, t, problem, reason);
    });
    this.events.wake();
  }

  private async failTx(tx: Tx, t: DeliveryTask, problem: DeliveryProblem, reason: string) {
    if (!DELIVERY_TRANSITIONS[t.status].includes('FAILED') || t.status === 'FAILED') return;
    await this.move(tx, t, 'FAILED', { problem, failureReason: reason, failedFrom: t.status, failedAt: new Date(), nextRetryAt: null }, { problem, reason });
  }

  private async log(db: Tx, taskId: string, type: string, robotId: string | null, location: string | null, payload: Record<string, unknown> | null) {
    await db.deliveryEvent.create({ data: { taskId, type, robotId, location, payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined } });
  }

  // ───────────── Đổi bàn khi đang giao ─────────────

  private async retarget(tx: Tx, sessionId: string) {
    const [table] = await currentTables(tx, sessionId);
    if (!table) return [];
    const tasks = await tx.deliveryTask.findMany({ where: { sessionId, status: { in: [...BEFORE_LOADED, 'LOADING', 'GOING_TO_TABLE', 'FAILED'] } } });
    const moving: string[] = [];
    for (const t of tasks) {
      if (t.tableId === table.id) continue;
      await tx.deliveryTask.update({ where: { id: t.id }, data: { tableId: table.id, tableCode: table.code, deliveryLocation: tableLocation(table.code), version: { increment: 1 } } });
      await this.log(tx, t.id, 'RETARGETED', t.robotId, tableLocation(table.code), { from: t.tableCode, to: table.code });
      await this.emitTask(tx, 'delivery.task.updated', t.id);
      if (t.status === 'GOING_TO_TABLE') moving.push(t.id);
    }
    return moving;
  }

  private async resend(taskIds: string[]) {
    for (const id of taskIds) {
      const t = await this.prisma.deliveryTask.findUnique({ where: { id }, include: { robot: true, items: true } });
      if (t?.status === 'GOING_TO_TABLE') await this.sendPhaseCommand(t);
    }
  }

  // ───────────── DTO & phát sự kiện ─────────────

  async taskDto(id: string, db: Tx = this.prisma): Promise<DeliveryTaskDto> {
    const t = await db.deliveryTask.findUnique({ where: { id }, include: { robot: true, items: true } });
    if (!t) throw new NotFoundException('Không tìm thấy delivery task');
    const items = await db.orderItem.findMany({ where: { id: { in: t.items.map((i) => i.orderItemId) } } });
    return {
      id: t.id,
      code: t.code,
      status: t.status,
      problem: (t.problem as DeliveryProblem | null) ?? null,
      failureReason: t.failureReason,
      robotId: t.robotId,
      robotCode: t.robot?.code ?? null,
      robotModel: t.robot?.model ?? null,
      sessionId: t.sessionId,
      tableId: t.tableId,
      tableCode: t.tableCode,
      pickupLocation: t.pickupLocation,
      deliveryLocation: t.deliveryLocation,
      retryCount: t.retryCount,
      confirmedBy: (t.confirmedBy as DeliveryTaskDto['confirmedBy']) ?? null,
      createdAt: t.createdAt.toISOString(),
      assignedAt: t.assignedAt?.toISOString() ?? null,
      loadedAt: t.loadedAt?.toISOString() ?? null,
      arrivedAt: t.arrivedAt?.toISOString() ?? null,
      deliveredAt: t.deliveredAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
      items: items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, station: i.station, status: i.status })),
    };
  }

  async tasks(opts: { active?: boolean; sessionId?: string }) {
    const rows = await this.prisma.deliveryTask.findMany({
      where: {
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.active ? { status: { in: [...DELIVERY_ACTIVE, 'DELIVERED', 'RETURNING'] } } : { createdAt: { gt: new Date(Date.now() - 6 * 3600_000) } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return Promise.all(rows.map((r) => this.taskDto(r.id)));
  }

  async taskEvents(id: string): Promise<DeliveryEventDto[]> {
    const rows = await this.prisma.deliveryEvent.findMany({ where: { taskId: id }, orderBy: { createdAt: 'asc' } });
    return rows.map((e) => ({ id: e.id, taskId: e.taskId, type: e.type, robotId: e.robotId, location: e.location, payload: e.payload as Record<string, unknown> | null, createdAt: e.createdAt.toISOString() }));
  }

  async robotDto(id: string): Promise<RobotDto> {
    const r = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    const t = await this.heldTask(id);
    const fresh = r.vendor === 'MANUAL' || (!!r.lastSeenAt && Date.now() - r.lastSeenAt.getTime() < deliveryConfig().heartbeatTimeoutMs);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      vendor: r.vendor,
      model: r.model,
      state: r.state,
      online: r.state !== 'OFFLINE' && fresh,
      paused: r.paused,
      battery: r.battery,
      telemetrySimulated: r.telemetrySimulated,
      location: r.location,
      capabilities: (r.capabilities ?? {}) as Record<string, boolean>,
      error: r.error,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      taskId: t?.id ?? null,
    };
  }

  async robotList() {
    const rows = await this.prisma.robot.findMany({ orderBy: { code: 'asc' } });
    return Promise.all(rows.map((r) => this.robotDto(r.id)));
  }

  async locations(): Promise<RobotLocationDto[]> {
    const rows = await this.prisma.robotLocation.findMany({ orderBy: [{ sort: 'asc' }, { code: 'asc' }] });
    return rows.map((r) => ({ code: r.code, kind: r.kind, name: r.name, tableId: r.tableId, vendorMapping: r.vendorMapping as Record<string, unknown> }));
  }

  private async emitTask(tx: Tx, type: EventType, id: string) {
    const task = await this.taskDto(id, tx);
    await this.events.append(tx, type, 'delivery_task', id, {
      sessionId: task.sessionId,
      tableIds: [task.tableId],
      stations: [...new Set(task.items.map((i) => i.station))],
      task,
    });
  }

  private async emitRobot(id: string) {
    const robot = await this.robotDto(id);
    await this.prisma.$transaction((tx) => this.events.append(tx, 'robot.status', 'robot', id, { robot }));
    this.events.wake();
  }

  /** Vị trí tức thời gửi "volatile" (không lưu sổ) để vẽ robot trên sa bàn. */
  private telemetry(robot: Robot, task: DeliveryTask | null, e: RobotEvent) {
    const t: RobotTelemetry = {
      robotId: robot.id,
      code: robot.code,
      battery: robot.battery,
      location: robot.location,
      target: e.target ?? null,
      progress: e.progress ?? null,
      taskCode: task?.code ?? null,
      tableCode: task?.tableCode ?? null,
      status: task?.status ?? null,
    };
    this.realtime.emitVolatile('robot.telemetry', t, [R.dispatch, R.dashboard, R.pos, ...(task ? [R.table(task.tableId)] : [])]);
  }
}
