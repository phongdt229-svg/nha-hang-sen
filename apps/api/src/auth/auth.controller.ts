import { Body, Controller, Get, Post, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { verifyPassword } from './password';
import { Allow, CurrentPrincipal, Principal, Public } from './principal';

const LoginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

const PairingCodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TABLET'), tableId: z.string().uuid() }),
  z.object({ kind: z.literal('KDS'), station: z.string().min(1) }),
]);

const PairSchema = z.object({ code: z.string().length(6), name: z.string().min(1).max(60) });

const PAIRING_TTL_MS = 10 * 60 * 1000;

@Controller()
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Post('auth/login')
  async login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>) {
    const user = await this.prisma.user.findUnique({ where: { username: body.username } });
    if (!user || !user.active || !verifyPassword(body.password, user.passwordHash)) {
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }
    const principal: Principal = { kind: 'user', sub: user.id, role: user.role, name: user.name };
    return { token: await this.jwt.signAsync(principal, { expiresIn: '12h' }), user: principal };
  }

  /** Nhân viên tạo mã 6 số để ghép tablet với bàn hoặc KDS với trạm bếp. */
  @Allow('MANAGER', 'WAITER')
  @Post('devices/pairing-codes')
  async createPairingCode(@Body(new ZodPipe(PairingCodeSchema)) body: z.infer<typeof PairingCodeSchema>) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await this.prisma.pairingCode.upsert({
      where: { code },
      create: { code, kind: body.kind, tableId: 'tableId' in body ? body.tableId : null, station: 'station' in body ? body.station : null, expiresAt },
      update: { kind: body.kind, tableId: 'tableId' in body ? body.tableId : null, station: 'station' in body ? body.station : null, expiresAt, usedAt: null },
    });
    return { code, expiresAt };
  }

  /** Thiết bị đổi mã ghép lấy token thiết bị dài hạn. Mã chỉ dùng được một lần. */
  @Public()
  @Post('devices/pair')
  async pair(@Body(new ZodPipe(PairSchema)) body: z.infer<typeof PairSchema>) {
    const device = await this.prisma.$transaction(async (tx) => {
      const used = await tx.pairingCode.updateMany({
        where: { code: body.code, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (used.count === 0) throw new BadRequestException('Mã ghép không đúng hoặc đã hết hạn');
      const pc = await tx.pairingCode.findUniqueOrThrow({ where: { code: body.code } });
      return tx.device.create({
        data: { kind: pc.kind, name: body.name, tableId: pc.tableId, station: pc.station },
        include: { table: true },
      });
    });
    const principal: Principal = {
      kind: 'device',
      sub: device.id,
      deviceKind: device.kind,
      tableId: device.tableId,
      station: device.station,
    };
    return {
      token: await this.jwt.signAsync(principal, { expiresIn: '365d' }),
      device: { id: device.id, kind: device.kind, name: device.name, tableId: device.tableId, tableCode: device.table?.code ?? null, station: device.station },
    };
  }

  @Get('auth/me')
  me(@CurrentPrincipal() principal: Principal) {
    return principal;
  }
}
