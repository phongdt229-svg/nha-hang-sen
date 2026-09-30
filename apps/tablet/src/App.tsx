import type { DeliveryTaskDto, DomainEvent, MenuCategoryDto, MenuItemDto, OrderDto, SessionDto } from '@nhs/types';
import {
  ApiError,
  Badge,
  Button,
  ConnectionDot,
  createApi,
  errorMessage,
  formatTime,
  formatVnd,
  ITEM_STATUS_LABEL,
  ITEM_STATUS_TONE,
  Logo,
  Modal,
  NetworkError,
  PairScreen,
  storage,
  TAG_LABEL,
  useRealtime,
  useToast,
  type PairedDevice,
} from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCart } from './cart';

const TOKEN_KEY = 'nhs.tablet.token';
const DEVICE_KEY = 'nhs.tablet.device';

export function App() {
  const [token, setToken] = useState(() => storage.get(TOKEN_KEY));
  const [device, setDevice] = useState<PairedDevice | null>(() => JSON.parse(storage.get(DEVICE_KEY) ?? 'null'));

  const unpair = useCallback(() => {
    storage.set(TOKEN_KEY, null);
    storage.set(DEVICE_KEY, null);
    setToken(null);
  }, []);

  if (!token || !device) {
    return (
      <PairScreen
        subtitle="Ghép tablet với bàn"
        onPaired={(t, d) => {
          storage.set(TOKEN_KEY, t);
          storage.set(DEVICE_KEY, JSON.stringify(d));
          setDevice(d);
          setToken(t);
        }}
      />
    );
  }
  return <Tablet token={token} device={device} onUnauthorized={unpair} />;
}

