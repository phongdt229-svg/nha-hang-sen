import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Allow, CurrentPrincipal, Public, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { DispatchService } from './dispatch.service';
import { RobotRegistry } from './robot.registry';

const PickupSchema = z.object({ trayCode: z.string().min(1).max(40) });
const ReasonSchema = z.object({ reason: z.string().min(1).max(200) });
const StaffSchema = z.object({ orderItemIds: z.array(z.string().uuid()).min(1) });
const RobotSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(60),
  vendor: z.enum(['SIMULATED', 'MQTT', 'ORIONSTAR', 'MANUAL']),
  externalId: z.string().min(1).max(80),
  model: z.string().max(60).optional(),
  zone: z.string().max(40).optional(),
});
const EnableSchema = z.object({ enabled: z.boolean() });
const FaultSchema = z.object({ fault: z.enum(['bi_ket', 'pin_yeu', 'mat_ket_noi', 'phuc_hoi']) });
const ManualSchema = z.object({ step: z.enum(['AT_PICKUP', 'ARRIVED', 'DELIVERED']) });
const OrionSchema = z.object({
  robotSn: z.string(),
  taskId: z.string(),
  state: z.enum(['ARRIVED', 'DELIVERED', 'FAILED', 'RETURNED']),
  battery: z.number().optional(),
  reason: z.string().optional(),
});

const DISPATCHERS = ['MANAGER', 'WAITER', 'KITCHEN', 'HEAD_CHEF'] as const;

@Controller()
export class DispatchController {
  constructor(
    private readonly dispatch: DispatchService,
    private readonly registry: RobotRegistry,
    private readonly prisma: PrismaService,
  ) {}

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Get('dispatch/queue')
  queue() {
    return this.dispatch.readyQueue();
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Get('trips')
  trips(@Query('active') active?: string) {
    return this.dispatch.trips(active !== 'false');
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS', 'TABLET')
  @Get('trips/:id')
  trip(@Param('id', ParseUUIDPipe) id: string) {
    return this.dispatch.tripDto(id);
  }

  @Allow(...DISPATCHERS, 'KDS')
  @Post('trips/:id/pickup')
  pickup(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PickupSchema)) b: z.infer<typeof PickupSchema>) {
    return this.dispatch.pickup(p, id, b.trayCode);
  }

  @Allow(...DISPATCHERS)
  @Post('trips/:id/fallback-staff')
  fallback(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.dispatch.fallbackStaff(p, id, b.reason);
  }

  @Allow(...DISPATCHERS, 'TABLET')
  @Post('trips/:id/confirm-delivered')
  confirm(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.dispatch.confirmDelivered(p, id);
  }

