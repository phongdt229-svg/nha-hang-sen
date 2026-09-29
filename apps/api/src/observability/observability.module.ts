import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EINVOICE_QUEUE } from '../einvoice/einvoice.service';
import { KITCHEN_QUEUE } from '../kitchen/kitchen.config';
import { PAYMENTS_QUEUE } from '../payments/payments.service';
import { REPORTS_QUEUE } from '../reports/business-day.service';
import { ObservabilityController } from './observability.controller';
import { OPS_QUEUE, ObservabilityProcessor, ObservabilityService } from './observability.service';

@Module({
  imports: [BullModule.registerQueue({ name: KITCHEN_QUEUE }, { name: PAYMENTS_QUEUE }, { name: EINVOICE_QUEUE }, { name: REPORTS_QUEUE }, { name: OPS_QUEUE })],
  controllers: [ObservabilityController],
  providers: [ObservabilityService, ObservabilityProcessor],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
