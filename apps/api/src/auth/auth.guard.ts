import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Access, ACCESS_KEY, hasAccess, Principal, PUBLIC_KEY } from './principal';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Thiếu token');
    const principal = await this.verify(header.slice(7));
    req.principal = principal;

    const allowed = this.reflector.getAllAndOverride<Access[]>(ACCESS_KEY, targets);
    if (allowed && !hasAccess(principal, allowed)) throw new ForbiddenException('Không đủ quyền');
    return true;
  }

  async verify(token: string): Promise<Principal> {
    let principal: Principal;
    try {
      principal = await this.jwt.verifyAsync<Principal>(token);
    } catch {
      throw new UnauthorizedException('Token không hợp lệ');
    }
    if (principal.kind === 'device') {
      // Thiết bị dùng token dài hạn nên kiểm tra thu hồi mỗi lần gọi.
      const device = await this.prisma.device.findUnique({ where: { id: principal.sub } });
      if (!device || device.revokedAt) throw new UnauthorizedException('Thiết bị đã bị thu hồi');
      return { ...principal, tableId: device.tableId, station: device.station };
    }
    // Nhân viên nghỉ việc / đổi vai trò có hiệu lực ngay, không chờ token 12 giờ hết hạn.
    const user = await this.prisma.user.findUnique({ where: { id: principal.sub }, select: { active: true, role: true, name: true } });
    if (!user || !user.active) throw new UnauthorizedException('Tài khoản đã bị khóa');
    return { ...principal, role: user.role, name: user.name };
  }
}
