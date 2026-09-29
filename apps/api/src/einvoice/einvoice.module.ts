import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EInvoiceController } from './einvoice.controller';
import { createAdapter, EINVOICE_ADAPTER, EINVOICE_QUEUE, EInvoiceProcessor, EInvoiceService } from './einvoice.service';

@Module({
  imports: [BullModule.registerQueue({ name: EINVOICE_QUEUE })],
  controllers: [EInvoiceController],
  providers: [{ provide: EINVOICE_ADAPTER, useFactory: createAdapter }, EInvoiceService, EInvoiceProcessor],
  exports: [EInvoiceService],
})
export class EInvoiceModule {}
