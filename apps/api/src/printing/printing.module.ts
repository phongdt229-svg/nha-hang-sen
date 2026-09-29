import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { PrintingController } from './printing.controller';
import { PrintingService } from './printing.service';

@Module({
  imports: [KitchenModule, BillingModule],
  controllers: [PrintingController],
  providers: [PrintingService],
})
export class PrintingModule {}
