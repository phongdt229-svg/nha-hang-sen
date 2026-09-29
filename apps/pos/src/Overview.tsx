import { formatVnd, TABLE_STATUS_LABEL } from '@nhs/ui';
import type { TableStatus } from '@nhs/types';
import { useQuery } from '@tanstack/react-query';
import { usePos } from './context';

interface OverviewData {
  businessDay: string;
  revenue: number;
  bills: number;
  tables: Partial<Record<TableStatus, number>>;
  servingUnpaid: number;
  byMethod: Record<string, number>;
  einvoice: { revenue: number; invoiced: number; difference: number; unissued: number };
}

export const METHOD_LABEL: Record<string, string> = { CASH: 'Tiền mặt', QR: 'QR ngân hàng', CARD: 'Thẻ', EWALLET: 'Ví điện tử' };

export function Overview() {
  const { api, role } = usePos();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<OverviewData>('/reports/overview'), refetchInterval: 30_000, enabled: role !== 'WAITER' });
  if (role === 'WAITER') return <p className="p-8 text-center text-stone-500">Chỉ thu ngân và quản lý xem được báo cáo.</p>;
  const d = q.data;
  if (!d) return <p className="p-8 text-center text-stone-500">Đang tải…</p>;
  const inUse = (d.tables.DINING ?? 0) + (d.tables.PAYMENT ?? 0);
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <h1 className="text-xl font-bold">
        Ngày kinh doanh <span className="text-sen-700">{d.businessDay}</span>
      </h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Doanh thu đã thu" value={formatVnd(d.revenue)} />
        <Stat label="Số bill" value={String(d.bills)} />
        <Stat label="Bàn đang dùng" value={String(inUse)} />
        <Stat label="Đang phục vụ, chưa thu" value={formatVnd(d.servingUnpaid)} />
      </div>
      {(d.einvoice.difference !== 0 || d.einvoice.unissued > 0) && (
        <p className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          Doanh thu (sau hoàn tiền) {formatVnd(d.einvoice.revenue)} ≠ tổng hóa đơn đã phát hành {formatVnd(d.einvoice.invoiced)}
          {d.einvoice.unissued > 0 && ` · ${d.einvoice.unissued} hóa đơn chưa phát hành`}. Kiểm tra mục Cảnh báo.
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
          <h2 className="mb-3 font-semibold">Theo phương thức thanh toán</h2>
          {Object.keys(d.byMethod).length === 0 && <p className="text-sm text-stone-500">Chưa có thanh toán.</p>}
          <ul className="space-y-2">
            {Object.entries(d.byMethod).map(([m, v]) => (
              <li key={m} className="flex justify-between text-sm">
                <span>{METHOD_LABEL[m] ?? m}</span>
                <span className="font-semibold tabular-nums">{formatVnd(v)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
          <h2 className="mb-3 font-semibold">Trạng thái bàn</h2>
          <ul className="space-y-2">
            {(Object.keys(TABLE_STATUS_LABEL) as TableStatus[]).map((s) => (
              <li key={s} className="flex justify-between text-sm">
                <span>{TABLE_STATUS_LABEL[s]}</span>
                <span className="font-semibold tabular-nums">{d.tables[s] ?? 0}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-stone-200">
      <div className="text-sm text-stone-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
