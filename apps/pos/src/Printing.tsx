import type { PrinterDto, PrinterState, PrintJobDto } from '@nhs/types';
import { Badge, Button, errorMessage, formatTime, Modal, newKey } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PairingCode } from './Alerts';
import { usePos } from './context';

export interface PrintStatus {
  printers: PrinterDto[];
  pending: PrintJobDto[];
}

const STATE: Record<PrinterState, [string, 'good' | 'warn' | 'danger' | 'neutral']> = {
  ONLINE: ['Sẵn sàng', 'good'],
  UNKNOWN: ['Chưa rõ', 'neutral'],
  OFFLINE: ['Mất kết nối', 'danger'],
  PAPER_OUT: ['Hết giấy', 'danger'],
  ERROR: ['Lỗi', 'danger'],
};

/** Máy in có vấn đề: agent không gửi nhịp, hoặc máy báo hết giấy / mất kết nối / lỗi. */
export const printerProblem = (p: PrinterDto) => p.stale || ['OFFLINE', 'PAPER_OUT', 'ERROR'].includes(p.state);

export function usePrintStatus(enabled = true) {
  const { api } = usePos();
  return useQuery({ queryKey: ['print'], queryFn: () => api.get<PrintStatus>('/print/status'), refetchInterval: 15_000, enabled });
}

/** Gửi lệnh in; mỗi lần bấm một khóa riêng, bấm đúp do mạng chập chờn vẫn chỉ in một lần. */
export function usePrint() {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function print(path: string, label: string) {
    setBusy(true);
    try {
      await api.post(path, undefined, { 'idempotency-key': newKey() });
      toast(`Đã gửi lệnh in ${label}`, 'good');
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['print'] });
    }
  }
  return { print, busy };
}

/** Máy in và lệnh in còn chờ (mục 15: máy in hết giấy / mất kết nối → lệnh nằm trong hàng đợi, POS báo lỗi). */
export function PrinterPanel() {
  const { api, toast, role } = usePos();
  const qc = useQueryClient();
  const status = usePrintStatus();
  const { print, busy } = usePrint();
  const [pairing, setPairing] = useState(false);
  const printers = status.data?.printers ?? [];
  const pending = status.data?.pending ?? [];
  const isManager = role === 'MANAGER' || role === 'ADMIN';

  async function cancel(j: PrintJobDto) {
    if (!window.confirm(`Hủy lệnh in "${j.title}"?`)) return;
    try {
      await api.post(`/print/jobs/${j.id}/cancel`);
      void qc.invalidateQueries({ queryKey: ['print'] });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <section className="no-print space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Máy in</h2>
        {isManager && (
          <Button size="sm" variant="secondary" onClick={() => setPairing(true)}>
            Ghép print agent
          </Button>
        )}
      </div>
      {printers.length === 0 && (
        <p className="rounded-2xl bg-white p-6 text-center text-stone-500 ring-1 ring-stone-200">
          Chưa có print agent nào kết nối. Phiếu vẫn in được bằng máy in của trình duyệt.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {printers.map((p) => {
          const [label, tone] = p.stale ? (['Agent mất kết nối', 'danger'] as const) : STATE[p.state];
          return (
            <article key={p.target} className={`rounded-2xl bg-white p-4 ring-1 ${printerProblem(p) ? 'ring-2 ring-red-300' : 'ring-stone-200'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{p.name}</span>
                <Badge tone={tone}>{label}</Badge>
              </div>
              <div className="mt-1 text-sm text-stone-500">
                {p.target}
                {p.lastSeenAt && ` · nhịp cuối ${formatTime(p.lastSeenAt)}`}
              </div>
              {p.lastError && printerProblem(p) && <p className="mt-1 text-sm text-red-700">{p.lastError}</p>}
              <Button className="mt-2" size="sm" variant="ghost" disabled={busy} onClick={() => void print(`/printers/${p.target}/test`, `thử ở ${p.name}`)}>
                In thử
              </Button>
            </article>
          );
        })}
      </div>
      {pending.length > 0 && (
        <div className="rounded-2xl bg-white ring-1 ring-amber-300">
          <h3 className="border-b border-stone-100 px-4 py-2 text-sm font-semibold">Lệnh in đang chờ ({pending.length})</h3>
          <ul className="divide-y divide-stone-100 text-sm">
            {pending.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span>
                  {j.title} <span className="text-stone-500">· {formatTime(j.createdAt)}</span>
                  {j.attempts > 0 && <span className="text-stone-500"> · thử {j.attempts} lần</span>}
                  {j.error && <span className="block text-red-700">{j.error}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={j.status === 'PRINTING' ? 'info' : 'warn'}>{j.status === 'PRINTING' ? 'Đang in' : 'Chờ máy in'}</Badge>
                  <Button size="sm" variant="ghost" onClick={() => void cancel(j)}>
                    Hủy
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pairing && <PairAgent onClose={() => setPairing(false)} />}
    </section>
  );
}

function PairAgent({ onClose }: { onClose: () => void }) {
  const { api, toast } = usePos();
  const q = useQuery({
    queryKey: ['pair', 'printer'],
    queryFn: async () => {
      try {
        return (await api.post<{ code: string }>('/devices/pairing-codes', { kind: 'PRINTER' })).code;
      } catch (e) {
        toast(errorMessage(e));
        return null;
      }
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  return (
    <Modal title="Ghép print agent" onClose={onClose}>
      {q.data ? (
        <>
          <PairingCode code={q.data} hint="Chạy print agent trên máy tính tại quán với PAIRING_CODE bằng mã này. Mã hết hạn sau 10 phút." />
          <pre className="mt-4 overflow-x-auto rounded-xl bg-stone-900 p-3 text-xs text-stone-100">
            {`PAIRING_CODE=${q.data} \\\nPRINTERS="BEP_NONG=tcp://192.168.1.51:9100;RECEIPT=tcp://192.168.1.50:9100" \\\nnode apps/print-agent/dist/main.js`}
          </pre>
        </>
      ) : (
        <p className="text-stone-500">Đang tạo mã…</p>
      )}
    </Modal>
  );
}
