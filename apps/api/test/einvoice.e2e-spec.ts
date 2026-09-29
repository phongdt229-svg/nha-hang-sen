import type { MockEInvoiceAdapter } from '@nhs/einvoice-adapters';
import { EINVOICE_ADAPTER } from '../src/einvoice/einvoice.service';
import { key, sessionWithOrder, startApp, waitFor, type Harness } from './harness';

/** Sprint 6: hóa đơn điện tử (mục 12, kịch bản mục 15). */
describe('Hóa đơn điện tử', () => {
  let h: Harness;
  let manager: string, cashier: string, accountant: string;

  beforeAll(async () => {
    h = await startApp();
    [manager, cashier, accountant] = await Promise.all([h.login('quanly'), h.login('thungan'), h.login('ketoan')]);
    await h.call('POST', '/shifts/open', cashier, { openingCash: 500_000 });
  });
  afterAll(() => h.close());

  const pay = (billId: string, amount: number) =>
    h.call('POST', `/bills/${billId}/payments`, cashier, { method: 'CASH', received: amount }, { 'idempotency-key': key() });

  const invoices = async (billId: string) => (await h.call('GET', `/bills/${billId}/einvoices`, cashier)).body as any[];
  const original = (billId: string, ok: (inv: any) => boolean) =>
    waitFor(
      async () => (await invoices(billId)).find((i) => i.kind === 'ORIGINAL'),
      (i) => !!i && ok(i),
    );

  /** Mở bàn, gọi món, (nhập người mua), khóa bill và thu đủ tiền mặt. */
  async function paidBill(codes: { code: string; qty: number }[], buyer?: object) {
    const { session } = await sessionWithOrder(h, manager, codes);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    if (buyer) expect((await h.call('PUT', `/bills/${bill.id}/buyer`, cashier, buyer)).status).toBe(200);
    const locked = (await h.call('POST', `/bills/${bill.id}/lock`, cashier, { version: bill.version })).body;
    expect((await pay(bill.id, locked.total)).status).toBe(201);
    return locked;
  }

  it('thanh toán xong → tự phát hành; bill đồ ăn + bia tách đúng từng mức thuế', async () => {
    const bill = await paidBill([
      { code: 'MC01', qty: 2 },
      { code: 'BR01', qty: 4 },
    ]);
    const inv = await original(bill.id, (i) => i.status === 'ISSUED');
    expect(inv.number).toMatch(/^\d{8}$/);
    expect(inv.lookupCode).toBeTruthy();
    expect(inv.total).toBe(bill.total);
    expect(inv.totalTax).toBe(bill.totalTax);
    expect(inv.taxes.map((t: any) => t.rate)).toEqual([800, 1000]);
    expect(inv.taxes.reduce((a: number, t: any) => a + t.base + t.tax, 0)).toBe(bill.total);
    // Phiếu thanh toán lấy được số hóa đơn và mã tra cứu.
    const after = (await h.call('GET', `/bills/${bill.id}`, cashier)).body;
    expect(after.einvoice).toMatchObject({ status: 'ISSUED', number: inv.number, lookupCode: inv.lookupCode });
  });

  it('bấm phát hành nhiều lần → chỉ một hóa đơn gốc', async () => {
    const bill = await paidBill([{ code: 'MC02', qty: 1 }]);
    const rs = await Promise.all([1, 2, 3].map(() => h.call('POST', `/bills/${bill.id}/einvoice`, cashier)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    await original(bill.id, (i) => i.status === 'ISSUED');
    expect(await h.prisma.eInvoice.count({ where: { billId: bill.id } })).toBe(1);
  });

  it('nhập MST: tra cứu tự điền; MST sai định dạng bị chặn ngay', async () => {
    const r = await h.call('GET', '/tax-codes/0100109106', cashier);
    expect(r.status).toBe(200);
    expect(r.body.name).toContain('Hoa Sen');
    expect((await h.call('GET', '/tax-codes/123', cashier)).status).toBe(400);
    expect((await h.call('GET', '/tax-codes/0999999999', cashier)).status).toBe(404);
  });

  it('MST không tồn tại → Failed có lý do → sửa rồi phát hành lại, không trùng', async () => {
    const bill = await paidBill([{ code: 'MC03', qty: 1 }], { kind: 'COMPANY', taxCode: '0999999999', name: 'Công ty Sai', email: 'kt@example.com' });
    const failed = await original(bill.id, (i) => i.status === 'FAILED');
    expect(failed.error).toContain('0999999999');
    expect((await h.call('GET', '/einvoices/attention', cashier)).body.some((i: any) => i.id === failed.id)).toBe(true);

    const fix = await h.call('PUT', `/bills/${bill.id}/buyer`, cashier, { kind: 'COMPANY', taxCode: '0100109106', name: 'Công ty TNHH Hoa Sen Demo' });
    expect(fix.status).toBe(200);
    const issued = await original(bill.id, (i) => i.status === 'ISSUED');
    expect(issued.id).toBe(failed.id);
    expect(issued.buyer.taxCode).toBe('0100109106');
    expect(await h.prisma.eInvoice.count({ where: { billId: bill.id } })).toBe(1);

    // Đã phát hành thì không sửa người mua trực tiếp nữa, phải lập hóa đơn điều chỉnh.
    expect((await h.call('PUT', `/bills/${bill.id}/buyer`, cashier, { kind: 'PERSON' })).status).toBe(409);
  });

  it('mất Internet khi thanh toán → hóa đơn nằm trong hàng đợi, có mạng lại tự phát hành', async () => {
    const adapter = h.app.get<MockEInvoiceAdapter>(EINVOICE_ADAPTER);
    adapter.offline = true;
    try {
      const bill = await paidBill([{ code: 'MC04', qty: 1 }]);
      const pending = await original(bill.id, (i) => i.attempts >= 1 && i.status === 'PENDING');
      expect(pending.error).toBeTruthy();
      expect((await h.call('GET', `/bills/${bill.id}`, cashier)).body.status).toBe('PAID');
      adapter.offline = false;
      await h.call('POST', '/einvoices/retry-pending', cashier);
      const issued = await original(bill.id, (i) => i.status === 'ISSUED');
      expect(issued.id).toBe(pending.id);
    } finally {
      adapter.offline = false;
    }
  });

  it('tách bill 2 phần → 2 hóa đơn, tổng khớp bill gốc', async () => {
    const { session, order } = await sessionWithOrder(h, manager, [
      { code: 'MC05', qty: 1 },
      { code: 'BR02', qty: 2 },
    ]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    const ids = order.items.map((i: { id: string }) => i.id);
    const split = await h.call('POST', `/bills/${bill.id}/split`, cashier, {
      version: bill.version,
      groups: [
        { label: 'A', orderItemIds: [ids[0]] },
        { label: 'B', orderItemIds: [ids[1]] },
      ],
    });
    const parts = split.body as any[];
    for (const p of parts) await pay(p.id, p.total);
    const invs = await Promise.all(parts.map((p) => original(p.id, (i) => i.status === 'ISSUED')));
    expect(invs[0].number).not.toBe(invs[1].number);
    expect(invs[0].total + invs[1].total).toBe(bill.total);
    expect(await h.prisma.eInvoice.count({ where: { billId: bill.id } })).toBe(0);
  });

  it('hoàn tiền sau khi xuất hóa đơn → hóa đơn điều chỉnh giảm đúng số hoàn', async () => {
    const bill = await paidBill([
      { code: 'MC06', qty: 1 },
      { code: 'BR01', qty: 2 },
    ]);
    const inv = await original(bill.id, (i) => i.status === 'ISSUED');
    const r = await h.call('POST', `/bills/${bill.id}/refunds`, manager, { amount: 40_000, method: 'QR', reason: 'Món bị nguội' });
    expect(r.status).toBe(201);
    const adj = await waitFor(
      async () => (await invoices(bill.id)).find((i) => i.kind === 'ADJUSTMENT'),
      (i) => i?.status === 'ISSUED',
    );
    expect(adj.total).toBe(-40_000);
    expect(adj.taxes.every((t: any) => t.base <= 0 && t.tax <= 0)).toBe(true);
    expect((await h.call('GET', `/einvoices/${inv.id}`, cashier)).body.status).toBe('ADJUSTED');
    expect(await h.prisma.eInvoiceLink.count({ where: { originalId: inv.id, linkedId: adj.id } })).toBe(1);

    // Bảng kê theo thuế suất tính cả điều chỉnh âm.
    const day = adj.businessDay;
    const summary = (await h.call('GET', `/einvoices/tax-summary?from=${day}&to=${day}`, accountant)).body;
    expect(summary.totals.total).toBeGreaterThan(0);
  });

  it('điều chỉnh/thay thế chỉ dành cho kế toán, quản lý; thay thế thì hóa đơn cũ không còn tính', async () => {
    const bill = await paidBill([{ code: 'KV01', qty: 1 }]);
    const inv = await original(bill.id, (i) => i.status === 'ISSUED');
    expect((await h.call('POST', `/einvoices/${inv.id}/replace`, cashier, { reason: 'x' })).status).toBe(403);
    expect((await h.call('GET', '/einvoices?from=2026-01-01&to=2030-01-01', cashier)).status).toBe(403);

    const adj = await h.call('POST', `/einvoices/${inv.id}/adjust`, accountant, {
      reason: 'Sai tên người mua',
      buyer: { kind: 'COMPANY', taxCode: '0312345678', name: 'Công ty Cổ phần Thử Nghiệm Sen' },
    });
    expect(adj.status).toBe(201);
    expect(adj.body).toMatchObject({ kind: 'ADJUSTMENT', status: 'ISSUED', total: 0 });

    const rep = await h.call('POST', `/einvoices/${inv.id}/replace`, accountant, { reason: 'Sai thông tin' });
    expect(rep.status).toBe(201);
    expect(rep.body).toMatchObject({ kind: 'REPLACEMENT', status: 'ISSUED', total: bill.total });
    expect((await h.call('GET', `/einvoices/${inv.id}`, accountant)).body.status).toBe('REPLACED');
    const audit = await h.prisma.auditLog.count({ where: { entityId: inv.id, action: { in: ['einvoice.adjust', 'einvoice.replace'] } } });
    expect(audit).toBe(2);
  });

  it('doanh thu ngày kinh doanh = tổng hóa đơn đã phát hành', async () => {
    const r = await waitFor(
      async () => (await h.call('GET', '/einvoices/reconcile', manager)).body,
      (x) => x.unissued === 0 && x.difference === 0,
    );
    expect(r.revenue).toBe(r.invoiced);
    expect((await h.call('GET', '/reports/overview', manager)).body.einvoice.difference).toBe(0);
  });
});
