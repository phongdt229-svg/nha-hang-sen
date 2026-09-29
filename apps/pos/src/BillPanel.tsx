import type { BillDto } from '@nhs/types';
import { ApiError, Badge, Button, errorMessage, formatVnd, Modal } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';
import { BuyerSection, EInvoiceStatusRow } from './EInvoice';
import { PaymentBox, Receipt } from './Payment';
import { BillTable } from './TablePanel';

const field = 'mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5';

/** Bill của phiên. Sau khi tách có nhiều bill con, mỗi bill thu tiền riêng (mục 17.4 Sprint 5). */
export function BillPanel({ sessionId }: { sessionId: string }) {
  const { api } = usePos();
  const bills = useQuery({ queryKey: ['bill', sessionId, 'list'], queryFn: () => api.get<BillDto[]>(`/sessions/${sessionId}/bills`) });
  const list = bills.data;
  if (!list) return <p className="text-stone-500">Đang tải…</p>;
  if (list.length === 0) return <p className="py-6 text-center text-stone-500">Phiên chưa có bill.</p>;
  const parentId = list.find((b) => b.parentId)?.parentId ?? null;
  if (!parentId) return <BillCard bill={list[0]} onConflict={() => void bills.refetch()} />;
  return (
    <div className="space-y-4">
      <UnsplitBar parentId={parentId} bills={list} />
      {list.map((b) => (
        <section key={b.id} className="rounded-2xl p-4 ring-1 ring-stone-200">
          <BillCard bill={b} onConflict={() => void bills.refetch()} />
        </section>
      ))}
    </div>
  );
}

