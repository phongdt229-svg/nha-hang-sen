/** Việt Nam dùng UTC+7 cố định, không có giờ mùa hè. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Ngày kinh doanh (mục 10.1): bill lúc 01:00 sáng thuộc ngày hôm trước
 * nếu giờ chốt là 04:00. Trả về YYYY-MM-DD.
 */
export function businessDay(at: Date, cutoffHour = 4): string {
  const shifted = new Date(at.getTime() + VN_OFFSET_MS - cutoffHour * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Ngày lịch theo giờ Việt Nam, dùng để chọn thuế suất theo thời điểm lập hóa đơn. */
export function vnDate(at: Date): string {
  return new Date(at.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}
