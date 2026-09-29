import type { BillBuyer, BillLine, EInvoice } from '@prisma/client';
import type { HoaDonDong, HoaDonInput, NguoiMua } from '@nhs/einvoice-adapters';
import type { TaxSummary } from '@nhs/pricing';
import type { BillBuyerDto, EInvoiceDto } from '@nhs/types';
import { fromSnapshot } from '../billing/bill.calc';

export type TaxLine = { rate: number; base: number; tax: number };

/** Gom theo thuế suất (hóa đơn thể hiện tiền trước thuế, tiền thuế theo từng mức — mục 12.3). */
export function byRate(taxes: Pick<TaxSummary, 'rateBp' | 'base' | 'tax'>[]): TaxLine[] {
  const m = new Map<number, TaxLine>();
  for (const t of taxes) {
    const g = m.get(t.rateBp) ?? { rate: t.rateBp, base: 0, tax: 0 };
    g.base += t.base;
    g.tax += t.tax;
    m.set(t.rateBp, g);
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate);
}

export function toNguoiMua(b: BillBuyer | null): NguoiMua | null {
  if (!b) return null;
  return { loai: b.kind, maSoThue: b.taxCode, ten: b.name, diaChi: b.address, email: b.email, soDienThoai: b.phone, soDinhDanh: b.idNumber };
}

export function toBuyerDto(b: BillBuyer | null): BillBuyerDto | null {
  return b && { kind: b.kind, taxCode: b.taxCode, name: b.name, address: b.address, email: b.email, phone: b.phone };
}

/** Số liệu hóa đơn lấy từ ảnh chụp bill đã khóa, không tính lại, không nhập tay (mục 12.1). */
export function buildInvoice(key: string, billNumber: string, date: string, lines: BillLine[], buyer: BillBuyer | null): HoaDonInput {
  const priced = fromSnapshot(lines);
  const dong: HoaDonDong[] = priced.lines.map((l) => ({
    ten: l.name,
    soLuong: l.qty,
    donGia: l.unitPrice,
    thanhTienTruocThue: l.base,
    thueSuatBp: l.rateBp,
    tienThue: l.tax,
    giamGia: l.discount,
  }));
  return {
    khoa: key,
    maBill: billNumber,
    ngayLap: date,
    nguoiMua: toNguoiMua(buyer),
    dong,
    tongTruocThue: priced.totalBase,
    tongThue: priced.totalTax,
    tongThanhToan: priced.total,
    theoThueSuat: byRate(priced.taxes).map((t) => ({ thueSuatBp: t.rate, truocThue: t.base, tienThue: t.tax })),
  };
}

/** Dòng điều chỉnh giảm theo từng mức thuế (hoàn tiền sau khi đã xuất hóa đơn). */
export function adjustmentLines(taxes: TaxLine[], reason: string): HoaDonDong[] {
  return taxes.map((t) => ({
    ten: `Điều chỉnh giảm – ${reason} (thuế suất ${t.rate / 100}%)`,
    soLuong: 1,
    donGia: t.base,
    thanhTienTruocThue: t.base,
    thueSuatBp: t.rate,
    tienThue: t.tax,
    giamGia: 0,
  }));
}

export function toEInvoiceDto(e: EInvoice, billNumber: string, buyer: BillBuyer | null): EInvoiceDto {
  return {
    id: e.id,
    billId: e.billId,
    billNumber,
    kind: e.kind,
    provider: e.provider,
    status: e.status,
    templateCode: e.templateCode,
    series: e.series,
    number: e.number,
    lookupCode: e.lookupCode,
    lookupUrl: e.lookupUrl,
    taxAuthorityCode: e.taxAuthorityCode,
    issuedAt: e.issuedAt?.toISOString() ?? null,
    businessDay: e.businessDay,
    totalBase: e.totalBase,
    totalTax: e.totalTax,
    total: e.total,
    taxes: e.taxes as TaxLine[],
    buyer: toBuyerDto(buyer),
    error: e.error,
    attempts: e.attempts,
    createdAt: e.createdAt.toISOString(),
  };
}
