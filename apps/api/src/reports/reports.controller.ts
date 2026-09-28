import { Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Allow, CurrentPrincipal, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { BusinessDayService } from './business-day.service';
import { ExportService } from './export.service';
import { GROUP_BY, ReportsService } from './reports.service';
import type { ReportTable } from './table';

const Range = z.object({ from: z.string(), to: z.string() });
const RevenueQuery = Range.extend({ group_by: z.enum(GROUP_BY).default('day') });
const ExportQuery = Range.extend({
  type: z.enum(['revenue', 'kpis', 'adjustments']).default('revenue'),
  group_by: z.enum(GROUP_BY).default('day'),
  format: z.enum(['xlsx', 'csv', 'pdf']).default('xlsx'),
});

/** Báo cáo cho chủ, quản lý, kế toán; kế toán chỉ xem, không sửa bill (mục 9). */
@Allow('MANAGER', 'ACCOUNTANT')
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly days: BusinessDayService,
    private readonly exporter: ExportService,
  ) {}

  @Get('reports/revenue')
  revenue(@Query(new ZodPipe(RevenueQuery)) q: z.infer<typeof RevenueQuery>) {
    return this.reports.revenue(q.from, q.to, q.group_by);
  }

  @Get('reports/kpis')
  kpis(@Query(new ZodPipe(Range)) q: z.infer<typeof Range>) {
    return this.reports.kpis(q.from, q.to);
  }

  @Get('reports/adjustments')
  adjustments(@Query(new ZodPipe(Range)) q: z.infer<typeof Range>) {
    return this.reports.adjustments(q.from, q.to);
  }

  @Get('reports/export')
  async export(@Query(new ZodPipe(ExportQuery)) q: z.infer<typeof ExportQuery>, @Res() res: Response) {
    const tables = await this.tablesFor(q.type, q.from, q.to, q.group_by);
    const file = await this.exporter.render(tables, q.format, `Từ ${q.from} đến ${q.to} · xuất lúc ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`);
    res.setHeader('content-type', file.contentType);
    res.setHeader('content-disposition', `attachment; filename="bao-cao-${q.type}-${q.from}-${q.to}.${file.ext}"`);
    res.send(file.body);
  }

  @Get('business-days')
  list() {
    return this.days.list();
  }

  @Allow('MANAGER')
  @Post('business-days/:day/close')
  close(@CurrentPrincipal() p: Principal, @Param('day') day: string) {
    this.reports.checkRange(day, day);
    return this.days.close(day, p);
  }

  private async tablesFor(type: string, from: string, to: string, groupBy: (typeof GROUP_BY)[number]): Promise<ReportTable[]> {
    if (type === 'adjustments') return [await this.reports.adjustments(from, to)];
    if (type === 'kpis') {
      const k = await this.reports.kpis(from, to);
      return [
        {
          title: 'Chỉ số vận hành',
          columns: [
            { key: 'label', label: 'Chỉ số' },
            { key: 'value', label: 'Giá trị' },
          ],
          rows: [
            { label: 'Số bill', value: k.bills },
            { label: 'Doanh thu', value: k.revenue },
            { label: 'Số khách', value: k.guests },
            { label: 'Trung bình/bill', value: k.avgPerBill },
            { label: 'Doanh thu/khách', value: k.revenuePerGuest },
            { label: 'Doanh thu/bàn/ngày', value: k.revenuePerTable },
            { label: 'Vòng quay bàn/ngày', value: k.tableTurnover },
            { label: 'Thời gian ngồi TB (phút)', value: k.avgDiningMinutes },
          ],
        },
      ];
    }
    return [await this.reports.revenue(from, to, groupBy)];
  }
}