  @Allow(...DISPATCHERS)
  @Post('trips/:id/manual')
  manual(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ManualSchema)) b: z.infer<typeof ManualSchema>) {
    return this.dispatch.manualReport(id, b.step);
  }

  @Allow(...DISPATCHERS)
  @Post('dispatch/items/staff')
  toStaff(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(StaffSchema)) b: z.infer<typeof StaffSchema>) {
    return this.dispatch.itemsToStaff(p, b.orderItemIds);
  }

  @Allow(...DISPATCHERS)
  @Post('dispatch/tick')
  async tick() {
    await this.dispatch.tick();
    return this.dispatch.readyQueue();
  }

  @Allow(...DISPATCHERS, 'CASHIER', 'KDS')
  @Get('robots')
  robots() {
    return this.dispatch.robotList();
  }

  @Allow('MANAGER')
  @Post('robots')
  async createRobot(@Body(new ZodPipe(RobotSchema)) b: z.infer<typeof RobotSchema>) {
    const r = await this.prisma.robot.create({ data: b });
    if (r.vendor === 'SIMULATED') this.registry.sim.register(r.externalId);
    return this.dispatch.robotDto(r.id);
  }

  @Allow('MANAGER')
  @Patch('robots/:id')
  enable(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(EnableSchema)) b: z.infer<typeof EnableSchema>) {
    return this.dispatch.setRobotEnabled(p, id, b.enabled);
  }

  @Allow(...DISPATCHERS)
  @Post('robots/:id/charge')
  charge(@Param('id', ParseUUIDPipe) id: string) {
    return this.dispatch.charge(id);
  }

  /** Gây lỗi robot giả lập để diễn tập fallback (kẹt, pin yếu, mất kết nối). */
  @Allow('MANAGER')
  @Post('robots/:id/simulate')
  simulate(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(FaultSchema)) b: z.infer<typeof FaultSchema>) {
    return this.dispatch.simulate(id, b.fault);
  }

  /**
   * Callback từ hãng robot. Định dạng dưới đây là dạng đã chuẩn hóa; khi có tài liệu OrionStar
   * OpenAPI, ánh xạ payload thật sang dạng này ở đây.
   */
  @Public()
  @Post('webhooks/robots/:vendor')
  webhook(@Param('vendor') vendor: string, @Req() req: RawBodyRequest<Request>, @Headers('x-signature') sig: string | undefined, @Body() body: unknown) {
    const secret = process.env.ORIONSTAR_WEBHOOK_SECRET;
    if (vendor !== 'orionstar' || !secret || !req.rawBody || !sig) throw new UnauthorizedException();
    const expected = createHmac('sha256', secret).update(req.rawBody).digest();
    const got = Buffer.from(sig, 'hex');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new UnauthorizedException('Sai chữ ký');
    this.registry.orion.handleCallback(OrionSchema.parse(body));
    return { ok: true };
  }

  /** Chỉ số giao món (mục 15): Ready → Pickup → Delivered, tỷ lệ fallback, chuyến lỗi. */
  @Allow('MANAGER', 'ACCOUNTANT')
  @Get('reports/delivery')
  async metrics(@Query('from') from: string, @Query('to') to: string) {
    const [row] = await this.prisma.$queryRaw<
      { trips: bigint; delivered: bigint; failed: bigint; cancelled: bigint; ready_to_pickup: number | null; pickup_to_delivered: number | null; ready_to_delivered: number | null; staff_items: bigint; robot_items: bigint }[]
    >`
      WITH t AS (
        SELECT dt.*, (SELECT MIN(oi.ready_at) FROM trip_items ti JOIN order_items oi ON oi.id = ti.order_item_id WHERE ti.trip_id = dt.id) AS ready_at
        FROM delivery_trips dt
        WHERE ((dt.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date
      )
      SELECT COUNT(*) AS trips,
             COUNT(*) FILTER (WHERE stage IN ('DELIVERED', 'RETURNING', 'DONE')) AS delivered,
             COUNT(*) FILTER (WHERE stage = 'FAILED') AS failed,
             COUNT(*) FILTER (WHERE stage = 'CANCELLED') AS cancelled,
             AVG(EXTRACT(EPOCH FROM picked_up_at - ready_at)) AS ready_to_pickup,
             AVG(EXTRACT(EPOCH FROM delivered_at - picked_up_at)) AS pickup_to_delivered,
             AVG(EXTRACT(EPOCH FROM delivered_at - ready_at)) AS ready_to_delivered,
             (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.delivery_mode = 'STAFF' AND oi.status = 'DELIVERED'
                 AND ((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date) AS staff_items,
             (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
               WHERE oi.delivery_mode = 'ROBOT' AND oi.status = 'DELIVERED'
                 AND ((o.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN ${from}::date AND ${to}::date) AS robot_items
      FROM t`;
    const n = (v: bigint | number | null) => (v === null ? null : Number(v));
    const staff = Number(row.staff_items);
    const robot = Number(row.robot_items);
    return {
      trips: n(row.trips),
      delivered: n(row.delivered),
      failed: n(row.failed),
      cancelled: n(row.cancelled),
      avgReadyToPickupSec: row.ready_to_pickup === null ? null : Math.round(Number(row.ready_to_pickup)),
      avgPickupToDeliveredSec: row.pickup_to_delivered === null ? null : Math.round(Number(row.pickup_to_delivered)),
      avgReadyToDeliveredSec: row.ready_to_delivered === null ? null : Math.round(Number(row.ready_to_delivered)),
      fallbackRate: staff + robot === 0 ? 0 : staff / (staff + robot),
    };
  }
}
