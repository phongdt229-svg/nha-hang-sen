import { Controller, Get } from '@nestjs/common';
import { businessDay } from '@nhs/pricing';
import { Allow } from '../auth/principal';
import { PrismaService } from '../prisma/prisma.service';

@Controller('reports')
export class OverviewController {
  constructor(private readonly prisma: PrismaService) {}

  /** Số liệu tổng quan real-time (mục 10.2): doanh thu tính theo ngày kinh doanh, từ bill đã thanh toán. */
  @Allow('MANAGER', 'CASHIER')
  @Get('overview')
  async overview() {
    const day = businessDay(new Date(), Number(process.env.BUSINESS_DAY_CUTOFF_HOUR ?? 4));
    const [paid, tables, serving, byMethod] = await Promise.all([
      this.prisma.bill.aggregate({ where: { businessDay: day, status: { in: ['PAID', 'CLOSED'] } }, _sum: { total: true }, _count: true }),
      this.prisma.table.groupBy({ by: ['status'], _count: true }),
      this.prisma.orderItem.findMany({
        where: { status: { not: 'CANCELLED' }, order: { session: { status: { in: ['OPEN', 'PAYMENT'] } } } },
        select: { qty: true, unitPrice: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: { status: 'SUCCEEDED', bill: { businessDay: day } },
        _sum: { amount: true },
      }),
    ]);
    return {
      businessDay: day,
      revenue: paid._sum.total ?? 0,
      bills: paid._count,
      tables: Object.fromEntries(tables.map((t) => [t.status, t._count])),
      servingUnpaid: serving.reduce((a, i) => a + i.qty * i.unitPrice, 0),
      byMethod: Object.fromEntries(byMethod.map((m) => [m.method, m._sum.amount ?? 0])),
    };
  }
}
