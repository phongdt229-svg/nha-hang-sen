import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { businessDay } from '@nhs/pricing';
import { z } from 'zod';
import { Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { cutoffHour } from '../billing/billing.service';
import { ZodPipe } from '../common/zod.pipe';
import { EInvoiceService } from './einvoice.service';

const opt = (max: number) => z.string().trim().max(max).nullish();
const BuyerSchema = z.object({
  kind: z.enum(['PERSON', 'COMPANY']),
  taxCode: opt(14),
  name: opt(200),
  address: opt(300),
  email: z.string().trim().email().max(200).nullish().or(z.literal('')),
  phone: opt(20),
  idNumber: opt(20),
});
const AdjustSchema = z.object({ reason: z.string().min(1).max(200), buyer: BuyerSchema });
const ReasonSchema = z.object({ reason: z.string().min(1).max(200) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');
const ListQuery = z.object({
  from: day,
  to: day,
  status: z.enum(['PENDING', 'SENT', 'ISSUED', 'FAILED', 'ADJUSTED', 'REPLACED']).optional(),
});
const Range = z.object({ from: day, to: day });
const DayQuery = z.object({ day: day.optional() });

/** Hóa đơn điện tử (mục 12): thu ngân nhập người mua và phát hành; kế toán điều chỉnh/thay thế. */
@Controller()
export class EInvoiceController {
  constructor(private readonly einvoice: EInvoiceService) {}

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT', 'TABLET')
  @Get('tax-codes/:mst')
  lookup(@Param('mst') mst: string) {
    return this.einvoice.lookupTaxCode(mst);
  }

  @Allow('CASHIER', 'MANAGER', 'TABLET')
  @Put('bills/:id/buyer')
  setBuyer(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(BuyerSchema)) b: z.infer<typeof BuyerSchema>) {
    return this.einvoice.setBuyer(p, id, b);
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Get('bills/:id/buyer')
  buyer(@Param('id', ParseUUIDPipe) id: string) {
    return this.einvoice.buyer(id);
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Get('bills/:id/einvoices')
  forBill(@Param('id', ParseUUIDPipe) id: string) {
    return this.einvoice.forBill(id);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('bills/:id/einvoice')
  request(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.einvoice.requestForBill(p, id);
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Get('einvoices/attention')
  attention() {
    return this.einvoice.attention();
  }

  @Allow('MANAGER', 'ACCOUNTANT')
  @Get('einvoices/tax-summary')
  taxSummary(@Query(new ZodPipe(Range)) q: z.infer<typeof Range>) {
    return this.einvoice.taxSummary(q.from, q.to);
  }

  @Allow('MANAGER', 'ACCOUNTANT')
  @Get('einvoices/reconcile')
  reconcile(@Query(new ZodPipe(DayQuery)) q: z.infer<typeof DayQuery>) {
    return this.einvoice.reconcile(q.day ?? businessDay(new Date(), cutoffHour()));
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Post('einvoices/retry-pending')
  retryPending() {
    return this.einvoice.retryPending();
  }

  @Allow('MANAGER', 'ACCOUNTANT')
  @Get('einvoices')
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.einvoice.list(q.from, q.to, q.status);
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Get('einvoices/:id')
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.einvoice.dtoById(id);
  }

  @Allow('ACCOUNTANT', 'MANAGER')
  @Post('einvoices/:id/adjust')
  adjust(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AdjustSchema)) b: z.infer<typeof AdjustSchema>) {
    return this.einvoice.adjust(p, id, b.reason, b.buyer);
  }

  @Allow('ACCOUNTANT', 'MANAGER')
  @Post('einvoices/:id/replace')
  replace(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.einvoice.replace(p, id, b.reason);
  }
}
