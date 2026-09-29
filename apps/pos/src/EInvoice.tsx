import type { BillBuyerDto, BillDto, EInvoiceDto, EInvoiceStatus } from '@nhs/types';
import { ApiError, Badge, Button, errorMessage, formatTime, formatVnd, Modal } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ChangeEvent } from 'react';
import { usePos } from './context';

export const EINVOICE_STATUS: Record<EInvoiceStatus, [label: string, tone: 'good' | 'warn' | 'danger' | 'info' | 'neutral']> = {
  PENDING: ['Chờ phát hành', 'warn'],
  SENT: ['Đang gửi', 'info'],
  ISSUED: ['Đã phát hành', 'good'],
  FAILED: ['Lỗi', 'danger'],
  ADJUSTED: ['Đã điều chỉnh', 'neutral'],
  REPLACED: ['Đã thay thế', 'neutral'],
};

const input = 'mt-1 w-full rounded-xl border border-stone-300 px-3 py-2';

/**
 * Thông tin người mua lấy hóa đơn công ty (mục 12.4): nhập MST → tra cứu tự điền tên, địa chỉ;
 * khách chỉ kiểm tra và nhập email. Lưu trước khi thu tiền; hóa đơn lỗi thì sửa ở đây rồi gửi lại.
 */
export function BuyerForm({ billId, onSaved }: { billId: string; onSaved?: () => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ['buyer', billId], queryFn: () => api.get<BillBuyerDto | null>(`/bills/${billId}/buyer`) });
  const [f, setF] = useState({ taxCode: '', name: '', address: '', email: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const b = saved.data;
    if (b) setF({ taxCode: b.taxCode ?? '', name: b.name ?? '', address: b.address ?? '', email: b.email ?? '' });
  }, [saved.data]);

  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function lookup() {
    setBusy(true);
    try {
      const r = await api.get<{ name: string; address: string }>(`/tax-codes/${encodeURIComponent(f.taxCode.trim())}`);
      setF({ ...f, name: r.name, address: r.address });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.put(`/bills/${billId}/buyer`, { kind: 'COMPANY', taxCode: f.taxCode.trim(), name: f.name, address: f.address, email: f.email });
      toast('Đã lưu thông tin xuất hóa đơn', 'good');
      void qc.invalidateQueries({ queryKey: ['buyer', billId] });
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
      void qc.invalidateQueries({ queryKey: ['bill'] });
      onSaved?.();
    } catch (e) {
      toast(e instanceof ApiError && e.body?.error === 'EINVOICE_ISSUED' ? 'Hóa đơn đã phát hành — liên hệ kế toán để lập hóa đơn điều chỉnh' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="text-sm font-medium">Mã số thuế</span>
          <input className={input} inputMode="numeric" value={f.taxCode} onChange={set('taxCode')} placeholder="10 số hoặc 10 số-3 số" />
        </label>
        <Button variant="secondary" disabled={busy || f.taxCode.trim().length < 10} onClick={() => void lookup()}>
          Tra cứu
        </Button>
      </div>
      <label className="block">
        <span className="text-sm font-medium">Tên đơn vị</span>
        <input className={input} value={f.name} onChange={set('name')} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Địa chỉ</span>
        <input className={input} value={f.address} onChange={set('address')} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Email nhận hóa đơn</span>
        <input className={input} type="email" value={f.email} onChange={set('email')} />
      </label>
      <Button className="w-full" disabled={busy || !f.taxCode || !f.name} onClick={() => void save()}>
        Lưu thông tin hóa đơn
      </Button>
    </div>
  );
}

/** Mục "Khách lấy hóa đơn công ty" gắn vào bill đang chờ thu tiền. */
export function BuyerSection({ billId }: { billId: string }) {
  const { api } = usePos();
  const saved = useQuery({ queryKey: ['buyer', billId], queryFn: () => api.get<BillBuyerDto | null>(`/bills/${billId}/buyer`) });
  const [open, setOpen] = useState(false);
  const b = saved.data;
  return (
    <section className="rounded-xl ring-1 ring-stone-200">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="font-medium">Khách lấy hóa đơn công ty</span>
        <span className="text-sm text-stone-500">{b?.taxCode ? `MST ${b.taxCode}` : open ? 'Đóng' : 'Nhập MST'}</span>
      </button>
      {open && (
        <div className="border-t border-stone-100 p-4">
          <BuyerForm billId={billId} onSaved={() => setOpen(false)} />
        </div>
      )}
    </section>
  );
}

/** Trạng thái hóa đơn của bill đã thanh toán; lỗi thì cho sửa người mua hoặc phát hành lại. */
export function EInvoiceStatusRow({ bill }: { bill: BillDto }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [fixing, setFixing] = useState(false);
  const inv = bill.einvoice;

  async function reissue() {
    try {
      await api.post(`/bills/${bill.id}/einvoice`);
      void qc.invalidateQueries({ queryKey: ['bill'] });
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  if (!inv) {
    return (
      <div className="flex items-center justify-between rounded-xl bg-stone-50 p-3 text-sm">
        <span>Chưa có hóa đơn điện tử</span>
        <Button size="sm" variant="secondary" onClick={() => void reissue()}>
          Phát hành
        </Button>
      </div>
    );
  }
  const [label, tone] = EINVOICE_STATUS[inv.status];
  return (
    <div className="space-y-2 rounded-xl bg-stone-50 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          Hóa đơn điện tử {inv.number && <b>số {inv.number}</b>}
          {inv.lookupCode && <span className="text-stone-500"> · mã tra cứu {inv.lookupCode}</span>}
        </span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {inv.error && <p className="text-red-700">{inv.error}</p>}
      {inv.status === 'FAILED' && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setFixing(true)}>
            Sửa thông tin người mua
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void reissue()}>
            Phát hành lại
          </Button>
        </div>
      )}
      {fixing && (
        <Modal title={`Sửa người mua – ${bill.number}`} onClose={() => setFixing(false)}>
          <BuyerForm billId={bill.id} onSaved={() => setFixing(false)} />
        </Modal>
      )}
    </div>
  );
}

