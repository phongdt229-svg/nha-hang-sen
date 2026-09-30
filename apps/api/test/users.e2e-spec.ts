import { startApp, type Harness } from './harness';

/** Tài khoản nhân viên và thiết bị: trước pilot phải đổi được mật khẩu mẫu, khóa người nghỉ việc, thu hồi thiết bị mất. */
describe('Tài khoản & thiết bị', () => {
  let h: Harness;
  let admin: string, manager: string;
  const username = `nv${Date.now().toString(36)}`;

  beforeAll(async () => {
    h = await startApp();
    [admin, manager] = await Promise.all([h.login('admin'), h.login('quanly')]);
  });
  afterAll(() => h.close());

  const login = (password: string) => h.call('POST', '/auth/login', undefined, { username, password });

  it('chủ quán tạo nhân viên; nhân viên đổi mật khẩu; mật khẩu cũ hết hiệu lực', async () => {
    const created = await h.call('POST', '/users', admin, { username, name: 'Thu ngân mới', role: 'CASHIER', password: 'tam-thoi-123' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ username, role: 'CASHIER', active: true });
    expect(created.body.passwordHash).toBeUndefined();
    expect((await h.call('POST', '/users', admin, { username, name: 'Trùng', role: 'CASHIER', password: 'tam-thoi-123' })).status).toBe(409);

    const token = (await login('tam-thoi-123')).body.token;
    expect((await h.call('POST', '/auth/password', token, { currentPassword: 'sai-roi', newPassword: 'mat-khau-moi-1' })).status).toBe(401);
    expect((await h.call('POST', '/auth/password', token, { currentPassword: 'tam-thoi-123', newPassword: 'ngan' })).status).toBe(400);
    expect((await h.call('POST', '/auth/password', token, { currentPassword: 'tam-thoi-123', newPassword: 'mat-khau-moi-1' })).status).toBe(201);
    expect((await login('tam-thoi-123')).status).toBe(401);
    expect((await login('mat-khau-moi-1')).status).toBe(201);
  });

  it('khóa tài khoản → token đang dùng mất hiệu lực ngay; đổi vai trò có hiệu lực ngay', async () => {
    const user = ((await h.call('GET', '/users', admin)).body as any[]).find((u) => u.username === username);
    const token = (await login('mat-khau-moi-1')).body.token;
    expect((await h.call('GET', '/shifts/current', token)).status).toBe(200);

    await h.call('PATCH', `/users/${user.id}`, admin, { role: 'WAITER' });
    expect((await h.call('GET', '/shifts/current', token)).status).toBe(403);
    expect((await h.call('GET', '/auth/me', token)).body.role).toBe('WAITER');

    await h.call('PATCH', `/users/${user.id}`, admin, { active: false });
    expect((await h.call('GET', '/auth/me', token)).status).toBe(401);
    expect((await login('mat-khau-moi-1')).status).toBe(401);
    expect(await h.prisma.auditLog.count({ where: { entityId: user.id, action: 'user.update' } })).toBe(2);
  });

  it('không tự khóa chính mình; chỉ chủ quán quản lý nhân viên', async () => {
    const me = (await h.call('GET', '/auth/me', admin)).body;
    expect((await h.call('PATCH', `/users/${me.sub}`, admin, { active: false })).status).toBe(409);
    expect((await h.call('GET', '/users', manager)).status).toBe(403);
    expect((await h.call('POST', '/users', manager, { username: 'x-y-z', name: 'X', role: 'ADMIN', password: '12345678' })).status).toBe(403);
  });

  it('thu hồi tablet bị mất → token thiết bị hết hiệu lực', async () => {
    const tables = (await h.call('GET', '/tables', manager)).body as any[];
    const { code } = (await h.call('POST', '/devices/pairing-codes', manager, { kind: 'TABLET', tableId: tables[0].id })).body;
    const paired = (await h.call('POST', '/devices/pair', undefined, { code, name: 'Tablet mất' })).body;
    expect((await h.call('GET', '/menu', paired.token)).status).toBe(200);

    const listed = ((await h.call('GET', '/devices', manager)).body as any[]).find((d) => d.id === paired.device.id);
    expect(listed).toMatchObject({ kind: 'TABLET', revokedAt: null });
    expect((await h.call('POST', `/devices/${paired.device.id}/revoke`, manager)).status).toBe(201);
    expect((await h.call('GET', '/menu', paired.token)).status).toBe(401);
    expect((await h.call('POST', `/devices/${paired.device.id}/revoke`, manager)).status).toBe(409);
  });

  it('nhập mã ghép màn hình bếp vào tablet → bị từ chối, mã vẫn dùng được cho KDS', async () => {
    const { code } = (await h.call('POST', '/devices/pairing-codes', manager, { kind: 'KDS', station: 'BEP_NONG' })).body;
    const wrong = await h.call('POST', '/devices/pair', undefined, { code, name: 'Tablet', kind: 'TABLET' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toContain('mã ghép màn hình bếp');

    const kds = await h.call('POST', '/devices/pair', undefined, { code, name: 'Bếp', kind: 'KDS' });
    expect(kds.status).toBe(201);
    expect(kds.body.device).toMatchObject({ kind: 'KDS', station: 'BEP_NONG' });
  });
});
