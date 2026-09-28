/**
 * Robot Adapter – lớp trung gian (mục 7.1). Bộ điều phối không gọi trực tiếp hãng robot nào;
 * mỗi loại robot có một adapter tuân theo cùng giao diện này.
 */

export interface RobotStatus {
  robotId: string;
  online: boolean;
  battery: number;
  /** Mô tả vị trí: "BEP", "T05", "SAC", "DI_CHUYEN"… */
  location: string;
  busy: boolean;
  error?: string;
}

export type RobotEventType =
  /** Robot đã tới điểm lấy món ở bếp, chờ nhân viên đặt khay và quét mã. */
  | 'AT_PICKUP'
  /** Đã nhận lệnh giao, đang đi tới bàn. */
  | 'MOVING'
  | 'ARRIVED'
  /** Khách xác nhận đã lấy món (nút trên robot hoặc trên tablet). */
  | 'DELIVERED'
  | 'RETURNING'
  /** Đã về vị trí chờ, sẵn sàng chuyến mới. */
  | 'DONE'
  | 'FAILED'
  | 'LOW_BATTERY'
  | 'STATUS';

export interface RobotEvent {
  robotId: string;
  tripId?: string;
  type: RobotEventType;
  battery?: number;
  location?: string;
  /** Tiến độ quãng đường hiện tại 0..1 (để vẽ robot trên sơ đồ). */
  progress?: number;
  reason?: string;
  at: number;
}

export interface TripCommand {
  tripId: string;
  /** Mã bàn đích, trùng tên điểm trên bản đồ robot (T05 ↔ "Bàn 05"). */
  banDich: string;
  mon: string[];
  hienThi?: string;
}

export interface RobotAdapter {
  readonly vendor: string;
  /** Gọi robot tới điểm lấy món ở bếp. */
  denDiemLayMon(robotId: string, tripId: string): Promise<void>;
  /** Gửi robot giao món tới bàn (sau khi khay đã được xác thực). */
  giaoMon(robotId: string, trip: TripCommand): Promise<void>;
  layTrangThai(robotId: string): Promise<RobotStatus>;
  /** Hủy chuyến (robot kẹt, đổi robot khác, đổi bàn đích). */
  huyChuyen(robotId: string, tripId: string): Promise<void>;
  /** Khách xác nhận đã nhận món từ màn hình khác (tablet) thay vì bấm nút trên robot. */
  xacNhanDaNhan(robotId: string, tripId: string): Promise<void>;
  /** Đi sạc. */
  diSac(robotId: string): Promise<void>;
  /** Đăng ký nhận sự kiện: đã tới, đã nhận món, lỗi, pin yếu. */
  onSuKien(handler: (e: RobotEvent) => void): void;
  close?(): Promise<void>;
}

export class RobotCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RobotCommandError';
  }
}
