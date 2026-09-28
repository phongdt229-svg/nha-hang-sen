import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';

/** Một giao dịch tiền vào tài khoản (từ webhook hoặc từ tra cứu sao kê). */
export interface IncomingTxn {
  txnId: string;
  amount: number;
  content: string;
}

/**
 * Adapter đơn vị trung gian thanh toán (PayOS, Casso, cổng ngân hàng… — mục 3.6).
 * Mỗi đơn vị có định dạng webhook và chữ ký riêng; thêm đối tác = thêm một lớp thực thi interface này.
 */
export interface PaymentProvider {
  readonly name: string;
  verify(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parse(body: unknown): IncomingTxn[];
  /** Tự hỏi lại giao dịch từ một thời điểm khi webhook không đến (đối soát định kỳ). */
  lookup(since: Date): Promise<IncomingTxn[]>;
}

export function hmacHex(secret: string, raw: Buffer | string) {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

interface HmacBody {
  transactions?: { id: string | number; amount: number; description: string }[];
}

function parseHmacBody(body: unknown): IncomingTxn[] {
  const txns = (body as HmacBody)?.transactions;
  if (!Array.isArray(txns)) return [];
  return txns
    .filter((t) => t && (typeof t.id === 'string' || typeof t.id === 'number') && Number.isSafeInteger(t.amount) && typeof t.description === 'string')
    .map((t) => ({ txnId: String(t.id), amount: t.amount, content: t.description }));
}

/**
 * Định dạng webhook chung ký HMAC-SHA256 trên body gốc (header `x-signature`, hex), body
 * `{ transactions: [{ id, amount, description }] }`. Dùng trực tiếp với dịch vụ có định dạng này,
 * hoặc làm mẫu để viết adapter cho đối tác đã chọn.
 */
export class HmacWebhookProvider implements PaymentProvider {
  constructor(
    readonly name: string,
    private readonly secret: string,
    private readonly lookupUrl?: string,
  ) {}

  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    const sig = headers['x-signature'];
    return typeof sig === 'string' && safeEqualHex(sig, hmacHex(this.secret, raw));
  }

  parse(body: unknown) {
    return parseHmacBody(body);
  }

  async lookup(since: Date): Promise<IncomingTxn[]> {
    if (!this.lookupUrl) return [];
    const res = await fetch(`${this.lookupUrl}?since=${encodeURIComponent(since.toISOString())}`, {
      headers: { 'x-signature': hmacHex(this.secret, since.toISOString()) },
    });
    if (!res.ok) throw new Error(`Tra cứu giao dịch lỗi ${res.status}`);
    return parseHmacBody(await res.json());
  }
}

/** Ngân hàng giả lập cho dev/test: sao kê nằm trong bảng mock_bank_txns. */
export class MockBankProvider extends HmacWebhookProvider {
  constructor(private readonly prisma: PrismaService) {
    super('mock', process.env.MOCK_WEBHOOK_SECRET ?? 'mock-secret');
  }

  override async lookup(since: Date): Promise<IncomingTxn[]> {
    const rows = await this.prisma.mockBankTxn.findMany({ where: { createdAt: { gte: since } } });
    return rows.map((r) => ({ txnId: r.txnId, amount: r.amount, content: r.content }));
  }
}

/** Tìm mã bill trong nội dung chuyển khoản; ngân hàng hay bỏ dấu "-" nên chấp nhận cả hai dạng. */
export function billNumberFrom(content: string): number | null {
  const m = /B(\d{3})-?(\d{5})/i.exec(content);
  if (!m || m[1] !== (process.env.BRANCH_CODE ?? '001')) return null;
  return Number(m[2]);
}
