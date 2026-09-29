import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UnauthorizedException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../common/audit.service';
import { isUniqueViolation } from '../common/errors.filter';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password';
import { actorId, Allow, CurrentPrincipal, type Principal } from './principal';

const ROLES = ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HEAD_CHEF', 'STOREKEEPER', 'ACCOUNTANT'] as const;
const Password = z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự').max(100);
const ChangePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: Password });
const CreateUserSchema = z.object({
  username: z.string().regex(/^[a-z0-9._-]{3,30}$/, 'Tên đăng nhập 3–30 ký tự: chữ thường, số, . _ -'),
  name: z.string().trim().min(1).max(60),
  role: z.enum(ROLES),
  password: Password,
});
const UpdateUserSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: Password.optional(),
});

const toDto = (u: User) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() });

/** Tài khoản nhân viên và thiết bị (mục 9): chủ quán quản lý nhân viên, quản lý thu hồi thiết bị mất. */
@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Nhân viên tự đổi mật khẩu (bắt buộc sau lần đăng nhập đầu bằng mật khẩu mẫu). */
  @Post('auth/password')
  async changePassword(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ChangePasswordSchema)) b: z.infer<typeof ChangePasswordSchema>) {
    if (p.kind !== 'user') throw new BadRequestException('Chỉ tài khoản nhân viên đổi được mật khẩu');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: p.sub } });
    if (!verifyPassword(b.currentPassword, user.passwordHash)) throw new UnauthorizedException('Mật khẩu hiện tại không đúng');
    if (b.currentPassword === b.newPassword) throw new BadRequestException('Mật khẩu mới phải khác mật khẩu cũ');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(b.newPassword) } });
      await this.audit.record(tx, { actorId: user.id, action: 'user.password', entity: 'user', entityId: user.id });
    });
    return { ok: true };
  }

  @Allow('ADMIN')
  @Get('users')
  async list() {
    return (await this.prisma.user.findMany({ orderBy: [{ active: 'desc' }, { username: 'asc' }] })).map(toDto);
  }

  @Allow('ADMIN')
  @Post('users')
  async create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateUserSchema)) b: z.infer<typeof CreateUserSchema>) {
    try {
      return toDto(
        await this.prisma.$transaction(async (tx) => {
          const u = await tx.user.create({ data: { username: b.username, name: b.name, role: b.role, passwordHash: hashPassword(b.password) } });
          await this.audit.record(tx, { actorId: actorId(p), action: 'user.create', entity: 'user', entityId: u.id, after: { username: u.username, role: u.role } });
          return u;
        }),
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(`Tên đăng nhập ${b.username} đã có`);
      throw e;
    }
  }

  /** Đổi vai trò, khóa/mở tài khoản, đặt lại mật khẩu. Có hiệu lực ngay (guard kiểm tra mỗi request). */
  @Allow('ADMIN')
  @Patch('users/:id')
  async update(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateUserSchema)) b: z.infer<typeof UpdateUserSchema>) {
    if (p.kind === 'user' && p.sub === id && (b.active === false || (b.role && b.role !== 'ADMIN'))) {
      throw new ConflictException('Không tự khóa hoặc tự hạ quyền tài khoản đang dùng');
    }
    const u = await this.prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Không tìm thấy nhân viên');
      const after = await tx.user.update({
        where: { id },
        data: { name: b.name, role: b.role, active: b.active, ...(b.password ? { passwordHash: hashPassword(b.password) } : {}) },
      });
      await this.audit.record(tx, {
        actorId: actorId(p),
        action: 'user.update',
        entity: 'user',
        entityId: id,
        before: { name: before.name, role: before.role, active: before.active },
        after: { name: after.name, role: after.role, active: after.active, passwordReset: !!b.password },
      });
      return after;
    });
    return toDto(u);
  }

  @Allow('MANAGER')
  @Get('devices')
  async devices() {
    const rows = await this.prisma.device.findMany({ include: { table: true }, orderBy: { createdAt: 'desc' } });
    return rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      tableCode: d.table?.code ?? null,
      station: d.station,
      revokedAt: d.revokedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /** Thu hồi tablet/KDS/print agent bị mất hoặc thay mới: token của thiết bị hết hiệu lực ngay. */
  @Allow('MANAGER')
  @Post('devices/:id/revoke')
  async revoke(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.$transaction(async (tx) => {
      const n = await tx.device.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (n.count === 0) throw new ConflictException('Thiết bị không tồn tại hoặc đã thu hồi');
      await this.audit.record(tx, { actorId: actorId(p), action: 'device.revoke', entity: 'device', entityId: id });
    });
    return { ok: true };
  }
}
