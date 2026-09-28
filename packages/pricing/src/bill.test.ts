import { describe, expect, it } from 'vitest';
import { allocate, businessDay, divRound, MissingTaxRateError, priceBill, splitBill, type TaxRate } from './index';

// Bảng thuế suất có ngày hiệu lực: giảm 10% → 8% cho đồ ăn đến hết 2026, bia không được giảm.
const RATES: TaxRate[] = [
  { taxGroup: 'FOOD', rateBp: 1000, validFrom: '2000-01-01', validTo: '2025-06-30' },
  { taxGroup: 'FOOD', rateBp: 800, validFrom: '2025-07-01', validTo: '2026-12-31' },
  { taxGroup: 'FOOD', rateBp: 1000, validFrom: '2027-01-01', validTo: null },
  { taxGroup: 'ALCOHOL', rateBp: 1000, validFrom: '2000-01-01', validTo: null },
];

const LINES = [
  { id: 'pho', name: 'Phở bò', qty: 2, unitPrice: 65_000, taxGroup: 'FOOD' },
  { id: 'bia', name: 'Bia Sài Gòn', qty: 4, unitPrice: 25_000, taxGroup: 'ALCOHOL' },
];

describe('làm tròn', () => {
  it('làm tròn nửa lên, đối xứng với số âm', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 3)).toBe(1);
  });

  it('phân bổ giữ nguyên tổng', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b)).toBe(-100);
    expect(allocate(23_000, [130_000, 100_000])).toEqual([13_000, 10_000]);
  });
});

describe('golden: bill đồ ăn + bia (giá đã gồm VAT)', () => {
  it('tách đúng từng mức thuế suất năm 2026', () => {
    const bill = priceBill({ lines: LINES, taxRates: RATES, date: '2026-09-29' });
    expect(bill.total).toBe(230_000);
    expect(bill.taxes).toEqual([
      { taxGroup: 'ALCOHOL', rateBp: 1000, base: 90_909, tax: 9_091 },
      { taxGroup: 'FOOD', rateBp: 800, base: 120_370, tax: 9_630 },
    ]);
    expect(bill.totalTax).toBe(18_721);
  });

  it('qua 01/01/2027 tự áp dụng thuế suất mới', () => {
    const bill = priceBill({ lines: LINES, taxRates: RATES, date: '2027-01-01' });
    const food = bill.taxes.find((t) => t.taxGroup === 'FOOD')!;
    expect(food).toEqual({ taxGroup: 'FOOD', rateBp: 1000, base: 118_182, tax: 11_818 });
    expect(bill.total).toBe(230_000);
  });

  it('giá chưa gồm VAT thì cộng thuế lên trên', () => {
    const bill = priceBill({
      lines: LINES,
      taxRates: RATES,
      date: '2026-09-29',
      config: { pricesIncludeVat: false, rounding: 'LINE' },
    });
    expect(bill.totalBase).toBe(230_000);
    expect(bill.totalTax).toBe(10_400 + 10_000);
    expect(bill.total).toBe(250_400);
  });

  it('giảm giá bill phân bổ theo tỷ lệ, tổng vẫn khớp', () => {
    const bill = priceBill({ lines: LINES, billDiscount: 23_000, taxRates: RATES, date: '2026-09-29' });
    expect(bill.discount).toBe(23_000);
    expect(bill.total).toBe(207_000);
    expect(bill.lines.map((l) => l.amount)).toEqual([117_000, 90_000]);
  });

  it('thiếu thuế suất thì báo lỗi, không đoán', () => {
    expect(() =>
      priceBill({ lines: [{ ...LINES[0], taxGroup: 'XYZ' }], taxRates: RATES, date: '2026-09-29' }),
    ).toThrow(MissingTaxRateError);
  });

  it('từ chối tiền số thực', () => {
    expect(() =>
      priceBill({ lines: [{ ...LINES[0], unitPrice: 65_000.5 }], taxRates: RATES, date: '2026-09-29' }),
    ).toThrow(RangeError);
  });
});

describe('tách bill', () => {
  it('tổng các bill con bằng bill gốc', () => {
    const bill = priceBill({ lines: LINES, billDiscount: 7_777, taxRates: RATES, date: '2026-09-29' });
    const parts = splitBill(bill, [['pho'], ['bia']]);
    expect(parts.reduce((a, p) => a + p.total, 0)).toBe(bill.total);
    expect(parts.reduce((a, p) => a + p.totalTax, 0)).toBe(bill.totalTax);
  });

  it('không cho bỏ sót hoặc lặp dòng', () => {
    const bill = priceBill({ lines: LINES, taxRates: RATES, date: '2026-09-29' });
    expect(() => splitBill(bill, [['pho']])).toThrow();
    expect(() => splitBill(bill, [['pho', 'bia'], ['bia']])).toThrow();
  });
});

describe('ngày kinh doanh', () => {
  it('bill 01:00 sáng thuộc ngày hôm trước', () => {
    expect(businessDay(new Date('2026-09-29T18:00:00Z'))).toBe('2026-09-29'); // 01:00 ngày 30 giờ VN
    expect(businessDay(new Date('2026-09-29T21:30:00Z'))).toBe('2026-09-30'); // 04:30 ngày 30 giờ VN
  });
});
