export interface TaxRate {
  taxGroup: string;
  /** Thuế suất theo điểm cơ bản: 800 = 8%, 1000 = 10%. */
  rateBp: number;
  /** Ngày hiệu lực dạng YYYY-MM-DD, tính cả hai đầu. */
  validFrom: string;
  validTo: string | null;
}

export class MissingTaxRateError extends Error {
  constructor(taxGroup: string, date: string) {
    super(`Không có thuế suất hiệu lực cho nhóm ${taxGroup} ngày ${date}`);
  }
}

/** Chọn thuế suất theo nhóm thuế và ngày lập (mục 12.3). */
export function resolveTaxRate(rates: TaxRate[], taxGroup: string, date: string): number {
  const matches = rates.filter(
    (r) => r.taxGroup === taxGroup && r.validFrom <= date && (r.validTo === null || date <= r.validTo),
  );
  if (matches.length === 0) throw new MissingTaxRateError(taxGroup, date);
  // Nếu cấu hình chồng lấn, dòng có ngày bắt đầu muộn nhất thắng.
  return matches.sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0].rateBp;
}
