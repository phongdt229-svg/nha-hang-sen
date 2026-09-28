import type { BillDto, MenuCategoryDto, MenuItemDto, OrderDto, SessionDto, TableDto } from '@nhs/types';
import {
  ApiError,
  Badge,
  Button,
  errorMessage,
  formatTime,
  formatVnd,
  ITEM_STATUS_LABEL,
  ITEM_STATUS_TONE,
  Modal,
  newKey,
  TABLE_STATUS_LABEL,
} from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PairingCode } from './Alerts';
import { usePos } from './context';
import { PaymentBox, Receipt } from './Payment';

export function TablePanel({ table, tables, onClose }: { table: TableDto; tables: TableDto[]; onClose: () => void }) {
  // Giữ phiên đang xem kể cả khi vừa thanh toán xong (bàn chuyển CLEANING) để còn in phiếu.
  const [sessionId, setSessionId] = useState(table.sessionId);
  if (table.sessionId && table.sessionId !== sessionId) setSessionId(table.sessionId);
  return (
    <Modal title={`Bàn ${table.code} · ${TABLE_STATUS_LABEL[table.status]}`} onClose={onClose} wide>
      {table.status === 'CLEANING' && (
        <div className="mb-4">
          <CleaningPanel table={table} onDone={onClose} />
        </div>
      )}
      {sessionId ? <SessionPanel sessionId={sessionId} tables={tables} /> : table.status !== 'CLEANING' && <OpenPanel table={table} />}
      <TabletPairing tableId={table.id} />
    </Modal>
  );
}

