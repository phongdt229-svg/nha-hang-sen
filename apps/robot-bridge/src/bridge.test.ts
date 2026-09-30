import { locationMap, MbotV1Adapter, memoryMbotLinkPair, type RobotEvent } from '@nhs/robot-adapters';
import { afterEach, describe, expect, it } from 'vitest';
import { RobotBridge, type BridgeLink } from './bridge';
import { encode, parse, shortId } from './protocol';
import { VirtualMbot } from './virtual-mbot';

const SA_BAN = locationMap({ KITCHEN_PASS_01: 0, ROBOT_HOME: 0, TABLE_T01: 1, TABLE_T02: 2, TABLE_T03: 3, TABLE_T04: 4, CHARGER_01: 5 }, ['KITCHEN_PASS_01']);

describe('giao thức serial', () => {
  it('mã hóa lệnh, đọc dòng robot; bỏ qua nhiễu', () => {
    expect(encode({ op: 'G', stop: 3, cid: 'abc' })).toBe('G 3 abc\n');
    expect(encode({ op: 'Q' })).toBe('Q\n');
    expect(parse('ST 2 M -1')).toEqual({ op: 'ST', stop: 2, mode: 'M', mv: -1 });
    expect(parse('ARR 4\r')).toEqual({ op: 'ARR', stop: 4 });
    expect(parse('ERR c1 vach khong hop le')).toEqual({ op: 'ERR', cid: 'c1', reason: 'vach khong hop le' });
    expect(parse('ST x M 1')).toBeNull();
    expect(parse('@@#!')).toBeNull();
    expect(shortId('c1abc.def/ghi-jkl')).toHaveLength(12);
  });
});

/** Chuỗi đầy đủ trong bộ nhớ: Robot Gateway (MbotV1Adapter) ↔ bridge ↔ mBot ảo. */
function setup() {
  const { adapterSide, robotSide } = memoryMbotLinkPair();
  const adapter = new MbotV1Adapter(adapterSide, { ackTimeoutMs: 300 });
  adapter.setLocations(SA_BAN);
  const link: BridgeLink = { publish: (msg) => robotSide.publish('mbot-01', msg), onCommand: (h) => robotSide.onCommand((_id, cmd) => h(cmd)) };
  const mbot = new VirtualMbot({ segmentMs: 30, statusMs: 40 });
  const bridge = new RobotBridge(link, mbot, { statusMs: 40, serialTimeoutMs: 200, drainPerStop: 1 });
  const ev: RobotEvent[] = [];
  adapter.onEvent((e) => ev.push(e));
  const until = (type: RobotEvent['type'], from = 0) =>
    new Promise<RobotEvent>((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        const hit = ev.slice(from).find((e) => e.type === type);
        if (hit) resolve(hit);
        else if (Date.now() - t0 > 3000) reject(new Error(`Không thấy ${type}`));
        else setTimeout(check, 5);
      };
      check();
    });
  return { adapter, bridge, mbot, ev, until };
}

