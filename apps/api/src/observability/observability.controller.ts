import { Controller, Get, Headers, Post, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Allow, Public } from '../auth/principal';
import { registry } from './metrics';
import { ObservabilityService } from './observability.service';

function tokenOk(header: string | undefined) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return true;
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

@Controller()
export class ObservabilityController {
  constructor(private readonly ops: ObservabilityService) {}

  /** Prometheus đọc số liệu. Đặt METRICS_TOKEN để chỉ Prometheus (có token) đọc được. */
  @Public()
  @Get('metrics')
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    if (!tokenOk(auth)) throw new UnauthorizedException();
    res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(await registry.render());
  }

  /** Sẵn sàng phục vụ: 503 khi mất PostgreSQL hoặc Redis (dùng cho healthcheck Docker, giám sát ngoài). */
  @Public()
  @Get('health/ready')
  async ready(@Res() res: Response) {
    const h = await this.ops.health();
    res.status(h.ok ? 200 : 503).json(h);
  }

  @Allow('MANAGER')
  @Get('ops/alerts')
  alerts() {
    return this.ops.activeAlerts();
  }

  /** Chạy watchdog ngay (quản lý kiểm tra cấu hình Telegram/Zalo). */
  @Allow('MANAGER')
  @Post('ops/watchdog')
  watchdog() {
    return this.ops.watchdog();
  }
}
