const vnd = new Intl.NumberFormat('vi-VN');

/** Tiền là số nguyên đồng; chỉ định dạng khi hiển thị. */
export const formatVnd = (amount: number) => `${vnd.format(amount)}đ`;

export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

export function minutesSince(iso: string, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
