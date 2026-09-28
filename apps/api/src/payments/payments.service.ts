import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException, OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Job, Queue } from 'bullmq';
import { BillingService } from '../billing/billing.service';
import { isUniqueViolation } from '../common/errors.filter';
import { PrismaService } from '../prisma/prisma.service';
import { billNumberFrom, HmacWebhookProvider, MockBankProvider, type IncomingTxn, type PaymentProvider } from './providers';

export const PAYMENTS_QUEUE = 'payments';

export type MatchResult = 'confirmed' | 'duplicate' | 'no_bill' | 'no_pending_payment' | 'amount_mismatch';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {
    if (process.env.MOCK_PROVIDERS !== 'false') this.providers.set('mock', new MockBankProvider(prisma));
    if (process.env.PAYMENT_WEBHOOK_SECRET) {
      const name = process.env.PAYMENT_PROVIDER ?? 'bank';
      this.providers.set(name, new HmacWebhookProvider(name, process.env.PAYMENT_WEBHOOK_SECRET, process.env.PAYMENT_LOOKUP_URL));
    }
  }

  provider(name: string) {
    const p = this.providers.get(name);
    if (!p) throw new NotFoundException(`Chưa cấu hình đối tác thanh toán ${name}`);
    return p;
  }

  /** Webhook: kiểm tra chữ ký, lưu payload gốc, ghi nhận từng giao dịch; gửi trùng không cộng tiền 2 lần. */
  async webhook(name: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>, body: unknown) {
    const provider = this.provider(name);
    const ok = !!raw && provider.verify(raw, headers);
    const results: { txnId: string; result: MatchResult }[] = [];
    if (ok) for (const t of provider.parse(body)) results.push({ txnId: t.txnId, result: await this.match(t) });
    await this.prisma.webhookLog.create({
      data: {
        provider: name,
        kind: 'PAYMENT',
        headers: headers as Prisma.InputJsonValue,
        body: (body ?? {}) as Prisma.InputJsonValue,
        signatureOk: ok,
        result: ok ? JSON.stringify(results) : 'INVALID_SIGNATURE',
      },
    });
    if (!ok) throw new UnauthorizedException('Chữ ký webhook không hợp lệ');
    return { results };
  }

  /** Khớp giao dịch với thanh toán QR đang chờ theo mã bill trong nội dung và đúng số tiền. */
  async match(t: IncomingTxn): Promise<MatchResult> {
    if (await this.prisma.payment.findUnique({ where: { providerTxnId: t.txnId } })) return 'duplicate';
    const number = billNumberFrom(t.content);
    if (number === null) return 'no_bill';
    const bill = await this.prisma.bill.findFirst({ where: { number } });
    if (!bill) return 'no_bill';
    const pending = await this.prisma.payment.findMany({ where: { billId: bill.id, status: 'PENDING', method: { in: ['QR', 'EWALLET', 'CARD'] } } });
    if (pending.length === 0) return 'no_pending_payment';
    const payment = pending.find((p) => p.amount === t.amount);
    if (!payment) {
      this.logger.warn(`Giao dịch ${t.txnId} số tiền ${t.amount} không khớp bill ${bill.number}`);
      return 'amount_mismatch';
    }
    try {
      return (await this.billing.confirmOnly(null, payment.id, t.txnId)) ? 'confirmed' : 'duplicate';
    } catch (e) {
      if (isUniqueViolation(e)) return 'duplicate';
      throw e;
    }
  }

  /** Đối soát (mục 13.5): thanh toán chờ quá lâu mà không có webhook thì tự hỏi lại đối tác. */
  async reconcile() {
    const after = Number(process.env.RECONCILE_AFTER_MS ?? 120_000);
    const stale = await this.prisma.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - after), gt: new Date(Date.now() - 86_400_000) } },
      orderBy: { createdAt: 'asc' },
    });
    if (stale.length === 0) return { checked: 0, confirmed: 0 };
    const since = new Date(stale[0].createdAt.getTime() - 60_000);
    let confirmed = 0;
    for (const provider of this.providers.values()) {
      let txns: IncomingTxn[] = [];
      try {
        txns = await provider.lookup(since);
      } catch (e) {
        this.logger.warn(`Đối soát ${provider.name} lỗi: ${e instanceof Error ? e.message : e}`);
      }
      for (const t of txns) if ((await this.match(t)) === 'confirmed') confirmed++;
    }
    return { checked: stale.length, confirmed };
  }
}

@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly payments: PaymentsService,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.queue.upsertJobScheduler('reconcile', { every: Number(process.env.RECONCILE_EVERY_MS ?? 60_000) }, { name: 'reconcile' });
  }

  async process(job: Job) {
    if (job.name === 'reconcile') return this.payments.reconcile();
  }
}
