import type { DomainEvent, KitchenTicketDto, MenuItemDto, OrderItemDto } from '@nhs/types';
import {
  Badge,
  Button,
  ConnectionDot,
  createApi,
  errorMessage,
  ITEM_STATUS_LABEL,
  ITEM_STATUS_TONE,
  Logo,
  minutesSince,
  Modal,
  PairScreen,
  storage,
  useRealtime,
  useToast,
  type PairedDevice,
} from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TOKEN_KEY = 'nhs.kds.token';
const DEVICE_KEY = 'nhs.kds.device';
const DONE = new Set(['READY', 'DELIVERED', 'CANCELLED', 'ASSIGNED', 'PICKED_UP']);

export const STATION_LABEL: Record<string, string> = { BEP_NONG: 'Bếp nóng', BEP_LANH: 'Bếp lạnh', QUAY_BAR: 'Quầy bar' };

export function App() {
  const [token, setToken] = useState(() => storage.get(TOKEN_KEY));
  const [device, setDevice] = useState<PairedDevice | null>(() => JSON.parse(storage.get(DEVICE_KEY) ?? 'null'));
  const unpair = useCallback(() => {
    storage.set(TOKEN_KEY, null);
    storage.set(DEVICE_KEY, null);
    setToken(null);
  }, []);

  if (!token || !device?.station) {
    return (
      <PairScreen
        subtitle="Ghép màn hình bếp với trạm"
        onPaired={(t, d) => {
          storage.set(TOKEN_KEY, t);
          storage.set(DEVICE_KEY, JSON.stringify(d));
          setDevice(d);
          setToken(t);
        }}
      />
    );
  }
  return <Kitchen token={token} device={device} station={device.station} onUnauthorized={unpair} />;
}

/** Âm báo bằng Web Audio; trình duyệt chỉ cho phát sau lần chạm đầu tiên. */
function useChime() {
  const ctx = useRef<AudioContext | null>(null);
  const [enabled, setEnabled] = useState(false);
  const enable = () => {
    ctx.current ??= new AudioContext();
    void ctx.current.resume();
    setEnabled(true);
  };
  const play = useCallback(() => {
    const c = ctx.current;
    if (!c) return;
    [0, 0.18].forEach((delay, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.value = i === 0 ? 880 : 1175;
      g.gain.setValueAtTime(0.25, c.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + 0.35);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + delay);
      o.stop(c.currentTime + delay + 0.4);
    });
  }, []);
  return { enabled, enable, play };
}

function Kitchen({ token, device, station, onUnauthorized }: { token: string; device: PairedDevice; station: string; onUnauthorized: () => void }) {
  const api = useMemo(() => createApi(() => token, onUnauthorized), [token, onUnauthorized]);
  const qc = useQueryClient();
  const toast = useToast();
  const chime = useChime();
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  const [, tick] = useState(0);
  const acking = useRef(new Set<string>());
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const tickets = useQuery({ queryKey: ['tickets'], queryFn: () => api.get<KitchenTicketDto[]>('/kitchen/tickets'), refetchInterval: 30_000 });

  /** ACK ngay khi nhận (mục 6.3). Phiếu trùng: không thêm phiếu mới, chỉ gửi lại ACK. */
  const ack = useCallback(
    async (id: string) => {
      if (acking.current.has(id)) return;
      acking.current.add(id);
      try {
        await api.post(`/kitchen/tickets/${id}/ack`);
        void qc.invalidateQueries({ queryKey: ['tickets'] });
      } catch (e) {
        toast.show(errorMessage(e));
      } finally {
        acking.current.delete(id);
      }
    },
    [api, qc, toast.show],
  );

  const connected = useRealtime({ token, storageKey: `kds.${device.id}` }, (e: DomainEvent) => {
    if (e.type === 'kitchen.sent') {
      const t = (e.data as { ticket: KitchenTicketDto }).ticket;
      if (t.station === station) void ack(t.id);
    }
    if (e.type.startsWith('kitchen.') || e.type.startsWith('order.')) void qc.invalidateQueries({ queryKey: ['tickets'] });
    if (e.type.startsWith('menu.')) void qc.invalidateQueries({ queryKey: ['menu'] });
  });

  // Phiếu SENT còn sót (vd. lúc màn hình tắt) thì ACK khi tải lại; phiếu mới thì kêu chuông.
  useEffect(() => {
    if (!tickets.data) return;
    for (const t of tickets.data) if (t.status === 'SENT') void ack(t.id);
    const ids = new Set(tickets.data.map((t) => t.id));
    if (seen.current && [...ids].some((id) => !seen.current!.has(id))) chime.play();
    seen.current = ids;
  }, [tickets.data, ack, chime.play]);

  const active = (tickets.data ?? []).filter((t) => t.items.some((i) => !DONE.has(i.status)));

  async function setStatus(item: OrderItemDto, status: 'PREPARING' | 'READY') {
    try {
      await api.patch(`/order-items/${item.id}/status`, { status });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    } catch (e) {
      toast.show(errorMessage(e));
    }
  }

  return (
    <div className="flex min-h-full flex-col bg-stone-100">
      <header className="flex flex-wrap items-center justify-between gap-3 bg-stone-900 px-4 py-3 text-white">
        <div className="flex items-center gap-4">
          <span className="text-xl font-bold">{STATION_LABEL[station] ?? station}</span>
          <span className="text-stone-400">{active.length} phiếu đang chờ</span>
        </div>
        <div className="flex items-center gap-3">
          {!chime.enabled && (
            <Button size="sm" variant="secondary" onClick={chime.enable}>
              Bật âm báo
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setSoldOutOpen(true)}>
            Báo hết món
          </Button>
          <span className="rounded-lg bg-white/10 px-2 py-1">
            <ConnectionDot connected={connected} />
          </span>
        </div>
      </header>

      {active.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-stone-500">
          <Logo />
          <p>Chưa có phiếu mới.</p>
        </div>
      ) : (
        <main className="grid flex-1 content-start gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {active.map((t) => (
            <TicketCard key={t.id} ticket={t} onAck={() => void ack(t.id)} onStatus={setStatus} />
          ))}
        </main>
      )}

      {soldOutOpen && <SoldOutModal api={api} station={station} onClose={() => setSoldOutOpen(false)} onError={toast.show} />}
      {toast.node}
    </div>
  );
}

