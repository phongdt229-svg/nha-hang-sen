import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { PaymentsController } from './payments.controller';
import { PAYMENTS_QUEUE, PaymentsProcessor, PaymentsService } from './payments.service';

@Module({
  imports: [BillingModule, BullModule.registerQueue({ name: PAYMENTS_QUEUE })],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentsProcessor],
})
export class PaymentsModule {}
