/**
 * Giao thức serial bridge ↔ firmware mBot v1 (firmware/mbot-v1/mbot_v1.ino): mỗi lệnh một dòng ASCII,
 * 115200 baud, kết thúc "\n". Chạy được qua cáp USB và module Bluetooth (cả hai hiện ra thành cổng COM).
 *
 * Bridge → robot:
 *   G <stop> <cid>   đi tới vạch dừng <stop> (chạy một chiều theo sa bàn, đếm vạch)
 *   S <cid>          dừng khẩn cấp
 *   P <cid> / R <cid> tạm dừng / chạy tiếp
 *   C <cid>          hủy đích hiện tại, đứng yên
 *   Q                hỏi trạng thái ngay
 *
 * Robot → bridge:
 *   HELLO <model> <fw>          khởi động xong, đang đứng ở vạch đôi gốc (vạch 0)
 *   OK <cid> | ERR <cid> <lý do>  xác nhận / từ chối lệnh
 *   PASS <stop>                  vừa đi qua vạch
 *   ARR <stop>                   đã dừng ở vạch đích
 *   OBS | CLR                    siêu âm thấy vật cản / đường đã thông
 *   BTN                          nút trên mCore được bấm (khách "đã nhận món")
 *   LOST                         mất đường line quá lâu, robot tự dừng (cần người đặt lại)
 *   ST <stop> <mode> <mV>        trạng thái định kỳ; mode I=rảnh M=chạy P=tạm dừng O=vật cản S=dừng khẩn; mV=-1 nếu không đo pin
 */

export type RobotLineMode = 'I' | 'M' | 'P' | 'O' | 'S';

export type BridgeToRobot =
  | { op: 'G'; stop: number; cid: string }
  | { op: 'S' | 'P' | 'R' | 'C'; cid: string }
  | { op: 'Q' };

export type RobotToBridge =
  | { op: 'HELLO'; model: string; firmware: string }
  | { op: 'OK'; cid: string }
  | { op: 'ERR'; cid: string; reason: string }
  | { op: 'PASS'; stop: number }
  | { op: 'ARR'; stop: number }
  | { op: 'OBS' }
  | { op: 'CLR' }
  | { op: 'BTN' }
  | { op: 'LOST' }
  | { op: 'ST'; stop: number; mode: RobotLineMode; mv: number };

/** Mã lệnh ngắn gọn cho firmware (bộ nhớ mCore rất nhỏ): chỉ chữ, số, gạch; tối đa 12 ký tự. */
export const shortId = (id: string) => id.replace(/[^A-Za-z0-9-]/g, '').slice(-12) || '0';

export function encode(cmd: BridgeToRobot): string {
  switch (cmd.op) {
    case 'G':
      return `G ${cmd.stop} ${cmd.cid}\n`;
    case 'Q':
      return 'Q\n';
    default:
      return `${cmd.op} ${cmd.cid}\n`;
  }
}

const int = (s: string | undefined) => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : NaN);

/** Đọc một dòng từ robot; dòng lạ (nhiễu serial, log debug) trả về null để bỏ qua. */
export function parse(line: string): RobotToBridge | null {
  const parts = line.trim().split(/\s+/);
  const [op, a, b, c] = parts;
  switch (op) {
    case 'HELLO':
      return { op, model: a ?? 'MBOT', firmware: b ?? '?' };
    case 'OK':
      return a ? { op, cid: a } : null;
    case 'ERR':
      return a ? { op, cid: a, reason: parts.slice(2).join(' ') || 'lỗi' } : null;
    case 'PASS':
    case 'ARR': {
      const stop = int(a);
      return Number.isNaN(stop) ? null : { op, stop };
    }
    case 'OBS':
    case 'CLR':
    case 'BTN':
    case 'LOST':
      return { op };
    case 'ST': {
      const stop = int(a);
      const mv = int(c);
      if (Number.isNaN(stop) || Number.isNaN(mv) || !['I', 'M', 'P', 'O', 'S'].includes(b ?? '')) return null;
      return { op, stop, mode: b as RobotLineMode, mv };
    }
    default:
      return null;
  }
}

/** Cổng giao tiếp theo dòng: cổng serial thật hoặc mBot ảo. */
export interface LinePort {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  close(): Promise<void>;
}
