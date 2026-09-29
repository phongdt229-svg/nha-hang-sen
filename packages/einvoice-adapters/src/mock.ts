import {
  EInvoiceRejectedError,
  EInvoiceUnavailableError,
  isValidTaxCodeFormat,
  type DieuChinhInput,
  type EInvoiceAdapter,
  type HoaDonInput,
  type KetQuaPhatHanh,
  type TrangThaiHoaDon,
} from './adapter';

/** Danh bạ MST giả lập cho dev/test. */
const DIRECTORY: Record<string, { ten: string; diaChi: string }> = {
  '0100109106': { ten: 'Công ty TNHH Hoa Sen Demo', diaChi: '12 Hàng Bài, Hoàn Kiếm, Hà Nội' },
  '0312345678': { ten: 'Công ty Cổ phần Thử Nghiệm Sen', diaChi: '45 Lê Lợi, Quận 1, TP. Hồ Chí Minh' },
  '0401234567': { ten: 'Công ty TNHH Du lịch Biển Xanh', diaChi: '8 Bạch Đằng, Hải Châu, Đà Nẵng' },
};

/**
 * Adapter giả lập nhà cung cấp hóa đơn điện tử: cấp số tăng dần, trả lại kết quả cũ khi gửi lại
 * cùng khóa, từ chối MST không có trong danh bạ, và có công tắc "mất kết nối" để kiểm thử hàng đợi.
 */
export class MockEInvoiceAdapter implements EInvoiceAdapter {
  readonly name = 'mock';
  private seq = 0;
  private readonly byKey = new Map<string, KetQuaPhatHanh>();
  private readonly issued = new Map<string, TrangThaiHoaDon>();
  offline = false;

  constructor(private readonly opts: { mauSo?: string; kyHieu?: string; lookupBase?: string } = {}) {}

  /** Tiếp tục dãy số sau lần khởi động lại (mock giữ trạng thái trong bộ nhớ). */
  resumeFrom(lastNumber: number) {
    this.seq = Math.max(this.seq, lastNumber);
  }

  /** Hóa đơn gốc phát hành trước lần khởi động lại không còn trong bộ nhớ: chấp nhận nếu đúng định dạng số. */
  private knowsOriginal(soHoaDon: string) {
    return this.issued.has(soHoaDon) || /^\d{8}$/.test(soHoaDon);
  }

  private ensureOnline() {
    if (this.offline) throw new EInvoiceUnavailableError('Không kết nối được nhà cung cấp hóa đơn (giả lập)');
  }

  private issue(key: string, _input?: unknown): KetQuaPhatHanh {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const soHoaDon = String(++this.seq).padStart(8, '0');
    const maTraCuu = `SEN${Date.now().toString(36).toUpperCase()}${this.seq}`;
    const result: KetQuaPhatHanh = {
      soHoaDon,
      kyHieu: this.opts.kyHieu ?? 'C26MSN',
      mauSo: this.opts.mauSo ?? '1',
      maTraCuu,
      maCoQuanThue: `M1-26-DEMO-${soHoaDon}`,
      urlTraCuu: `${this.opts.lookupBase ?? 'https://tracuu.example.invalid'}/?ma=${maTraCuu}`,
    };
    this.byKey.set(key, result);
    this.issued.set(soHoaDon, 'DA_CAP_MA');
    return result;
  }

  private checkBuyer(input: { nguoiMua?: HoaDonInput['nguoiMua'] }) {
    const mst = input.nguoiMua?.maSoThue;
    if (!mst) return;
    if (!isValidTaxCodeFormat(mst)) throw new EInvoiceRejectedError(`Mã số thuế ${mst} sai định dạng`);
    if (!DIRECTORY[mst.slice(0, 10)]) throw new EInvoiceRejectedError(`Mã số thuế ${mst} không tồn tại hoặc đã ngừng hoạt động`);
  }

  async phatHanh(hoaDon: HoaDonInput) {
    this.ensureOnline();
    this.checkBuyer(hoaDon);
    if (hoaDon.dong.length === 0) throw new EInvoiceRejectedError('Hóa đơn không có dòng hàng');
    return this.issue(hoaDon.khoa, hoaDon);
  }

  async traCuuMST(mst: string) {
    this.ensureOnline();
    return DIRECTORY[mst.slice(0, 10)] ?? null;
  }

  async dieuChinh(soHoaDonGoc: string, noiDung: DieuChinhInput) {
    this.ensureOnline();
    if (!this.knowsOriginal(soHoaDonGoc)) throw new EInvoiceRejectedError(`Không tìm thấy hóa đơn gốc ${soHoaDonGoc}`);
    if (noiDung.nguoiMua) this.checkBuyer(noiDung);
    return this.issue(noiDung.khoa);
  }

  async thayThe(soHoaDonGoc: string, hoaDonMoi: HoaDonInput) {
    this.ensureOnline();
    if (!this.knowsOriginal(soHoaDonGoc)) throw new EInvoiceRejectedError(`Không tìm thấy hóa đơn gốc ${soHoaDonGoc}`);
    this.checkBuyer(hoaDonMoi);
    const r = this.issue(hoaDonMoi.khoa);
    this.issued.set(soHoaDonGoc, 'DA_CAP_MA');
    return r;
  }

  async layTrangThai(soHoaDon: string): Promise<TrangThaiHoaDon> {
    this.ensureOnline();
    return this.issued.get(soHoaDon) ?? 'KHONG_TON_TAI';
  }
}
