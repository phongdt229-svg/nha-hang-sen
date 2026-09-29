import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EInvoiceModule } from '../einvoice/einvoice.module';
import { BusinessDayService, REPORTS_QUEUE, ReportsProcessor } from './business-day.service';
import { ExportService } from './export.service';
import { OverviewController } from './overview.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [BullModule.registerQueue({ name: REPORTS_QUEUE }), EInvoiceModule],
  controllers: [ReportsController, OverviewController],
  providers: [ReportsService, BusinessDayService, ReportsProcessor, ExportService],
  exports: [ReportsService, ExportService],
})
export class ReportsModule {}
