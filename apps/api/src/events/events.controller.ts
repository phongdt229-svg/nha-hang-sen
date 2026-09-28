import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { BROADCAST, toDomainEvent } from './events.service';
import { roomsOf } from './realtime.gateway';

const QuerySchema = z.object({
  after: z.coerce.number().int().min(0),
  station: z.string().optional(),
});

@Controller('events')
export class EventsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Mốc seq hiện tại: client mới mở lần đầu bắt đầu từ đây thay vì phát lại toàn bộ lịch sử. */
  @Get('head')
  async head() {
    const last = await this.prisma.eventLog.findFirst({ where: { publishedAt: { not: null } }, orderBy: { seq: 'desc' }, select: { seq: true } });
    return { seq: Number(last?.seq ?? 0) };
  }

  /** Client kết nối lại gửi lastEventId để lấy các sự kiện bị lỡ (mục 13.2). */
  @Get()
  async since(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(QuerySchema)) q: z.infer<typeof QuerySchema>) {
    const rooms = [...roomsOf(p, q.station), BROADCAST];
    const rows = await this.prisma.eventLog.findMany({
      where: { seq: { gt: BigInt(q.after) }, publishedAt: { not: null }, rooms: { hasSome: rooms } },
      orderBy: { seq: 'asc' },
      take: 500,
    });
    return rows.map(toDomainEvent);
  }
}
