import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { Notifier } from '../common/notifier';
import { EINVOICE_QUEUE } from '../einvoice/einvoice.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { KITCHEN_QUEUE } from '../kitchen/kitchen.config';
import { PAYMENTS_QUEUE } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { REPORTS_QUEUE } from '../reports/business-day.service';
import { metrics, registry } from './metrics';

export const OPS_QUEUE = 'ops';

const staleMs = () => Number(process.env.PRINT_AGENT_STALE_MS ?? 15_000);
const repeatMs = () => Number(process.env.ALERT_REPEAT_MS ?? 30 * 60_000);
const outboxStuckSeconds = () => Number(process.env.ALERT_OUTBOX_STUCK_SECONDS ?? 30);
const einvoiceBacklogMs = () => Number(process.env.EINVOICE_BACKLOG_ALERT_MS ?? 30 * 60_000);

export interface Health {
  ok: boolean;
  postgres: boolean;
  redis: boolean;
  outboxBacklog: number;
  outboxOldestSeconds: number;
}

export interface Alert {
  key: string;
  title: string;
  text: string;
}

interface ActiveAlert extends Alert {
  since: Date;
  lastSent: number;
}

@Injectable()
export class ObservabilityService implements OnModuleInit {
  private readonly logger = new Logger('Watchdog');
  private readonly active = new Map<string, ActiveAlert>();
  private readonly queues: Queue[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxPublisher,
    private readonly notifier: Notifier,
    @InjectQueue(KITCHEN_QUEUE) kitchen: Queue,
    @InjectQueue(PAYMENTS_QUEUE) payments: Queue,
    @InjectQueue(EINVOICE_QUEUE) einvoice: Queue,
    @InjectQueue(REPORTS_QUEUE) reports: Queue,
    @InjectQueue(OPS_QUEUE) ops: Queue,
  ) {
    this.queues = [kitchen, payments, einvoice, reports, ops];
  }

  onModuleInit() {
    // Đếm theo sự kiện nghiệp vụ: mỗi sự kiện được bộ phát xử lý đúng một lần.
    this.outbox.on('order.confirmed', async () => metrics.ordersConfirmed.inc());
    this.outbox.on('kitchen.fallback', async (_tx, e) => metrics.kdsFallbacks.inc({ station: (e.data as { station?: string }).station ?? '' }));
    this.outbox.on('payment.succeeded', async (_tx, e) => metrics.paymentsSucceeded.inc({ method: (e.data as { method?: string }).method ?? '' }));
    metrics.processStart.set(Math.round(Date.now() / 1000 - process.uptime()));
    registry.onCollect(() => this.collect());
  }

