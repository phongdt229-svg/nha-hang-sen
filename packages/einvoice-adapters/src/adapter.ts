/**
 * Lớp adapter hóa đơn điện tử (mục 12.1, 12.7). Hệ thống không tự ký số, không tự truyền
 * dữ liệu lên cơ quan thuế: mỗi nhà cung cấp (MISA meInvoice, Viettel S-Invoice, VNPT, BKAV…)
 * có một adapter tuân theo interface này. Đổi nhà cung cấp không phải sửa POS.
 */

export interface HoaDonDong {
  ten: string;
  soLuong: number;
  donGia: number;
  /** Tiền trước thuế của dòng, đồng. */
  thanhTienTruocThue: number;
  /** Thuế suất theo điểm cơ bản: 800 = 8%. */
  thueSuatBp: number;
  tienThue: number;
  giamGia: number;
}

export interface NguoiMua {
  loai: 'PERSON' | 'COMPANY';
  maSoThue?: string | null;
  ten?: string | null;
  diaChi?: string | null;
  email?: string | null;
  soDienThoai?: string | null;
  soDinhDanh?: string | null;
}

export interface HoaDonInput {
  /** Khóa idempotency: nhà cung cấp phải trả lại hóa đơn cũ nếu gửi lại cùng khóa. */
  khoa: string;
  maBill: string;
  ngayLap: string;
  nguoiMua: NguoiMua | null;
  dong: HoaDonDong[];
  tongTruocThue: number;
  tongThue: number;
  tongThanhToan: number;
  theoThueSuat: { thueSuatBp: number; truocThue: number; tienThue: number }[];
}

export interface KetQuaPhatHanh {
  soHoaDon: string;
  kyHieu: string;
  mauSo: string;
  maTraCuu: string;
  maCoQuanThue?: string;
  urlTraCuu?: string;
  pdfUrl?: string;
}

export interface DieuChinhInput {
  khoa: string;
  lyDo: string;
  /** Điều chỉnh thông tin người mua (sai tên, địa chỉ). */
  nguoiMua?: NguoiMua;
  /** Điều chỉnh số tiền: giá trị âm là điều chỉnh giảm. */
  dong?: HoaDonDong[];
}

export type TrangThaiHoaDon = 'CHO_CAP_MA' | 'DA_CAP_MA' | 'BI_TU_CHOI' | 'KHONG_TON_TAI';

export interface EInvoiceAdapter {
  readonly name: string;
  phatHanh(hoaDon: HoaDonInput): Promise<KetQuaPhatHanh>;
  traCuuMST(mst: string): Promise<{ ten: string; diaChi: string } | null>;
  dieuChinh(soHoaDonGoc: string, noiDung: DieuChinhInput): Promise<KetQuaPhatHanh>;
  thayThe(soHoaDonGoc: string, hoaDonMoi: HoaDonInput): Promise<KetQuaPhatHanh>;
  layTrangThai(soHoaDon: string): Promise<TrangThaiHoaDon>;
}

/** Nhà cung cấp từ chối dữ liệu (sai MST, sai định dạng): không gửi lại, cần sửa thông tin. */
export class EInvoiceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EInvoiceRejectedError';
  }
}

/** Không kết nối được (mất Internet, nhà cung cấp bảo trì): giữ trong hàng đợi và gửi lại. */
export class EInvoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EInvoiceUnavailableError';
  }
}

/** Kiểm tra định dạng MST: 10 số, hoặc 10 số + "-" + 3 số (đơn vị phụ thuộc). */
export function isValidTaxCodeFormat(mst: string): boolean {
  return /^\d{10}(-\d{3})?$/.test(mst);
}