function TicketCard({ ticket, onAck, onStatus }: { ticket: KitchenTicketDto; onAck: () => void; onStatus: (i: OrderItemDto, s: 'PREPARING' | 'READY') => void }) {
  const mins = minutesSince(ticket.createdAt);
  const late = mins >= 15;
  const fallback = ticket.status === 'FALLBACK';
  return (
    <article className={`flex flex-col rounded-2xl bg-white shadow-sm ring-2 ${fallback ? 'ring-amber-400' : late ? 'ring-red-400' : 'ring-transparent'}`}>
      <div className={`flex items-center justify-between rounded-t-2xl px-4 py-3 ${late ? 'bg-red-50' : 'bg-stone-50'}`}>
        <div>
          <div className="text-2xl font-bold">{ticket.tableCodes.join(' + ') || '—'}</div>
          <div className="text-sm text-stone-500">Order {ticket.orderNumber}</div>
        </div>
        <div className={`text-right text-lg font-bold ${late ? 'text-red-600' : 'text-stone-600'}`}>{mins} phút</div>
      </div>
      {fallback && (
        <div className="border-y border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-sm text-amber-900">Phiếu đã chuyển in giấy do mất kết nối. Xác nhận nếu bếp đã nhận món này.</p>
          <Button size="sm" className="w-full" onClick={onAck}>
            Bếp đã nhận phiếu
          </Button>
        </div>
      )}
      <ul className="flex-1 divide-y divide-stone-100">
        {ticket.items.map((i) => (
          <li key={i.id} className={`flex items-center justify-between gap-3 px-4 py-3 ${DONE.has(i.status) ? 'opacity-50' : ''}`}>
            <div className="min-w-0">
              <div className={`text-lg font-semibold ${i.status === 'CANCELLED' ? 'line-through' : ''}`}>
                <span className="text-sen-700">{i.qty}×</span> {i.name}
              </div>
              {i.note && <div className="text-sm font-medium text-amber-700">⚠ {i.note}</div>}
              <Badge tone={ITEM_STATUS_TONE[i.status]}>{ITEM_STATUS_LABEL[i.status]}</Badge>
            </div>
            {i.status === 'KDS_ACK' && (
              <Button size="lg" variant="secondary" onClick={() => onStatus(i, 'PREPARING')}>
                Nấu
              </Button>
            )}
            {i.status === 'PREPARING' && (
              <Button size="lg" variant="good" onClick={() => onStatus(i, 'READY')}>
                Xong
              </Button>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

function SoldOutModal({ api, station, onClose, onError }: { api: ReturnType<typeof createApi>; station: string; onClose: () => void; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const menu = useQuery({ queryKey: ['menu'], queryFn: () => api.get<{ items: MenuItemDto[] }>('/menu') });
  const items = (menu.data?.items ?? []).filter((i) => i.station === station);
  async function toggle(item: MenuItemDto) {
    try {
      await api.patch(`/menu/${item.id}/availability`, { available: !item.available });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    } catch (e) {
      onError(errorMessage(e));
    }
  }
  return (
    <Modal title="Báo hết / bán lại" onClose={onClose}>
      <ul className="divide-y divide-stone-100">
        {items.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
            <span className={i.available ? '' : 'text-stone-400'}>{i.name}</span>
            <Button size="sm" variant={i.available ? 'danger' : 'good'} onClick={() => void toggle(i)}>
              {i.available ? 'Báo hết' : 'Bán lại'}
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