  /** Số liệu tức thời đọc từ DB/Redis ngay khi Prometheus hỏi. */
  private async collect() {
    metrics.memory.set(process.memoryUsage().rss);
    const health = await this.health();
    metrics.up.set(health.postgres ? 1 : 0, { dependency: 'postgres' });
    metrics.up.set(health.redis ? 1 : 0, { dependency: 'redis' });
    metrics.outboxBacklog.set(health.outboxBacklog);
    metrics.outboxOldestSeconds.set(health.outboxOldestSeconds);
    if (!health.postgres) return;

    const [tables, robots, printers, printJobs, einvoices, deliveries] = await Promise.all([
      this.prisma.table.groupBy({ by: ['status'], _count: true }),
      this.prisma.robot.groupBy({ by: ['state'], _count: true }),
      this.prisma.printer.findMany(),
      this.prisma.printJob.groupBy({ by: ['target'], where: { status: { in: ['QUEUED', 'PRINTING'] } }, _count: true }),
      this.prisma.eInvoice.groupBy({ by: ['status'], where: { status: { in: ['PENDING', 'SENT', 'FAILED'] } }, _count: true }),
      this.prisma.deliveryTask.groupBy({ by: ['status'], where: { status: { notIn: ['COMPLETED', 'CANCELLED', 'MANUAL_TAKEOVER'] } }, _count: true }),
    ]);
    metrics.deliveryTasks.reset();
    for (const d of deliveries) metrics.deliveryTasks.set(d._count, { status: d.status });
    for (const g of [metrics.tablesByStatus, metrics.robotsByState, metrics.printerUp, metrics.printPending, metrics.einvoiceUnissued, metrics.queueJobs]) g.reset();
    for (const t of tables) metrics.tablesByStatus.set(t._count, { status: t.status });
    for (const r of robots) metrics.robotsByState.set(r._count, { state: r.state });
    const cutoff = Date.now() - staleMs();
    for (const p of printers) metrics.printerUp.set(p.state === 'ONLINE' && (p.lastSeenAt?.getTime() ?? 0) >= cutoff ? 1 : 0, { target: p.target });
    for (const j of printJobs) metrics.printPending.set(j._count, { target: j.target });
    for (const e of einvoices) metrics.einvoiceUnissued.set(e._count, { status: e.status });
    if (health.redis) {
      for (const q of this.queues) {
        const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts)) metrics.queueJobs.set(n, { queue: q.name, state });
      }
    }
  }

  async health(): Promise<Health> {
    const postgres = await this.prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    );
    const redis = await this.queues[0].client
      .then((c) => (c as unknown as { ping(): Promise<string> }).ping())
      .then((r) => r === 'PONG')
      .catch(() => false);
    let outboxBacklog = 0;
    let outboxOldestSeconds = 0;
    if (postgres) {
      const [row] = await this.prisma.$queryRaw<{ n: bigint; oldest: Date | null }[]>`
        SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM event_log WHERE published_at IS NULL`;
      outboxBacklog = Number(row.n);
      outboxOldestSeconds = row.oldest ? Math.max(0, Math.round((Date.now() - row.oldest.getTime()) / 1000)) : 0;
    }
    return { ok: postgres && redis, postgres, redis, outboxBacklog, outboxOldestSeconds };
  }

  /** Các điều kiện cần báo chủ/quản lý ngay (mục 13.7: cảnh báo qua Zalo/Telegram). */
  async evaluate(): Promise<Alert[]> {
    const alerts: Alert[] = [];
    const h = await this.health();
    if (!h.postgres) alerts.push({ key: 'postgres', title: 'Mất kết nối cơ sở dữ liệu', text: 'API không truy cập được PostgreSQL. Xem runbook mục "Server / cơ sở dữ liệu".' });
    if (!h.redis) alerts.push({ key: 'redis', title: 'Mất kết nối Redis', text: 'Hàng đợi (gửi lại phiếu bếp, hóa đơn, đối soát) đang dừng. Xem runbook.' });
    if (h.outboxOldestSeconds > outboxStuckSeconds()) {
      alerts.push({ key: 'outbox', title: 'Sự kiện bị kẹt', text: `${h.outboxBacklog} sự kiện chưa phát, lâu nhất ${h.outboxOldestSeconds} giây. Màn hình bếp/tablet có thể không cập nhật.` });
    }
    if (!h.postgres) return alerts;

    const cutoff = new Date(Date.now() - staleMs());
    const [fallback, printers, einvoices, robots, deliveries] = await Promise.all([
      this.prisma.kitchenTicket.count({ where: { status: 'FALLBACK', order: { session: { status: { not: 'CLOSED' } } } } }),
      this.prisma.printer.findMany({ where: { OR: [{ state: { in: ['OFFLINE', 'PAPER_OUT', 'ERROR'] } }, { lastSeenAt: { lt: cutoff } }] } }),
      this.prisma.eInvoice.count({ where: { status: { in: ['PENDING', 'SENT', 'FAILED'] }, createdAt: { lte: new Date(Date.now() - einvoiceBacklogMs()) } } }),
      this.prisma.robot.findMany({ where: { state: 'ERROR' } }),
      this.prisma.deliveryTask.findMany({ where: { OR: [{ status: 'FAILED' }, { status: 'WAITING_CUSTOMER', problem: 'CUSTOMER_ABSENT' }] }, include: { robot: true } }),
    ]);
    if (fallback > 0) alerts.push({ key: 'kds-fallback', title: 'Order chưa vào bếp', text: `${fallback} phiếu bếp không được KDS xác nhận. Kiểm tra màn hình bếp và phiếu giấy.` });
    for (const p of printers) {
      const why = p.lastSeenAt && p.lastSeenAt >= cutoff ? (p.lastError ?? p.state) : 'print agent mất kết nối';
      alerts.push({ key: `printer:${p.target}`, title: `Máy in ${p.name} gặp sự cố`, text: `${why}. Lệnh in đang nằm trong hàng đợi.` });
    }
    if (einvoices > 0) alerts.push({ key: 'einvoice', title: 'Hóa đơn điện tử tồn đọng', text: `${einvoices} hóa đơn chưa phát hành quá hạn, thu ngân cần xử lý.` });
    for (const r of robots) alerts.push({ key: `robot:${r.code}`, title: `Robot ${r.name} báo lỗi`, text: r.error ?? 'Kiểm tra robot và chuyển món cho nhân viên giao.' });
    // Robot lỗi không được để món kẹt "Ready" vô thời hạn (RD-17): báo nhân viên chọn thử lại / robot khác / giao tay.
    for (const d of deliveries) {
      alerts.push(
        d.status === 'FAILED'
          ? { key: `delivery:${d.code}`, title: `Giao món ${d.code} bàn ${d.tableCode} bị lỗi`, text: `${d.failureReason ?? d.problem ?? 'Robot gặp sự cố'}. Vào POS → Robot: thử lại, giao robot khác hoặc nhân viên giao.` }
          : { key: `delivery:${d.code}`, title: `Robot chờ khách bàn ${d.tableCode}`, text: `Robot ${d.robot?.code ?? ''} đã tới nhưng khách chưa nhận món. Nhân viên kiểm tra và xác nhận giúp.` },
      );
    }
    return alerts;
  }

  /** Gửi cảnh báo mới, nhắc lại cảnh báo kéo dài, báo "đã khắc phục" khi hết — không gửi lặp mỗi phút. */
  async watchdog() {
    const now = Date.now();
    const firing = await this.evaluate();
    const sent: string[] = [];
    for (const a of firing) {
      const prev = this.active.get(a.key);
      if (!prev || now - prev.lastSent >= repeatMs()) {
        await this.notifier.send(`⚠️ ${a.title}`, prev ? `${a.text}\n(Kéo dài từ ${prev.since.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })})` : a.text);
        sent.push(a.key);
      }
      this.active.set(a.key, { ...a, since: prev?.since ?? new Date(), lastSent: sent.includes(a.key) ? now : prev!.lastSent });
    }
    const keys = new Set(firing.map((a) => a.key));
    for (const [k, a] of this.active) {
      if (keys.has(k)) continue;
      this.active.delete(k);
      await this.notifier.send(`✅ Đã khắc phục: ${a.title}`, `Sự cố kéo dài từ ${a.since.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`);
      sent.push(`resolved:${k}`);
    }
    if (sent.length > 0) this.logger.log(`Đã gửi: ${sent.join(', ')}`);
    return { firing: firing.map((a) => a.key), sent };
  }

  activeAlerts() {
    return [...this.active.values()].map((a) => ({ key: a.key, title: a.title, text: a.text, since: a.since.toISOString() }));
  }
}

@Processor(OPS_QUEUE)
export class ObservabilityProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly ops: ObservabilityService,
    @InjectQueue(OPS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.queue.upsertJobScheduler('watchdog', { every: Number(process.env.WATCHDOG_EVERY_MS ?? 60_000) }, { name: 'watchdog' });
  }

  async process(job: Job) {
    if (job.name === 'watchdog') return this.ops.watchdog();
  }
}
