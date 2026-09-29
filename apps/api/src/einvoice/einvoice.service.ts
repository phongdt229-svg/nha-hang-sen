import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import type { EInvoice, EInvoiceKind, EInvoiceStatus, Prisma } from '@prisma/client';
import {
  EInvoiceRejectedError,
  isValidTaxCodeFormat,
  MockEInvoiceAdapter,
  type DieuChinhInput,
  type EInvoiceAdapter,
  type KetQuaPhatHanh,
} from '@nhs/einvoice-adapters';
import { businessDay, refundByTaxRate, vnDate } from '@nhs/pricing';
import type { BillBuyerDto, EInvoiceDto } from '@nhs/types';
import type { Job, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { actorId, type Principal } from '../auth/principal';
import { billNumber, fromSnapshot } from '../billing/bill.calc';
import { cutoffHour } from '../billing/billing.service';
import { AuditService } from '../common/audit.service';
import { EventsService } from '../events/events.service';
import { OutboxPublisher } from '../events/outbox.publisher';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import type { ReportTable } from '../reports/table';
import { assertTabletOwnsSession, currentTables } from '../sessions/session.helpers';
import { adjustmentLines, buildInvoice, byRate, toBuyerDto, toEInvoiceDto, type TaxLine } from './einvoice.mapper';

export const EINVOICE_QUEUE = 'einvoice';
export const EINVOICE_ADAPTER = Symbol('EINVOICE_ADAPTER');

const autoIssue = () => process.env.EINVOICE_AUTO !== 'false';
const retryAfterMs = () => Number(process.env.EINVOICE_RETRY_AFTER_MS ?? 60_000);

/** Trạng thái còn hiệu lực khi cộng doanh thu hóa đơn (bản bị thay thế không tính). */
const EFFECTIVE: EInvoiceStatus[] = ['ISSUED', 'ADJUSTED'];
const DONE: EInvoiceStatus[] = ['ISSUED', 'ADJUSTED', 'REPLACED'];

export const originalKey = (billId: string) => `einv:${billId}:ORIGINAL`;

export function createAdapter(): EInvoiceAdapter {
  const provider = process.env.EINVOICE_PROVIDER ?? 'mock';
  if (provider === 'mock' && process.env.MOCK_PROVIDERS !== 'false') {
    return new MockEInvoiceAdapter({ lookupBase: process.env.EINVOICE_LOOKUP_BASE });
  }
  throw new Error(`Chưa có adapter cho nhà cung cấp hóa đơn điện tử "${provider}"`);
}

export interface BuyerInput {
  kind: 'PERSON' | 'COMPANY';
  taxCode?: string | null;
  name?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  idNumber?: string | null;
}

@Injectable()
export class EInvoiceService implements OnModuleInit {
  private readonly logger = new Logger('EInvoice');

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly outbox: OutboxPublisher,
    private readonly audit: AuditService,
    @Inject(EINVOICE_ADAPTER) readonly adapter: EInvoiceAdapter,
    @InjectQueue(EINVOICE_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    // Phát hành tự động sau thanh toán (mục 12.4). Tách bill: mỗi bill con một bill.paid → một hóa đơn.
    this.outbox.on('bill.paid', async (tx, e) => {
      if (autoIssue()) await this.createOriginal(tx, (e.data as { billId: string }).billId);
    });
    // Hoàn tiền sau khi đã xuất hóa đơn → hóa đơn điều chỉnh giảm (mục 12.5).
    this.outbox.on('payment.refunded', async (tx, e) => {
      await this.createRefundAdjustment(tx, (e.data as { refundId: string }).refundId);
    });
    // Job chạy sau khi transaction ghi hóa đơn đã commit; chưa thấy dòng thì lượt quét định kỳ sẽ gửi lại.
    this.outbox.on('einvoice.requested', async (_tx, e) => {
      await this.enqueue((e.data as { einvoiceId: string }).einvoiceId, 300);
    });
    if (this.adapter instanceof MockEInvoiceAdapter) {
      const last = await this.prisma.eInvoice.findFirst({ where: { provider: 'mock', number: { not: null } }, orderBy: { number: 'desc' } });
      if (last?.number) this.adapter.resumeFrom(Number(last.number));
    }
  }

  async enqueue(id: string, delay = 0) {
    await this.queue.add('issue', { id }, { jobId: id, delay, attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true, removeOnFail: true });
  }

  private async route(tx: Tx, billId: string) {
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } });
    const tables = await currentTables(tx, bill.sessionId);
    return { sessionId: bill.sessionId, tableIds: tables.map((t) => t.id), billId };
  }

  /** Tạo yêu cầu hóa đơn gốc; khóa idempotency theo bill nên gọi lại bao nhiêu lần cũng chỉ có một. */
  async createOriginal(tx: Tx, billId: string): Promise<EInvoice> {
    const key = originalKey(billId);
    const existing = await tx.eInvoice.findUnique({ where: { idempotencyKey: key } });
    if (existing) return existing;
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId } });
    if (bill.status !== 'PAID' && bill.status !== 'CLOSED') throw new ConflictException('Chỉ phát hành hóa đơn cho bill đã thanh toán đủ');
    const priced = fromSnapshot(await tx.billLine.findMany({ where: { billId } }));
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO einvoices (id, bill_id, kind, provider, business_day, total_base, total_tax, total, taxes, payload, status, idempotency_key)
      VALUES (${randomUUID()}, ${billId}, 'ORIGINAL'::"EInvoiceKind", ${this.adapter.name}, ${bill.businessDay}, ${priced.totalBase},
              ${priced.totalTax}, ${priced.total}, ${JSON.stringify(byRate(priced.taxes))}::jsonb, '{}'::jsonb, 'PENDING'::"EInvoiceStatus", ${key})
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
    const inv = await tx.eInvoice.findUniqueOrThrow({ where: { idempotencyKey: key } });
    if (rows.length > 0) await this.events.append(tx, 'einvoice.requested', 'einvoice', inv.id, { ...(await this.route(tx, billId)), einvoiceId: inv.id });
    return inv;
  }

  private async createRefundAdjustment(tx: Tx, refundId: string) {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    const original = await tx.eInvoice.findFirst({ where: { billId: refund.billId, kind: 'ORIGINAL', status: { not: 'FAILED' } } });
    if (!original) return; // Chưa xuất hóa đơn: bút toán âm chỉ nằm trong báo cáo doanh thu.
    const priced = fromSnapshot(await tx.billLine.findMany({ where: { billId: refund.billId } }));
    const taxes = byRate(refundByTaxRate(refund.amount, priced.taxes));
    await this.createLinked(tx, original, 'ADJUSTMENT', `einv:adj:${refundId}`, refund.reason, taxes, refund.businessDay, {
      lyDo: `Hoàn tiền: ${refund.reason}`,
      dong: adjustmentLines(taxes, 'hoàn tiền'),
    });
  }

  private async createLinked(
    tx: Tx,
    original: EInvoice,
    kind: Exclude<EInvoiceKind, 'ORIGINAL'>,
    key: string,
    reason: string,
    taxes: TaxLine[],
    day: string | null,
    payload: Omit<DieuChinhInput, 'khoa'> | Record<string, never>,
  ) {
    const existing = await tx.eInvoice.findUnique({ where: { idempotencyKey: key } });
    if (existing) return existing;
    const inv = await tx.eInvoice.create({
      data: {
        billId: original.billId,
        kind,
        provider: original.provider,
        businessDay: day,
        totalBase: taxes.reduce((a, t) => a + t.base, 0),
        totalTax: taxes.reduce((a, t) => a + t.tax, 0),
        total: taxes.reduce((a, t) => a + t.base + t.tax, 0),
        taxes: taxes as unknown as Prisma.InputJsonValue,
        payload: payload as Prisma.InputJsonValue,
        idempotencyKey: key,
      },
    });
    await tx.eInvoiceLink.create({ data: { originalId: original.id, linkedId: inv.id, kind, reason } });
    await this.events.append(tx, 'einvoice.requested', 'einvoice', inv.id, { ...(await this.route(tx, original.billId)), einvoiceId: inv.id });
    return inv;
  }

  /**
   * Gửi một hóa đơn tới nhà cung cấp. Gọi adapter ngoài transaction, với khóa idempotency cố định
   * nên gửi lại sau lỗi mạng không phát hành trùng. Trả về "retry" khi cần thử lại.
   */
  async issue(id: string): Promise<'done' | 'skipped' | 'retry'> {
    const inv = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: EInvoiceStatus }[]>`SELECT status FROM einvoices WHERE id = ${id} FOR UPDATE`;
      if (!row || DONE.includes(row.status) || row.status === 'FAILED') return null;
      return tx.eInvoice.update({ where: { id }, data: { status: 'SENT', attempts: { increment: 1 } } });
    });
    if (!inv) return 'skipped';

    const original = inv.kind === 'ORIGINAL' ? inv : await this.originalOf(inv.id);
    if (inv.kind !== 'ORIGINAL' && !original?.number) {
      // Hóa đơn gốc chưa được cấp số: chờ, lượt quét sau gửi lại.
      await this.prisma.eInvoice.update({ where: { id }, data: { status: 'PENDING' } });
      return 'retry';
    }

    let result: KetQuaPhatHanh;
    let payload: unknown;
    try {
      if (inv.kind === 'ADJUSTMENT') {
        const input = { ...(inv.payload as unknown as Omit<DieuChinhInput, 'khoa'>), khoa: inv.idempotencyKey };
        payload = input;
        result = await this.adapter.dieuChinh(original!.number!, input);
      } else {
        const input = await this.invoiceInput(inv);
        payload = input;
        result = inv.kind === 'REPLACEMENT' ? await this.adapter.thayThe(original!.number!, input) : await this.adapter.phatHanh(input);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof EInvoiceRejectedError) {
        await this.prisma.$transaction(async (tx) => {
          await tx.eInvoice.update({ where: { id }, data: { status: 'FAILED', error: message } });
          await this.events.append(tx, 'einvoice.failed', 'einvoice', id, { ...(await this.route(tx, inv.billId)), einvoiceId: id, error: message });
        });
        this.events.wake();
        return 'done';
      }
      this.logger.warn(`Hóa đơn ${id} chưa gửi được, sẽ thử lại: ${message}`);
      await this.prisma.eInvoice.update({ where: { id }, data: { status: 'PENDING', error: message } });
      return 'retry';
    }

    const fresh = await this.prisma.$transaction(async (tx) => {
      // Hai tiến trình cùng gửi một hóa đơn (job + thu ngân bấm gửi lại): nhà cung cấp trả cùng số, chỉ ghi nhận một lần.
      const [row] = await tx.$queryRaw<{ status: EInvoiceStatus }[]>`SELECT status FROM einvoices WHERE id = ${id} FOR UPDATE`;
      if (DONE.includes(row.status)) return false;
      await tx.eInvoice.update({
        where: { id },
        data: {
          status: 'ISSUED',
          number: result.soHoaDon,
          series: result.kyHieu,
          templateCode: result.mauSo,
          lookupCode: result.maTraCuu,
          lookupUrl: result.urlTraCuu ?? null,
          taxAuthorityCode: result.maCoQuanThue ?? null,
          pdfUrl: result.pdfUrl ?? null,
          issuedAt: new Date(),
          error: null,
          payload: payload as Prisma.InputJsonValue,
        },
      });
      const route = await this.route(tx, inv.billId);
      if (inv.kind === 'ORIGINAL') {
        await this.events.append(tx, 'einvoice.issued', 'einvoice', id, { ...route, einvoiceId: id, number: result.soHoaDon, lookupCode: result.maTraCuu });
      } else {
        await tx.eInvoice.update({ where: { id: original!.id }, data: { status: inv.kind === 'REPLACEMENT' ? 'REPLACED' : 'ADJUSTED' } });
        await this.events.append(tx, 'einvoice.adjusted', 'einvoice', id, { ...route, einvoiceId: id, originalId: original!.id, kind: inv.kind, number: result.soHoaDon });
      }
      return true;
    });
    if (fresh) this.events.wake();
    return 'done';
  }

  private async originalOf(linkedId: string) {
    const link = await this.prisma.eInvoiceLink.findFirst({ where: { linkedId } });
    return link ? this.prisma.eInvoice.findUnique({ where: { id: link.originalId } }) : null;
  }

  private async invoiceInput(inv: EInvoice) {
    const bill = await this.prisma.bill.findUniqueOrThrow({ where: { id: inv.billId } });
    const [lines, buyer] = await Promise.all([
      this.prisma.billLine.findMany({ where: { billId: inv.billId }, orderBy: { name: 'asc' } }),
      this.prisma.billBuyer.findUnique({ where: { billId: inv.billId } }),
    ]);
    return buildInvoice(inv.idempotencyKey, billNumber(bill.number), vnDate(new Date()), lines, buyer);
  }

  /**
   * Quét định kỳ: gửi lại hóa đơn còn chờ (mất Internet, tiến trình khởi động lại).
   */
  async sweep() {
    const stale = await this.prisma.eInvoice.findMany({
      where: { status: { in: ['PENDING', 'SENT'] }, createdAt: { lte: new Date(Date.now() - retryAfterMs()) } },
      select: { id: true },
      take: 200,
    });
    for (const s of stale) await this.enqueue(s.id);
    // Cảnh báo tồn đọng do watchdog gửi (observability), có chống gửi lặp.
    return { requeued: stale.length };
  }

  /** Chạy ngay các hóa đơn đang chờ (thu ngân bấm "Gửi lại tất cả" khi có mạng). */
  async retryPending() {
    const pending = await this.prisma.eInvoice.findMany({ where: { status: { in: ['PENDING', 'SENT'] } }, orderBy: { createdAt: 'asc' }, take: 200 });
    let issued = 0;
    for (const p of pending) if ((await this.issue(p.id)) === 'done') issued++;
    return { checked: pending.length, issued };
  }

  async setBuyer(p: Principal, billId: string, b: BuyerInput): Promise<BillBuyerDto> {
    if (b.kind === 'COMPANY') {
      if (!b.taxCode) throw new BadRequestException('Hóa đơn công ty cần mã số thuế');
      if (!b.name) throw new BadRequestException('Hóa đơn công ty cần tên đơn vị');
    }
    if (b.taxCode && !isValidTaxCodeFormat(b.taxCode)) throw new BadRequestException(`Mã số thuế ${b.taxCode} sai định dạng`);
    const data = {
      kind: b.kind,
      taxCode: b.taxCode || null,
      name: b.name || null,
      address: b.address || null,
      email: b.email || null,
      phone: b.phone || null,
      idNumber: b.idNumber || null,
    };
    let retry: string | null = null;
    const buyer = await this.prisma.$transaction(async (tx) => {
      const bill = await tx.bill.findUnique({ where: { id: billId } });
      if (!bill) throw new NotFoundException('Không tìm thấy bill');
      await assertTabletOwnsSession(tx, p, bill.sessionId);
      const inv = await tx.eInvoice.findUnique({ where: { idempotencyKey: originalKey(billId) } });
      if (inv && DONE.includes(inv.status)) {
        throw new ConflictException({ error: 'EINVOICE_ISSUED', message: 'Hóa đơn đã phát hành; sửa thông tin người mua bằng hóa đơn điều chỉnh' });
      }
      const before = await tx.billBuyer.findUnique({ where: { billId } });
      const saved = await tx.billBuyer.upsert({ where: { billId }, create: { billId, ...data }, update: data });
      await this.audit.record(tx, { actorId: actorId(p), action: 'einvoice.buyer', entity: 'bill', entityId: billId, before: toBuyerDto(before), after: toBuyerDto(saved) });
      // Hóa đơn lỗi do sai thông tin: sửa xong gửi lại với đúng khóa cũ → không phát hành trùng.
      if (inv?.status === 'FAILED') {
        await tx.eInvoice.update({ where: { id: inv.id }, data: { status: 'PENDING', error: null } });
        retry = inv.id;
      }
      return saved;
    });
    if (retry) await this.enqueue(retry);
    return toBuyerDto(buyer)!;
  }

  async buyer(billId: string) {
    return toBuyerDto(await this.prisma.billBuyer.findUnique({ where: { billId } }));
  }

  async lookupTaxCode(mst: string) {
    if (!isValidTaxCodeFormat(mst)) throw new BadRequestException(`Mã số thuế ${mst} sai định dạng`);
    const r = await this.adapter.traCuuMST(mst);
    if (!r) throw new NotFoundException(`Không tìm thấy mã số thuế ${mst}`);
    return { taxCode: mst, name: r.ten, address: r.diaChi };
  }

  /** Thu ngân phát hành thủ công (khi tắt tự động) hoặc gửi lại hóa đơn lỗi. */
  async requestForBill(p: Principal, billId: string) {
    const inv = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bills WHERE id = ${billId} FOR UPDATE`;
      if (!row) throw new NotFoundException('Không tìm thấy bill');
      let inv = await this.createOriginal(tx, billId);
      if (inv.status === 'FAILED') inv = await tx.eInvoice.update({ where: { id: inv.id }, data: { status: 'PENDING', error: null } });
      await this.audit.record(tx, { actorId: actorId(p), action: 'einvoice.request', entity: 'bill', entityId: billId });
      return inv;
    });
    this.events.wake();
    if (inv.status === 'PENDING') await this.issue(inv.id);
    return this.dtoById(inv.id);
  }

  /** Điều chỉnh thông tin người mua (sai tên, địa chỉ) — chỉ kế toán/quản lý (mục 12.5). */
  async adjust(p: Principal, id: string, reason: string, b: BuyerInput) {
    if (b.taxCode && !isValidTaxCodeFormat(b.taxCode)) throw new BadRequestException(`Mã số thuế ${b.taxCode} sai định dạng`);
    const inv = await this.prisma.$transaction(async (tx) => {
      const original = await this.lockIssued(tx, id);
      const count = await tx.eInvoiceLink.count({ where: { originalId: id } });
      const saved = await tx.billBuyer.upsert({
        where: { billId: original.billId },
        create: { billId: original.billId, kind: b.kind, taxCode: b.taxCode, name: b.name, address: b.address, email: b.email, phone: b.phone },
        update: { kind: b.kind, taxCode: b.taxCode, name: b.name, address: b.address, email: b.email, phone: b.phone },
      });
      await this.audit.record(tx, { actorId: actorId(p), action: 'einvoice.adjust', entity: 'einvoice', entityId: id, after: toBuyerDto(saved), reason });
      return this.createLinked(tx, original, 'ADJUSTMENT', `einv:adj:${id}:${count + 1}`, reason, [], businessDay(new Date(), cutoffHour()), {
        lyDo: reason,
        nguoiMua: { loai: saved.kind, maSoThue: saved.taxCode, ten: saved.name, diaChi: saved.address, email: saved.email, soDienThoai: saved.phone },
      });
    });
    this.events.wake();
    await this.issue(inv.id);
    return this.dtoById(inv.id);
  }

  /** Thay thế hóa đơn sai sót bằng hóa đơn mới lập lại từ bill và thông tin người mua hiện tại. */
  async replace(p: Principal, id: string, reason: string) {
    const inv = await this.prisma.$transaction(async (tx) => {
      const original = await this.lockIssued(tx, id);
      await this.audit.record(tx, { actorId: actorId(p), action: 'einvoice.replace', entity: 'einvoice', entityId: id, reason });
      const taxes = original.taxes as TaxLine[];
      return this.createLinked(tx, original, 'REPLACEMENT', `einv:rep:${id}`, reason, taxes, original.businessDay, {});
    });
    this.events.wake();
    await this.issue(inv.id);
    return this.dtoById(inv.id);
  }

  private async lockIssued(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM einvoices WHERE id = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException('Không tìm thấy hóa đơn');
    const inv = await tx.eInvoice.findUniqueOrThrow({ where: { id } });
    if (inv.kind !== 'ORIGINAL' || !['ISSUED', 'ADJUSTED'].includes(inv.status)) {
      throw new ConflictException('Chỉ điều chỉnh/thay thế hóa đơn gốc đã phát hành');
    }
    return inv;
  }

  async dtoById(id: string): Promise<EInvoiceDto> {
    const inv = await this.prisma.eInvoice.findUniqueOrThrow({ where: { id } });
    return (await this.toDtos([inv]))[0];
  }

  private async toDtos(rows: EInvoice[]): Promise<EInvoiceDto[]> {
    const ids = [...new Set(rows.map((r) => r.billId))];
    const [bills, buyers] = await Promise.all([
      this.prisma.bill.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } }),
      this.prisma.billBuyer.findMany({ where: { billId: { in: ids } } }),
    ]);
    const num = new Map(bills.map((b) => [b.id, billNumber(b.number)]));
    const buyer = new Map(buyers.map((b) => [b.billId, b]));
    return rows.map((r) => toEInvoiceDto(r, num.get(r.billId) ?? '', buyer.get(r.billId) ?? null));
  }

  async forBill(billId: string) {
    return this.toDtos(await this.prisma.eInvoice.findMany({ where: { billId }, orderBy: { createdAt: 'asc' } }));
  }

  /** Danh sách theo ngày kinh doanh; hóa đơn chưa phát hành (chưa có ngày) lọc theo ngày tạo. */
  async list(from: string, to: string, status?: EInvoiceStatus) {
    const rows = await this.prisma.eInvoice.findMany({
      where: {
        ...(status ? { status } : {}),
        OR: [{ businessDay: { gte: from, lte: to } }, { businessDay: null, createdAt: { gte: new Date(`${from}T00:00:00+07:00`) } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return this.toDtos(rows);
  }

  /** Hóa đơn lỗi hoặc chưa phát hành, cần thu ngân xử lý trong ngày (mục 12.8). */
  async attention() {
    return this.toDtos(
      await this.prisma.eInvoice.findMany({ where: { status: { in: ['PENDING', 'SENT', 'FAILED'] } }, orderBy: { createdAt: 'asc' }, take: 100 }),
    );
  }

  /** Bảng kê hóa đơn theo thuế suất (tiền trước thuế, tiền thuế từng mức) để kế toán kê khai. */
  async taxSummary(from: string, to: string): Promise<ReportTable> {
    const rows = await this.prisma.eInvoice.findMany({ where: { status: { in: EFFECTIVE }, businessDay: { gte: from, lte: to } } });
    const agg = new Map<string, { day: string; rate: number; count: number; base: number; tax: number }>();
    for (const r of rows) {
      for (const t of r.taxes as TaxLine[]) {
        const k = `${r.businessDay}|${t.rate}`;
        const g = agg.get(k) ?? { day: r.businessDay!, rate: t.rate, count: 0, base: 0, tax: 0 };
        g.count++;
        g.base += t.base;
        g.tax += t.tax;
        agg.set(k, g);
      }
    }
    const list = [...agg.values()].sort((a, b) => a.day.localeCompare(b.day) || a.rate - b.rate);
    return {
      title: 'Bảng kê hóa đơn theo thuế suất',
      columns: [
        { key: 'day', label: 'Ngày kinh doanh' },
        { key: 'rate', label: 'Thuế suất', kind: 'text' },
        { key: 'count', label: 'Số hóa đơn', kind: 'number' },
        { key: 'base', label: 'Tiền trước thuế', kind: 'money' },
        { key: 'tax', label: 'Tiền thuế', kind: 'money' },
        { key: 'total', label: 'Tổng thanh toán', kind: 'money' },
      ],
      rows: list.map((g) => ({ day: g.day, rate: `${g.rate / 100}%`, count: g.count, base: g.base, tax: g.tax, total: g.base + g.tax })),
      totals: {
        count: rows.length,
        base: list.reduce((a, g) => a + g.base, 0),
        tax: list.reduce((a, g) => a + g.tax, 0),
        total: list.reduce((a, g) => a + g.base + g.tax, 0),
      },
    };
  }

  /** Đối soát: doanh thu (thu − hoàn) so với tổng hóa đơn đã phát hành theo ngày kinh doanh. */
  async reconcile(day: string) {
    const [paid, refunded, invoiced, open] = await Promise.all([
      this.prisma.bill.aggregate({ where: { businessDay: day, status: { in: ['PAID', 'CLOSED'] } }, _sum: { total: true } }),
      this.prisma.refund.aggregate({ where: { businessDay: day }, _sum: { amount: true } }),
      this.prisma.eInvoice.aggregate({ where: { businessDay: day, status: { in: EFFECTIVE } }, _sum: { total: true } }),
      this.prisma.eInvoice.count({ where: { status: { in: ['PENDING', 'SENT', 'FAILED'] } } }),
    ]);
    const revenue = (paid._sum.total ?? 0) - (refunded._sum.amount ?? 0);
    const invoicedTotal = invoiced._sum.total ?? 0;
    return { businessDay: day, revenue, invoiced: invoicedTotal, difference: revenue - invoicedTotal, unissued: open };
  }
}

@Processor(EINVOICE_QUEUE)
export class EInvoiceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly einvoice: EInvoiceService,
    @InjectQueue(EINVOICE_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.queue.upsertJobScheduler('sweep', { every: Number(process.env.EINVOICE_SWEEP_MS ?? 30_000) }, { name: 'sweep' });
  }

  async process(job: Job<{ id: string }>) {
    if (job.name === 'sweep') return this.einvoice.sweep();
    if (job.name === 'issue') {
      const r = await this.einvoice.issue(job.data.id);
      // Ném lỗi để BullMQ thử lại theo backoff; hết lượt thì lượt quét định kỳ tiếp tục.
      if (r === 'retry') throw new Error('Chưa gửi được hóa đơn, thử lại sau');
      return r;
    }
  }
}
