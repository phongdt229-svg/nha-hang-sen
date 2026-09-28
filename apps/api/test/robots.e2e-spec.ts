import { key, sessionWithOrder, startApp, waitFor, type Harness } from './harness';

/** Sprint 11–13: điều phối robot giao món (mục 15). */
describe('Robot giao món', () => {
  let h: Harness;
  let manager: string, kitchen: string;
  let robots: { id: string; code: string; state: string }[];

  beforeAll(async () => {
    h = await startApp();
    [manager, kitchen] = await Promise.all([h.login('quanly'), h.login('bep')]);
    robots = (await h.call('GET', '/robots', manager)).body;
  });
  afterAll(() => h.close());

  async function pairTablet(tableId: string) {
    const code = (await h.call('POST', '/devices/pairing-codes', manager, { kind: 'TABLET', tableId })).body.code;
    return (await h.call('POST', '/devices/pair', undefined, { code, name: 'tablet' })).body.token as string;
  }

  /** Bếp nhận phiếu và nấu xong các món chỉ định. */
  async function cook(orderId: string, itemIds?: string[], to: 'PREPARING' | 'READY' = 'READY') {
    const orders = await h.prisma.orderItem.findMany({ where: { orderId } });
    const stations = [...new Set(orders.map((o) => o.station))];
    for (const s of stations) {
      const tickets = await waitFor(
        async () => ((await h.call('GET', `/kitchen/tickets?station=${s}`, kitchen)).body as any[]).filter((t) => t.orderId === orderId),
        (t) => t.length > 0,
      );
      for (const t of tickets) await h.call('POST', `/kitchen/tickets/${t.id}/ack`, kitchen);
    }
    for (const i of orders.filter((o) => !itemIds || itemIds.includes(o.id))) {
      await h.call('PATCH', `/order-items/${i.id}/status`, kitchen, { status: 'PREPARING' });
      if (to === 'READY') await h.call('PATCH', `/order-items/${i.id}/status`, kitchen, { status: 'READY' });
    }
  }

  /** Dọn chuyến để trả robot về trạng thái rảnh cho test sau. */
  async function finish(tripId: string) {
    const t = (await h.call('GET', `/trips/${tripId}`, manager)).body;
    if (t.stage === 'ARRIVED') await h.call('POST', `/trips/${tripId}/confirm-delivered`, manager);
    else if (!['DONE', 'FAILED', 'CANCELLED', 'DELIVERED', 'RETURNING'].includes(t.stage)) await h.call('POST', `/trips/${tripId}/fallback-staff`, manager, { reason: 'dọn test' });
    await waitFor(async () => ((await h.call('GET', '/robots', manager)).body as any[]).find((r) => r.id === t.robotId).state, (st) => st === 'IDLE');
  }

  const tripOf = (sessionId: string, stages?: string[]) =>
    waitFor(
      async () => ((await h.call('GET', '/trips?active=false', manager)).body as any[]).find((t) => t.sessionId === sessionId && (!stages || stages.includes(t.stage))),
      (t) => !!t,
    );

  it('trọn chuyến: món xong → robot tự nhận chuyến → quét sai khay bị chặn → giao → khách bấm đã nhận', async () => {
    const { session, table, order } = await sessionWithOrder(h, manager, [{ code: 'MC01', qty: 1 }]);
    const tablet = await pairTablet(table.id);
    await cook(order.id);

    const trip = await tripOf(session.id, ['AT_PICKUP']);
    expect(trip).toMatchObject({ tableCode: table.code, items: [{ status: 'ASSIGNED' }] });

    const wrong = await h.call('POST', `/trips/${trip.id}/pickup`, kitchen, { trayCode: 'TR999' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('WRONG_TRAY');
    expect((await h.call('POST', `/trips/${trip.id}/pickup`, kitchen, { trayCode: trip.code })).body.stage).toBe('MOVING');

    await waitFor(async () => (await h.call('GET', `/trips/${trip.id}`, tablet)).body.stage, (s) => s === 'ARRIVED');
    const done = await h.call('POST', `/trips/${trip.id}/confirm-delivered`, tablet);
    expect(done.body.items[0].status).toBe('DELIVERED');
    await waitFor(async () => (await h.call('GET', `/trips/${trip.id}`, manager)).body.stage, (s) => s === 'DONE');
    const robot = (await h.call('GET', '/robots', manager)).body.find((r: any) => r.code === trip.robotCode);
    expect(robot.state).toBe('IDLE');
  });

  it('gom món: món đầu xong khi món sau còn nấu → chờ; xong hết → một chuyến chở cả hai', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [
      { code: 'MC02', qty: 1 },
      { code: 'MC04', qty: 1 },
    ]);
    const [a, b] = order.items;
    await cook(order.id, [a.id]);
    await cook(order.id, [b.id], 'PREPARING');
    await new Promise((r) => setTimeout(r, 500));
    expect(((await h.call('GET', '/trips?active=false', manager)).body as any[]).some((t) => t.sessionId === session.id)).toBe(false);
    await h.call('PATCH', `/order-items/${b.id}/status`, kitchen, { status: 'READY' });
    const trip = await tripOf(session.id);
    expect(trip.items).toHaveLength(2);
    await finish(trip.id);
  });

  it('chuyển bàn giữa lúc bếp đang nấu → robot giao đúng bàn mới', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [{ code: 'MC03', qty: 1 }]);
    await cook(order.id, undefined, 'PREPARING');
    const free = ((await h.call('GET', '/tables', manager)).body as any[]).find((t) => t.status === 'AVAILABLE');
    await h.call('POST', `/sessions/${session.id}/move`, manager, { toTableId: free.id });
    await h.call('PATCH', `/order-items/${order.items[0].id}/status`, kitchen, { status: 'READY' });
    const trip = await tripOf(session.id, ['AT_PICKUP']);
    expect(trip.tableCode).toBe(free.code);
    await finish(trip.id);
  });

  it('chuyển bàn khi robot đang chạy → đổi đích sang bàn mới', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [{ code: 'MC05', qty: 1 }]);
    await cook(order.id);
    const trip = await tripOf(session.id, ['AT_PICKUP']);
    await h.call('POST', `/trips/${trip.id}/pickup`, kitchen, { trayCode: trip.code });
    const free = ((await h.call('GET', '/tables', manager)).body as any[]).find((t) => t.status === 'AVAILABLE');
    await h.call('POST', `/sessions/${session.id}/move`, manager, { toTableId: free.id });
    const arrived = await waitFor(async () => (await h.call('GET', `/trips/${trip.id}`, manager)).body, (t) => t.stage === 'ARRIVED');
    expect(arrived.tableCode).toBe(free.code);
    await finish(trip.id);
  });

  it('robot kẹt → chuyến lỗi, món quay lại hàng chờ và được robot khác giao', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [{ code: 'MC06', qty: 1 }]);
    await cook(order.id);
    const first = await tripOf(session.id, ['AT_PICKUP']);
    await h.call('POST', `/trips/${first.id}/pickup`, kitchen, { trayCode: first.code });
    await h.call('POST', `/robots/${first.robotId}/simulate`, manager, { fault: 'bi_ket' });

    expect((await h.call('GET', `/trips/${first.id}`, manager)).body).toMatchObject({ stage: 'FAILED', failReason: 'Robot bị kẹt' });
    const second = await waitFor(
      async () => ((await h.call('GET', '/trips?active=false', manager)).body as any[]).find((t) => t.sessionId === session.id && t.id !== first.id),
      (t) => !!t,
    );
    expect(second.robotId).not.toBe(first.robotId);
    expect(((await h.call('GET', '/robots', manager)).body as any[]).find((r) => r.id === first.robotId).state).toBe('ERROR');
    await h.call('POST', `/robots/${first.robotId}/simulate`, manager, { fault: 'phuc_hoi' });
    await h.call('POST', `/trips/${second.id}/fallback-staff`, manager, { reason: 'dọn test' });
  });

  it('robot mất kết nối → OFFLINE, món quay lại hàng chờ', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [{ code: 'KV02', qty: 1 }]);
    await cook(order.id);
    const trip = await tripOf(session.id, ['AT_PICKUP']);
    await h.call('POST', `/robots/${trip.robotId}/simulate`, manager, { fault: 'mat_ket_noi' });
    const failed = await waitFor(async () => (await h.call('GET', `/trips/${trip.id}`, manager)).body, (t) => t.stage === 'FAILED');
    expect(failed.failReason).toBe('Robot mất kết nối');
    expect(((await h.call('GET', '/robots', manager)).body as any[]).find((r) => r.id === trip.robotId).state).toBe('OFFLINE');
    await h.call('POST', `/robots/${trip.robotId}/simulate`, manager, { fault: 'phuc_hoi' });
    await waitFor(async () => ((await h.call('GET', '/robots', manager)).body as any[]).find((r) => r.id === trip.robotId).state, (s) => s === 'IDLE');
  });

  it('chuyển nhân viên giao → món không bị robot nhận lại, nhân viên báo đã phục vụ', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [{ code: 'MC01', qty: 2 }]);
    await cook(order.id);
    const trip = await tripOf(session.id, ['AT_PICKUP']);
    const r = await h.call('POST', `/trips/${trip.id}/fallback-staff`, manager, { reason: 'Khay quá nặng' });
    expect(r.body.stage).toBe('CANCELLED');
    await new Promise((res) => setTimeout(res, 400));
    const trips = ((await h.call('GET', '/trips?active=false', manager)).body as any[]).filter((t) => t.sessionId === session.id);
    expect(trips).toHaveLength(1);
    const item = order.items[0].id;
    expect((await h.call('PATCH', `/order-items/${item}/status`, manager, { status: 'DELIVERED' })).body.status).toBe('DELIVERED');
  });

  it('báo cáo chỉ số giao món', async () => {
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const m = (await h.call('GET', `/reports/delivery?from=${today}&to=${today}`, manager)).body;
    expect(m.trips).toBeGreaterThan(0);
    expect(m.failed).toBeGreaterThan(0);
    expect(m.avgReadyToDeliveredSec).not.toBeNull();
    expect(m.fallbackRate).toBeGreaterThan(0);
  });
});
