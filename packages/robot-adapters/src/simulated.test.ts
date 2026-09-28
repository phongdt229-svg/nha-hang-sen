import { describe, expect, it } from 'vitest';
import { SimulatedAdapter, type RobotEvent } from './index';

const fast = () => new SimulatedAdapter({ toPickupMs: 30, travelMs: () => 40, returnMs: 30, tickMs: 10 });
const until = (events: RobotEvent[], type: RobotEvent['type']) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const check = () => (events.some((e) => e.type === type) ? resolve() : Date.now() - t0 > 2000 ? reject(new Error(type)) : setTimeout(check, 5));
    check();
  });

describe('SimulatedAdapter', () => {
  it('chạy trọn chuyến: tới bếp → giao → khách nhận → về', async () => {
    const a = fast();
    a.register('R1');
    const ev: RobotEvent[] = [];
    a.onSuKien((e) => ev.push(e));
    await a.denDiemLayMon('R1', 'TR1');
    await until(ev, 'AT_PICKUP');
    await a.giaoMon('R1', { tripId: 'TR1', banDich: 'T05', mon: ['Phở'] });
    await until(ev, 'ARRIVED');
    await a.xacNhanDaNhan('R1', 'TR1');
    await until(ev, 'DONE');
    expect(ev.filter((e) => e.type !== 'STATUS').map((e) => e.type)).toEqual(['AT_PICKUP', 'MOVING', 'ARRIVED', 'DELIVERED', 'RETURNING', 'DONE']);
    expect((await a.layTrangThai('R1')).battery).toBe(97);
  });

  it('không giao khi chưa tới bếp; robot kẹt → FAILED', async () => {
    const a = fast();
    a.register('R1');
    const ev: RobotEvent[] = [];
    a.onSuKien((e) => ev.push(e));
    await expect(a.giaoMon('R1', { tripId: 'TR1', banDich: 'T01', mon: [] })).rejects.toThrow();
    await a.denDiemLayMon('R1', 'TR1');
    await until(ev, 'AT_PICKUP');
    await a.giaoMon('R1', { tripId: 'TR1', banDich: 'T01', mon: [] });
    a.inject('R1', 'bi_ket');
    expect(ev.at(-1)).toMatchObject({ type: 'FAILED', tripId: 'TR1' });
  });
});
