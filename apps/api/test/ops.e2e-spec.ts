import { sessionWithOrder, startApp, waitFor, type Harness } from './harness';

/** Sprint 7: giám sát (Prometheus), sẵn sàng phục vụ, cảnh báo không gửi lặp (mục 13.7). */
describe('Giám sát & cảnh báo', () => {
  let h: Harness;
  let manager: string, kitchen: string, agent: string;

  beforeAll(async () => {
    h = await startApp();
    [manager, kitchen] = await Promise.all([h.login('quanly'), h.login('bep')]);
    const { code } = (await h.call('POST', '/devices/pairing-codes', manager, { kind: 'PRINTER' })).body;
    agent = (await h.call('POST', '/devices/pair', undefined, { code, name: 'Agent giám sát' })).body.token;
  });
  afterAll(() => h.close());

  const metricsText = async () => (await h.call('GET', '/metrics')).body.toString('utf8') as string;
  const value = (text: string, series: string) => {
    const line = text.split('\n').find((l) => l.startsWith(series + ' '));
    return line ? Number(line.slice(series.length + 1)) : undefined;
  };

  it('sẵn sàng phục vụ khi PostgreSQL và Redis hoạt động', async () => {
    const r = await h.call('GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, postgres: true, redis: true });
  });

  it('/metrics có độ trễ API, độ trễ order → KDS ACK, trạng thái phụ thuộc', async () => {
    const { order } = await sessionWithOrder(h, manager, [{ code: 'MC05', qty: 1 }]);
    const [ticket] = await waitFor(
      async () => ((await h.call('GET', '/kitchen/tickets?station=BEP_NONG', kitchen)).body as any[]).filter((t) => t.orderId === order.id),
      (t) => t.length === 1,
    );
    await h.call('POST', `/kitchen/tickets/${ticket.id}/ack`, kitchen);

    const text = await waitFor(metricsText, (t) => t.includes('nhs_orders_confirmed_total'));
    expect(text).toContain('# TYPE nhs_http_request_duration_seconds histogram');
    expect(text).toMatch(/nhs_http_request_duration_seconds_bucket\{method="POST",route="\/sessions\/:id\/orders",status="201",le="0.5"\} \d+/);
    expect(text).toMatch(/nhs_kds_ack_latency_seconds_count\{station="BEP_NONG",via="(kds|manual)"\} [1-9]/);
    expect(value(text, 'nhs_dependency_up{dependency="postgres"}')).toBe(1);
    expect(value(text, 'nhs_dependency_up{dependency="redis"}')).toBe(1);
    expect(text).toMatch(/nhs_queue_jobs\{queue="kitchen",state="waiting"\} \d+/);
    expect(text).toMatch(/nhs_tables\{status="DINING"\} [1-9]/);
  });

  it('METRICS_TOKEN: không có token thì bị từ chối', async () => {
    process.env.METRICS_TOKEN = 'bi-mat-prometheus';
    try {
      expect((await h.call('GET', '/metrics')).status).toBe(401);
      const ok = await h.call('GET', '/metrics', 'bi-mat-prometheus');
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  it('máy in hết giấy → cảnh báo một lần, không nhắc lại mỗi phút; khắc phục → báo đã khắc phục', async () => {
    const poll = (state: string) => h.call('POST', '/print/agent/poll', agent, { printers: [{ target: 'OPS1', state, error: state === 'PAPER_OUT' ? 'Máy in hết giấy' : null }] });
    await poll('PAPER_OUT');
    const first = (await h.call('POST', '/ops/watchdog', manager)).body;
    expect(first.firing).toContain('printer:OPS1');
    expect(first.sent).toContain('printer:OPS1');
    expect((await h.call('GET', '/ops/alerts', manager)).body.some((a: any) => a.key === 'printer:OPS1' && a.text.includes('hết giấy'))).toBe(true);

    await poll('PAPER_OUT');
    const second = (await h.call('POST', '/ops/watchdog', manager)).body;
    expect(second.firing).toContain('printer:OPS1');
    expect(second.sent).not.toContain('printer:OPS1');

    await poll('ONLINE');
    const third = (await h.call('POST', '/ops/watchdog', manager)).body;
    expect(third.firing).not.toContain('printer:OPS1');
    expect(third.sent).toContain('resolved:printer:OPS1');
  });

  it('chỉ quản lý xem được cảnh báo', async () => {
    expect((await h.call('GET', '/ops/alerts', kitchen)).status).toBe(403);
  });
});
