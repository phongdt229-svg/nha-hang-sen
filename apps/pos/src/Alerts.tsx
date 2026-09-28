import type { KitchenTicketDto } from '@nhs/types';
import { Badge, Button, errorMessage, formatTime, minutesSince, Modal } from '@nhs/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { STATION_LABEL, usePos } from './context';

/** Phiếu bếp hết lượt gửi lại (FALLBACK): in phiếu giấy, xác nhận tay khi bếp đã nhận (mục 6.4). */
export function Alerts({ tickets }: { tickets: KitchenTicketDto[] }) {
  const { api, toast, role } = usePos();
  const qc = useQueryClient();
  const [printing, setPrinting] = useState<KitchenTicketDto | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  async function manualAck(t: KitchenTicketDto) {
    try {
      await api.post(`/kitchen/tickets/${t.id}/ack`);
      void qc.invalidateQueries({ queryKey: ['fallback'] });
      toast('Đã ghi nhận bếp nhận phiếu', 'good');
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="no-print flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Cảnh báo bếp</h1>
        {(role === 'MANAGER' || role === 'ADMIN' || role === 'WAITER') && (
          <Button variant="secondary" onClick={() => setPairOpen(true)}>
            Ghép màn hình bếp
          </Button>
        )}
      </div>
      {tickets.length === 0 && <p className="no-print rounded-2xl bg-white p-8 text-center text-stone-500 ring-1 ring-stone-200">Mọi order đều đã vào bếp.</p>}
      {tickets.map((t) => (
        <article key={t.id} className="no-print rounded-2xl bg-white p-4 ring-2 ring-amber-300">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-bold">
                {t.tableCodes.join(' + ')} · Order {t.orderNumber} · {STATION_LABEL[t.station] ?? t.station}
              </div>
              <div className="text-sm text-stone-500">
                Gửi {t.attempts} lần, không có phản hồi · {formatTime(t.createdAt)} ({minutesSince(t.createdAt)} phút)
              </div>
            </div>
            <Badge tone="warn">Chờ bếp xác nhận</Badge>
          </div>
          <ul className="my-3 text-sm">
            {t.items.map((i) => (
              <li key={i.id}>
                {i.qty} × {i.name}
                {i.note && <span className="text-stone-500"> — {i.note}</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPrinting(t)}>
              In phiếu giấy
            </Button>
            <Button onClick={() => void manualAck(t)} disabled={role !== 'MANAGER' && role !== 'ADMIN'} title="Chỉ quản lý ca xác nhận thay bếp">
              Bếp đã nhận (nhập tay)
            </Button>
          </div>
        </article>
      ))}
      {printing && <KitchenSlip ticket={printing} onClose={() => setPrinting(null)} />}
      {pairOpen && <PairKds onClose={() => setPairOpen(false)} />}
    </div>
  );
}

function KitchenSlip({ ticket, onClose }: { ticket: KitchenTicketDto; onClose: () => void }) {
  return (
    <>
      <div className="hidden print:block print:font-mono">
        <p className="text-lg font-bold">PHIẾU BẾP – {STATION_LABEL[ticket.station] ?? ticket.station}</p>
        <p>
          Bàn {ticket.tableCodes.join(' + ')} · Order {ticket.orderNumber} · {formatTime(ticket.createdAt)}
        </p>
        <hr />
        {ticket.items.map((i) => (
          <p key={i.id}>
            {i.qty} x {i.name} {i.note ? `(${i.note})` : ''}
          </p>
        ))}
      </div>
      <Modal title={`Phiếu bếp ${ticket.orderNumber}`} onClose={onClose}>
        <p className="mb-4 text-sm text-stone-600">Bản in dự phòng dùng máy in của trình duyệt. Print agent ESC/POS sẽ thay thế ở bản sau.</p>
        <Button className="w-full" onClick={() => window.print()}>
          In
        </Button>
      </Modal>
    </>
  );
}

function PairKds({ onClose }: { onClose: () => void }) {
  const { api, toast } = usePos();
  const menu = useQuery({ queryKey: ['menu'], queryFn: () => api.get<{ items: { station: string }[] }>('/menu') });
  const stations = [...new Set((menu.data?.items ?? []).map((i) => i.station))];
  const [code, setCode] = useState<string | null>(null);
  async function create(station: string) {
    try {
      setCode((await api.post<{ code: string }>('/devices/pairing-codes', { kind: 'KDS', station })).code);
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  return (
    <Modal title="Ghép màn hình bếp" onClose={onClose}>
      {code ? (
        <PairingCode code={code} hint="Nhập mã này trên màn hình bếp. Mã hết hạn sau 10 phút." />
      ) : (
        <div className="grid gap-2">
          {stations.map((s) => (
            <Button key={s} variant="secondary" onClick={() => void create(s)}>
              {STATION_LABEL[s] ?? s}
            </Button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function PairingCode({ code, hint }: { code: string; hint: string }) {
  return (
    <div className="text-center">
      <div className="rounded-2xl bg-sen-50 py-6 text-5xl font-bold tracking-[0.3em] text-sen-700">{code}</div>
      <p className="mt-3 text-sm text-stone-600">{hint}</p>
    </div>
  );
}
