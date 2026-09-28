import { createHmac } from 'node:crypto';
import { key, sessionWithOrder, startApp, type Harness } from './harness';

/** Sprint 6: xác nhận QR tự động qua webhook và đối soát (mục 15). */
describe('Thanh toán qua webhook', () => {
  let h: Harness;
  let manager: string, cashier: string;

  beforeAll(async () => {
    h = await startApp();
    [manager, cashier] = await Promise.all([h.login('quanly'), h.login('thungan')]);
  });
  afterAll(() => h.close());

  async function pendingQr(code: string) {
    const { session } = await sessionWithOrder(h, manager, [{ code, qty: 1 }]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    await h.call('POST', `/bills/${bill.id}/lock`, cashier, { version: bill.version });
    const qr = (await h.call('POST', `/bills/${bill.id}/payments`, cashier, { method: 'QR' }, { 'idempotency-key': key() })).body;
    return { bill: qr.bill, payment: qr.payment };
  }

  const signed = (body: object) => {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', 'mock-secret').update(raw).digest('hex') };
  };

  it('webhook gửi 2 lần → chỉ ghi nhận 1 lần; nội dung không có dấu "-" vẫn khớp', async () => {
    const { bill, payment } = await pendingQr('MC01');
    const body = { transactions: [{ id: 'TXN-A1', amount: payment.amount, description: `CK ${bill.number.replace('-', '')} ban 3` }] };
    const { raw, sig } = signed(body);
    const [a, b] = await Promise.all([1, 2].map(() => h.call('POST', '/webhooks/payments/mock', undefined, raw, { 'x-signature': sig })));
    const results = [a.body.results[0].result, b.body.results[0].result].sort();
    expect(results).toEqual(['confirmed', 'duplicate']);
    const after = (await h.call('GET', `/bills/${bill.id}`, cashier)).body;
    expect(after).toMatchObject({ status: 'PAID', paid: payment.amount });
  });

  it('chữ ký sai → 401 và vẫn lưu payload để truy vết', async () => {
    const r = await h.call('POST', '/webhooks/payments/mock', undefined, JSON.stringify({ transactions: [] }), { 'x-signature': 'deadbeef' });
    expect(r.status).toBe(401);
    expect(await h.prisma.webhookLog.count({ where: { signatureOk: false } })).toBeGreaterThan(0);
  });

  it('sai số tiền → không ghi nhận', async () => {
    const { bill, payment } = await pendingQr('MC02');
    const r = await h.call('POST', '/dev/mock-bank/transactions', cashier, { amount: payment.amount - 1000, content: bill.number });
    expect(r.body.result.results[0].result).toBe('amount_mismatch');
  });

  it('webhook không đến → tác vụ đối soát tự hỏi lại và cập nhật', async () => {
    const { bill, payment } = await pendingQr('MC03');
    await h.call('POST', '/dev/mock-bank/transactions', cashier, { amount: payment.amount, content: `Thanh toan ${bill.number}`, deliverWebhook: false });
    expect((await h.call('GET', `/bills/${bill.id}`, cashier)).body.status).toBe('LOCKED');
    const r = await h.call('POST', '/payments/reconcile', manager);
    expect(r.body.confirmed).toBeGreaterThanOrEqual(1);
    expect((await h.call('GET', `/bills/${bill.id}`, cashier)).body.status).toBe('PAID');
  });
});
