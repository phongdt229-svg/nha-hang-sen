import { describe, expect, it } from 'vitest';
import { locationMap, MbotV1Adapter, memoryMbotLinkPair, type MbotCommand, type MbotMessage, type RobotEvent } from './index';

const SA_BAN = locationMap({ KITCHEN_PASS_01: 0, ROBOT_HOME: 0, TABLE_T01: 1, TABLE_T02: 2, CHARGER_01: 5 }, ['KITCHEN_PASS_01']);

function setup(opts: { ack?: boolean } = {}) {
  const { adapterSide, robotSide } = memoryMbotLinkPair();
  const a = new MbotV1Adapter(adapterSide, { ackTimeoutMs: 80 });
  a.setLocations(SA_BAN);
  const cmds: MbotCommand[] = [];
  const ev: RobotEvent[] = [];
  a.onEvent((e) => ev.push(e));
  robotSide.onCommand((_id, cmd) => {
    cmds.push(cmd);
    if (opts.ack !== false) robotSide.publish('mbot-01', { type: 'ack', id: cmd.id, ok: true });
  });
  const say = (msg: MbotMessage) => robotSide.publish('mbot-01', msg);
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { a, cmds, ev, say, tick };
}

describe('MbotV1Adapter', () => {
  it('dịch mã vị trí sang số vạch dừng; robot xác nhận lệnh', async () => {
    const { a, cmds } = setup();
    await a.goTo('mbot-01', 'TABLE_T02', { taskId: 'D1', purpose: 'DELIVERY' });
    expect(cmds[0]).toMatchObject({ cmd: 'GOTO', stop: 2, taskId: 'D1', purpose: 'DELIVERY' });
    await a.returnHome('mbot-01', { taskId: 'D1' });
    expect(cmds[1]).toMatchObject({ cmd: 'GOTO', stop: 0, purpose: 'HOME' });
  });

  it('vị trí chưa có vạch dừng trên sa bàn → từ chối, không gửi lệnh', async () => {
    const { a, cmds } = setup();
    await expect(a.goTo('mbot-01', 'TABLE_T09', { taskId: 'D1', purpose: 'DELIVERY' })).rejects.toThrow('vạch dừng');
    expect(cmds).toHaveLength(0);
  });

  it('robot không xác nhận lệnh trong hạn → lỗi quá thời gian (để gateway thử lại)', async () => {
    const { a } = setup({ ack: false });
    await expect(a.pause('mbot-01')).rejects.toMatchObject({ timeout: true });
  });

  it('chuẩn hóa sự kiện: tới vạch theo mục đích lệnh, vật cản, nút bấm, mất kết nối', async () => {
    const { a, ev, say, tick } = setup();
    say({ type: 'status', online: true, stop: 0, mode: 'IDLE', battery: 90, batterySimulated: true, taskId: null, target: null });
    say({ type: 'event', ev: 'ARRIVED', stop: 0, taskId: 'D1', purpose: 'PICKUP' });
    say({ type: 'event', ev: 'ARRIVED', stop: 1, taskId: 'D1', purpose: 'DELIVERY' });
    say({ type: 'event', ev: 'OBSTACLE', taskId: 'D1' });
    say({ type: 'event', ev: 'BUTTON', taskId: 'D1' });
    say({ type: 'event', ev: 'ARRIVED', stop: 0, taskId: 'D1', purpose: 'HOME' });
    say({ type: 'status', online: false, stop: null, mode: 'IDLE', battery: 90, batterySimulated: true, taskId: null, target: null });
    await tick();
    const main = ev.filter((e) => e.type !== 'ROBOT_HEARTBEAT');
    expect(main.map((e) => e.type)).toEqual([
      'ROBOT_ONLINE',
      'ROBOT_ARRIVED_PICKUP',
      'ROBOT_ARRIVED_TABLE',
      'ROBOT_OBSTACLE',
      'ROBOT_CUSTOMER_CONFIRMED',
      'ROBOT_ARRIVED_HOME',
      'ROBOT_TASK_COMPLETED',
      'ROBOT_OFFLINE',
    ]);
    expect(main[2]).toMatchObject({ location: 'TABLE_T01', taskId: 'D1' });
    expect(main[1]).toMatchObject({ location: 'KITCHEN_PASS_01' });
    expect((await a.getStatus('mbot-01')).online).toBe(false);
  });
});
