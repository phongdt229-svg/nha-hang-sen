import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Prisma, PrintJob, Printer } from '@prisma/client';
import type { AgentJob, AgentPollRequest, KitchenTicketDto, PrintDocument, PrinterDto, PrintJobDto, PrintJobKind } from '@nhs/types';
import { randomUUID } from 'node:crypto';
import { actorId, type Principal } from '../auth/principal';
import { BillingService } from '../billing/billing.service';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../events/events.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { KitchenService } from '../kitchen/kitchen.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { currentTables } from '../sessions/session.helpers';
import { kitchenTicketDoc, receiptDoc, targetLabel, testDoc } from './documents';

/** Agent đã nhận lệnh mà quá thời gian này không báo kết quả (treo, mất điện) → trả lệnh về hàng đợi. */
const leaseMs = () => Number(process.env.PRINT_LEASE_MS ?? 30_000);
/** Agent không gửi nhịp quá lâu → POS báo máy in mất kết nối. */
const staleMs = () => Number(process.env.PRINT_AGENT_STALE_MS ?? 15_000);
/** fallback: chỉ in phiếu bếp khi KDS không nhận (mặc định); always: in mọi phiếu; off: không in tự động. */
const kitchenMode = () => process.env.PRINT_KITCHEN_TICKETS ?? 'fallback';

const READY_STATES = ['ONLINE', 'UNKNOWN'];

export interface EnqueueInput {
  target: string;
  kind: PrintJobKind;
  title: string;
  document: PrintDocument;
  key: string;
  refType?: string;
  refId?: string;
}

@Injectable()
export class PrintingService implements OnModuleInit {
  private readonly logger = new Logger('Printing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly outbox: OutboxPublisher,
    private readonly audit: AuditService,
    private readonly kitchen: KitchenService,
    private readonly billing: BillingService,
  ) {}

  onModuleInit() {
    // Hết lượt gửi lại mà KDS không nhận → in phiếu giấy ở trạm bếp (mục 6, Sprint 3).
    this.outbox.on('kitchen.fallback', async (tx, e) => {
      if (kitchenMode() === 'off') return;
      const ticket = (e.data as { ticket: KitchenTicketDto }).ticket;
      await this.enqueueTicket(tx, ticket, `kitchen:${ticket.id}:fallback`);
    });
    this.outbox.on('kitchen.sent', async (tx, e) => {
      if (kitchenMode() !== 'always') return;
      const ticket = (e.data as { ticket?: KitchenTicketDto }).ticket;
      if (ticket && ticket.attempts <= 1) await this.enqueueTicket(tx, ticket, `kitchen:${ticket.id}:sent`);
    });
  }

  private enqueueTicket(tx: Tx, ticket: KitchenTicketDto, key: string, reprint = false) {
    return this.enqueue(tx, {
      target: ticket.station,
      kind: 'KITCHEN_TICKET',
      title: `Phiếu bếp ${ticket.orderNumber} · bàn ${ticket.tableCodes.join('+')}`,
      document: kitchenTicketDoc(ticket, reprint),
      key,
      refType: 'kitchen_ticket',
      refId: ticket.id,
    });
  }

