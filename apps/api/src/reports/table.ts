/** Bảng số liệu dùng chung cho màn hình báo cáo và xuất file. */
export interface ReportColumn {
  key: string;
  label: string;
  kind?: 'money' | 'number' | 'text' | 'percent';
}

export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, number>;
}

export const n = (v: bigint | number | null | undefined) => Number(v ?? 0);