function OpenPanel({ table }: { table: TableDto }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [guests, setGuests] = useState(Math.min(2, table.seats));
  async function open() {
    try {
      await api.post('/sessions', { tableId: table.id, guests });
      void qc.invalidateQueries({ queryKey: ['tables'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <div className="flex items-end gap-2">
      <label className="flex-1">
        <span className="text-sm font-medium">Số khách (bàn {table.seats} ghế)</span>
        <input type="number" min={1} className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5" value={guests} onChange={(e) => setGuests(Number(e.target.value))} />
      </label>
      <Button onClick={() => void open()} disabled={guests < 1}>
        Mở bàn
      </Button>
    </div>
  );
}

function CleaningPanel({ table, onDone }: { table: TableDto; onDone: () => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  async function cleaned() {
    try {
      await api.post(`/tables/${table.id}/cleaned`);
      void qc.invalidateQueries({ queryKey: ['tables'] });
      onDone();
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <Button variant="good" size="lg" className="w-full" onClick={() => void cleaned()}>
      Đã dọn xong — bàn sẵn sàng
    </Button>
  );
}

function SessionPanel({ sessionId, tables }: { sessionId: string; tables: TableDto[] }) {
  const { api } = usePos();
  const [tab, setTab] = useState<'orders' | 'bill'>('orders');
  const [picker, setPicker] = useState(false);
  const [moving, setMoving] = useState(false);
  const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.get<SessionDto>(`/sessions/${sessionId}`) });
  const orders = useQuery({ queryKey: ['orders', sessionId], queryFn: () => api.get<OrderDto[]>(`/sessions/${sessionId}/orders`) });
  const s = session.data;
  if (!s) return <p className="text-stone-500">Đang tải…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-stone-50 p-3 text-sm">
        <span>
          <b>{s.code}</b> · {s.guests} khách · mở lúc {formatTime(s.openedAt)}
          {s.status === 'CLOSED' ? ' · đã đóng phiên' : ` · bàn ${s.tableCodes.join(' + ')}`}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={s.status !== 'OPEN'} onClick={() => setPicker(true)}>
            Gọi món hộ
          </Button>
          <Button size="sm" variant="secondary" disabled={s.status === 'CLOSED'} onClick={() => setMoving(true)}>
            Chuyển bàn
          </Button>
        </div>
      </div>
      <div className="flex gap-1 rounded-xl bg-stone-100 p-1">
        {(['orders', 'bill'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-lg py-2 text-sm font-semibold ${tab === t ? 'bg-white text-sen-700 shadow-sm' : 'text-stone-600'}`}>
            {t === 'orders' ? `Món đã gọi (${orders.data?.length ?? 0})` : 'Bill & thanh toán'}
          </button>
        ))}
      </div>
      {tab === 'orders' ? <OrdersList orders={orders.data ?? []} editable={s.status === 'OPEN'} /> : <BillPanel sessionId={sessionId} />}
      {picker && <OrderPicker sessionId={sessionId} onClose={() => setPicker(false)} />}
      {moving && <MoveTable session={s} tables={tables} onClose={() => setMoving(false)} />}
    </div>
  );
}

function OrdersList({ orders, editable }: { orders: OrderDto[]; editable: boolean }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  async function cancel(itemId: string, name: string) {
    const reason = window.prompt(`Lý do hủy "${name}"?`);
    if (!reason) return;
    try {
      await api.post(`/order-items/${itemId}/cancel`, { reason });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['bill'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  if (orders.length === 0) return <p className="py-6 text-center text-stone-500">Chưa có món.</p>;
  return (
    <div className="space-y-3">
      {orders.map((o) => (
        <section key={o.id} className="rounded-xl ring-1 ring-stone-200">
          <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2 text-sm">
            <span className="font-semibold">
              {o.number} · {formatTime(o.createdAt)} · {o.source === 'TABLET' ? 'Khách tự gọi' : 'Nhân viên gọi'}
            </span>
            {o.kitchenAcked ? <Badge tone="good">Bếp đã nhận</Badge> : <Badge tone="warn">Chưa ACK</Badge>}
          </div>
          <ul className="divide-y divide-stone-100">
            {o.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className={i.status === 'CANCELLED' ? 'text-stone-400 line-through' : ''}>
                  {i.qty} × {i.name} <span className="text-stone-500">{formatVnd(i.unitPrice)}</span>
                  {i.note && <span className="text-stone-500"> — {i.note}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={ITEM_STATUS_TONE[i.status]}>{ITEM_STATUS_LABEL[i.status]}</Badge>
                  {editable && ['CONFIRMED', 'SENT', 'KDS_ACK', 'FALLBACK'].includes(i.status) && (
                    <Button size="sm" variant="ghost" onClick={() => void cancel(i.id, i.name)}>
                      Hủy
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BillPanel({ sessionId }: { sessionId: string }) {
  const { api, toast, role } = usePos();
  const qc = useQueryClient();
  const bill = useQuery({ queryKey: ['bill', sessionId], queryFn: () => api.get<BillDto>(`/sessions/${sessionId}/bill`) });
  const [printing, setPrinting] = useState(false);
  const [change, setChange] = useState<number | null>(null);
  const b = bill.data;
  if (!b) return <p className="text-stone-500">Đang tải…</p>;
  const isManager = role === 'MANAGER' || role === 'ADMIN';

  async function act(path: string, body: Record<string, unknown>) {
    try {
      await api.post(path, { version: b!.version, ...body });
    } catch (e) {
      toast(errorMessage(e));
      if (e instanceof ApiError && e.body?.error === 'VERSION_CONFLICT') void bill.refetch();
    } finally {
      void qc.invalidateQueries({ queryKey: ['bill'] });
      void qc.invalidateQueries({ queryKey: ['session'] });
      void qc.invalidateQueries({ queryKey: ['tables'] });
    }
  }

  function discount() {
    const amount = Number(window.prompt('Số tiền giảm (đồng)?', String(b!.discount)) ?? NaN);
    if (!Number.isInteger(amount) || amount < 0) return;
    const reason = window.prompt('Lý do giảm giá?');
    if (reason) void act(`/bills/${b!.id}/discount`, { amount, reason });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Bill {b.number}</span>
        <Badge tone={b.status === 'OPEN' ? 'info' : b.status === 'LOCKED' ? 'warn' : 'good'}>
          {b.status === 'OPEN' ? 'Đang mở' : b.status === 'LOCKED' ? 'Đã khóa' : 'Đã thanh toán'}
        </Badge>
      </div>
      <BillTable bill={b} />
      <div className="flex flex-wrap gap-2">
        {b.status === 'OPEN' && (
          <>
            <Button onClick={() => void act(`/bills/${b.id}/lock`, {})} disabled={b.lines.length === 0}>
              Khóa bill để thanh toán
            </Button>
            {isManager && (
              <Button variant="secondary" onClick={discount}>
                Giảm giá
              </Button>
            )}
          </>
        )}
        {b.status === 'LOCKED' && isManager && b.paid === 0 && (
          <Button
            variant="secondary"
            onClick={() => {
              const reason = window.prompt('Lý do mở khóa bill?');
              if (reason) void act(`/bills/${b.id}/unlock`, { reason });
            }}
          >
            Mở khóa bill
          </Button>
        )}
        {b.status !== 'OPEN' && (
          <Button variant="secondary" onClick={() => setPrinting(true)}>
            In phiếu thanh toán
          </Button>
        )}
      </div>
      {change !== null && change > 0 && (
        <p className="rounded-xl bg-emerald-50 p-3 text-center text-lg font-bold text-emerald-800">Tiền thừa trả khách: {formatVnd(change)}</p>
      )}
      {b.status === 'LOCKED' && <PaymentBox bill={b} onCashPaid={setChange} />}
      {printing && <Receipt bill={b} onClose={() => setPrinting(false)} />}
    </div>
  );
}

export function BillTable({ bill }: { bill: BillDto }) {
  return (
    <div className="rounded-xl ring-1 ring-stone-200">
      <table className="w-full text-sm">
        <tbody className="divide-y divide-stone-100">
          {bill.lines.map((l) => (
            <tr key={l.orderItemId}>
              <td className="px-3 py-1.5">
                {l.qty} × {l.name}
                {l.discount > 0 && <span className="text-xs text-stone-500"> (giảm {formatVnd(l.discount)})</span>}
              </td>
              <td className="px-3 py-1.5 text-right text-xs text-stone-500">VAT {l.taxRate / 100}%</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatVnd(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="space-y-1 border-t border-stone-200 p-3 text-sm">
        <Row label="Tạm tính" value={formatVnd(bill.subtotal)} />
        {bill.discount > 0 && <Row label="Giảm giá" value={`−${formatVnd(bill.discount)}`} />}
        {bill.taxes.map((t) => (
          <Row key={`${t.taxGroup}${t.rate}`} label={`Trong đó VAT ${t.rate / 100}% (trên ${formatVnd(t.base)})`} value={formatVnd(t.tax)} muted />
        ))}
        <div className="flex justify-between pt-1 text-lg font-bold">
          <dt>Tổng cộng</dt>
          <dd className="tabular-nums text-sen-700">{formatVnd(bill.total)}</dd>
        </div>
        {bill.paid > 0 && <Row label="Đã thu" value={formatVnd(bill.paid)} />}
      </dl>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? 'text-stone-500' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function OrderPicker({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const menu = useQuery({ queryKey: ['menu'], queryFn: () => api.get<{ categories: MenuCategoryDto[]; items: MenuItemDto[] }>('/menu') });
  const [qty, setQty] = useState<Record<string, number>>({});
  // Một khóa idempotency cho mỗi lần mở hộp gọi món: bấm lặp không tạo order trùng.
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const items = menu.data?.items ?? [];
  const total = items.reduce((a, i) => a + (qty[i.id] ?? 0) * i.price, 0);

  async function submit() {
    setBusy(true);
    try {
      const lines = Object.entries(qty)
        .filter(([, n]) => n > 0)
        .map(([menuItemId, n]) => ({ menuItemId, qty: n }));
      const o = await api.post<OrderDto>(`/sessions/${sessionId}/orders`, { items: lines }, { 'idempotency-key': key });
      toast(`Đã gửi order ${o.number}`, 'good');
      void qc.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Gọi món hộ khách" onClose={onClose} wide>
      <div className="space-y-4">
        {(menu.data?.categories ?? []).map((c) => (
          <section key={c.id}>
            <h3 className="mb-1 text-sm font-semibold text-stone-500">{c.name}</h3>
            <ul className="divide-y divide-stone-100">
              {items
                .filter((i) => i.categoryId === c.id)
                .map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                    <span className={i.available ? '' : 'text-stone-400 line-through'}>
                      {i.name} <span className="text-stone-500">{formatVnd(i.price)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Button size="sm" variant="secondary" disabled={!qty[i.id]} onClick={() => setQty({ ...qty, [i.id]: (qty[i.id] ?? 0) - 1 })}>
                        −
                      </Button>
                      <span className="w-5 text-center font-semibold">{qty[i.id] ?? 0}</span>
                      <Button size="sm" variant="secondary" disabled={!i.available} onClick={() => setQty({ ...qty, [i.id]: (qty[i.id] ?? 0) + 1 })}>
                        +
                      </Button>
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      <Button size="lg" className="sticky bottom-0 mt-4 w-full" disabled={busy || total === 0} onClick={() => void submit()}>
        Gửi bếp · {formatVnd(total)}
      </Button>
    </Modal>
  );
}

function MoveTable({ session, tables, onClose }: { session: SessionDto; tables: TableDto[]; onClose: () => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const free = tables.filter((t) => t.status === 'AVAILABLE');
  async function move(toTableId: string) {
    try {
      await api.post(`/sessions/${session.id}/move`, { toTableId });
      void qc.invalidateQueries();
      toast('Đã chuyển bàn', 'good');
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <Modal title={`Chuyển ${session.code} sang bàn khác`} onClose={onClose}>
      {free.length === 0 && <p className="text-stone-500">Không có bàn trống.</p>}
      <div className="grid grid-cols-3 gap-2">
        {free.map((t) => (
          <Button key={t.id} variant="secondary" onClick={() => void move(t.id)}>
            {t.code} <span className="text-xs text-stone-500">{t.seats} ghế</span>
          </Button>
        ))}
      </div>
    </Modal>
  );
}

function TabletPairing({ tableId }: { tableId: string }) {
  const { api, toast, role } = usePos();
  const [code, setCode] = useState<string | null>(null);
  if (!['MANAGER', 'ADMIN', 'WAITER'].includes(role)) return null;
  async function create() {
    try {
      setCode((await api.post<{ code: string }>('/devices/pairing-codes', { kind: 'TABLET', tableId })).code);
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <div className="mt-6 border-t border-stone-200 pt-4">
      {code ? (
        <PairingCode code={code} hint="Nhập mã này trên tablet của bàn. Mã hết hạn sau 10 phút." />
      ) : (
        <Button size="sm" variant="ghost" onClick={() => void create()}>
          Ghép tablet cho bàn này
        </Button>
      )}
    </div>
  );
}
