import { allocate, assertMoney, divRound } from './rounding';
import { resolveTaxRate, type TaxRate } from './tax';

export interface PricingConfig {
  /** Giá niêm yết đã gồm VAT hay chưa (mục 12.3). */
  pricesIncludeVat: boolean;
  /** LINE: làm tròn thuế từng dòng; TOTAL: làm tròn theo tổng từng mức thuế. */
  rounding: 'LINE' | 'TOTAL';
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = { pricesIncludeVat: true, rounding: 'LINE' };

export interface PricingLineInput {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
  /** Giảm giá theo dòng, đồng. */
  discount?: number;
  taxGroup: string;
}

export interface PricingInput {
  lines: PricingLineInput[];
  /** Giảm giá cả bill, đồng; phân bổ vào các dòng theo tỷ lệ. */
  billDiscount?: number;
  taxRates: TaxRate[];
  /** Ngày lập (YYYY-MM-DD, giờ VN) để chọn thuế suất. */
  date: string;
  config?: PricingConfig;
}

export interface PricedLine {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
  taxGroup: string;
  rateBp: number;
  /** Tổng giảm giá của dòng (dòng + phần phân bổ từ bill). */
  discount: number;
  /** Tiền trước thuế. */
  base: number;
  tax: number;
  /** Thành tiền khách trả cho dòng. */
  amount: number;
}

export interface TaxSummary {
  taxGroup: string;
  rateBp: number;
  base: number;
  tax: number;
}

export interface PricedBill {
  lines: PricedLine[];
  /** Tổng tiền hàng theo giá niêm yết, trước giảm giá. */
  subtotal: number;
  discount: number;
  taxes: TaxSummary[];
  totalBase: number;
  totalTax: number;
  total: number;
}

function taxOf(net: number, rateBp: number, inclusive: boolean): number {
  return inclusive ? divRound(net * rateBp, 10000 + rateBp) : divRound(net * rateBp, 10000);
}

export function priceBill(input: PricingInput): PricedBill {
  const config = input.config ?? DEFAULT_PRICING_CONFIG;
  const billDiscount = input.billDiscount ?? 0;
  assertMoney(billDiscount, 'Giảm giá bill');

  const gross = input.lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty === 0) throw new RangeError(`Số lượng không hợp lệ: ${l.name}`);
    assertMoney(l.unitPrice, `Đơn giá ${l.name}`);
    const lineDiscount = l.discount ?? 0;
    assertMoney(lineDiscount, `Giảm giá ${l.name}`);
    return l.qty * l.unitPrice - lineDiscount;
  });
  const grossTotal = gross.reduce((a, b) => a + b, 0);
  if (billDiscount > grossTotal) throw new RangeError('Giảm giá lớn hơn tổng bill');
  const allocated = allocate(billDiscount, gross);

  const lines: PricedLine[] = input.lines.map((l, i) => {
    const rateBp = resolveTaxRate(input.taxRates, l.taxGroup, input.date);
    const net = gross[i] - allocated[i];
    const tax = taxOf(net, rateBp, config.pricesIncludeVat);
    const base = config.pricesIncludeVat ? net - tax : net;
    return {
      id: l.id,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      taxGroup: l.taxGroup,
      rateBp,
      discount: (l.discount ?? 0) + allocated[i],
      base,
      tax,
      amount: base + tax,
    };
  });

  return summarize(lines, config);
}

/** Tổng hợp các dòng đã tính thành bill; dùng chung cho tách bill. */
export function summarize(lines: PricedLine[], config: PricingConfig = DEFAULT_PRICING_CONFIG): PricedBill {
  const groups = new Map<string, TaxSummary>();
  for (const l of lines) {
    const key = `${l.taxGroup}|${l.rateBp}`;
    const g = groups.get(key) ?? { taxGroup: l.taxGroup, rateBp: l.rateBp, base: 0, tax: 0 };
    g.base += l.base;
    g.tax += l.tax;
    groups.set(key, g);
  }
  let taxes = [...groups.values()].sort((a, b) => a.taxGroup.localeCompare(b.taxGroup) || a.rateBp - b.rateBp);

  if (config.rounding === 'TOTAL') {
    // Tính lại thuế trên tổng của từng mức để khớp nhà cung cấp hóa đơn làm tròn theo tổng.
    taxes = taxes.map((g) => {
      const net = config.pricesIncludeVat ? g.base + g.tax : g.base;
      const tax = taxOf(net, g.rateBp, config.pricesIncludeVat);
      return { ...g, tax, base: config.pricesIncludeVat ? net - tax : net };
    });
  }

  const totalBase = taxes.reduce((a, g) => a + g.base, 0);
  const totalTax = taxes.reduce((a, g) => a + g.tax, 0);
  return {
    lines,
    subtotal: lines.reduce((a, l) => a + l.qty * l.unitPrice, 0),
    discount: lines.reduce((a, l) => a + l.discount, 0),
    taxes,
    totalBase,
    totalTax,
    total: totalBase + totalTax,
  };
}

/**
 * Tách bill theo nhóm dòng (theo món hoặc theo nhóm khách). Tách từ các dòng đã tính
 * nên tổng các bill con luôn bằng bill gốc khi làm tròn theo dòng.
 */
export function splitBill(bill: PricedBill, groups: string[][], config: PricingConfig = DEFAULT_PRICING_CONFIG) {
  const all = groups.flat();
  if (new Set(all).size !== all.length) throw new RangeError('Một dòng nằm trong nhiều bill con');
  const byId = new Map(bill.lines.map((l) => [l.id, l]));
  const missing = bill.lines.filter((l) => !all.includes(l.id));
  if (missing.length > 0 || all.some((id) => !byId.has(id))) {
    throw new RangeError('Các bill con phải chia hết đúng các dòng của bill gốc');
  }
  return groups.map((ids) => summarize(ids.map((id) => byId.get(id)!), config));
}
