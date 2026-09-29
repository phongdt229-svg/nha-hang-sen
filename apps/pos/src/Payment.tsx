import type { BillDto } from '@nhs/types';
import { Button, errorMessage, formatTime, formatVnd, Modal, newKey } from '@nhs/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePos } from './context';
import { printerProblem, usePrint, usePrintStatus } from './Printing';
import { BillTable } from './TablePanel';

interface PaymentResult {
  payment: { id: string; method: string; amount: number; received: number | null; change: number; status: string; qrUrl: string | null };
  bill: BillDto;
}

/** Thu tiền mặt hoặc tạo QR đúng số tiền; mỗi lần bấm dùng một Idempotency-Key. */
export function PaymentBox({ bill, onCashPaid }: { bill: BillDto; onCashPaid: (change: number) => void }) {
  const { api, toast } = usePos();
  const qc = useQueryClient();
  const remaining = bill.total - bill.paid;
  const [received, setReceived] = useState(remaining);
  const [key, setKey] = useState(newKey);
  const [pendingQr, setPendingQr] = useState<PaymentResult['payment'] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bill'] });
    void qc.invalidateQueries({ queryKey: ['tables'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['session'] });
  };

  async function pay(method: 'CASH' | 'QR') {
    setBusy(true);
    try {
      const r = await api.post<PaymentResult>(`/bills/${bill.id}/payments`, method === 'CASH' ? { method, received } : { method }, { 'idempotency-key': key });
      setKey(newKey());
      if (method === 'QR') setPendingQr(r.payment);
      else {
        onCashPaid(r.payment.change);
        toast(`Đã thu ${formatVnd(r.payment.amount)}`, 'good');
        refresh();
      }
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmQr(ok: boolean) {
    if (!pendingQr) return;
    setBusy(true);
    try {
      await api.post(`/payments/${pendingQr.id}/${ok ? 'confirm' : 'cancel'}`);
      if (ok) toast('Đã xác nhận nhận tiền', 'good');
      setPendingQr(null);
      refresh();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const quick = [...new Set([remaining, Math.ceil(remaining / 50_000) * 50_000, Math.ceil(remaining / 100_000) * 100_000, 500_000])].filter((v) => v >= remaining).slice(0, 4);

  return (
    <section className="space-y-3 rounded-xl bg-sen-50 p-4">
      <div className="flex justify-between text-lg font-bold">
        <span>Cần thu</span>
        <span className="tabular-nums text-sen-700">{formatVnd(remaining)}</span>
      </div>
      {pendingQr ? (
        <div className="space-y-3 text-center">
          {pendingQr.qrUrl ? (
            <img src={pendingQr.qrUrl} alt={`Mã QR thanh toán ${formatVnd(pendingQr.amount)}`} className="mx-auto w-56 rounded-lg bg-white p-2" />
          ) : (
            <p className="rounded-lg bg-white p-3 text-sm text-stone-600">
              Chưa cấu hình tài khoản VietQR (VIETQR_BANK_BIN, VIETQR_ACCOUNT_NO). Nội dung chuyển khoản: <b>{bill.number}</b>
            </p>
          )}
          <p className="text-sm">Chờ khách chuyển {formatVnd(pendingQr.amount)} — xác nhận khi đã thấy tiền về.</p>
          <div className="flex gap-2">
            <Button className="flex-1" variant="good" disabled={busy} onClick={() => void confirmQr(true)}>
              Đã nhận tiền
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void confirmQr(false)}>
              Hủy QR
            </Button>
          </div>
        </div>
      ) : (
        <>
          <label className="block">
            <span className="text-sm font-medium">Tiền mặt khách đưa</span>
            <input type="number" className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2.5 text-lg" value={received} onChange={(e) => setReceived(Number(e.target.value))} />
          </label>
          <div className="flex flex-wrap gap-2">
            {quick.map((v) => (
              <Button key={v} size="sm" variant="secondary" onClick={() => setReceived(v)}>
                {formatVnd(v)}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" variant="good" disabled={busy || received <= 0} onClick={() => void pay('CASH')}>
              Thu tiền mặt
            </Button>
            <Button size="lg" disabled={busy} onClick={() => void pay('QR')}>
              QR chuyển khoản
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Phiếu thanh toán: in ra máy in nhiệt ở quầy qua print agent; máy in của trình duyệt là dự phòng. */
export function Receipt({ bill, onClose }: { bill: BillDto; onClose: () => void }) {
  const { print, busy } = usePrint();
  const printer = usePrintStatus().data?.printers.find((p) => p.target === 'RECEIPT');
  return (
    <>
      <div className="hidden text-[12px] print:block print:w-[72mm] print:font-mono">
        <p className="text-center text-base font-bold">NHÀ HÀNG SEN</p>
        <p className="text-center">PHIẾU THANH TOÁN {bill.number}</p>
        <p className="text-center">{formatTime(new Date().toISOString())}</p>
        <hr className="my-1" />
        {bill.lines.map((l) => (
          <div key={l.orderItemId} className="flex justify-between">
            <span>
              {l.qty} x {l.name}
            </span>
            <span>{formatVnd(l.amount)}</span>
          </div>
        ))}
        <hr className="my-1" />
        {bill.taxes.map((t) => (
          <div key={t.taxGroup + t.rate} className="flex justify-between">
            <span>VAT {t.rate / 100}%</span>
            <span>{formatVnd(t.tax)}</span>
          </div>
        ))}
        <div className="flex justify-between font-bold">
          <span>TỔNG</span>
          <span>{formatVnd(bill.total)}</span>
        </div>
        {bill.einvoice?.status === 'ISSUED' ? (
          <div className="mt-2 text-center">
            <p>
              Hóa đơn điện tử số {bill.einvoice.number} ({bill.einvoice.series})
            </p>
            <p>Mã tra cứu: {bill.einvoice.lookupCode}</p>
            {bill.einvoice.lookupUrl && <p className="break-all">{bill.einvoice.lookupUrl}</p>}
          </div>
        ) : (
          <p className="mt-2 text-center">Hóa đơn điện tử đang phát hành — tra cứu lại bằng mã bill {bill.number}</p>
        )}
        <p className="text-center">Cảm ơn quý khách!</p>
      </div>
      <Modal title={`Phiếu thanh toán ${bill.number}`} onClose={onClose}>
        <BillTable bill={bill} />
        {printer && printerProblem(printer) && (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">
            {printer.name}: {printer.stale ? 'print agent mất kết nối' : (printer.lastError ?? printer.state)}. Lệnh in sẽ nằm trong hàng đợi đến khi máy in sẵn sàng.
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button disabled={busy} onClick={() => void print(`/bills/${bill.id}/print`, `phiếu ${bill.number}`)}>
            In máy in quầy
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            In bằng trình duyệt
          </Button>
        </div>
      </Modal>
    </>
  );
}
