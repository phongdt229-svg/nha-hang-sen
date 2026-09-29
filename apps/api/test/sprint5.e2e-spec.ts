import { key, sessionWithOrder, startApp, waitFor, type Harness } from './harness';

/** Sprint 5: tách/gộp bill, hoàn tiền, kết ca, báo cáo, xuất file (mục 15). */
describe('Sprint 5: tình huống tại quầy', () => {
  let h: Harness;
  let manager: string, cashier: string;

  beforeAll(async () => {
    h = await startApp();
    [manager, cashier] = await Promise.all([h.login('quanly'), h.login('thungan')]);
    await h.call('POST', '/shifts/open', cashier, { openingCash: 500_000 });
  });
  afterAll(() => h.close());

  const pay = (billId: string, received: number) =>
    h.call('POST', `/bills/${billId}/payments`, cashier, { method: 'CASH', received }, { 'idempotency-key': key() });

  it('tách bill theo món → tổng bill con = bill gốc; phiên chỉ đóng khi thu đủ mọi bill con', async () => {
    const { session, order, table } = await sessionWithOrder(h, manager, [
      { code: 'MC01', qty: 2 },
      { code: 'BR01', qty: 3 },
      { code: 'DU01', qty: 1 },
    ]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    const ids = order.items.map((i: { id: string }) => i.id);
    const split = await h.call('POST', `/bills/${bill.id}/split`, cashier, {
      version: bill.version,
      groups: [
        { label: 'G1', orderItemIds: [ids[0]] },
        { label: 'G2', orderItemIds: ids.slice(1) },
      ],
    });
    expect(split.status).toBe(201);
    const [g1, g2] = split.body;
    expect(g1.total + g2.total).toBe(bill.total);
    expect(g1.totalTax + g2.totalTax).toBe(bill.totalTax);

    await pay(g1.id, g1.total);
    let t = ((await h.call('GET', '/tables', manager)).body as any[]).find((x) => x.id === table.id);
    expect(t.status).toBe('PAYMENT');
    await pay(g2.id, g2.total);
    t = ((await h.call('GET', '/tables', manager)).body as any[]).find((x) => x.id === table.id);
    expect(t.status).toBe('CLEANING');
    expect((await h.call('GET', `/sessions/${session.id}/bills`, cashier)).body.map((b: any) => b.status)).toEqual(['PAID', 'PAID']);
  });

  it('tách bill bỏ sót món → bị từ chối', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [
      { code: 'MC02', qty: 1 },
      { code: 'MC03', qty: 1 },
    ]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    const r = await h.call('POST', `/bills/${bill.id}/split`, cashier, {
      version: bill.version,
      groups: [
        { label: 'G1', orderItemIds: [order.items[0].id] },
        { label: 'G2', orderItemIds: [order.items[0].id] },
      ],
    });
    expect(r.status).toBe(400);
  });

  it('hủy tách khi chưa thu tiền → bill gốc mở lại, gọi thêm được', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [
      { code: 'MC04', qty: 1 },
      { code: 'MC05', qty: 1 },
    ]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    await h.call('POST', `/bills/${bill.id}/split`, cashier, {
      version: bill.version,
      groups: order.items.map((i: any, n: number) => ({ label: `G${n + 1}`, orderItemIds: [i.id] })),
    });
    const r = await h.call('POST', `/bills/${bill.id}/unsplit`, manager, { reason: 'Khách đổi ý' });
    expect(r.body.status).toBe('OPEN');
    expect((await h.call('GET', `/sessions/${session.id}/bills`, cashier)).body).toHaveLength(1);
  });

  it('gộp hai phiên → order giữ lịch sử, một bill chung, bàn nguồn thuộc phiên đích', async () => {
    const a = await sessionWithOrder(h, manager, [{ code: 'MC01', qty: 1 }]);
    const b = await sessionWithOrder(h, manager, [{ code: 'MC02', qty: 2 }]);
    const merged = await h.call('POST', `/sessions/${a.session.id}/merge`, manager, { sourceSessionId: b.session.id });
    expect(merged.status).toBe(201);
    expect(merged.body.tableIds.sort()).toEqual([a.table.id, b.table.id].sort());
    expect(merged.body.guests).toBe(4);

    const orders = (await h.call('GET', `/sessions/${a.session.id}/orders`, manager)).body;
    expect(orders.map((o: any) => o.number)).toEqual([a.order.number, b.order.number]);
    const bill = (await h.call('GET', `/sessions/${a.session.id}/bill`, cashier)).body;
    expect(bill.total).toBe(65_000 + 120_000);
    const src = await h.prisma.diningSession.findUniqueOrThrow({ where: { id: b.session.id } });
    expect(src.status).toBe('CLOSED');
  });

  it('hoàn tiền sau khi chốt ngày → báo cáo ngày cũ không đổi, bút toán âm nằm ở ngày hoàn', async () => {
    const { session } = await sessionWithOrder(h, manager, [{ code: 'MC03', qty: 2 }]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    await h.call('POST', `/bills/${bill.id}/lock`, cashier, { version: bill.version });
    await pay(bill.id, 190_000);
    // Giả lập bill (và hóa đơn điện tử của nó) thuộc một ngày kinh doanh đã qua.
    await waitFor(() => h.prisma.eInvoice.count({ where: { billId: bill.id } }), (c) => c > 0);
    await h.prisma.bill.update({ where: { id: bill.id }, data: { businessDay: '2020-01-01' } });
    await h.prisma.eInvoice.updateMany({ where: { billId: bill.id }, data: { businessDay: '2020-01-01' } });
    await h.call('POST', '/business-days/2020-01-01/close', manager);
    const before = (await h.call('GET', '/reports/revenue?from=2020-01-01&to=2020-01-01&group_by=day', manager)).body;
    expect(before.totals.net).toBe(190_000);

    const r = await h.call('POST', `/bills/${bill.id}/refunds`, manager, { amount: 95_000, method: 'QR', reason: 'Món bị nguội' });
    expect(r.status).toBe(201);
    expect(r.body.bill.refunded).toBe(95_000);
    const after = (await h.call('GET', '/reports/revenue?from=2020-01-01&to=2020-01-01&group_by=day', manager)).body;
    expect(after.totals).toEqual(before.totals);
    const today = r.body.refund.businessDay;
    const todayReport = (await h.call('GET', `/reports/revenue?from=${today}&to=${today}&group_by=day`, manager)).body;
    expect(todayReport.totals.refund).toBeGreaterThanOrEqual(95_000);
    expect((await h.call('POST', `/bills/${bill.id}/refunds`, manager, { amount: 100_000, method: 'QR', reason: 'x' })).status).toBe(409);
  });

  it('thu tiền mặt khi chưa mở ca → bị chặn', async () => {
    const other = await h.login('quanly');
    const { session } = await sessionWithOrder(h, other, [{ code: 'DU02', qty: 1 }]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, other)).body;
    await h.call('POST', `/bills/${bill.id}/lock`, other, { version: bill.version });
    const r = await h.call('POST', `/bills/${bill.id}/payments`, other, { method: 'CASH', received: 40_000 }, { 'idempotency-key': key() });
    expect(r.body.error).toBe('SHIFT_REQUIRED');
  });

  it('kết ca: tiền mặt đếm lệch vượt ngưỡng → chờ quản lý duyệt', async () => {
    const shift = (await h.call('GET', '/shifts/current', cashier)).body;
    const report = (await h.call('GET', `/shifts/${shift.id}/report`, cashier)).body;
    const expected = report.openingCash + (report.totals.byMethod.CASH ?? 0) - (report.totals.refundsByMethod.CASH ?? 0);
    const closed = (await h.call('POST', `/shifts/${shift.id}/close`, cashier, { countedCash: expected - 100_000 })).body;
    expect(closed).toMatchObject({ status: 'PENDING_APPROVAL', expectedCash: expected, difference: -100_000 });
    expect((await h.call('POST', `/shifts/${shift.id}/approve`, cashier, { reason: 'x' })).status).toBe(403);
    const approved = (await h.call('POST', `/shifts/${shift.id}/approve`, manager, { reason: 'Đã kiểm lại, thiếu do trả nhầm' })).body;
    expect(approved.status).toBe('CLOSED');

    const next = (await h.call('POST', '/shifts/open', cashier, { openingCash: 200_000 })).body;
    const ok = (await h.call('POST', `/shifts/${next.id}/close`, cashier, { countedCash: 200_000 })).body;
    expect(ok).toMatchObject({ status: 'CLOSED', difference: 0 });
  });

  it('báo cáo theo món/phương thức khớp tổng, xuất Excel và CSV', async () => {
    const today = (await h.call('GET', '/reports/overview', manager)).body.businessDay;
    const q = `from=${today}&to=${today}`;
    const byDay = (await h.call('GET', `/reports/revenue?${q}&group_by=day`, manager)).body;
    const byItem = (await h.call('GET', `/reports/revenue?${q}&group_by=item`, manager)).body;
    const byMethod = (await h.call('GET', `/reports/revenue?${q}&group_by=method`, manager)).body;
    expect(byItem.totals.revenue).toBe(byDay.totals.revenue);
    expect(byMethod.totals.amount).toBe(byDay.totals.revenue);

    const xlsx = await h.call('GET', `/reports/export?${q}&type=revenue&group_by=item&format=xlsx`, manager);
    expect(xlsx.status).toBe(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const csv = await h.call('GET', `/reports/export?${q}&type=kpis&format=csv`, manager);
    expect((csv.body as Buffer).toString('utf8')).toContain('Vòng quay bàn');
    expect((await h.call('GET', `/reports/revenue?${q}`, cashier)).status).toBe(403);

    // Hồi quy múi giờ: cột thời gian lưu UTC, báo cáo theo giờ phải ra giờ Việt Nam.
    const byHour = (await h.call('GET', `/reports/revenue?${q}&group_by=hour`, manager)).body;
    const vnHour = new Date(Date.now() + 7 * 3600_000).getUTCHours();
    expect(byHour.rows.map((r: any) => Number(r.key))).toContain(vnHour);
  });
});
