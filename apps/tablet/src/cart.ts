import { newKey } from '@nhs/ui';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface CartLine {
  menuItemId: string;
  qty: number;
  note: string;
}

interface CartState {
  sessionId: string | null;
  lines: CartLine[];
  /** Khóa idempotency của giỏ hiện tại; chỉ đổi sau khi gửi thành công. */
  key: string;
  /** Đã gửi nhưng chưa biết kết quả (mất mạng): khóa sửa giỏ, gửi lại đúng khóa cũ. */
  pending: boolean;
  bindSession(sessionId: string | null): void;
  add(menuItemId: string): void;
  setQty(menuItemId: string, qty: number): void;
  setNote(menuItemId: string, note: string): void;
  remove(ids: string[]): void;
  setPending(pending: boolean): void;
  submitted(): void;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      sessionId: null,
      lines: [],
      key: newKey(),
      pending: false,
      bindSession: (sessionId) => {
        // Phiên mới (khách mới) thì bỏ giỏ của phiên cũ.
        if (get().sessionId !== sessionId) set({ sessionId, lines: [], key: newKey(), pending: false });
      },
      add: (id) =>
        !get().pending &&
        set((s) => {
          const found = s.lines.find((l) => l.menuItemId === id);
          return {
            lines: found ? s.lines.map((l) => (l === found ? { ...l, qty: Math.min(50, l.qty + 1) } : l)) : [...s.lines, { menuItemId: id, qty: 1, note: '' }],
          };
        }),
      setQty: (id, qty) =>
        !get().pending &&
        set((s) => ({ lines: qty <= 0 ? s.lines.filter((l) => l.menuItemId !== id) : s.lines.map((l) => (l.menuItemId === id ? { ...l, qty: Math.min(50, qty) } : l)) })),
      setNote: (id, note) => !get().pending && set((s) => ({ lines: s.lines.map((l) => (l.menuItemId === id ? { ...l, note } : l)) })),
      remove: (ids) => set((s) => ({ lines: s.lines.filter((l) => !ids.includes(l.menuItemId)), key: newKey(), pending: false })),
      setPending: (pending) => set({ pending }),
      submitted: () => set({ lines: [], key: newKey(), pending: false }),
    }),
    { name: 'nhs.tablet.cart', storage: createJSONStorage(() => localStorage) },
  ),
);
