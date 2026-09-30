import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, DELIVERY_STATUSES, DELIVERY_TRANSITIONS, InvalidTransitionError, ORDER_ITEM_TRANSITIONS, TABLE_TRANSITIONS } from './states';

describe('máy trạng thái', () => {
  it('cho phép vòng đời bàn chuẩn', () => {
    expect(canTransition(TABLE_TRANSITIONS, 'AVAILABLE', 'DINING')).toBe(true);
    expect(canTransition(TABLE_TRANSITIONS, 'DINING', 'PAYMENT')).toBe(true);
    expect(canTransition(TABLE_TRANSITIONS, 'PAYMENT', 'CLEANING')).toBe(true);
    expect(canTransition(TABLE_TRANSITIONS, 'CLEANING', 'AVAILABLE')).toBe(true);
  });

  it('từ chối Delivered quay về Preparing', () => {
    expect(() => assertTransition('món', ORDER_ITEM_TRANSITIONS, 'DELIVERED', 'PREPARING')).toThrow(
      InvalidTransitionError,
    );
  });

  it('không cho hủy món sau khi Ready', () => {
    expect(canTransition(ORDER_ITEM_TRANSITIONS, 'READY', 'CANCELLED')).toBe(false);
  });

  it('delivery task: luồng chính đi hết, không bỏ bước xác nhận khách (MB-14)', () => {
    const happy = ['PENDING', 'ASSIGNED', 'ROBOT_ACCEPTED', 'GOING_TO_PICKUP', 'ARRIVED_PICKUP', 'LOADING', 'GOING_TO_TABLE', 'ARRIVED_TABLE', 'WAITING_CUSTOMER', 'DELIVERED', 'RETURNING', 'COMPLETED'] as const;
    for (let i = 1; i < happy.length; i++) expect(canTransition(DELIVERY_TRANSITIONS, happy[i - 1], happy[i])).toBe(true);
    expect(canTransition(DELIVERY_TRANSITIONS, 'ARRIVED_TABLE', 'DELIVERED')).toBe(false);
  });

  it('delivery task: FAILED chỉ thoát bằng retry/reassign/giao tay/hủy; trạng thái cuối không đi đâu nữa', () => {
    expect(canTransition(DELIVERY_TRANSITIONS, 'FAILED', 'GOING_TO_TABLE')).toBe(true);
    expect(canTransition(DELIVERY_TRANSITIONS, 'FAILED', 'PENDING')).toBe(true);
    expect(canTransition(DELIVERY_TRANSITIONS, 'FAILED', 'COMPLETED')).toBe(false);
    for (const s of ['COMPLETED', 'CANCELLED', 'MANUAL_TAKEOVER'] as const) expect(DELIVERY_TRANSITIONS[s]).toEqual([]);
    for (const s of DELIVERY_STATUSES) for (const to of DELIVERY_TRANSITIONS[s]) expect(DELIVERY_STATUSES).toContain(to);
  });
});
