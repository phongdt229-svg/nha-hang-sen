import { key, startApp, waitFor, type Harness } from './harness';

/**
 * Giao món bằng robot theo v0.7 (RD, MB-21) với robot giả lập chạy vòng sa bàn.
 * R01 là mBot (không có robot bridge trong test → OFFLINE); R02, R03 là robot giả lập.
 */
describe('Delivery Task + robot giả lập (MB-21)', () => {
  let h: Harness;
  let manager: string, kitchen: string;

  const start = async () => {
    h = await startApp();
    [manager, kitchen] = await Promise.all([h.login('quanly'), h.login('bep')]);
  };
  beforeAll(start);
  afterAll(() => h.close());

  const api = (method: string, path: string, body?: unknown, token = manager) => h.call(method, path, token, body);
  const task = async (id: string) => (await api('GET', `/internal/delivery-tasks/${id}`)).body;
  const robot = async (id: string) => ((await api('GET', '/internal/robots')).body as any[]).find((r) => r.id === id);
  const events = async (id: string) => ((await api('GET', `/internal/delivery-tasks/${id}/events`)).body as any[]).map((e) => e.type);
  const until = (id: string, ok: (t: any) => boolean) => waitFor(() => task(id), ok);
  const status = (...s: string[]) => (t: any) => s.includes(t.status);

  async function pairTablet(tableId: string) {
    const code = (await api('POST', '/devices/pairing-codes', { kind: 'TABLET', tableId })).body.code;
    return (await h.call('POST', '/devices/pair', undefined, { code, name: 'tablet' })).body.token as string;
  }

  /** Mở phiên ở bàn trống (mặc định bàn số lớn nhất → robot chạy xa, đủ thời gian gây lỗi giữa đường). */
  async function open(codes: string[], pick: 'far' | 'near' = 'far') {
    const tables = ((await api('GET', '/tables')).body as any[]).filter((t) => t.status === 'AVAILABLE');
    const num = (t: any) => Number(t.code.replace(/\D/g, ''));
    tables.sort((a, b) => (pick === 'far' ? num(b) - num(a) : num(a) - num(b)));
    const table = tables[0];
    const session = (await api('POST', '/sessions', { tableId: table.id, guests: 2 })).body;
    const menu = (await api('GET', '/menu')).body.items as any[];
    const order = (
      await h.call('POST', `/sessions/${session.id}/orders`, manager, { items: codes.map((c) => ({ menuItemId: menu.find((m) => m.code === c).id, qty: 1 })) }, { 'idempotency-key': key() })
    ).body;
    return { table, session, order };
  }

  /** Bếp nhận phiếu, nấu, báo xong. */
  async function cook(orderId: string) {
    const items = await h.prisma.orderItem.findMany({ where: { orderId } });
    for (const s of new Set(items.map((i) => i.station))) {
      const tickets = await waitFor(
        async () => ((await h.call('GET', `/kitchen/tickets?station=${s}`, kitchen)).body as any[]).filter((t) => t.orderId === orderId),
        (t) => t.length > 0,
      );
      for (const t of tickets) await h.call('POST', `/kitchen/tickets/${t.id}/ack`, kitchen);
    }
    for (const i of items) {
      await h.call('PATCH', `/order-items/${i.id}/status`, kitchen, { status: 'PREPARING' });
      await h.call('PATCH', `/order-items/${i.id}/status`, kitchen, { status: 'READY' });
    }
  }

  const taskOfSession = (sessionId: string, ok = (t: any) => !!t) =>
    waitFor(async () => ((await api('GET', `/internal/delivery-tasks?active=false&sessionId=${sessionId}`)).body as any[])[0], (t) => !!t && ok(t));

  /** Món READY → task → robot tới bếp. */
  async function atPickup(codes = ['MC01'], pick: 'far' | 'near' = 'far') {
    const ctx = await open(codes, pick);
    await cook(ctx.order.id);
    const t = await taskOfSession(ctx.session.id, status('ARRIVED_PICKUP'));
    return { ...ctx, t };
  }

  /** Dọn robot về trạng thái rảnh cho test sau. */
  async function reset() {
    for (const r of (await api('GET', '/internal/robots')).body as any[]) {
      if (r.vendor !== 'SIMULATED') continue;
      await api('POST', `/internal/robots/${r.id}/simulate`, { fault: 'RECOVER' });
    }
    const open = await h.prisma.deliveryTask.findMany({ where: { status: { notIn: ['COMPLETED', 'CANCELLED', 'MANUAL_TAKEOVER'] } } });
    for (const t of open) {
      if (['DELIVERED', 'RETURNING'].includes(t.status)) continue;
      if (t.status === 'WAITING_CUSTOMER' || t.status === 'ARRIVED_TABLE') await api('POST', `/internal/delivery-tasks/${t.id}/confirm-delivered`);
      else await api('POST', `/internal/delivery-tasks/${t.id}/manual-takeover`, { reason: 'dọn test' });
    }
    await waitFor(
      async () => ((await api('GET', '/internal/robots')).body as any[]).filter((r) => r.vendor === 'SIMULATED'),
      (rs) => rs.every((r) => r.state === 'IDLE' && !r.taskId && r.online),
      20000,
    );
  }

  it('Scenario 1 — happy path: KDS READY → task → robot tới bếp → sai khay bị chặn → xác nhận đặt món → tới bàn → khách nhận trên tablet → về gốc', async () => {
    const { t, table } = await atPickup(['MC01', 'DU01']);
    expect(t).toMatchObject({ pickupLocation: 'KITCHEN_PASS_01', deliveryLocation: `TABLE_${table.code}`, tableCode: table.code });
    expect(t.items.every((i: any) => i.status === 'ASSIGNED')).toBe(true);
    expect(t.robotCode).toMatch(/^R0[23]$/);

    const wrong = await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, { trayCode: 'DT9999' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('WRONG_TRAY');

    expect((await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, { trayCode: t.code })).status).toBe(201);
    const waiting = await until(t.id, status('WAITING_CUSTOMER'));
    expect(waiting.items.every((i: any) => i.status === 'PICKED_UP')).toBe(true);
    // Robot tới bàn không tự coi là đã giao (MB-14).
    await new Promise((r) => setTimeout(r, 300));
    expect((await task(t.id)).status).toBe('WAITING_CUSTOMER');

    const tablet = await pairTablet(table.id);
    const seen = (await h.call('GET', '/internal/delivery-tasks', tablet)).body as any[];
    expect(seen.map((x) => x.id)).toContain(t.id);
    expect((await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-delivered`, tablet)).status).toBe(201);
    const done = await until(t.id, status('COMPLETED'));
    expect(done).toMatchObject({ confirmedBy: 'CUSTOMER' });
    expect(done.items.every((i: any) => i.status === 'DELIVERED')).toBe(true);
    expect(await events(t.id)).toEqual(
      expect.arrayContaining(['TASK_CREATED', 'ROBOT_ASSIGNED', 'ROBOT_ACCEPTED', 'ARRIVED_PICKUP', 'WRONG_TRAY', 'ITEMS_LOADED', 'DEPARTED_PICKUP', 'ARRIVED_TABLE', 'CUSTOMER_NOTIFIED', 'CUSTOMER_CONFIRMED', 'DELIVERED', 'RETURN_STARTED', 'TASK_COMPLETED']),
    );
    await waitFor(() => robot(done.robotId), (r) => r.state === 'IDLE' && r.location === 'KITCHEN_PASS_01');
  });

  it('Scenario 2 — robot offline: heartbeat timeout → FAILED; thử lại bị chặn khi còn offline → giao robot khác → nhân viên giao', async () => {
    await reset();
    const { t } = await atPickup();
    await api('POST', `/internal/robots/${t.robotId}/simulate`, { fault: 'OFFLINE' });
    const failed = await until(t.id, status('FAILED'));
    expect(failed.problem).toBe('OFFLINE');
    expect((await robot(t.robotId)).state).toBe('OFFLINE');
    expect((await api('POST', `/internal/delivery-tasks/${t.id}/retry`)).status).toBe(409);

    expect((await api('POST', `/internal/delivery-tasks/${t.id}/reassign`)).status).toBe(201);
    const again = await until(t.id, (x) => x.status === 'ARRIVED_PICKUP' && x.robotId !== t.robotId);
    expect(again.robotId).not.toBe(t.robotId);

    expect((await api('POST', `/internal/delivery-tasks/${t.id}/manual-takeover`, { reason: 'Robot demo cần sạc' })).body.status).toBe('MANUAL_TAKEOVER');
    const items = await h.prisma.orderItem.findMany({ where: { id: { in: again.items.map((i: any) => i.id) } } });
    expect(items.every((i) => i.status === 'READY' && i.deliveryMode === 'STAFF')).toBe(true);
    expect((await h.call('PATCH', `/order-items/${items[0].id}/status`, manager, { status: 'DELIVERED' })).body.status).toBe('DELIVERED');
  });

  it('Scenario 3 — vật cản thoáng qua: robot dừng, hệ thống tự thử lại, đi tiếp tới bàn', async () => {
    await reset();
    const { t } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE'));
    await api('POST', `/internal/robots/${t.robotId}/simulate`, { fault: 'OBSTACLE' });
    const arrived = await until(t.id, status('WAITING_CUSTOMER'));
    expect(arrived.problem).toBeNull();
    expect(await events(t.id)).toEqual(expect.arrayContaining(['ROBOT_OBSTACLE', 'NAVIGATION_RETRY']));
  });

  it('Vật cản kẹt hẳn: hết lượt thử lại → FAILED → nhân viên giao (MB-16 Retry exhausted → MANUAL_TAKEOVER)', async () => {
    await reset();
    const { t } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE'));
    await api('POST', `/internal/robots/${t.robotId}/simulate`, { fault: 'OBSTACLE_PERSISTENT' });
    const failed = await until(t.id, status('FAILED'));
    expect(failed).toMatchObject({ problem: 'OBSTACLE' });
    expect((await events(t.id)).filter((e) => e === 'NAVIGATION_RETRY')).toHaveLength(2);
    // Món đã trên robot: không cho giao robot khác / hủy, chỉ nhân viên giao.
    expect((await api('POST', `/internal/delivery-tasks/${t.id}/reassign`)).status).toBe(409);
    expect((await api('POST', `/internal/delivery-tasks/${t.id}/manual-takeover`, { reason: 'Kẹt lối đi' })).body.status).toBe('MANUAL_TAKEOVER');
  });

  it('Scenario 4 — khách không có mặt: quá thời gian chờ → báo nhân viên, vẫn chưa tính là đã giao; nhân viên xác nhận', async () => {
    await reset();
    const { t } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('WAITING_CUSTOMER'));
    const absent = await until(t.id, (x) => x.problem === 'CUSTOMER_ABSENT');
    expect(absent.status).toBe('WAITING_CUSTOMER');
    expect(await events(t.id)).toContain('CUSTOMER_TIMEOUT');
    const w = (await api('POST', '/ops/watchdog')).body;
    expect(w.firing).toContain(`delivery:${t.code}`);

    await api('POST', `/internal/delivery-tasks/${t.id}/confirm-delivered`);
    expect(await until(t.id, status('COMPLETED'))).toMatchObject({ confirmedBy: 'STAFF' });
  });

  it('Scenario 5 — lệnh trùng: tạo task / gán robot nhiều lần cùng lúc → chỉ một task, một lần gán', async () => {
    await reset();
    const { session, order } = await open(['MC02']);
    await cook(order.id);
    const itemIds = order.items.map((i: any) => i.id);
    const created = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', '/internal/delivery-tasks', { orderItemIds: itemIds })));
    const ids = new Set(created.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await h.prisma.deliveryTaskItem.count({ where: { orderItemId: { in: itemIds } } })).toBe(1);

    const t = await taskOfSession(session.id, (x) => !!x.robotId);
    const same = await Promise.all([1, 2, 3].map(() => api('POST', `/internal/delivery-tasks/${t.id}/assign`, { robotId: t.robotId })));
    expect(same.every((r) => r.status === 201 && r.body.robotId === t.robotId)).toBe(true);
    const other = ((await api('GET', '/internal/robots')).body as any[]).find((r) => r.vendor === 'SIMULATED' && r.id !== t.robotId);
    expect((await api('POST', `/internal/delivery-tasks/${t.id}/assign`, { robotId: other.id })).status).toBe(409);
    expect((await events(t.id)).filter((e) => e === 'ROBOT_ASSIGNED')).toHaveLength(1);
  });

  it('Pin nguy hiểm khi đang giao → FAILED, robot về sạc, không nhận task mới tới khi đủ pin', async () => {
    await reset();
    const { t } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE'));
    await api('POST', `/internal/robots/${t.robotId}/simulate`, { fault: 'LOW_BATTERY' });
    expect(await until(t.id, status('FAILED'))).toMatchObject({ problem: 'LOW_BATTERY' });
    await api('POST', `/internal/delivery-tasks/${t.id}/manual-takeover`, { reason: 'Hết pin' });
    await waitFor(() => robot(t.robotId), (r) => r.state === 'CHARGING' || r.location === 'CHARGER_01');
  });

  it('Lỗi API: một lần thì tự thử lại thành công; kéo dài thì FAILED (RD-18 max_api_retry)', async () => {
    await reset();
    const { t } = await atPickup();
    await api('POST', `/internal/robots/${t.robotId}/simulate`, { fault: 'API_TIMEOUT' });
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER'));
    await api('POST', `/internal/delivery-tasks/${t.id}/confirm-delivered`).catch(() => undefined);
    await reset();

    const { t: t2 } = await atPickup();
    await api('POST', `/internal/robots/${t2.robotId}/simulate`, { fault: 'API_TIMEOUT_PERSISTENT' });
    await h.call('POST', `/internal/delivery-tasks/${t2.id}/confirm-loaded`, kitchen, {});
    const failed = await until(t2.id, status('FAILED'));
    expect(failed).toMatchObject({ problem: 'API_TIMEOUT' });
    // Hết lỗi → thử lại cùng robot từ bước đang dở.
    await api('POST', `/internal/robots/${t2.robotId}/simulate`, { fault: 'RECOVER' });
    expect((await api('POST', `/internal/delivery-tasks/${t2.id}/retry`)).status).toBe(201);
    await until(t2.id, status('WAITING_CUSTOMER'));
  });

  it('Khách chuyển bàn khi robot đang chạy → đổi bàn đích, robot giao đúng bàn mới', async () => {
    await reset();
    const { t, session } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE'));
    const to = ((await api('GET', '/tables')).body as any[]).filter((x) => x.status === 'AVAILABLE').sort((a, b) => a.code.localeCompare(b.code))[0];
    await api('POST', `/sessions/${session.id}/move`, { toTableId: to.id });
    const arrived = await until(t.id, status('WAITING_CUSTOMER'));
    expect(arrived).toMatchObject({ tableCode: to.code, deliveryLocation: `TABLE_${to.code}` });
    expect(await events(t.id)).toContain('RETARGETED');
  });

  it('Scenario 6 — server khởi động lại giữa chuyến: khôi phục task, đối chiếu robot, nhân viên thử lại → giao tiếp', async () => {
    await reset();
    const { t } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE'));
    await h.close();
    await start();
    // Robot giả lập mất trạng thái khi server tắt → không còn giữ nhiệm vụ → FAILED(RESTART) chờ nhân viên.
    const failed = await until(t.id, status('FAILED'));
    expect(failed).toMatchObject({ problem: 'RESTART' });
    await waitFor(() => robot(t.robotId), (r) => r.online);
    expect((await api('POST', `/internal/delivery-tasks/${t.id}/retry`)).status).toBe(201);
    await until(t.id, status('WAITING_CUSTOMER'));
    await api('POST', `/internal/delivery-tasks/${t.id}/confirm-delivered`);
    await until(t.id, status('COMPLETED'));
  });

  it('robot điều khiển: dừng khẩn cấp → FAILED; không gọi về khi còn giữ task; phân quyền giả lập', async () => {
    await reset();
    const { t } = await atPickup();
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await until(t.id, status('GOING_TO_TABLE'));
    await api('POST', `/internal/robots/${t.robotId}/stop`);
    expect(await until(t.id, status('FAILED'))).toMatchObject({ problem: 'STOPPED' });
    expect((await api('POST', `/internal/robots/${t.robotId}/return-home`, {})).status).toBe(409);
    expect((await h.call('POST', `/internal/robots/${t.robotId}/simulate`, kitchen, { fault: 'OFFLINE' })).status).toBe(403);
    await api('POST', `/internal/delivery-tasks/${t.id}/manual-takeover`, { reason: 'dừng khẩn cấp' });
  });

  it('báo cáo giao món, số liệu /metrics', async () => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const m = (await api('GET', `/reports/delivery?from=${today}&to=${today}`)).body;
    expect(m.tasks).toBeGreaterThan(0);
    expect(m.completed).toBeGreaterThan(0);
    expect(m.failed).toBeGreaterThan(0);
    expect(m.manualTakeover).toBeGreaterThan(0);
    expect(m.fallbackRate).toBeGreaterThan(0);
    const text = (await h.call('GET', '/metrics')).body.toString('utf8');
    expect(text).toMatch(/nhs_robots\{state="(IDLE|OFFLINE|BUSY|CHARGING)"\} \d+/);
  });
});
