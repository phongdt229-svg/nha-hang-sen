import type { Bill, BillLine } from '@prisma/client';
import { priceBill, vnDate, type PricedBill, type PricingConfig, type TaxRate } from '@nhs/pricing';
import type { BillDto } from '@nhs/types';
import type { Tx } from '../prisma/prisma.service';

export const pricingConfig = (): PricingConfig => ({
  pricesIncludeVat: (process.env.PRICES_INCLUDE_VAT ?? 'true') === 'true',
  rounding: process.env.TAX_ROUNDING === 'TOTAL' ? 'TOTAL' : 'LINE',
});

export const billNumber = (n: number) => `B${process.env.BRANCH_CODE ?? '001'}-${String(n).padStart(5, '0')}`;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function loadTaxRates(tx: Tx): Promise<TaxRate[]> {
  const rows = await tx.taxRate.findMany();
  return rows.map((r) => ({ taxGroup: r.taxGroup, rateBp: r.rateBp, validFrom: isoDate(r.validFrom), validTo: r.validTo ? isoDate(r.validTo) : null }));
}

/** Tính bill trực tiếp từ các món chưa hủy của phiên (khi bill còn OPEN). */
export async function priceLive(tx: Tx, bill: Bill, at = new Date()): Promise<PricedBill> {
  const items = await tx.orderItem.findMany({
    where: { order: { sessionId: bill.sessionId }, status: { not: 'CANCELLED' } },
    orderBy: [{ order: { number: 'asc' } }, { name: 'asc' }],
  });
  return priceBill({
    lines: items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, unitPrice: i.unitPrice, taxGroup: i.taxGroup })),
    billDiscount: bill.discount,
    taxRates: await loadTaxRates(tx),
    date: vnDate(at),
    config: pricingConfig(),
  });
}

export function toBillDto(bill: Bill, priced: PricedBill, paid: number, refunded = 0): BillDto {
  return {
    id: bill.id,
    number: billNumber(bill.number),
    sessionId: bill.sessionId,
    status: bill.status,
    version: bill.version,
    parentId: bill.parentId,
    label: bill.label,
    lines: priced.lines.map((l) => ({
      orderItemId: l.id,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: l.discount,
      taxGroup: l.taxGroup,
      taxRate: l.rateBp,
      amount: l.amount,
    })),
    subtotal: priced.subtotal,
    discount: priced.discount,
    taxes: priced.taxes.map((t) => ({ taxGroup: t.taxGroup, rate: t.rateBp, base: t.base, tax: t.tax })),
    totalTax: priced.totalTax,
    total: priced.total,
    paid,
    refunded,
  };
}

/** Dựng lại PricedBill từ ảnh chụp bill_lines (bill đã khóa không tính lại). */
export function fromSnapshot(lines: BillLine[]): PricedBill {
  const taxes = new Map<string, { taxGroup: string; rateBp: number; base: number; tax: number }>();
  for (const l of lines) {
    const k = `${l.taxGroup}|${l.rateBp}`;
    const g = taxes.get(k) ?? { taxGroup: l.taxGroup, rateBp: l.rateBp, base: 0, tax: 0 };
    g.base += l.base;
    g.tax += l.tax;
    taxes.set(k, g);
  }
  const t = [...taxes.values()].sort((a, b) => a.taxGroup.localeCompare(b.taxGroup));
  return {
    lines: lines.map((l) => ({ id: l.orderItemId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, taxGroup: l.taxGroup, rateBp: l.rateBp, discount: l.discount, base: l.base, tax: l.tax, amount: l.amount })),
    subtotal: lines.reduce((a, l) => a + l.qty * l.unitPrice, 0),
    discount: lines.reduce((a, l) => a + l.discount, 0),
    taxes: t,
    totalBase: t.reduce((a, g) => a + g.base, 0),
    totalTax: t.reduce((a, g) => a + g.tax, 0),
    total: lines.reduce((a, l) => a + l.amount, 0),
  };
}
