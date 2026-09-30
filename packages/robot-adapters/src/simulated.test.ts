import { describe, expect, it } from 'vitest';
import { locationMap, SimulatedAdapter, type RobotEvent } from './index';

// Sa bàn A1: vạch 0 = bếp/vị trí gốc, 1–4 = bàn, 5 = trạm sạc; chạy một chiều.
const SA_BAN = locationMap({ KITCHEN_PASS_01: 0, ROBOT_HOME: 0, TABLE_T01: 1, TABLE_T02: 2, TABLE_T03: 3, TABLE_T04: 4, CHARGER_01: 5 }, ['KITCHEN_PASS_01']);

function setup(opts: ConstructorParameters<typeof SimulatedAdapter>[0] = {}) {
  const a = new SimulatedAdapter({ segmentMs: 40, tickMs: 10, heartbeatMs: 50, ...opts });
  a.setLocations(SA_BAN);
  const ev: RobotEvent[] = [];
  a.onEvent((e) => ev.push(e));
  const until = (type: RobotEvent['type'], after = 0) =>
    new Promise<RobotEvent>((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        const hit = ev.slice(after).find((e) => e.type === type);
        if (hit) resolve(hit);
        else if (Date.now() - t0 > 3000) reject(new Error(`Không thấy ${type}`));
        else setTimeout(check, 5);
      };
      check();
    });
  const main = () => ev.filter((e) => !['ROBOT_HEARTBEAT', 'ROBOT_LOCATION_CHANGED', 'ROBOT_BATTERY_CHANGED'].includes(e.type)).map((e) => e.type);
  return { a, ev, until, main };
}

describe('SimulatedAdapter (sa bàn)', () => {
  it('trọn chuyến: nhận task → tới bếp → tới bàn → khách bấm nút → về gốc', async () => {
    const { a, until, main } = setup();
    await a.connect('S1', { location: 'ROBOT_HOME' });
    await a.goTo('S1', 'KITCHEN_PASS_01', { taskId: 'D1', purpose: 'PICKUP' });
    expect((await until('ROBOT_ARRIVED_PICKUP')).location).toBe('KITCHEN_PASS_01');
    await a.goTo('S1', 'TABLE_T03', { taskId: 'D1', purpose: 'DELIVERY' });
    expect((await until('ROBOT_ARRIVED_TABLE')).location).toBe('TABLE_T03');
    await a.simulate('S1', 'BUTTON');
    await until('ROBOT_CUSTOMER_CONFIRMED');
    await a.returnHome('S1', { taskId: 'D1' });
    expect((await until('ROBOT_TASK_COMPLETED')).location).toBe('KITCHEN_PASS_01');
    expect(main()).toEqual(['ROBOT_ONLINE', 'ROBOT_TASK_ACCEPTED', 'ROBOT_ARRIVED_PICKUP', 'ROBOT_ARRIVED_TABLE', 'ROBOT_CUSTOMER_CONFIRMED', 'ROBOT_ARRIVED_HOME', 'ROBOT_TASK_COMPLETED']);
    // Chạy một chiều: từ bàn 3 về bếp phải đi qua bàn 4 và trạm sạc (3 đoạn), pin tụt theo quãng đường.
    expect((await a.getStatus('S1')).battery).toBeLessThan(100);
    await a.close();
  });

  it('nút "đã nhận" chỉ có tác dụng khi robot đứng chờ ở bàn, không phải ở bếp', async () => {
    const { a, until, main } = setup();
    await a.connect('S1');
    await a.goTo('S1', 'KITCHEN_PASS_01', { taskId: 'D1', purpose: 'PICKUP' });
    await a.goTo('S1', 'TABLE_T01', { taskId: 'D1', purpose: 'DELIVERY' });
    await a.simulate('S1', 'BUTTON');
    await until('ROBOT_ARRIVED_TABLE');
    expect(main()).not.toContain('ROBOT_CUSTOMER_CONFIRMED');
    await a.close();
  });

  it('vật cản thoáng qua: dừng, báo OBSTACLE; lệnh đi tiếp thì tới nơi', async () => {
    const { a, until, ev } = setup({ segmentMs: 200 });
    await a.connect('S1');
    await a.goTo('S1', 'TABLE_T04', { taskId: 'D1', purpose: 'DELIVERY' });
    await new Promise((r) => setTimeout(r, 60));
    await a.simulate('S1', 'OBSTACLE');
    const obs = await until('ROBOT_OBSTACLE');
    expect(obs.taskId).toBe('D1');
    expect((await a.getStatus('S1')).mode).toBe('OBSTACLE');
    await a.goTo('S1', 'TABLE_T04', { taskId: 'D1', purpose: 'DELIVERY' });
    await until('ROBOT_ARRIVED_TABLE', ev.indexOf(obs));
    await a.close();
  });

  it('vật cản kẹt hẳn: đi lại vẫn bị chặn; khôi phục thì báo đã thông', async () => {
    const { a, until, ev } = setup({ segmentMs: 200 });
    await a.connect('S1');
    await a.goTo('S1', 'TABLE_T02', { taskId: 'D1', purpose: 'DELIVERY' });
    await a.simulate('S1', 'OBSTACLE_PERSISTENT');
    await until('ROBOT_OBSTACLE');
    const n = ev.length;
    await a.goTo('S1', 'TABLE_T02', { taskId: 'D1', purpose: 'DELIVERY' });
    await until('ROBOT_OBSTACLE', n);
    await a.simulate('S1', 'RECOVER');
    await until('ROBOT_OBSTACLE_CLEARED');
    await a.close();
  });

  it('mất kết nối: lệnh báo quá thời gian, ngừng gửi nhịp; khôi phục thì ONLINE lại', async () => {
    const { a, until, ev } = setup();
    await a.connect('S1');
    await a.simulate('S1', 'OFFLINE');
    await expect(a.goTo('S1', 'TABLE_T01', { taskId: 'D1', purpose: 'DELIVERY' })).rejects.toMatchObject({ timeout: true });
    expect((await a.getStatus('S1')).online).toBe(false);
    const n = ev.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(ev.length).toBe(n);
    await a.simulate('S1', 'RECOVER');
    await until('ROBOT_ONLINE', n);
    await a.close();
  });

  it('lỗi API giả lập: một lần thì lệnh sau thành công; kéo dài thì luôn quá thời gian', async () => {
    const { a } = setup();
    await a.connect('S1');
    await a.simulate('S1', 'API_TIMEOUT');
    await expect(a.pause('S1')).rejects.toMatchObject({ timeout: true });
    await expect(a.pause('S1')).resolves.toBeUndefined();
    await a.simulate('S1', 'API_TIMEOUT_PERSISTENT');
    for (let i = 0; i < 3; i++) await expect(a.resume('S1')).rejects.toThrow();
    await a.close();
  });

  it('về trạm sạc: sạc tới đầy rồi rảnh', async () => {
    const { a, until } = setup({ chargePerSecond: 50 });
    await a.connect('S1', { battery: 40 });
    await a.returnHome('S1', { charge: true });
    expect((await until('ROBOT_ARRIVED_CHARGER')).location).toBe('CHARGER_01');
    await new Promise((r) => setTimeout(r, 1300));
    expect((await a.getStatus('S1')).battery).toBe(100);
    await a.close();
  });
});
