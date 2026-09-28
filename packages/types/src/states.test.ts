import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, InvalidTransitionError, ORDER_ITEM_TRANSITIONS, TABLE_TRANSITIONS } from './states';

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
});
