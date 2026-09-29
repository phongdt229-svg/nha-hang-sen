import { Badge, Button, errorMessage, formatTime, formatVnd } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';
import { METHOD_LABEL } from './Overview';

interface Shift {
  id: string;
  cashierId: string;
  status: 'OPEN' | 'PENDING_APPROVAL' | 'CLOSED';
  openingCash: number;
  countedCash: number | null;
  expectedCash: number | null;
  difference: number | null;
  note: string | null;
  openedAt: string;
  closedAt: string | null;
}

interface ShiftReport extends Shift {
  cashierName: string | null;
  totals: { byMethod: Record<string, number>; refundsByMethod: Record<string, number>; payments: number };
}

const field = 'mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5 text-lg';

/** Kết ca (mục 10.3): tổng theo phương thức, tiền mặt hệ thống so với tiền đếm; lệch vượt ngưỡng cần quản lý duyệt. */
export function ShiftScreen() {
  const { api, role } = usePos();
  const current = useQuery({ queryKey: ['shift', 'current'], queryFn: () => api.get<Shift | null>('/shifts/current') });
  const [closed, setClosed] = useState<Shift | null>(null);
  const isManager = role === 'MANAGER' || role === 'ADMIN';

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <h1 className="text-xl font-bold">Ca làm</h1>
      {current.isLoading ? (
        <p className="text-stone-500">Đang tải…</p>
      ) : current.data ? (
        <OpenShift shift={current.data} onClosed={setClosed} />
      ) : (
        <>
          {closed && <ClosedResult shift={closed} />}
          <OpenForm />
        </>
      )}
      {isManager && <PendingApprovals />}
    </div>
  );
}

