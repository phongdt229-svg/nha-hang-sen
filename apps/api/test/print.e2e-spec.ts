import { key, sessionWithOrder, startApp, waitFor, type Harness } from './harness';

/** In phiếu qua print agent (mục 13.4, 15): máy in hết giấy / mất kết nối → lệnh nằm trong hàng đợi, POS báo lỗi. */
describe('Print agent', () => {
  let h: Harness;
  let manager: string, cashier: string, agent: string;

  beforeAll(async () => {
    h = await startApp();
    [manager, cashier] = await Promise.all([h.login('quanly'), h.login('thungan')]);
    const { code } = (await h.call('POST', '/devices/pairing-codes', manager, { kind: 'PRINTER' })).body;
    agent = (await h.call('POST', '/devices/pair', undefined, { code, name: 'Agent test' })).body.token;
  });
  afterAll(() => h.close());

  const poll = (printers: { target: string; state: string; error?: string }[]) => h.call('POST', '/print/agent/poll', agent, { printers });
  const status = async () => (await h.call('GET', '/print/status', cashier)).body as { printers: any[]; pending: any[] };
  const test = (target: string) => h.call('POST', `/printers/${target}/test`, cashier, undefined, { 'idempotency-key': key() });

  /** Lấy hết lệnh đang chờ của một máy (dọn lệnh do các test khác sinh ra). */
  async function drain(target: string) {
    for (;;) {
      const { jobs } = (await poll([{ target, state: 'ONLINE' }])).body;
      if (jobs.length === 0) return;
      for (const j of jobs) await h.call('POST', `/print/jobs/${j.id}/done`, agent);
    }
  }

  it('in thử: agent nhận lệnh, báo đã in; báo lại lần hai không lỗi', async () => {
    await drain('TEST1');
    const job = (await test('TEST1')).body;
    expect(job.status).toBe('QUEUED');
    const { jobs } = (await poll([{ target: 'TEST1', state: 'ONLINE' }])).body;
    expect(jobs.map((j: any) => j.id)).toEqual([job.id]);
    expect(jobs[0].document.lines.length).toBeGreaterThan(0);
    // Đã giao cho agent thì lần hỏi sau không giao lại.
    expect((await poll([{ target: 'TEST1', state: 'ONLINE' }])).body.jobs).toHaveLength(0);
    for (let i = 0; i < 2; i++) expect((await h.call('POST', `/print/jobs/${job.id}/done`, agent)).body.status).toBe('DONE');
    expect((await status()).printers.find((p) => p.target === 'TEST1')).toMatchObject({ state: 'ONLINE', stale: false });
  });

  it('máy in hết giấy → lệnh nằm lại hàng đợi, POS thấy lỗi; thay giấy xong in tiếp', async () => {
    await drain('RECEIPT');
    const { session } = await sessionWithOrder(h, manager, [{ code: 'MC02', qty: 1 }]);
    const bill = (await h.call('GET', `/sessions/${session.id}/bill`, cashier)).body;
    const job = (await h.call('POST', `/bills/${bill.id}/print`, cashier, undefined, { 'idempotency-key': key() })).body;

    expect((await poll([{ target: 'RECEIPT', state: 'PAPER_OUT', error: 'Máy in hết giấy' }])).body.jobs).toHaveLength(0);
    let s = await status();
    expect(s.printers.find((p) => p.target === 'RECEIPT')).toMatchObject({ state: 'PAPER_OUT', lastError: 'Máy in hết giấy' });
    expect(s.pending.find((j) => j.id === job.id)).toMatchObject({ status: 'QUEUED' });

    // Agent tưởng máy sẵn sàng nhưng in lỗi giữa chừng.
    const got = (await poll([{ target: 'RECEIPT', state: 'ONLINE' }])).body.jobs;
    expect(got.map((j: any) => j.id)).toContain(job.id);
    const failed = (await h.call('POST', `/print/jobs/${job.id}/failed`, agent, { state: 'PAPER_OUT', error: 'Hết giấy khi đang in' })).body;
    expect(failed).toMatchObject({ status: 'QUEUED', attempts: 1, error: 'Hết giấy khi đang in' });

    const again = (await poll([{ target: 'RECEIPT', state: 'ONLINE' }])).body.jobs;
    expect(again.map((j: any) => j.id)).toContain(job.id);
    expect(again.find((j: any) => j.id === job.id).document.lines.some((l: any) => l.kind === 'text' && /TẠM TÍNH/.test(l.text))).toBe(true);
    await h.call('POST', `/print/jobs/${job.id}/done`, agent);
    s = await status();
    expect(s.pending.some((j) => j.id === job.id)).toBe(false);
  });

  it('agent treo sau khi nhận lệnh → hết hạn giữ lệnh thì giao lại', async () => {
    await drain('TEST2');
    const job = (await test('TEST2')).body;
    expect((await poll([{ target: 'TEST2', state: 'ONLINE' }])).body.jobs).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 500));
    const again = (await poll([{ target: 'TEST2', state: 'ONLINE' }])).body.jobs;
    expect(again.map((j: any) => j.id)).toEqual([job.id]);
    await h.call('POST', `/print/jobs/${job.id}/done`, agent);
  });

  it('KDS không nhận phiếu (FALLBACK) → tự in phiếu giấy ở trạm bếp, không in trùng', async () => {
    const { order } = await sessionWithOrder(h, manager, [{ code: 'KV02', qty: 2 }]);
    const s = await waitFor(status, (x) => x.pending.some((j) => j.kind === 'KITCHEN_TICKET' && j.target === 'BEP_NONG' && j.title.includes(order.number)));
    const job = s.pending.find((j) => j.title.includes(order.number))!;
    expect(await h.prisma.printJob.count({ where: { refType: 'kitchen_ticket', title: { contains: order.number }, kind: 'KITCHEN_TICKET' } })).toBe(1);
    // Hàng đợi bếp có thể còn phiếu dự phòng của các file test khác; agent in lần lượt đến phiếu này.
    let printed: any;
    while (!printed) {
      const { jobs } = (await poll([{ target: 'BEP_NONG', state: 'ONLINE' }])).body;
      expect(jobs.length).toBeGreaterThan(0);
      printed = jobs.find((j: any) => j.id === job.id);
      for (const j of jobs) await h.call('POST', `/print/jobs/${j.id}/done`, agent);
    }
    expect(printed.document.beep).toBe(true);
    expect(printed.document.lines.some((l: any) => l.kind === 'text' && l.text.includes('2 x Nem rán'))).toBe(true);
  });

  it('hủy lệnh in; phân quyền agent và nhân viên tách biệt', async () => {
    const job = (await test('TEST3')).body;
    expect((await h.call('POST', `/print/jobs/${job.id}/cancel`, cashier)).body.status).toBe('CANCELLED');
    expect((await h.call('POST', `/print/jobs/${job.id}/cancel`, cashier)).status).toBe(409);
    expect((await poll([{ target: 'TEST3', state: 'ONLINE' }])).body.jobs).toHaveLength(0);
    expect((await h.call('POST', '/print/agent/poll', cashier, { printers: [] })).status).toBe(403);
    expect((await h.call('GET', '/print/status', agent)).status).toBe(403);
    expect((await h.call('POST', '/printers/TEST3/test', cashier)).status).toBe(400);
  });
});
