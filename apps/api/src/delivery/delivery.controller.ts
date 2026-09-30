import { Body, Controller, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Allow, CurrentPrincipal, Public, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryService } from './delivery.service';
import { RobotGateway } from './robot-gateway';

const ItemsSchema = z.object({ orderItemIds: z.array(z.string().uuid()).min(1).max(20) });
const AssignSchema = z.object({ robotId: z.string().uuid().optional() });
const RobotTaskSchema = z.object({ taskId: z.string().uuid() });
const LoadedSchema = z.object({ trayCode: z.string().min(1).max(40).optional() });
const ReasonSchema = z.object({ reason: z.string().min(1).max(200) });
const HomeSchema = z.object({ charge: z.boolean().default(false) });
const EnableSchema = z.object({ enabled: z.boolean() });
const FaultSchema = z.object({ fault: z.enum(['OBSTACLE', 'OBSTACLE_PERSISTENT', 'OFFLINE', 'LOW_BATTERY', 'API_TIMEOUT', 'API_TIMEOUT_PERSISTENT', 'BUTTON', 'RECOVER']) });
const RobotSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(60),
  vendor: z.enum(['SIMULATED', 'MAKEBLOCK', 'ORIONSTAR', 'MANUAL']),
  externalId: z.string().min(1).max(80),
  model: z.string().max(60).optional(),
  zone: z.string().max(40).optional(),
});
const OrionSchema = z.object({
  robotSn: z.string(),
  taskId: z.string(),
  state: z.enum(['ACCEPTED', 'ARRIVED', 'OBSTACLE', 'ERROR', 'DELIVERED', 'RETURNED']),
  position: z.string().optional(),
  battery: z.number().optional(),
  reason: z.string().optional(),
});

/** Người điều phối giao món: quản lý, phục vụ, bếp. */
const DISPATCHERS = ['MANAGER', 'WAITER', 'KITCHEN', 'HEAD_CHEF'] as const;

/**
 * Hợp đồng nội bộ Robot Gateway + Delivery (LB-22, MB-18). Đây là API của Nha Hang Sen,
 * không phải API của Makeblock hay OrionStar.
 */
