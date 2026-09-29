/**
 * Tài liệu in dạng cấu trúc (mục 13.4): API dựng nội dung phiếu, print agent tại quán chỉ việc
 * mã hóa thành lệnh ESC/POS cho từng máy in. Đổi mẫu phiếu không phải cập nhật agent.
 */
export type PrintLine =
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; size?: 1 | 2 }
  /** Hai cột: trái (tên món) và phải (số tiền), tự cắt cho vừa khổ giấy. */
  | { kind: 'pair'; left: string; right: string; bold?: boolean }
  | { kind: 'rule' }
  | { kind: 'feed'; lines: number }
  | { kind: 'qr'; data: string };

export interface PrintDocument {
  lines: PrintLine[];
  /** Cắt giấy sau khi in. */
  cut?: boolean;
  /** Kêu bíp (phiếu bếp dự phòng). */
  beep?: boolean;
}

/** Đích in: mã trạm bếp (BEP_NONG, QUAY_BAR…) hoặc RECEIPT cho máy in phiếu thanh toán ở quầy. */
export const RECEIPT_TARGET = 'RECEIPT';

export type PrinterState = 'UNKNOWN' | 'ONLINE' | 'OFFLINE' | 'PAPER_OUT' | 'ERROR';
export type PrintJobStatus = 'QUEUED' | 'PRINTING' | 'DONE' | 'CANCELLED';
export type PrintJobKind = 'KITCHEN_TICKET' | 'RECEIPT' | 'TEST';

export interface PrinterDto {
  target: string;
  name: string;
  state: PrinterState;
  lastError: string | null;
  lastSeenAt: string | null;
  /** Agent không gửi nhịp quá lâu: coi như mất kết nối. */
  stale: boolean;
}

export interface PrintJobDto {
  id: string;
  target: string;
  kind: PrintJobKind;
  title: string;
  status: PrintJobStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  printedAt: string | null;
}

/** Agent báo trạng thái từng máy in khi hỏi việc. */
export interface AgentPollRequest {
  printers: { target: string; name?: string; state: PrinterState; error?: string | null }[];
}

export interface AgentJob {
  id: string;
  target: string;
  kind: PrintJobKind;
  title: string;
  document: PrintDocument;
}
