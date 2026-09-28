import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { ShiftsService } from './shifts.service';

@Module({ controllers: [BillingController], providers: [BillingService, ShiftsService], exports: [BillingService] })
export class BillingModule {}