/** Hóa đơn lỗi / chưa phát hành cần xử lý trong ngày (mục 12.8). */
export function EInvoiceAlerts() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['einvoices', 'attention'], queryFn: () => api.get<EInvoiceDto[]>('/einvoices/attention'), refetchInterval: 60_000 });
  const [fixing, setFixing] = useState<EInvoiceDto | null>(null);
  const list = q.data ?? [];

  async function retryAll() {
    try {
      const r = await api.post<{ checked: number; issued: number }>('/einvoices/retry-pending');
      toast(`Đã phát hành ${r.issued}/${r.checked} hóa đơn`, r.issued === r.checked ? 'good' : 'danger');
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      void qc.invalidateQueries({ queryKey: ['einvoices'] });
    }
  }

  return (
    <section className="no-print space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Hóa đơn điện tử cần xử lý</h2>
        {list.some((i) => i.status !== 'FAILED') && (
          <Button size="sm" variant="secondary" onClick={() => void retryAll()}>
            Gửi lại hóa đơn đang chờ
          </Button>
        )}
      </div>
      {list.length === 0 && <p className="rounded-2xl bg-white p-6 text-center text-stone-500 ring-1 ring-stone-200">Mọi hóa đơn đã phát hành.</p>}
      {list.map((i) => {
        const [label, tone] = EINVOICE_STATUS[i.status];
        return (
          <article key={i.id} className={`rounded-2xl bg-white p-4 ring-2 ${i.status === 'FAILED' ? 'ring-red-300' : 'ring-amber-300'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-bold">
                  Bill {i.billNumber} · {formatVnd(i.total)}
                  {i.kind !== 'ORIGINAL' && <span className="font-normal text-stone-500"> ({i.kind === 'ADJUSTMENT' ? 'điều chỉnh' : 'thay thế'})</span>}
                </div>
                <div className="text-sm text-stone-500">
                  Tạo lúc {formatTime(i.createdAt)} · gửi {i.attempts} lần{i.buyer?.taxCode ? ` · MST ${i.buyer.taxCode}` : ''}
                </div>
              </div>
              <Badge tone={tone}>{label}</Badge>
            </div>
            {i.error && <p className="mt-2 text-sm text-red-700">{i.error}</p>}
            {i.status === 'FAILED' && i.kind === 'ORIGINAL' && (
              <Button className="mt-3" size="sm" onClick={() => setFixing(i)}>
                Sửa thông tin người mua & gửi lại
              </Button>
            )}
          </article>
        );
      })}
      {fixing && (
        <Modal title={`Sửa người mua – ${fixing.billNumber}`} onClose={() => setFixing(null)}>
          <BuyerForm billId={fixing.billId} onSaved={() => setFixing(null)} />
        </Modal>
      )}
    </section>
  );
}