function OpenForm() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [cash, setCash] = useState(0);
  async function open() {
    try {
      await api.post('/shifts/open', { openingCash: cash });
      toast('Đã mở ca', 'good');
      void qc.invalidateQueries({ queryKey: ['shift'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-stone-200">
      <h2 className="font-semibold">Mở ca mới</h2>
      <p className="text-sm text-stone-600">Cần mở ca trước khi thu hoặc hoàn tiền mặt.</p>
      <label className="block">
        <span className="text-sm font-medium">Tiền mặt đầu ca (đồng)</span>
        <input type="number" min={0} className={field} value={cash} onChange={(e) => setCash(Number(e.target.value))} />
      </label>
      <Button size="lg" className="w-full" disabled={!Number.isInteger(cash) || cash < 0} onClick={() => void open()}>
        Mở ca
      </Button>
    </section>
  );
}

function OpenShift({ shift, onClosed }: { shift: Shift; onClosed: (s: Shift) => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['shift', shift.id, 'report'], queryFn: () => api.get<ShiftReport>(`/shifts/${shift.id}/report`), refetchInterval: 30_000 });
  const [counted, setCounted] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const t = report.data?.totals;
  const expected = shift.openingCash + (t?.byMethod.CASH ?? 0) - (t?.refundsByMethod.CASH ?? 0);

  async function close() {
    if (counted === '') return;
    setBusy(true);
    try {
      const r = await api.post<Shift>(`/shifts/${shift.id}/close`, { countedCash: counted, note: note || undefined });
      onClosed(r);
      void qc.invalidateQueries({ queryKey: ['shift'] });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl bg-white p-4 ring-1 ring-stone-200">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Ca đang mở từ {formatTime(shift.openedAt)}</h2>
        <Badge tone="good">Đang mở</Badge>
      </div>
      <Totals totals={t} openingCash={shift.openingCash} />
      <div className="flex justify-between rounded-xl bg-sen-50 p-3 font-semibold">
        <span>Tiền mặt phải có trong két</span>
        <span className="tabular-nums">{formatVnd(expected)}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-sm font-medium">Tiền mặt đếm thực tế</span>
          <input type="number" min={0} className={field} value={counted} onChange={(e) => setCounted(e.target.value === '' ? '' : Number(e.target.value))} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Ghi chú</span>
          <input className={field} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {counted !== '' && counted !== expected && (
        <p className={`text-sm font-semibold ${counted < expected ? 'text-red-700' : 'text-amber-800'}`}>
          {counted < expected ? 'Thiếu' : 'Thừa'} {formatVnd(Math.abs(counted - expected))}
        </p>
      )}
      <Button size="lg" className="w-full" disabled={busy || counted === ''} onClick={() => void close()}>
        Kết ca
      </Button>
    </section>
  );
}

function Totals({ totals, openingCash }: { totals?: ShiftReport['totals']; openingCash: number }) {
  if (!totals) return <p className="text-sm text-stone-500">Đang tính…</p>;
  const methods = [...new Set([...Object.keys(totals.byMethod), ...Object.keys(totals.refundsByMethod)])];
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-stone-500">
        <tr>
          <th className="py-1 font-medium">Phương thức</th>
          <th className="py-1 text-right font-medium">Thu</th>
          <th className="py-1 text-right font-medium">Hoàn</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-stone-100">
        <tr>
          <td className="py-1.5">Tiền đầu ca</td>
          <td className="py-1.5 text-right tabular-nums">{formatVnd(openingCash)}</td>
          <td />
        </tr>
        {methods.map((m) => (
          <tr key={m}>
            <td className="py-1.5">{METHOD_LABEL[m] ?? m}</td>
            <td className="py-1.5 text-right tabular-nums">{formatVnd(totals.byMethod[m] ?? 0)}</td>
            <td className="py-1.5 text-right tabular-nums text-red-700">{totals.refundsByMethod[m] ? `−${formatVnd(totals.refundsByMethod[m])}` : ''}</td>
          </tr>
        ))}
        <tr>
          <td className="py-1.5 text-stone-500" colSpan={3}>
            {totals.payments} lượt thanh toán
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function ClosedResult({ shift }: { shift: Shift }) {
  const pending = shift.status === 'PENDING_APPROVAL';
  return (
    <section className={`space-y-1 rounded-2xl p-4 ring-1 ${pending ? 'bg-amber-50 ring-amber-200' : 'bg-emerald-50 ring-emerald-200'}`}>
      <h2 className="font-semibold">{pending ? 'Đã kết ca — chênh lệch vượt ngưỡng, chờ quản lý duyệt' : 'Đã kết ca'}</h2>
      <p className="text-sm">
        Hệ thống {formatVnd(shift.expectedCash ?? 0)} · đếm được {formatVnd(shift.countedCash ?? 0)} · chênh lệch{' '}
        <b>{formatVnd(shift.difference ?? 0)}</b>
      </p>
    </section>
  );
}

function PendingApprovals() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['shift', 'pending'], queryFn: () => api.get<Shift[]>('/shifts?status=PENDING_APPROVAL') });
  async function approve(s: Shift) {
    const reason = window.prompt(`Lý do duyệt chênh lệch ${formatVnd(s.difference ?? 0)}?`);
    if (!reason) return;
    try {
      await api.post(`/shifts/${s.id}/approve`, { reason });
      toast('Đã duyệt', 'good');
      void qc.invalidateQueries({ queryKey: ['shift'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  const rows = list.data ?? [];
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold">Ca chờ duyệt chênh lệch</h2>
      {rows.length === 0 && <p className="rounded-2xl bg-white p-6 text-center text-stone-500 ring-1 ring-stone-200">Không có ca nào chờ duyệt.</p>}
      {rows.map((s) => (
        <article key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-4 ring-2 ring-amber-300">
          <div className="text-sm">
            <div className="font-semibold">
              Ca {formatTime(s.openedAt)}–{s.closedAt ? formatTime(s.closedAt) : ''}
            </div>
            <div className="text-stone-600">
              Hệ thống {formatVnd(s.expectedCash ?? 0)} · đếm {formatVnd(s.countedCash ?? 0)} · lệch <b>{formatVnd(s.difference ?? 0)}</b>
              {s.note && <> · {s.note}</>}
            </div>
          </div>
          <Button size="sm" onClick={() => void approve(s)}>
            Duyệt
          </Button>
        </article>
      ))}
    </section>
  );
}
