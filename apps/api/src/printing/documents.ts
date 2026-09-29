import type { BillDto, KitchenTicketDto, PrintDocument, PrintLine } from '@nhs/types';

const vnd = (v: number) => `${new Intl.NumberFormat('vi-VN').format(v)}đ`;
const time = (d: Date) => d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const shopName = () => process.env.SHOP_NAME ?? 'NHÀ HÀNG SEN';

const STATION_LABEL: Record<string, string> = { BEP_NONG: 'Bếp nóng', BEP_LANH: 'Bếp lạnh', QUAY_BAR: 'Quầy bar' };
export const targetLabel = (target: string) => (target === 'RECEIPT' ? 'Máy in quầy thu ngân' : (STATION_LABEL[target] ?? target));

/** Phiếu bếp: chữ to, không giá; in khi KDS không nhận phiếu (FALLBACK) hoặc bếp yêu cầu in lại. */
export function kitchenTicketDoc(t: KitchenTicketDto, reprint = false): PrintDocument {
  const lines: PrintLine[] = [
    { kind: 'text', text: `PHIẾU BẾP – ${targetLabel(t.station).toUpperCase()}`, align: 'center', bold: true },
    ...(reprint ? [{ kind: 'text', text: '(IN LẠI)', align: 'center' } as const] : []),
    { kind: 'text', text: `Bàn ${t.tableCodes.join(' + ')}`, align: 'center', bold: true, size: 2 },
    { kind: 'text', text: `Order ${t.orderNumber} · ${time(new Date(t.createdAt))}`, align: 'center' },
    { kind: 'rule' },
  ];
  for (const i of t.items) {
    if (i.status === 'CANCELLED') continue;
    lines.push({ kind: 'text', text: `${i.qty} x ${i.name}`, bold: true, size: 2 });
    if (i.note) lines.push({ kind: 'text', text: `   * ${i.note}` });
  }
  lines.push({ kind: 'rule' }, { kind: 'feed', lines: 2 });
  return { lines, cut: true, beep: true };
}

/** Phiếu thanh toán 80mm: món, VAT theo từng mức, tổng, số hóa đơn điện tử và QR tra cứu (mục 12.4). */
export function receiptDoc(bill: BillDto, tableCodes: string[]): PrintDocument {
  const lines: PrintLine[] = [
    { kind: 'text', text: shopName(), align: 'center', bold: true, size: 2 },
    ...(process.env.SHOP_ADDRESS ? [{ kind: 'text', text: process.env.SHOP_ADDRESS, align: 'center' } as const] : []),
    { kind: 'text', text: 'PHIẾU THANH TOÁN', align: 'center', bold: true },
    { kind: 'text', text: `${bill.number}${bill.label ? ` · ${bill.label}` : ''} · Bàn ${tableCodes.join(' + ') || '-'}`, align: 'center' },
    { kind: 'text', text: time(new Date()), align: 'center' },
    { kind: 'rule' },
  ];
  for (const l of bill.lines) {
    lines.push({ kind: 'pair', left: `${l.qty} x ${l.name}`, right: vnd(l.amount) });
    if (l.discount > 0) lines.push({ kind: 'pair', left: '   Giảm giá', right: `-${vnd(l.discount)}` });
  }
  lines.push({ kind: 'rule' });
  for (const t of bill.taxes) lines.push({ kind: 'pair', left: `Tiền hàng chịu VAT ${t.rate / 100}%`, right: vnd(t.base) }, { kind: 'pair', left: `  Thuế GTGT ${t.rate / 100}%`, right: vnd(t.tax) });
  lines.push({ kind: 'pair', left: 'TỔNG CỘNG', right: vnd(bill.total), bold: true });
  if (bill.paid > 0) lines.push({ kind: 'pair', left: 'Đã thanh toán', right: vnd(bill.paid) });
  if (bill.refunded > 0) lines.push({ kind: 'pair', left: 'Đã hoàn', right: `-${vnd(bill.refunded)}` });
  lines.push({ kind: 'rule' });

  const inv = bill.einvoice;
  if (inv?.status === 'ISSUED') {
    lines.push({ kind: 'text', text: `Hóa đơn điện tử số ${inv.number} (${inv.series})`, align: 'center' }, { kind: 'text', text: `Mã tra cứu: ${inv.lookupCode}`, align: 'center', bold: true });
    if (inv.lookupUrl) lines.push({ kind: 'qr', data: inv.lookupUrl });
  } else if (bill.status === 'PAID' || bill.status === 'CLOSED') {
    lines.push({ kind: 'text', text: `Hóa đơn điện tử đang phát hành – tra cứu theo mã ${bill.number}`, align: 'center' });
  } else {
    lines.push({ kind: 'text', text: 'PHIẾU TẠM TÍNH – CHƯA THANH TOÁN', align: 'center', bold: true });
  }
  lines.push({ kind: 'text', text: 'Cảm ơn quý khách!', align: 'center' }, { kind: 'feed', lines: 2 });
  return { lines, cut: true };
}

export function testDoc(target: string): PrintDocument {
  return {
    lines: [
      { kind: 'text', text: 'IN THỬ', align: 'center', bold: true, size: 2 },
      { kind: 'text', text: targetLabel(target), align: 'center' },
      { kind: 'text', text: time(new Date()), align: 'center' },
      { kind: 'rule' },
      { kind: 'pair', left: 'Tiếng Việt có dấu', right: 'Đồng ý' },
      { kind: 'pair', left: 'Căn phải', right: vnd(1_234_000) },
      { kind: 'feed', lines: 2 },
    ],
    cut: true,
  };
}
