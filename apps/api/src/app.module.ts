import { BullModule } from '@nestjs/bullmq';
import { Controller, Get, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { Public } from './auth/principal';
import { BillingModule } from './billing/billing.module';
import { CommonModule } from './common/common.module';
import { DeliveryModule } from './delivery/delivery.module';
import { EInvoiceModule } from './einvoice/einvoice.module';
import { EventsModule } from './events/events.module';
import { KitchenModule } from './kitchen/kitchen.module';
import { MenuModule } from './menu/menu.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { ObservabilityModule } from './observability/observability.module';
import { PrintingModule } from './printing/printing.module';
import { PrismaModule } from './prisma/prisma.service';
import { ReportsModule } from './reports/reports.module';
import { SessionsModule } from './sessions/sessions.module';

function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
  };
}

@Controller()
class HealthController {
  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    BullModule.forRoot({ connection: redisConnection(), prefix: process.env.QUEUE_PREFIX ?? 'nhs' }),
    PrismaModule,
    CommonModule,
    AuthModule,
    EventsModule,
    SessionsModule,
    MenuModule,
    OrdersModule,
    KitchenModule,
    BillingModule,
    ReportsModule,
    PaymentsModule,
    EInvoiceModule,
    PrintingModule,
    ObservabilityModule,
    DeliveryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