function Tablet({ token, device, onUnauthorized }: { token: string; device: PairedDevice; onUnauthorized: () => void }) {
  const api = useMemo(() => createApi(() => token, onUnauthorized), [token, onUnauthorized]);
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'menu' | 'orders'>('menu');
  const [cartOpen, setCartOpen] = useState(false);

  const session = useQuery({ queryKey: ['session'], queryFn: () => api.get<SessionDto | null>('/devices/me/session') });
  const menu = useQuery({ queryKey: ['menu'], queryFn: () => api.get<{ categories: MenuCategoryDto[]; items: MenuItemDto[] }>('/menu') });
  const sessionId = session.data?.id ?? null;
  const orders = useQuery({
    queryKey: ['orders', sessionId],
    queryFn: () => api.get<OrderDto[]>(`/sessions/${sessionId}/orders`),
    enabled: !!sessionId,
  });

  // Robot giao món tới bàn (RD-13): khách xác nhận "Đã nhận món" ngay trên tablet.
  const deliveries = useQuery({ queryKey: ['delivery'], queryFn: () => api.get<DeliveryTaskDto[]>('/internal/delivery-tasks'), enabled: !!sessionId });

  const bindSession = useCart((s) => s.bindSession);
  useEffect(() => {
    if (session.isSuccess) bindSession(sessionId);
  }, [session.isSuccess, sessionId, bindSession]);

  const connected = useRealtime({ token, storageKey: `tablet.${device.id}` }, (e: DomainEvent) => {
    if (e.type.startsWith('menu.')) void qc.invalidateQueries({ queryKey: ['menu'] });
    if (e.type.startsWith('session.') || e.type.startsWith('bill.') || e.type === 'table.status' || e.type === 'payment.succeeded') {
      void qc.invalidateQueries({ queryKey: ['session'] });
    }
    if (e.type.startsWith('order.') || e.type.startsWith('kitchen.')) void qc.invalidateQueries({ queryKey: ['orders'] });
    if (e.type.startsWith('delivery.')) {
      void qc.invalidateQueries({ queryKey: ['delivery'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    }
  });

  if (session.isLoading) return <Centered>Đang tải…</Centered>;
  if (!session.data) {
    return (
      <Centered>
        <Logo />
        <p className="mt-6 text-2xl font-semibold">Bàn {device.tableCode}</p>
        <p className="mt-2 text-stone-600">Kính chào quý khách! Nhân viên sẽ mở bàn trong giây lát.</p>
        <div className="mt-6">
          <ConnectionDot connected={connected} />
        </div>
      </Centered>
    );
  }

  const locked = session.data.status !== 'OPEN';
  const orderCount = orders.data?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3">
        <Logo subtitle={`Bàn ${session.data.tableCodes.join(' + ')} · ${session.data.guests} khách`} />
        <nav className="flex gap-1 rounded-xl bg-stone-100 p-1" aria-label="Chuyển mục">
          {(['menu', 'orders'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? 'bg-white text-sen-700 shadow-sm' : 'text-stone-600'}`}
            >
              {t === 'menu' ? 'Thực đơn' : `Món đã gọi${orderCount ? ` (${orderCount})` : ''}`}
            </button>
          ))}
        </nav>
        <ConnectionDot connected={connected} />
      </header>

      {locked && (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-900">
          Bàn đang thanh toán, tạm dừng gọi thêm món. Cảm ơn quý khách!
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'menu' ? (
          <MenuView categories={menu.data?.categories ?? []} items={menu.data?.items ?? []} locked={locked} />
        ) : (
          <OrdersView orders={orders.data ?? []} />
        )}
      </main>

      <RobotDelivery tasks={(deliveries.data ?? []).filter((t) => t.sessionId === sessionId)} api={api} onError={toast.show} />

      {!locked && tab === 'menu' && <CartBar items={menu.data?.items ?? []} onOpen={() => setCartOpen(true)} />}
      {cartOpen && (
        <CartModal
          items={menu.data?.items ?? []}
          sessionId={session.data.id}
          api={api}
          onClose={() => setCartOpen(false)}
          onDone={(o) => {
            setCartOpen(false);
            setTab('orders');
            toast.show(`Đã gửi order ${o.number}. Bếp sẽ xác nhận ngay.`, 'good');
            void qc.invalidateQueries({ queryKey: ['orders'] });
          }}
          onError={(m) => toast.show(m)}
          onSoldOut={() => void qc.invalidateQueries({ queryKey: ['menu'] })}
        />
      )}
      {toast.node}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center p-6 text-center">{children}</div>;
}

function MenuView({ categories, items, locked }: { categories: MenuCategoryDto[]; items: MenuItemDto[]; locked: boolean }) {
  const [active, setActive] = useState<string | null>(null);
  const add = useCart((s) => s.add);
  const lines = useCart((s) => s.lines);
  const pending = useCart((s) => s.pending);
  const current = active ?? categories[0]?.id;
  const shown = items.filter((i) => i.categoryId === current);

  return (
    <div className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Danh mục">
        {categories.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={c.id === current}
            onClick={() => setActive(c.id)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${c.id === current ? 'bg-sen-600 text-white' : 'bg-white text-stone-700 ring-1 ring-stone-200'}`}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {shown.map((item) => {
          const qty = lines.find((l) => l.menuItemId === item.id)?.qty ?? 0;
          return (
            <article key={item.id} className={`flex flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-stone-200 ${item.available ? '' : 'opacity-60'}`}>
              <DishImage item={item} />
              <div className="flex flex-1 flex-col gap-2 p-3">
                <h3 className="font-semibold leading-snug">{item.name}</h3>
                <div className="flex flex-wrap gap-1">
                  {item.tags.map((t) => (
                    <Badge key={t} tone={t === 'cay' ? 'danger' : t === 'chay' ? 'good' : 'accent'}>
                      {TAG_LABEL[t] ?? t}
                    </Badge>
                  ))}
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <span className="font-bold text-sen-700">{formatVnd(item.price)}</span>
                  {!item.available ? (
                    <Badge tone="muted">Hết món</Badge>
                  ) : (
                    <Button size="sm" disabled={locked || pending} onClick={() => add(item.id)} aria-label={`Thêm ${item.name}`}>
                      {qty > 0 ? `+ (${qty})` : '+ Thêm'}
                    </Button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const DISH_TINTS = ['bg-sen-100', 'bg-emerald-100', 'bg-amber-100', 'bg-sky-100', 'bg-rose-100'];

function DishImage({ item }: { item: MenuItemDto }) {
  if (item.imageUrl) return <img src={item.imageUrl} alt="" className="aspect-[4/3] w-full object-cover" loading="lazy" />;
  const tint = DISH_TINTS[item.code.charCodeAt(item.code.length - 1) % DISH_TINTS.length];
  return (
    <div className={`flex aspect-[4/3] w-full items-center justify-center ${tint}`} aria-hidden>
      <span className="text-4xl font-bold text-stone-500/60">{item.name.charAt(0)}</span>
    </div>
  );
}

function CartBar({ items, onOpen }: { items: MenuItemDto[]; onOpen: () => void }) {
  const lines = useCart((s) => s.lines);
  const pending = useCart((s) => s.pending);
  if (lines.length === 0) return null;
  const byId = new Map(items.map((i) => [i.id, i]));
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const total = lines.reduce((a, l) => a + l.qty * (byId.get(l.menuItemId)?.price ?? 0), 0);
  return (
    <div className="border-t border-stone-200 bg-white p-3">
      <Button size="lg" className="mx-auto flex w-full max-w-xl justify-between" onClick={onOpen}>
        <span>{pending ? 'Đang chờ gửi lại…' : `Giỏ hàng · ${count} món`}</span>
        <span>{formatVnd(total)}</span>
      </Button>
    </div>
  );
}

function CartModal(props: {
  items: MenuItemDto[];
  sessionId: string;
  api: ReturnType<typeof createApi>;
  onClose: () => void;
  onDone: (o: OrderDto) => void;
  onError: (message: string) => void;
  onSoldOut: () => void;
}) {
  const { lines, pending, setQty, setNote, setPending, submitted, remove } = useCart();
  const [busy, setBusy] = useState(false);
  const byId = new Map(props.items.map((i) => [i.id, i]));
  const total = lines.reduce((a, l) => a + l.qty * (byId.get(l.menuItemId)?.price ?? 0), 0);

  const submit = useCallback(async () => {
    const { lines, key } = useCart.getState();
    if (lines.length === 0) return;
    setBusy(true);
    setPending(true);
    try {
      const order = await props.api.post<OrderDto>(
        `/sessions/${props.sessionId}/orders`,
        { items: lines.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, note: l.note || undefined })) },
        { 'idempotency-key': key },
      );
      submitted();
      props.onDone(order);
    } catch (e) {
      if (e instanceof NetworkError) {
        // Không biết server đã nhận chưa: giữ nguyên giỏ và khóa, gửi lại khi có mạng.
        props.onError('Mất mạng. Giỏ hàng được giữ nguyên và sẽ tự gửi lại khi có mạng.');
      } else if (e instanceof ApiError && e.body?.error === 'ITEM_UNAVAILABLE') {
        remove((e.body.menuItemIds as string[]) ?? []);
        props.onSoldOut();
        props.onError('Xin lỗi, có món vừa hết và đã được bỏ khỏi giỏ.');
      } else {
        setPending(false);
        props.onError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }, [props, setPending, submitted, remove]);

  useEffect(() => {
    if (!pending) return;
    const retry = () => void submit();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [pending, submit]);

  return (
    <Modal title="Giỏ hàng" onClose={props.onClose}>
      {lines.length === 0 ? (
        <p className="py-6 text-center text-stone-500">Chưa có món nào.</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {lines.map((l) => {
            const item = byId.get(l.menuItemId);
            return (
              <li key={l.menuItemId} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{item?.name ?? 'Món'}</div>
                    <div className="text-sm text-stone-500">{formatVnd(item?.price ?? 0)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => setQty(l.menuItemId, l.qty - 1)} aria-label="Bớt">
                      −
                    </Button>
                    <span className="w-6 text-center font-semibold">{l.qty}</span>
                    <Button size="sm" variant="secondary" disabled={pending} onClick={() => setQty(l.menuItemId, l.qty + 1)} aria-label="Thêm">
                      +
                    </Button>
                  </div>
                </div>
                <input
                  className="mt-2 w-full rounded-lg border border-stone-200 px-3 py-1.5 text-sm"
                  placeholder="Ghi chú (ít cay, không hành…)"
                  value={l.note}
                  disabled={pending}
                  maxLength={200}
                  onChange={(e) => setNote(l.menuItemId, e.target.value)}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex items-center justify-between border-t border-stone-200 pt-4 text-lg font-bold">
        <span>Tạm tính</span>
        <span className="text-sen-700">{formatVnd(total)}</span>
      </div>
      <p className="mt-1 text-xs text-stone-500">Giá đã gồm VAT. Món chỉ được gửi bếp khi quý khách bấm xác nhận.</p>
      <Button size="lg" className="mt-4 w-full" disabled={busy || lines.length === 0} onClick={() => void submit()}>
        {busy ? 'Đang gửi…' : pending ? 'Gửi lại' : 'Xác nhận gọi món'}
      </Button>
    </Modal>
  );
}

function OrdersView({ orders }: { orders: OrderDto[] }) {
  if (orders.length === 0) return <p className="p-10 text-center text-stone-500">Quý khách chưa gọi món nào.</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      {[...orders].reverse().map((o) => (
        <section key={o.id} className="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-bold">
              Order {o.number} <span className="font-normal text-stone-500">· {formatTime(o.createdAt)}</span>
            </h3>
            {o.kitchenAcked ? <Badge tone="good">Bếp đã nhận</Badge> : <Badge tone="warn">Đang gửi bếp…</Badge>}
          </div>
          <ul className="space-y-1.5">
            {o.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 text-sm">
                <span className={i.status === 'CANCELLED' ? 'text-stone-400 line-through' : ''}>
                  {i.qty} × {i.name}
                  {i.note && <span className="text-stone-500"> — {i.note}</span>}
                </span>
                <Badge tone={ITEM_STATUS_TONE[i.status]}>{ITEM_STATUS_LABEL[i.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Robot đang mang món tới / đã tới bàn: khách bấm "Đã nhận món" (không tự coi là đã giao khi robot tới, MB-14). */
function RobotDelivery({ tasks, api, onError }: { tasks: DeliveryTaskDto[]; api: ReturnType<typeof createApi>; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const arrived = tasks.find((t) => t.status === 'ARRIVED_TABLE' || t.status === 'WAITING_CUSTOMER');
  const coming = tasks.find((t) => t.status === 'GOING_TO_TABLE' || t.status === 'LOADING');

  async function received(t: DeliveryTaskDto) {
    setBusy(true);
    try {
      await api.post(`/internal/delivery-tasks/${t.id}/confirm-delivered`);
      void qc.invalidateQueries({ queryKey: ['delivery'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (arrived) {
    return (
      <Modal title="Robot đã tới bàn" onClose={() => undefined}>
        <p className="text-lg">Mời quý khách lấy món trên robot:</p>
        <ul className="my-3 space-y-1 text-lg font-semibold">
          {arrived.items.map((i) => (
            <li key={i.id}>
              {i.qty} × {i.name}
            </li>
          ))}
        </ul>
        <p className="mb-4 text-sm text-stone-500">Sau khi lấy đủ món, quý khách bấm nút bên dưới (hoặc nút trên robot) để robot quay về.</p>
        <Button size="lg" variant="good" className="w-full" disabled={busy} onClick={() => void received(arrived)}>
          Đã nhận món
        </Button>
      </Modal>
    );
  }
  if (coming) {
    return (
      <div className="bg-sen-50 px-4 py-2 text-center text-sm font-medium text-sen-700" role="status">
        Robot đang mang {coming.items.reduce((a, i) => a + i.qty, 0)} món tới bàn…
      </div>
    );
  }
  return null;
}
