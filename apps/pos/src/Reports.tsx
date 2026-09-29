import { Button, errorMessage, formatVnd } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';

interface ReportColumn {
  key: string;
  label: string;
  kind?: 'money' | 'number' | 'text' | 'percent';
}
interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, number>;
}
interface Kpis {
  bills: number;
  revenue: number;
  guests: number;
  avgPerBill: number;
  revenuePerGuest: number;
  revenuePerTable: number;
  tableTurnover: number;
  avgDiningMinutes: number;
}
interface BusinessDay {
  day: string;
  closedAt: string;
  closedBy: string;
  summary: { revenue: number; refund: number; net: number; bills: number; openShifts: number; lockedBillsUnpaid: number };
}

const GROUP_BY = [
  ['day', 'Theo ngày'],
  ['hour', 'Theo giờ'],
  ['item', 'Theo món'],
  ['category', 'Theo danh mục'],
  ['method', 'Theo phương thức'],
  ['source', 'Theo nguồn order'],
  ['shift', 'Theo ca'],
] as const;
type GroupBy = (typeof GROUP_BY)[number][0];

type View = 'revenue' | 'kpis' | 'adjustments' | 'einvoices' | 'days';
const VIEWS: [View, string][] = [
  ['revenue', 'Doanh thu'],
  ['kpis', 'Chỉ số'],
  ['adjustments', 'Giảm giá · hủy · hoàn'],
  ['einvoices', 'Bảng kê hóa đơn'],
  ['days', 'Chốt ngày'],
];

/** Ngày kinh doanh hiện tại theo giờ Việt Nam (kết thúc lúc 04:00 sáng hôm sau). */
function currentBusinessDay() {
  return new Date(Date.now() + 7 * 3_600_000 - 4 * 3_600_000).toISOString().slice(0, 10);
}

const input = 'rounded-xl border border-stone-300 px-3 py-2';

