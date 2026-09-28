import { io } from 'socket.io-client';
import { key, startApp, waitFor, type Harness } from './harness';

/** Các kịch bản kiểm thử bắt buộc trước pilot thuộc phạm vi lõi MVP (mục 15). */
describe('Lõi MVP: phiên → order → bếp → bill → thanh toán', () => {
  let h: Harness;
  let manager: string, cashier: string, kitchen: string;
  let tables: { id: string; code: string; status: string }[];
  let menu: { id: string; code: string; station: string }[];
  const item = (code: string) => menu.find((m) => m.code === code)!;
  let nextTable = 0;

  beforeAll(async () => {
    h = await startApp();
    [manager, cashier, kitchen] = await Promise.all([h.login('quanly'), h.login('thungan'), h.login('bep')]);
    tables = ((await h.call('GET', '/tables', manager)).body as typeof tables).filter((t) => t.status === 'AVAILABLE');
    menu = (await h.call('GET', '/menu', manager)).body.items;
    await h.call('POST', '/shifts/open', cashier, { openingCash: 1_000_000 });
  });

  afterAll(() => h.close());

  async function openTable(guests = 2) {
    const table = tables[nextTable++];
    const s = await h.call('POST', '/sessions', manager, { tableId: table.id, guests });
    expect(s.status).toBe(201);
    return { table, session: s.body };
  }

  async function pairTablet(tableId: string) {
    const code = (await h.call('POST', '/devices/pairing-codes', manager, { kind: 'TABLET', tableId })).body.code;
    return (await h.call('POST', '/devices/pair', undefined, { code, name: 'tablet' })).body.token as string;
  }

  const order = (token: string, sessionId: string, k: string, items: { code: string; qty: number }[]) =>
    h.call('POST', `/sessions/${sessionId}/orders`, token, { items: items.map((i) => ({ menuItemId: item(i.code).id, qty: i.qty })) }, { 'idempotency-key': k });

  const ticketsOf = async (station: string, orderId: string) =>
    ((await h.call('GET', `/kitchen/tickets?station=${station}`, kitchen)).body as any[]).filter((t) => t.orderId === orderId);

  it('khách bấm xác nhận 5 lần song song → chỉ 1 order', async () => {
    const { table, session } = await openTable();
    const tablet = await pairTablet(table.id);
    const k = key();
    const results = await Promise.all(Array.from({ length: 5 }, () => order(tablet, session.id, k, [{ code: 'MC01', qty: 1 }])));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await h.call('GET', `/sessions/${session.id}/orders`, tablet)).body).toHaveLength(1);
  });

  it('KDS không ACK → gửi lại 3 lần → FALLBACK; bếp nhập tay → KDS_ACK', async () => {
    const { session } = await openTable();
    const o = (await order(manager, session.id, key(), [{ code: 'KV01', qty: 2 }])).body;
    const [ticket] = await waitFor(() => ticketsOf('BEP_LANH', o.id), (t) => t[0]?.status === 'FALLBACK');
    expect(ticket.attempts).toBe(4); // 1 lần gửi + 3 lần gửi lại
    expect(ticket.items[0].status).toBe('FALLBACK');

    const acked = await h.call('POST', `/kitchen/tickets/${ticket.id}/ack`, kitchen);
    expect(acked.body.status).toBe('ACKED');
    const orders = (await h.call('GET', `/sessions/${session.id}/orders`, manager)).body;
    expect(orders[0].kitchenAcked).toBe(true);
    expect(orders[0].items[0].status).toBe('KDS_ACK');
  });

  it('KDS ACK kịp thời → không gửi lại; ACK lặp vẫn an toàn', async () => {
    const { session } = await openTable();
    const o = (await order(manager, session.id, key(), [{ code: 'MC02', qty: 1 }])).body;
    const [ticket] = await waitFor(() => ticketsOf('BEP_NONG', o.id), (t) => t.length === 1);
    await Promise.all([1, 2, 3].map(() => h.call('POST', `/kitchen/tickets/${ticket.id}/ack`, kitchen)));
    await new Promise((r) => setTimeout(r, 1500));
    const [after] = await ticketsOf('BEP_NONG', o.id);
    expect(after).toMatchObject({ status: 'ACKED', attempts: 1 });
  });

  it('món hết → tablet không gọi được', async () => {
    const { table, session } = await openTable();
    const tablet = await pairTablet(table.id);
    await h.call('PATCH', `/menu/${item('TM01').id}/availability`, kitchen, { available: false });
    const r = await order(tablet, session.id, key(), [{ code: 'TM01', qty: 1 }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ITEM_UNAVAILABLE');
    await h.call('PATCH', `/menu/${item('TM01').id}/availability`, kitchen, { available: true });
  });

  it('chuyển bàn: phiên giữ nguyên, bàn cũ CLEANING, tablet bàn cũ không gọi thêm được', async () => {
    const { table: from, session } = await openTable();
    const oldTablet = await pairTablet(from.id);
    const to = tables[nextTable++];
    const newTablet = await pairTablet(to.id);
    const moved = await h.call('POST', `/sessions/${session.id}/move`, manager, { toTableId: to.id });
    expect(moved.body).toMatchObject({ id: session.id, tableCodes: [to.code] });

    const all = (await h.call('GET', '/tables', manager)).body as any[];
    expect(all.find((t) => t.id === from.id).status).toBe('CLEANING');
    expect(all.find((t) => t.id === to.id)).toMatchObject({ status: 'DINING', sessionId: session.id });
    expect((await h.call('GET', '/devices/me/session', newTablet)).body.id).toBe(session.id);
    expect((await order(oldTablet, session.id, key(), [{ code: 'MC01', qty: 1 }])).status).toBe(403);
    expect((await order(newTablet, session.id, key(), [{ code: 'MC01', qty: 1 }])).status).toBe(201);
  });

  it('hai thu ngân cùng khóa một bill → chỉ một thao tác thành công', async () => {
    const { session } = await openTable();
    await order(manager, session.id, key(), [{ code: 'MC03', qty: 1 }]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    const results = await Promise.all([1, 2].map(() => h.call('POST', `/bills/${bill.id}/lock`, cashier, { version: bill.version })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('thanh toán gửi 2 lần cùng khóa → ghi nhận 1 lần; thu đủ → bàn CLEANING, phiên đóng', async () => {
    const { table, session } = await openTable();
    await order(manager, session.id, key(), [
      { code: 'MC01', qty: 2 },
      { code: 'BR01', qty: 4 },
    ]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    expect(bill.total).toBe(230_000);
    const locked = (await h.call('POST', `/bills/${bill.id}/lock`, cashier, { version: bill.version })).body;
    expect(locked.status).toBe('LOCKED');

    const k = key();
    const pays = await Promise.all([1, 2].map(() => h.call('POST', `/bills/${bill.id}/payments`, cashier, { method: 'CASH', received: 500_000 }, { 'idempotency-key': k })));
    expect(pays.every((p) => p.status === 201)).toBe(true);
    expect(new Set(pays.map((p) => p.body.payment.id)).size).toBe(1);
    expect(pays[0].body.payment.change).toBe(270_000);
    expect(pays[0].body.bill).toMatchObject({ status: 'PAID', paid: 230_000 });

    const t = ((await h.call('GET', '/tables', manager)).body as any[]).find((x) => x.id === table.id);
    expect(t).toMatchObject({ status: 'CLEANING', sessionId: null });
    expect((await h.call('POST', `/tables/${table.id}/cleaned`, manager)).status).toBe(201);
  });

  it('thanh toán QR chờ xác nhận; xác nhận lặp không cộng tiền 2 lần', async () => {
    const { session } = await openTable();
    await order(manager, session.id, key(), [{ code: 'MC04', qty: 1 }]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    await h.call('POST', `/bills/${bill.id}/lock`, cashier, { version: bill.version });
    const qr = (await h.call('POST', `/bills/${bill.id}/payments`, cashier, { method: 'QR' }, { 'idempotency-key': key() })).body;
    expect(qr.payment.status).toBe('PENDING');
    const [a, b] = await Promise.all([1, 2].map(() => h.call('POST', `/payments/${qr.payment.id}/confirm`, cashier, {})));
    expect(a.body.bill.paid).toBe(120_000);
    expect(b.body.bill.paid).toBe(120_000);
    expect(b.body.bill.status).toBe('PAID');
  });

  it('WebSocket rớt rồi nối lại → lấy đủ sự kiện bị lỡ qua lastEventId, không trùng', async () => {
    const { table, session } = await openTable();
    const tablet = await pairTablet(table.id);
    const seen: number[] = [];
    const socket = io(h.url, { auth: { token: tablet }, transports: ['websocket'] });
    socket.on('event', (e: { seq: number }) => seen.push(e.seq));
    await new Promise<void>((r) => socket.on('connect', () => r()));

    await order(tablet, session.id, key(), [{ code: 'MC05', qty: 1 }]);
    await waitFor(async () => seen.length, (n) => n > 0);
    socket.disconnect();
    const lastEventId = Math.max(...seen);

    await order(tablet, session.id, key(), [{ code: 'MC06', qty: 1 }]); // xảy ra lúc mất kết nối
    const missed = await waitFor(
      async () => (await h.call('GET', `/events?after=${lastEventId}`, tablet)).body as any[],
      (evs) => evs.some((e) => e.type === 'order.confirmed'),
    );
    expect(missed.every((e) => e.seq > lastEventId)).toBe(true);
    expect(new Set(missed.map((e) => e.seq)).size).toBe(missed.length);
  });

  it('quyền: tablet không khóa bill, bếp không mở bàn', async () => {
    const { table, session } = await openTable();
    const tablet = await pairTablet(table.id);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    expect((await h.call('POST', `/bills/${bill.id}/lock`, tablet, { version: 0 })).status).toBe(403);
    expect((await h.call('POST', '/sessions', kitchen, { tableId: tables[nextTable].id, guests: 2 })).status).toBe(403);
  });
});
