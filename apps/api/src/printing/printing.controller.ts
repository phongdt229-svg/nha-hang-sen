import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrintingService } from './printing.service';

const State = z.enum(['UNKNOWN', 'ONLINE', 'OFFLINE', 'PAPER_OUT', 'ERROR']);
const PollSchema = z.object({
  printers: z
    .array(z.object({ target: z.string().min(1).max(40), name: z.string().max(60).optional(), state: State, error: z.string().max(300).nullish() }))
    .max(20),
});
const FailedSchema = z.object({ state: z.enum(['OFFLINE', 'PAPER_OUT', 'ERROR']), error: z.string().min(1).max(300) });
const Target = z.string().regex(/^[A-Z0-9_]{1,40}$/, 'Mã máy in không hợp lệ');

function requireKey(key: string | undefined) {
  if (!key || key.length < 8) throw new BadRequestException('Thiếu header Idempotency-Key hợp lệ');
  return key;
}

/** In phiếu qua print agent chạy tại quán (mục 13.4). */
@Controller()
export class PrintingController {
  constructor(private readonly printing: PrintingService) {}

  /** Agent hỏi việc mỗi giây, kèm trạng thái từng máy in. */
  @Allow('PRINTER')
  @Post('print/agent/poll')
  poll(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(PollSchema)) b: z.infer<typeof PollSchema>) {
    return this.printing.poll(p, b);
  }

  @Allow('PRINTER')
  @Post('print/jobs/:id/done')
  done(@Param('id', ParseUUIDPipe) id: string) {
    return this.printing.done(id);
  }

  @Allow('PRINTER')
  @Post('print/jobs/:id/failed')
  failed(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(FailedSchema)) b: z.infer<typeof FailedSchema>) {
    return this.printing.failed(id, b.state, b.error);
  }

  @Allow('MANAGER', 'CASHIER', 'WAITER')
  @Get('print/status')
  status() {
    return this.printing.status();
  }

  @Allow('MANAGER', 'CASHIER')
  @Get('print/jobs')
  jobs() {
    return this.printing.jobs();
  }

  @Allow('MANAGER', 'CASHIER')
  @Post('print/jobs/:id/cancel')
  cancel(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.printing.cancel(p, id);
  }

  @Allow('MANAGER', 'CASHIER')
  @Post('printers/:target/test')
  test(@Param('target', new ZodPipe(Target)) target: string, @Headers('idempotency-key') key?: string) {
    return this.printing.printTest(target, requireKey(key));
  }

  @Allow('MANAGER', 'CASHIER')
  @Post('bills/:id/print')
  receipt(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key?: string) {
    return this.printing.printReceipt(p, id, requireKey(key));
  }

  @Allow('MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'KDS')
  @Post('kitchen/tickets/:id/print')
  ticket(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Headers('idempotency-key') key?: string) {
    return this.printing.printTicket(p, id, requireKey(key));
  }
}
