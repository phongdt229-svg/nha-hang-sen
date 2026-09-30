import { MqttBridgeLink, RobotBridge, VirtualMbot } from '@nhs/robot-bridge';
import { key, startApp, waitFor, type Harness } from './harness';

/**
 * mBot v1 demo đầu–cuối (MB-22): API (MbotV1Adapter) ↔ MQTT (mosquitto tại quán) ↔ robot bridge ↔ mBot ảo
 * chạy theo sa bàn A1. Cần MQTT broker ở localhost:1883 (`pnpm infra:up`).
 */
const MQTT_URL = process.env.TEST_MQTT_URL ?? 'mqtt://localhost:1883';

describe('mBot v1 qua robot bridge', () => {
  let h: Harness;
  let manager: string, kitchen: string;
  let bridge: RobotBridge;
  let mbot: VirtualMbot;
  let mbotId: string;
  let sims: string[] = [];
  let tableId: string;

  const start = async () => {
    process.env.MQTT_URL = MQTT_URL;
    h = await startApp();
    [manager, kitchen] = await Promise.all([h.login('quanly'), h.login('bep')]);
  };

  beforeAll(async () => {
    // Bàn demo: một bàn trống bất kỳ gắn vào vạch 2 trên sa bàn (bỏ mapping mặc định của BÀN 2).
    await start();
    const table = ((await h.call('GET', '/tables', manager)).body as any[]).find((t) => t.status === 'AVAILABLE');
    tableId = table.id;
    await h.prisma.robotLocation.updateMany({ where: { code: 'TABLE_T02' }, data: { vendorMapping: {} } });
    await h.prisma.robotLocation.update({ where: { code: `TABLE_${table.code}` }, data: { vendorMapping: { MAKEBLOCK: { stop: 2 } } } });
    await h.close();
    await start();

    mbot = new VirtualMbot({ segmentMs: 250, statusMs: 100 });
    bridge = new RobotBridge(new MqttBridgeLink(MQTT_URL, 'mbot-01'), mbot, { statusMs: 100 });
    const robots = (await h.call('GET', '/internal/robots', manager)).body as any[];
    mbotId = robots.find((r) => r.code === 'R01').id;
    // Tắt robot giả lập để chỉ mBot nhận task.
    sims = robots.filter((r) => r.vendor === 'SIMULATED').map((r) => r.id);
    for (const id of sims) await h.call('PATCH', `/internal/robots/${id}`, manager, { enabled: false });
    await waitFor(async () => (await h.call('GET', '/internal/robots', manager)).body.find((r: any) => r.id === mbotId), (r) => r.online && r.state === 'IDLE');
  });

  afterAll(async () => {
    for (const id of sims) await h.call('PATCH', `/internal/robots/${id}`, manager, { enabled: true });
    await bridge.close();
    await h.close();
    delete process.env.MQTT_URL;
  });

  async function orderReady() {
    let session = (await h.call('POST', '/sessions', manager, { tableId, guests: 2 })).body;
    if (!session.id) {
      // Bàn đang dùng từ lần chạy trước: lấy phiên hiện tại.
      const t = ((await h.call('GET', '/tables', manager)).body as any[]).find((x) => x.id === tableId);
      session = { id: t.sessionId };
    }
    const menu = (await h.call('GET', '/menu', manager)).body.items as any[];
    const order = (await h.call('POST', `/sessions/${session.id}/orders`, manager, { items: [{ menuItemId: menu.find((m) => m.code === 'MC03').id, qty: 1 }] }, { 'idempotency-key': key() })).body;
    const tickets = await waitFor(
      async () => ((await h.call('GET', '/kitchen/tickets?station=BEP_NONG', kitchen)).body as any[]).filter((t) => t.orderId === order.id),
      (t) => t.length > 0,
    );
    await h.call('POST', `/kitchen/tickets/${tickets[0].id}/ack`, kitchen);
    for (const i of order.items) {
      await h.call('PATCH', `/order-items/${i.id}/status`, kitchen, { status: 'PREPARING' });
      await h.call('PATCH', `/order-items/${i.id}/status`, kitchen, { status: 'READY' });
    }
    return { session, order };
  }

  const taskOf = (sessionId: string, ok: (t: any) => boolean) =>
    waitFor(async () => ((await h.call('GET', `/internal/delivery-tasks?active=false&sessionId=${sessionId}`, manager)).body as any[])[0], (t) => !!t && ok(t), 20000);

  it('happy path trên sa bàn: mBot nhận task, tới bếp, nhân viên xác nhận đặt món, tới bàn, khách bấm nút trên robot, về gốc', async () => {
    const { session } = await orderReady();
    const t = await taskOf(session.id, (x) => x.status === 'ARRIVED_PICKUP');
    expect(t).toMatchObject({ robotCode: 'R01', robotModel: 'MBOT_V1' });
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await taskOf(session.id, (x) => x.status === 'WAITING_CUSTOMER');
    mbot.pressButton();
    const done = await taskOf(session.id, (x) => x.status === 'COMPLETED');
    expect(done.confirmedBy).toBe('ROBOT_BUTTON');
    const r = (await h.call('GET', '/internal/robots', manager)).body.find((x: any) => x.id === mbotId);
    expect(r).toMatchObject({ vendor: 'MAKEBLOCK', telemetrySimulated: true, location: 'KITCHEN_PASS_01' });
    expect(r.battery).toBeLessThan(100);
  });

  it('server khởi động lại khi mBot đang giao: robot vẫn chạy, API đối chiếu rồi giao tiếp (MB-21 Scenario 6)', async () => {
    await waitFor(async () => (await h.call('GET', '/internal/robots', manager)).body.find((r: any) => r.id === mbotId), (r) => r.state === 'IDLE' && !r.taskId);
    const { session } = await orderReady();
    const t = await taskOf(session.id, (x) => x.status === 'ARRIVED_PICKUP');
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-loaded`, kitchen, {});
    await taskOf(session.id, (x) => x.status === 'GOING_TO_TABLE');
    await h.close();
    await start();
    const waiting = await taskOf(session.id, (x) => x.status === 'WAITING_CUSTOMER');
    expect(waiting.problem).toBeNull();
    const ev = ((await h.call('GET', `/internal/delivery-tasks/${t.id}/events`, manager)).body as any[]).map((e) => e.type);
    expect(ev).toContain('RECONCILED');
    expect(ev).not.toContain('TASK_FAILED');
    await h.call('POST', `/internal/delivery-tasks/${t.id}/confirm-delivered`, manager);
    await taskOf(session.id, (x) => x.status === 'COMPLETED');
  });

  it('mất kết nối bridge → mBot OFFLINE; bridge chạy lại → ONLINE', async () => {
    await h.call('POST', `/internal/robots/${mbotId}/simulate`, manager, { fault: 'OFFLINE' });
    await waitFor(async () => (await h.call('GET', '/internal/robots', manager)).body.find((r: any) => r.id === mbotId), (r) => r.state === 'OFFLINE', 10000);
    await h.call('POST', `/internal/robots/${mbotId}/simulate`, manager, { fault: 'RECOVER' });
    await waitFor(async () => (await h.call('GET', '/internal/robots', manager)).body.find((r: any) => r.id === mbotId), (r) => r.online && r.state === 'IDLE', 10000);
  });
});
