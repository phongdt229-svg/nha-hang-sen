import type { DomainEvent } from '@nhs/types';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE } from './api';
import { storage } from './storage';

export interface RealtimeOptions {
  token: string | null;
  /** Khóa lưu lastEventId, riêng cho từng màn hình. */
  storageKey: string;
  /** Trạm bếp (khi đăng nhập bằng tài khoản bếp thay vì thiết bị KDS). */
  station?: string;
}

/** Nghe thêm các kênh dữ liệu tức thời không lưu sổ (vd. "robot.telemetry"). */
export type VolatileListeners = Record<string, (payload: never) => void>;

/**
 * Kết nối WebSocket và bảo đảm không lỡ sự kiện (mục 13.2):
 * mỗi lần (re)connect gọi GET /events?after=lastEventId để lấy phần bị lỡ,
 * sự kiện có seq đã xử lý thì bỏ qua.
 */
export function useRealtime(opts: RealtimeOptions, onEvent: (e: DomainEvent) => void, volatile?: VolatileListeners) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const extra = useRef(volatile);
  extra.current = volatile;

  useEffect(() => {
    if (!opts.token) return;
    const lastKey = `nhs.lastEventId.${opts.storageKey}`;
    const stored = storage.get(lastKey);
    let last = Number(stored ?? 0);
    let catchingUp: Promise<void> = Promise.resolve();
    const auth = { headers: { authorization: `Bearer ${opts.token}` } };

    const deliver = (e: DomainEvent) => {
      if (e.seq <= last) return;
      last = e.seq;
      storage.set(lastKey, String(last));
      handler.current(e);
    };

    const catchUp = async () => {
      try {
        if (stored === null && last === 0) {
          // Lần đầu mở màn hình: dữ liệu đã tải qua API, chỉ cần mốc hiện tại.
          const res = await fetch(`${API_BASE}/events/head`, auth);
          if (!res.ok) return;
          last = (await res.json()).seq;
          storage.set(lastKey, String(last));
          return;
        }
        for (;;) {
          const q = new URLSearchParams({ after: String(last), ...(opts.station ? { station: opts.station } : {}) });
          const res = await fetch(`${API_BASE}/events?${q}`, auth);
          if (!res.ok) return;
          const events: DomainEvent[] = await res.json();
          events.forEach(deliver);
          if (events.length < 500) return;
        }
      } catch {
        /* sẽ thử lại ở lần kết nối sau */
      }
    };

    const socket = io({ path: '/socket.io', auth: { token: opts.token, station: opts.station }, transports: ['websocket'] });
    socket.on('connect', () => {
      setConnected(true);
      catchingUp = catchUp();
    });
    socket.on('disconnect', () => setConnected(false));
    // Sự kiện trực tiếp đến trong lúc đang bắt kịp: xử lý sau để giữ đúng thứ tự seq.
    socket.on('event', (e: DomainEvent) => void catchingUp.then(() => deliver(e)));
    socket.onAny((name: string, payload: unknown) => {
      if (name !== 'event') (extra.current?.[name] as ((p: unknown) => void) | undefined)?.(payload);
    });
    return () => {
      socket.disconnect();
    };
  }, [opts.token, opts.storageKey, opts.station]);

  return connected;
}