describe('robot bridge + mBot ảo', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it('trọn chuyến theo sa bàn: bếp → BÀN 3 → khách bấm nút → về gốc, pin giả lập tụt theo quãng đường', async () => {
    const s = setup();
    cleanup.push(() => s.bridge.close());
    await s.until('ROBOT_ONLINE');
    await s.adapter.goTo('mbot-01', 'KITCHEN_PASS_01', { taskId: 'DT0001', purpose: 'PICKUP' });
    expect(await s.until('ROBOT_ARRIVED_PICKUP')).toMatchObject({ taskId: 'DT0001', location: 'KITCHEN_PASS_01' });
    await s.adapter.goTo('mbot-01', 'TABLE_T03', { taskId: 'DT0001', purpose: 'DELIVERY' });
    expect(await s.until('ROBOT_ARRIVED_TABLE')).toMatchObject({ taskId: 'DT0001', location: 'TABLE_T03' });
    s.mbot.pressButton();
    expect(await s.until('ROBOT_CUSTOMER_CONFIRMED')).toMatchObject({ taskId: 'DT0001' });
    await s.adapter.returnHome('mbot-01', { taskId: 'DT0001' });
    // Chạy một chiều: BÀN 3 → BÀN 4 → TRẠM SẠC → BẾP.
    expect(await s.until('ROBOT_TASK_COMPLETED')).toMatchObject({ taskId: 'DT0001', location: 'KITCHEN_PASS_01' });
    await new Promise((r) => setTimeout(r, 60)); // chờ một nhịp trạng thái sau khi robot về
    const st = await s.adapter.getStatus('mbot-01');
    expect(st).toMatchObject({ online: true, batterySimulated: true, mode: 'IDLE', taskId: null });
    expect(st.battery).toBe(94);
  });

  it('nút bấm khi robot không đứng chờ ở bàn thì bỏ qua', async () => {
    const s = setup();
    cleanup.push(() => s.bridge.close());
    await s.until('ROBOT_ONLINE');
    s.mbot.pressButton();
    await new Promise((r) => setTimeout(r, 60));
    expect(s.ev.some((e) => e.type === 'ROBOT_CUSTOMER_CONFIRMED')).toBe(false);
  });

  it('vật cản trước siêu âm: robot dừng, báo OBSTACLE; bỏ vật cản rồi gửi lại lệnh thì tới bàn', async () => {
    const s = setup();
    cleanup.push(() => s.bridge.close());
    await s.until('ROBOT_ONLINE');
    await s.adapter.goTo('mbot-01', 'TABLE_T04', { taskId: 'DT0002', purpose: 'DELIVERY' });
    await new Promise((r) => setTimeout(r, 45));
    s.mbot.setObstacle(true);
    await s.until('ROBOT_OBSTACLE');
    s.mbot.setObstacle(false);
    await s.until('ROBOT_OBSTACLE_CLEARED');
    const n = s.ev.length;
    await s.adapter.goTo('mbot-01', 'TABLE_T04', { taskId: 'DT0002', purpose: 'DELIVERY' });
    expect(await s.until('ROBOT_ARRIVED_TABLE', n)).toMatchObject({ location: 'TABLE_T04' });
  });

  it('giả lập lỗi ở bridge: lỗi API → lệnh không được xác nhận; mất kết nối → ngừng báo trạng thái; khôi phục', async () => {
    const s = setup();
    cleanup.push(() => s.bridge.close());
    await s.until('ROBOT_ONLINE');
    await s.adapter.simulate('mbot-01', 'API_TIMEOUT');
    await new Promise((r) => setTimeout(r, 20));
    await expect(s.adapter.pause('mbot-01')).rejects.toMatchObject({ timeout: true });
    await expect(s.adapter.pause('mbot-01')).resolves.toBeUndefined();

    await s.adapter.simulate('mbot-01', 'OFFLINE');
    await new Promise((r) => setTimeout(r, 30));
    const n = s.ev.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(s.ev.length).toBe(n);
    await expect(s.adapter.goTo('mbot-01', 'TABLE_T01', { taskId: 'DT0003', purpose: 'DELIVERY' })).rejects.toMatchObject({ timeout: true });

    await s.adapter.simulate('mbot-01', 'RECOVER');
    await s.until('ROBOT_HEARTBEAT', n);
    await s.adapter.simulate('mbot-01', 'LOW_BATTERY');
    await new Promise((r) => setTimeout(r, 60));
    expect((await s.adapter.getStatus('mbot-01')).battery).toBe(12);
  });

  it('robot im lặng (rút cáp, mất Bluetooth) → bridge báo offline cho API', async () => {
    const s = setup();
    cleanup.push(() => s.bridge.close());
    await s.until('ROBOT_ONLINE');
    await s.mbot.close(); // mBot ngừng gửi ST
    await s.until('ROBOT_OFFLINE');
    expect((await s.adapter.getStatus('mbot-01')).online).toBe(false);
  });

  it('vạch không có trên sa bàn → robot báo ERR, lệnh bị từ chối', async () => {
    const s = setup();
    cleanup.push(() => s.bridge.close());
    await s.until('ROBOT_ONLINE');
    s.adapter.setLocations(locationMap({ KITCHEN_PASS_01: 0, TABLE_T09: 9 }));
    await expect(s.adapter.goTo('mbot-01', 'TABLE_T09', { taskId: 'DT0004', purpose: 'DELIVERY' })).rejects.toThrow('vach');
  });
});