/** Báo cáo doanh thu cho chủ, quản lý, kế toán (mục 10.2); số liệu theo ngày kinh doanh. */
export function Reports() {
  const { role } = usePos();
  const today = currentBusinessDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [view, setView] = useState<View>('revenue');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-auto text-xl font-bold">Báo cáo</h1>
        <label className="text-sm">
          <span className="block font-medium">Từ ngày</span>
          <input type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="block font-medium">Đến ngày</span>
          <input type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-stone-100 p-1" aria-label="Loại báo cáo">
        {VIEWS.map(([v, label]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${view === v ? 'bg-white text-sen-700 shadow-sm' : 'text-stone-600'}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {!valid && view !== 'days' ? (
        <p className="text-red-700">Khoảng ngày không hợp lệ.</p>
      ) : view === 'revenue' ? (
        <Revenue from={from} to={to} groupBy={groupBy} setGroupBy={setGroupBy} />
      ) : view === 'kpis' ? (
        <KpiView from={from} to={to} />
      ) : view === 'adjustments' ? (
        <TableView path={`/reports/adjustments?from=${from}&to=${to}`} exportType="adjustments" from={from} to={to} />
      ) : view === 'einvoices' ? (
        <TableView path={`/einvoices/tax-summary?from=${from}&to=${to}`} exportType="einvoices" from={from} to={to} />
      ) : (
        <Days canClose={role === 'MANAGER' || role === 'ADMIN'} />
      )}
    </div>
  );
}

function Revenue({ from, to, groupBy, setGroupBy }: { from: string; to: string; groupBy: GroupBy; setGroupBy: (g: GroupBy) => void }) {
  return (
    <div className="space-y-3">
      <select className={input} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} aria-label="Nhóm theo">
        {GROUP_BY.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <TableView path={`/reports/revenue?from=${from}&to=${to}&group_by=${groupBy}`} exportType="revenue" groupBy={groupBy} from={from} to={to} />
    </div>
  );
}

function TableView({ path, exportType, groupBy, from, to }: { path: string; exportType: string; groupBy?: GroupBy; from: string; to: string }) {
  const { api } = usePos();
  const q = useQuery({ queryKey: ['report', path], queryFn: () => api.get<ReportTable>(path) });
  if (q.error) return <p className="text-red-700">{errorMessage(q.error)}</p>;
  if (!q.data) return <p className="text-stone-500">Đang tải…</p>;
  return (
    <div className="space-y-3">
      <DataTable table={q.data} />
      <ExportButtons type={exportType} from={from} to={to} groupBy={groupBy} />
    </div>
  );
}

function cell(v: string | number | null | undefined, kind?: ReportColumn['kind']) {
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'money') return formatVnd(Number(v));
  if (kind === 'percent') return `${(Number(v) * 100).toFixed(1)}%`;
  if (kind === 'number') return new Intl.NumberFormat('vi-VN').format(Number(v));
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  return String(v);
}

function DataTable({ table }: { table: ReportTable }) {
  const numeric = (c: ReportColumn) => c.kind === 'money' || c.kind === 'number' || c.kind === 'percent';
  return (
    <section className="rounded-2xl bg-white ring-1 ring-stone-200">
      <h2 className="border-b border-stone-100 px-4 py-3 font-semibold">{table.title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-left text-stone-500">
            <tr>
              {table.columns.map((c) => (
                <th key={c.key} className={`whitespace-nowrap px-4 py-2 font-medium ${numeric(c) ? 'text-right' : ''}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length} className="px-4 py-6 text-center text-stone-500">
                  Không có số liệu trong khoảng này.
                </td>
              </tr>
            )}
            {table.rows.map((r, i) => (
              <tr key={i}>
                {table.columns.map((c) => (
                  <td key={c.key} className={`px-4 py-2 ${numeric(c) ? 'text-right tabular-nums' : ''}`}>
                    {cell(r[c.key], c.kind)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {table.totals && table.rows.length > 0 && (
            <tfoot className="border-t-2 border-stone-200 font-semibold">
              <tr>
                {table.columns.map((c, i) => (
                  <td key={c.key} className={`px-4 py-2 ${numeric(c) ? 'text-right tabular-nums' : ''}`}>
                    {i === 0 ? 'Tổng' : cell(table.totals![c.key], c.kind)}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

function ExportButtons({ type, from, to, groupBy }: { type: string; from: string; to: string; groupBy?: GroupBy }) {
  const { api, toast } = usePos();
  const [busy, setBusy] = useState<string | null>(null);
  async function download(format: 'xlsx' | 'csv' | 'pdf') {
    setBusy(format);
    try {
      const q = new URLSearchParams({ type, from, to, format, ...(groupBy ? { group_by: groupBy } : {}) });
      const { blob, filename } = await api.download(`/reports/export?${q}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      {(['xlsx', 'csv', 'pdf'] as const).map((f) => (
        <Button key={f} size="sm" variant="secondary" disabled={busy !== null} onClick={() => void download(f)}>
          {busy === f ? 'Đang xuất…' : `Xuất ${f.toUpperCase()}`}
        </Button>
      ))}
    </div>
  );
}

function KpiView({ from, to }: { from: string; to: string }) {
  const { api } = usePos();
  const q = useQuery({ queryKey: ['report', 'kpis', from, to], queryFn: () => api.get<Kpis>(`/reports/kpis?from=${from}&to=${to}`) });
  const k = q.data;
  if (!k) return <p className="text-stone-500">Đang tải…</p>;
  const stats: [string, string][] = [
    ['Số bill', String(k.bills)],
    ['Doanh thu', formatVnd(k.revenue)],
    ['Số khách', String(k.guests)],
    ['Trung bình / bill', formatVnd(k.avgPerBill)],
    ['Doanh thu / khách', formatVnd(k.revenuePerGuest)],
    ['Doanh thu / bàn / ngày', formatVnd(k.revenuePerTable)],
    ['Vòng quay bàn / ngày', String(k.tableTurnover)],
    ['Thời gian ngồi TB', `${k.avgDiningMinutes} phút`],
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
            <div className="text-sm text-stone-500">{label}</div>
            <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <ExportButtons type="kpis" from={from} to={to} />
    </div>
  );
}

/** Chốt ngày (mục 10.3): khóa số liệu ngày đã qua; hoàn tiền sau đó ghi vào ngày hoàn. */
function Days({ canClose }: { canClose: boolean }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['business-days'], queryFn: () => api.get<BusinessDay[]>('/business-days') });
  const yesterday = new Date(Date.parse(currentBusinessDay()) - 86_400_000).toISOString().slice(0, 10);
  const [day, setDay] = useState(yesterday);
  async function close() {
    if (!window.confirm(`Chốt ngày kinh doanh ${day}? Sau khi chốt, số liệu ngày này không đổi nữa.`)) return;
    try {
      await api.post(`/business-days/${day}/close`);
      toast(`Đã chốt ngày ${day}`, 'good');
      void qc.invalidateQueries({ queryKey: ['business-days'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <div className="space-y-3">
      {canClose && (
        <div className="flex flex-wrap items-end gap-2 rounded-2xl bg-white p-4 ring-1 ring-stone-200">
          <label className="text-sm">
            <span className="block font-medium">Ngày kinh doanh cần chốt</span>
            <input type="date" className={input} value={day} max={yesterday} onChange={(e) => setDay(e.target.value)} />
          </label>
          <Button onClick={() => void close()}>Chốt ngày</Button>
          <p className="basis-full text-xs text-stone-500">Hệ thống cũng tự chốt ngày hôm trước bằng tác vụ đêm.</p>
        </div>
      )}
      <DataTable
        table={{
          title: 'Các ngày đã chốt',
          columns: [
            { key: 'day', label: 'Ngày' },
            { key: 'bills', label: 'Số bill', kind: 'number' },
            { key: 'revenue', label: 'Doanh thu', kind: 'money' },
            { key: 'refund', label: 'Hoàn tiền', kind: 'money' },
            { key: 'net', label: 'Thực thu', kind: 'money' },
            { key: 'closedAt', label: 'Chốt lúc' },
            { key: 'by', label: 'Người chốt' },
          ],
          rows: (q.data ?? []).map((d) => ({
            day: d.day,
            bills: d.summary.bills,
            revenue: d.summary.revenue,
            refund: d.summary.refund,
            net: d.summary.net,
            closedAt: d.closedAt,
            by: d.closedBy === 'system' ? 'Tự động' : 'Quản lý',
          })),
        }}
      />
    </div>
  );
}
