import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { DeviceKind, Role } from '@nhs/types';

export type Principal =
  | { kind: 'user'; sub: string; role: Role; name: string }
  | { kind: 'device'; sub: string; deviceKind: DeviceKind; tableId: string | null; station: string | null };

/** Vai trò cho phép: vai trò nhân viên hoặc loại thiết bị. */
export type Access = Role | DeviceKind;

export const PUBLIC_KEY = 'public';
export const ACCESS_KEY = 'access';

export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Allow = (...access: Access[]) => SetMetadata(ACCESS_KEY, access);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});

export function actorId(p: Principal): string {
  return p.kind === 'user' ? p.sub : `device:${p.sub}`;
}

export function hasAccess(p: Principal, allowed: Access[]): boolean {
  if (p.kind === 'user') return p.role === 'ADMIN' || allowed.includes(p.role);
  return allowed.includes(p.deviceKind);
}