function useRefreshBills() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['bill'] });
    void qc.invalidateQueries({ queryKey: ['session'] });
    void qc.invalidateQueries({ queryKey: ['tables'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
}

function UnsplitBar({ parentId, bills }: { parentId: string; bills: BillDto[] }) {
  const { api, toast, role } = usePos();
  const refresh = useRefreshBills();
  const canUndo = (role === 'MANAGER' || role === 'ADMIN') && bills.every((b) => b.paid === 0);
  async function unsplit() {
    const reason = window.prompt('Lý do hủy tách bill?');
    if (!reason) return;
    try {
      await api.post(`/bills/${parentId}/unsplit`, { reason });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      refresh();
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-sen-50 p-3 text-sm">
      <span>
        Bill đã tách thành <b>{bills.length} phần</b> · tổng {formatVnd(bills.reduce((a, b) => a + b.total, 0))}
      </span>
      {canUndo && (
        <Button size="sm" variant="secondary" onClick={() => void unsplit()}>
          Hủy tách
        </Button>
      )}
    </div>
  );
}

function BillCard({ bill: b, onConflict }: { bill: BillDto; onConflict: () => void }) {
  const { api, toast, role } = usePos();
  const refresh = useRefreshBills();
  const [printing, setPrinting] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [change, setChange] = useState<number | null>(null);
  const isManager = role === 'MANAGER' || role === 'ADMIN';
  const paid = b.status === 'PAID' || b.status === 'CLOSED';

  async function act(path: string, body: Record<string, unknown>) {
    try {
      await api.post(path, { version: b.version, ...body });
    } catch (e) {
      toast(errorMessage(e));
      if (e instanceof ApiError && e.body?.error === 'VERSION_CONFLICT') onConflict();
    } finally {
      refresh();
    }
  }

  function discount() {
    const amount = Number(window.prompt('Số tiền giảm (đồng)?', String(b.discount)) ?? NaN);
    if (!Number.isInteger(amount) || amount < 0) return;
    const reason = window.prompt('Lý do giảm giá?');
    if (reason) void act(`/bills/${b.id}/discount`, { amount, reason });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">
          Bill {b.number}
          {b.label && <span className="text-stone-500"> · {b.label}</span>}
        </span>
        <Badge tone={b.status === 'OPEN' ? 'info' : b.status === 'LOCKED' ? 'warn' : 'good'}>
          {b.status === 'OPEN' ? 'Đang mở' : b.status === 'LOCKED' ? 'Đã khóa' : 'Đã thanh toán'}
        </Badge>
      </div>
      <BillTable bill={b} />
      {b.refunded > 0 && <p className="text-right text-sm text-red-700">Đã hoàn {formatVnd(b.refunded)}</p>}
      <div className="flex flex-wrap gap-2">
        {b.status === 'OPEN' && (
          <>
            <Button onClick={() => void act(`/bills/${b.id}/lock`, {})} disabled={b.lines.length === 0}>
              Khóa bill để thanh toán
            </Button>
            {role !== 'WAITER' && (
              <Button variant="secondary" onClick={() => setSplitting(true)} disabled={b.lines.length < 2}>
                Tách bill
              </Button>
            )}
            {isManager && (
              <Button variant="secondary" onClick={discount}>
                Giảm giá
              </Button>
            )}
          </>
        )}
        {b.status === 'LOCKED' && isManager && b.paid === 0 && !b.parentId && (
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
        {paid && isManager && b.refunded < b.total && (
          <Button variant="secondary" onClick={() => setRefunding(true)}>
            Hoàn tiền
          </Button>
        )}
      </div>
      {change !== null && change > 0 && (
        <p className="rounded-xl bg-emerald-50 p-3 text-center text-lg font-bold text-emerald-800">Tiền thừa trả khách: {formatVnd(change)}</p>
      )}
      {b.status === 'LOCKED' && <BuyerSection billId={b.id} />}
      {b.status === 'LOCKED' && <PaymentBox bill={b} onCashPaid={setChange} />}
      {paid && <EInvoiceStatusRow bill={b} />}
      {printing && <Receipt bill={b} onClose={() => setPrinting(false)} />}
      {splitting && <SplitBill bill={b} onClose={() => setSplitting(false)} />}
      {refunding && <RefundForm bill={b} onClose={() => setRefunding(false)} />}
    </div>
  );
}

/** Tách bill theo món hoặc theo nhóm khách: gán từng món cho một phần; mỗi phần thành một bill thu riêng. */
function SplitBill({ bill, onClose }: { bill: BillDto; onClose: () => void }) {
  const { api, toast } = usePos();
  const refresh = useRefreshBills();
  const [parts, setParts] = useState(2);
  const [assign, setAssign] = useState<Record<string, number>>(() => Object.fromEntries(bill.lines.map((l, i) => [l.orderItemId, i % 2])));
  const [busy, setBusy] = useState(false);
  const labels = Array.from({ length: parts }, (_, i) => `Khách ${i + 1}`);
  const partOf = (id: string) => Math.min(assign[id] ?? 0, parts - 1);
  const groups = labels
    .map((label, i) => ({ label, lines: bill.lines.filter((l) => partOf(l.orderItemId) === i) }))
    .filter((g) => g.lines.length > 0);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/bills/${bill.id}/split`, {
        version: bill.version,
        groups: groups.map((g) => ({ label: g.label, orderItemIds: g.lines.map((l) => l.orderItemId) })),
      });
      toast(`Đã tách thành ${groups.length} bill`, 'good');
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <Modal title={`Tách bill ${bill.number}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span>Số phần:</span>
        {[2, 3, 4, 5].map((n) => (
          <Button key={n} size="sm" variant={parts === n ? 'primary' : 'secondary'} onClick={() => setParts(n)} disabled={n > bill.lines.length}>
            {n}
          </Button>
        ))}
      </div>
      <ul className="divide-y divide-stone-100 rounded-xl ring-1 ring-stone-200">
        {bill.lines.map((l) => (
          <li key={l.orderItemId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>
              {l.qty} × {l.name} <span className="text-stone-500">{formatVnd(l.amount)}</span>
            </span>
            <div className="flex gap-1" role="radiogroup" aria-label={`Phần của ${l.name}`}>
              {labels.map((label, i) => (
                <button
                  key={label}
                  role="radio"
                  aria-checked={partOf(l.orderItemId) === i}
                  aria-label={label}
                  onClick={() => setAssign({ ...assign, [l.orderItemId]: i })}
                  className={`min-w-8 rounded-lg px-2.5 py-1 text-xs font-semibold ${partOf(l.orderItemId) === i ? 'bg-sen-600 text-white' : 'bg-stone-100 text-stone-600'}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.label} className="flex justify-between rounded-xl bg-stone-50 px-3 py-2 text-sm">
            <span>{g.label}</span>
            <span className="font-semibold tabular-nums">{formatVnd(g.lines.reduce((a, l) => a + l.amount, 0))}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-stone-500">Tiền từng phần là tạm tính; khi tách hệ thống tính lại thuế, tổng các phần luôn bằng bill gốc.</p>
      <Button className="mt-4 w-full" disabled={busy || groups.length < 2} onClick={() => void submit()}>
        Tách thành {groups.length} bill
      </Button>
    </Modal>
  );
}

/** Hoàn tiền: ghi bút toán âm vào ngày hoàn, không sửa bill đã thanh toán (mục 10.1). */
function RefundForm({ bill, onClose }: { bill: BillDto; onClose: () => void }) {
  const { api, toast } = usePos();
  const refresh = useRefreshBills();
  const max = bill.total - bill.refunded;
  const [amount, setAmount] = useState(max);
  const [method, setMethod] = useState<'CASH' | 'QR' | 'CARD' | 'EWALLET'>('CASH');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= max && reason.trim().length > 0;

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/bills/${bill.id}/refunds`, { amount, method, reason });
      toast(`Đã hoàn ${formatVnd(amount)}`, 'good');
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <Modal title={`Hoàn tiền ${bill.number}`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm font-medium">Số tiền hoàn (tối đa {formatVnd(max)})</span>
          <input type="number" min={1} max={max} className={field} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Hình thức</span>
          <select className={field} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="CASH">Tiền mặt (cần đang mở ca)</option>
            <option value="QR">Chuyển khoản</option>
            <option value="CARD">Thẻ</option>
            <option value="EWALLET">Ví điện tử</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Lý do</span>
          <input className={field} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="text-xs text-stone-500">Bill đã xuất hóa đơn điện tử thì hệ thống tự lập hóa đơn điều chỉnh giảm.</p>
        <Button className="w-full" disabled={busy || !valid} onClick={() => void submit()}>
          Xác nhận hoàn tiền
        </Button>
      </div>
    </Modal>
  );
}
