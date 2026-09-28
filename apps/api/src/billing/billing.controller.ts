import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { BillingService } from './billing.service';
import { ShiftsService } from './shifts.service';

const VersionSchema = z.object({ version: z.number().int().min(0) });
const UnlockSchema = VersionSchema.extend({ reason: z.string().min(1).max(200) });
const DiscountSchema = VersionSchema.extend({ amount: z.number().int().min(0), reason: z.string().min(1).max(200) });
const PaySchema = z.object({ method: z.enum(['CASH', 'QR', 'CARD', 'EWALLET']), received: z.number().int().positive().optional() });
const ConfirmSchema = z.object({ providerTxnId: z.string().max(100).optional() });
const SplitSchema = VersionSchema.extend({
  groups: z.array(z.object({ label: z.string().min(1).max(20), orderItemIds: z.array(z.string().uuid()).min(1) })).min(2).max(20),
});
const ReasonSchema = z.object({ reason: z.string().min(1).max(200) });
const RefundSchema = z.object({ amount: z.number().int().positive(), method: z.enum(['CASH', 'QR', 'CARD', 'EWALLET']), reason: z.string().min(1).max(200) });
const OpenShiftSchema = z.object({ openingCash: z.number().int().min(0) });
const CloseShiftSchema = z.object({ countedCash: z.number().int().min(0), note: z.string().max(300).optional() });

@Controller()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly shifts: ShiftsService,
  ) {}

  @Allow('CASHIER', 'MANAGER', 'WAITER')
  @Get('sessions/:id/bills')
  bills(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.listForSession(id);
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Get('bills/:id')
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.byId(id);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('bills/:id/split')
  split(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SplitSchema)) b: z.infer<typeof SplitSchema>) {
    return this.billing.split(p, id, b.version, b.groups);
  }

  @Allow('MANAGER')
  @Post('bills/:id/unsplit')
  unsplit(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.billing.unsplit(p, id, b.reason);
  }

  @Allow('MANAGER')
  @Post('bills/:id/refunds')
  refund(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RefundSchema)) b: z.infer<typeof RefundSchema>) {
    return this.billing.refund(p, id, b.amount, b.method, b.reason);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('shifts/open')
  openShift(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(OpenShiftSchema)) b: z.infer<typeof OpenShiftSchema>) {
    return this.shifts.open(p, b.openingCash);
  }

  @Allow('CASHIER', 'MANAGER')
  @Get('shifts/current')
  currentShift(@CurrentPrincipal() p: Principal) {
    return this.shifts.current(p);
  }

  @Allow('MANAGER', 'ACCOUNTANT')
  @Get('shifts')
  listShifts(@Query('status') status?: 'OPEN' | 'PENDING_APPROVAL' | 'CLOSED') {
    return this.shifts.list(status);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('shifts/:id/close')
  closeShift(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CloseShiftSchema)) b: z.infer<typeof CloseShiftSchema>) {
    return this.shifts.close(p, id, b.countedCash, b.note);
  }

  @Allow('MANAGER')
  @Post('shifts/:id/approve')
  approveShift(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ReasonSchema)) b: z.infer<typeof ReasonSchema>) {
    return this.shifts.approve(p, id, b.reason);
  }

  @Allow('CASHIER', 'MANAGER', 'ACCOUNTANT')
  @Get('shifts/:id/report')
  shiftReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.shifts.report(id);
  }

  @Allow('CASHIER', 'MANAGER', 'WAITER')
  @Get('sessions/:id/bill')
  bill(@Param('id', ParseUUIDPipe) id: string) {
    return this.billing.forSession(id);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('bills/:id/lock')
  lock(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(VersionSchema)) b: z.infer<typeof VersionSchema>) {
    return this.billing.lock(p, id, b.version);
  }

  @Allow('MANAGER')
  @Post('bills/:id/unlock')
  unlock(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UnlockSchema)) b: z.infer<typeof UnlockSchema>) {
    return this.billing.unlock(p, id, b.version, b.reason);
  }

  @Allow('MANAGER')
  @Post('bills/:id/discount')
  discount(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DiscountSchema)) b: z.infer<typeof DiscountSchema>) {
    return this.billing.setDiscount(p, id, b.amount, b.reason, b.version);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('bills/:id/payments')
  pay(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(PaySchema)) b: z.infer<typeof PaySchema>,
  ) {
    if (!key || key.length < 8) throw new BadRequestException('Thiếu header Idempotency-Key hợp lệ');
    return this.billing.pay(p, id, key, b.method, b.received);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('payments/:id/confirm')
  confirm(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ConfirmSchema)) b: z.infer<typeof ConfirmSchema>) {
    return this.billing.confirm(p, id, b.providerTxnId);
  }

  @Allow('CASHIER', 'MANAGER')
  @Post('payments/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.cancelPending(p, id);
  }
}