@Controller()
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly gateway: RobotGateway,
    private readonly prisma: PrismaService,
  ) {}

  // ── Delivery tasks ──

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Get('internal/delivery-queue')
  queue() {
    return this.delivery.readyQueue();
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS', 'TABLET')
  @Get('internal/delivery-tasks')
  async list(@CurrentPrincipal() p: Principal, @Query('active') active?: string, @Query('sessionId') sessionId?: string) {
    if (p.kind === 'device' && p.deviceKind === 'TABLET') {
      // Tablet chỉ xem task của bàn mình.
      const all = await this.delivery.tasks({ active: true, sessionId });
      return all.filter((t) => t.tableId === p.tableId);
    }
    return this.delivery.tasks({ active: active !== 'false', sessionId });
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Get('internal/delivery-tasks/:id')
  task(@Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.taskDto(id);
  }

  @Allow(...DISPATCHERS, 'CASHIER')
  @Get('internal/delivery-tasks/:id/events')
  events(@Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.taskEvents(id);
  }

  /** "Giao bằng robot" từ KDS/POS: tạo task ngay cho các món đã READY. */
  @Allow(...DISPATCHERS, 'KDS')
  @Post('internal/delivery-tasks')
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ItemsSchema)) b: z.infer<typeof ItemsSchema>) {
    return this.delivery.create(p, b.orderItemIds);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/delivery-tasks/:id/assign')
  assign(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AssignSchema)) b: z.infer<typeof AssignSchema>) {
    return this.assignTo(p, id, b.robotId ?? null);
  }

  private async assignTo(p: Principal, taskId: string, robotId: string | null) {
    if (robotId) return this.delivery.assign(taskId, robotId, p);
    const t = await this.prisma.deliveryTask.findUnique({ where: { id: taskId } });
    if (!t) throw new NotFoundException('Không tìm thấy delivery task');
    // Không chỉ định robot: để bộ điều phối chọn ở nhịp kế tiếp (gọi lại nhiều lần vẫn an toàn).
    await this.delivery.tick();
    return this.delivery.taskDto(taskId);
  }

  @Allow(...DISPATCHERS, 'KDS')
  @Post('internal/delivery-tasks/:id/confirm-loaded')
  confirmLoaded(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(LoadedSchema)) b: z.infer<typeof LoadedSchema>) {
    return this.delivery.confirmLoaded(p, id, b.trayCode);
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'TABLET')
  @Post('internal/delivery-tasks/:id/confirm-delivered')
  confirmDelivered(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.confirmDelivered(p, id);
  }

  @Allow(...DISPATCHERS, 'CASHIER')
  @Post('internal/delivery-tasks/:id/manual-takeover')
  takeover(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.delivery.manualTakeover(p, id, b.reason);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/delivery-tasks/:id/retry')
  retry(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.retry(p, id);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/delivery-tasks/:id/reassign')
  reassign(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.reassign(p, id);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/delivery-tasks/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.delivery.cancel(p, id, b.reason);
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Post('internal/delivery-items/staff')
  toStaff(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ItemsSchema)) b: z.infer<typeof ItemsSchema>) {
    return this.delivery.itemsToStaff(p, b.orderItemIds);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/delivery/tick')
  async tick() {
    await this.delivery.tick();
    return this.delivery.readyQueue();
  }

  // ── Robots (Robot Gateway) ──

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Get('internal/robots')
  robots() {
    return this.delivery.robotList();
  }

  @Allow(...DISPATCHERS, 'CASHIER')
  @Get('internal/robots/:id/status')
  async status(@Param('id', ParseUUIDPipe) id: string) {
    const robot = await this.prisma.robot.findUniqueOrThrow({ where: { id } });
    const live = await this.gateway
      .adapter(robot.vendor)
      .getStatus(robot.externalId)
      .catch((e: Error) => ({ online: false, error: e.message }));
    return { ...(await this.delivery.robotDto(id)), live };
  }

  @Allow(...DISPATCHERS, 'CASHIER')
  @Get('internal/robots/:id/location')
  async location(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.delivery.robotDto(id);
    return { robotId: r.id, location: r.location };
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS', 'TABLET')
  @Get('internal/robot-locations')
  locations() {
    return this.delivery.locations();
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/tasks')
  robotTask(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RobotTaskSchema)) b: z.infer<typeof RobotTaskSchema>) {
    return this.delivery.assign(b.taskId, id, p);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/tasks/:taskId/cancel')
  robotCancel(@CurrentPrincipal() p: Principal, @Param('taskId', ParseUUIDPipe) taskId: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.delivery.cancel(p, taskId, b.reason);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/stop')
  stop(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.robotStop(p, id);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/pause')
  pause(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.robotPause(p, id, true);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/resume')
  resume(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.robotPause(p, id, false);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/return-home')
  home(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(HomeSchema)) b: z.infer<typeof HomeSchema>) {
    return this.delivery.robotReturnHome(p, id, b.charge);
  }

  /** Giả lập lỗi cho demo (MB-16): vật cản, mất kết nối, pin yếu, lỗi API, nút khách, khôi phục. */
  @Allow('MANAGER', 'WAITER')
  @Post('internal/robots/:id/simulate')
  simulate(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(FaultSchema)) b: z.infer<typeof FaultSchema>) {
    return this.delivery.simulate(p, id, b.fault);
  }

  @Allow(...DISPATCHERS)
  @Post('internal/robots/:id/manual-arrived')
  manualArrived(@Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.manualArrived(id);
  }

  @Allow('MANAGER')
  @Patch('internal/robots/:id')
  enable(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(EnableSchema)) b: z.infer<typeof EnableSchema>) {
    return this.delivery.setRobotEnabled(p, id, b.enabled);
  }

  @Allow('MANAGER')
  @Post('internal/robots')
  async createRobot(@Body(new ZodPipe(RobotSchema)) b: z.infer<typeof RobotSchema>) {
    const r = await this.prisma.robot.create({ data: { ...b, telemetrySimulated: b.vendor !== 'ORIONSTAR' } });
    await this.gateway.connect(r).catch(() => undefined);
    return this.delivery.robotDto(r.id);
  }

  /**
   * Callback từ hãng robot (LuckiBot Pro). Payload dưới đây là dạng đã chuẩn hóa; khi có tài liệu
   * OrionStar OpenAPI (LB-29) thì ánh xạ payload thật sang dạng này ở đây.
   */
  @Public()
  @Post('webhooks/robots/:vendor')
  webhook(@Param('vendor') vendor: string, @Req() req: RawBodyRequest<Request>, @Headers('x-signature') sig: string | undefined, @Body() body: unknown) {
    const secret = process.env.ORIONSTAR_WEBHOOK_SECRET;
    if (vendor !== 'orionstar' || !secret || !req.rawBody || !sig) throw new UnauthorizedException();
    const expected = createHmac('sha256', secret).update(req.rawBody).digest();
    const got = Buffer.from(sig, 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new UnauthorizedException('Sai chữ ký');
    this.gateway.luckibot.handleCallback(OrionSchema.parse(body));
    return { ok: true };
  }

  /** Chỉ số giao món (mục 15, LB-26): Ready → Loaded → Delivered, tỷ lệ giao tay, task lỗi. */
  @Allow('MANAGER', 'ACCOUNTANT')
  @Get('reports/delivery')
  async metrics(@Query('from') from: string, @Query('to') to: string) {
    const [row] = await this.prisma.$queryRaw<
      {
        tasks: bigint;
        completed: bigint;
        failed: bigint;
        takeover: bigint;
        cancelled: bigint;
        ready_to_loaded: number | null;
        loaded_to_delivered: number | null;
        ready_to_delivered: number | null;
        staff_items: bigint;
        robot_items: bigint;
      }[]
    >`
      WITH t AS (
        SELECT dt.*, (SELECT MIN(oi.ready_at) FROM delivery_task_items ti JOIN order_items oi ON oi.id = ti.order_item_id WHERE ti.task_id = dt.id) AS ready_at
        FROM delivery_tasks dt
        WHERE ((dt.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date
      )
      SELECT COUNT(*) AS tasks,
             COUNT(*) FILTER (WHERE status IN ('DELIVERED', 'RETURNING', 'COMPLETED')) AS completed,
             COUNT(*) FILTER (WHERE failed_at IS NOT NULL) AS failed,
             COUNT(*) FILTER (WHERE status = 'MANUAL_TAKEOVER') AS takeover,
             COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
             AVG(EXTRACT(EPOCH FROM loaded_at - ready_at)) AS ready_to_loaded,
             AVG(EXTRACT(EPOCH FROM delivered_at - loaded_at)) AS loaded_to_delivered,
             AVG(EXTRACT(EPOCH FROM delivered_at - ready_at)) AS ready_to_delivered,
             (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.delivery_mode = 'STAFF' AND oi.status = 'DELIVERED'
                 AND ((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date) AS staff_items,
             (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.delivery_mode = 'ROBOT' AND oi.status = 'DELIVERED'
                 AND ((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date) AS robot_items
      FROM t`;
    const n = (v: bigint | number | null) => (v === null ? null : Number(v));
    const sec = (v: number | null) => (v === null ? null : Math.round(Number(v)));
    const staff = Number(row.staff_items);
    const robot = Number(row.robot_items);
    return {
      tasks: n(row.tasks),
      completed: n(row.completed),
      failed: n(row.failed),
      manualTakeover: n(row.takeover),
      cancelled: n(row.cancelled),
      avgReadyToLoadedSec: sec(row.ready_to_loaded),
      avgLoadedToDeliveredSec: sec(row.loaded_to_delivered),
      avgReadyToDeliveredSec: sec(row.ready_to_delivered),
      fallbackRate: staff + robot === 0 ? 0 : staff / (staff + robot),
    };
  }
}