  /** Xếp lệnh in; khóa idempotency nên phát sự kiện trùng hay bấm in hai lần vẫn chỉ in một lần. */
  async enqueue(tx: Tx, j: EnqueueInput): Promise<PrintJob> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO print_jobs (id, target, kind, title, document, ref_type, ref_id, idempotency_key)
      VALUES (${randomUUID()}, ${j.target}, ${j.kind}, ${j.title}, ${JSON.stringify(j.document)}::jsonb, ${j.refType ?? null}, ${j.refId ?? null}, ${j.key})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
    const job = await tx.printJob.findUniqueOrThrow({ where: { idempotencyKey: j.key } });
    if (rows.length > 0) await this.events.append(tx, 'print.queued', 'print_job', job.id, { jobId: job.id, target: j.target, kind: j.kind, title: j.title });
    return job;
  }

  private async enqueueNow(j: EnqueueInput) {
    const job = await this.prisma.$transaction((tx) => this.enqueue(tx, j));
    this.events.wake();
    return toJobDto(job);
  }

  /** In lại phiếu bếp theo yêu cầu (mỗi lần bấm một khóa riêng từ client). */
  async printTicket(p: Principal, ticketId: string, key: string) {
    const ticket = await this.kitchen.ticketDto(ticketId);
    return this.enqueueNow({
      target: ticket.station,
      kind: 'KITCHEN_TICKET',
      title: `Phiếu bếp ${ticket.orderNumber} · bàn ${ticket.tableCodes.join('+')} (in lại)`,
      document: kitchenTicketDoc(ticket, true),
      key: `kitchen:${ticketId}:manual:${key}`,
      refType: 'kitchen_ticket',
      refId: ticketId,
    });
  }

  /** In phiếu thanh toán (tạm tính hoặc sau khi thu) ra máy in quầy. */
  async printReceipt(p: Principal, billId: string, key: string) {
    const bill = await this.billing.byId(billId);
    const row = await this.prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    const tables = await currentTables(this.prisma, row.sessionId);
    // Phiên đã đóng (in lại sau khi thu tiền) thì lấy các bàn phiên từng ngồi.
    const lastTables = tables.length > 0 ? tables : (await this.prisma.tableAssignment.findMany({ where: { sessionId: row.sessionId }, include: { table: true } })).map((a) => a.table);
    return this.enqueueNow({
      target: 'RECEIPT',
      kind: 'RECEIPT',
      title: `Phiếu thanh toán ${bill.number}`,
      document: receiptDoc(bill, lastTables.map((t) => t.code)),
      key: `receipt:${billId}:${key}`,
      refType: 'bill',
      refId: billId,
    });
  }

  async printTest(target: string, key: string) {
    return this.enqueueNow({ target, kind: 'TEST', title: `In thử – ${targetLabel(target)}`, document: testDoc(target), key: `test:${target}:${key}` });
  }

  /**
   * Agent gửi nhịp kèm trạng thái máy in và nhận lệnh cần in. Chỉ giao lệnh cho máy đang sẵn sàng;
   * máy hết giấy / mất kết nối thì lệnh nằm lại trong hàng đợi.
   */
  async poll(p: Principal, body: AgentPollRequest): Promise<{ jobs: AgentJob[] }> {
    const agentId = p.sub;
    const now = new Date();
    const changed: Printer[] = [];
    const jobs = await this.prisma.$transaction(async (tx) => {
      for (const pr of body.printers) {
        const before = await tx.printer.findUnique({ where: { target: pr.target } });
        const saved = await tx.printer.upsert({
          where: { target: pr.target },
          create: { target: pr.target, name: pr.name ?? targetLabel(pr.target), state: pr.state, lastError: pr.error ?? null, lastSeenAt: now, agentId },
          update: { name: pr.name ?? before?.name ?? targetLabel(pr.target), state: pr.state, lastError: pr.error ?? null, lastSeenAt: now, agentId },
        });
        if (before?.state !== saved.state) changed.push(saved);
      }
      for (const pr of changed) {
        const type = READY_STATES.includes(pr.state) ? 'print.done' : 'print.failed';
        await this.events.append(tx, type, 'printer', pr.target, { target: pr.target, state: pr.state, error: pr.lastError, printer: true });
      }
      // Lệnh đã giao mà quá hạn không có kết quả → trả về hàng đợi.
      await tx.printJob.updateMany({ where: { status: 'PRINTING', leasedUntil: { lt: now } }, data: { status: 'QUEUED', error: 'Agent không báo kết quả, sẽ in lại' } });
      const ready = body.printers.filter((x) => READY_STATES.includes(x.state)).map((x) => x.target);
      if (ready.length === 0) return [];
      return tx.$queryRaw<PrintJob[]>`
        UPDATE print_jobs SET status = 'PRINTING', attempts = attempts + 1, leased_until = ${new Date(now.getTime() + leaseMs())}
        WHERE id IN (
          SELECT id FROM print_jobs WHERE status = 'QUEUED' AND target = ANY(${ready}::text[])
          ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
        RETURNING id, target, kind, title, document, created_at AS "createdAt"`;
    });
    if (changed.length > 0) this.events.wake();
    return {
      jobs: jobs
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((j) => ({ id: j.id, target: j.target, kind: j.kind as PrintJobKind, title: j.title, document: j.document as unknown as PrintDocument })),
    };
  }

  /** In xong. Gọi lại (agent gửi lại do mất mạng) không có tác dụng phụ. */
  async done(id: string) {
    const r = await this.prisma.$transaction(async (tx) => {
      const job = await tx.printJob.findUnique({ where: { id } });
      if (!job) throw new NotFoundException('Không tìm thấy lệnh in');
      if (job.status === 'DONE' || job.status === 'CANCELLED') return job;
      const saved = await tx.printJob.update({ where: { id }, data: { status: 'DONE', printedAt: new Date(), error: null, leasedUntil: null } });
      await this.events.append(tx, 'print.done', 'print_job', id, { jobId: id, target: job.target, title: job.title });
      return saved;
    });
    this.events.wake();
    return toJobDto(r);
  }

  /** In lỗi (hết giấy, kẹt giấy, mất kết nối): lệnh quay lại hàng đợi, POS được báo. */
  async failed(id: string, state: 'OFFLINE' | 'PAPER_OUT' | 'ERROR', error: string) {
    const r = await this.prisma.$transaction(async (tx) => {
      const job = await tx.printJob.findUnique({ where: { id } });
      if (!job) throw new NotFoundException('Không tìm thấy lệnh in');
      if (job.status !== 'PRINTING') return job;
      const saved = await tx.printJob.update({ where: { id }, data: { status: 'QUEUED', error, leasedUntil: null } });
      await tx.printer.updateMany({ where: { target: job.target }, data: { state, lastError: error } });
      await this.events.append(tx, 'print.failed', 'print_job', id, { jobId: id, target: job.target, title: job.title, state, error });
      return saved;
    });
    this.events.wake();
    return toJobDto(r);
  }

  async cancel(p: Principal, id: string) {
    const r = await this.prisma.$transaction(async (tx) => {
      const n = await tx.printJob.updateMany({ where: { id, status: { in: ['QUEUED', 'PRINTING'] } }, data: { status: 'CANCELLED', leasedUntil: null } });
      if (n.count === 0) throw new ConflictException('Lệnh in đã xong hoặc đã hủy');
      await this.audit.record(tx, { actorId: actorId(p), action: 'print.cancel', entity: 'print_job', entityId: id });
      return tx.printJob.findUniqueOrThrow({ where: { id } });
    });
    return toJobDto(r);
  }

  /** Trạng thái máy in và lệnh còn chờ, cho POS hiện cảnh báo. */
  async status(): Promise<{ printers: PrinterDto[]; pending: PrintJobDto[] }> {
    const [printers, pending] = await Promise.all([
      this.prisma.printer.findMany({ orderBy: { target: 'asc' } }),
      this.prisma.printJob.findMany({ where: { status: { in: ['QUEUED', 'PRINTING'] } }, orderBy: { createdAt: 'asc' }, take: 100 }),
    ]);
    const cutoff = Date.now() - staleMs();
    return {
      printers: printers.map((p) => ({
        target: p.target,
        name: p.name,
        state: p.state,
        lastError: p.lastError,
        lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
        stale: !p.lastSeenAt || p.lastSeenAt.getTime() < cutoff,
      })),
      pending: pending.map(toJobDto),
    };
  }

  async jobs(where: Prisma.PrintJobWhereInput = {}) {
    return (await this.prisma.printJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })).map(toJobDto);
  }
}

export function toJobDto(j: PrintJob): PrintJobDto {
  return {
    id: j.id,
    target: j.target,
    kind: j.kind as PrintJobKind,
    title: j.title,
    status: j.status,
    attempts: j.attempts,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    printedAt: j.printedAt?.toISOString() ?? null,
  };
}
