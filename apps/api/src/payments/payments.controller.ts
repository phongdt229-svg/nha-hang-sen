import { Body, Controller, ForbiddenException, Headers, Param, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Allow, Public } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from './payments.service';
import { hmacHex } from './providers';

const MockTxnSchema = z.object({ amount: z.number().int().positive(), content: z.string().min(1).max(200), deliverWebhook: z.boolean().default(true) });

export const mockEnabled = () => process.env.MOCK_PROVIDERS !== 'false';

@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Nhận kết quả thanh toán từ đối tác; xác thực bằng chữ ký, không bằng token. */
  @Public()
  @Post('webhooks/payments/:provider')
  webhook(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string>, @Body() body: unknown) {
    return this.payments.webhook(provider, req.rawBody, headers, body);
  }

  @Allow('MANAGER', 'ACCOUNTANT')
  @Post('payments/reconcile')
  reconcile() {
    return this.payments.reconcile();
  }

  /** Giả lập tiền về tài khoản (dev/test). deliverWebhook=false mô phỏng webhook bị mất. */
  @Allow('MANAGER', 'CASHIER')
  @Post('dev/mock-bank/transactions')
  async mockTxn(@Body(new ZodPipe(MockTxnSchema)) b: z.infer<typeof MockTxnSchema>) {
    if (!mockEnabled()) throw new ForbiddenException('Tắt ở môi trường thật');
    const txn = await this.prisma.mockBankTxn.create({ data: { txnId: `MOCK-${randomUUID()}`, amount: b.amount, content: b.content } });
    if (!b.deliverWebhook) return { txn, delivered: false };
    const body = { transactions: [{ id: txn.txnId, amount: txn.amount, description: txn.content }] };
    const raw = Buffer.from(JSON.stringify(body));
    const result = await this.payments.webhook('mock', raw, { 'x-signature': hmacHex(process.env.MOCK_WEBHOOK_SECRET ?? 'mock-secret', raw) }, body);
    return { txn, delivered: true, result };
  }
}
