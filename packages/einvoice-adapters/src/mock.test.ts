import { describe, expect, it } from 'vitest';
import { EInvoiceRejectedError, EInvoiceUnavailableError, MockEInvoiceAdapter, type HoaDonInput } from './index';

const input = (khoa: string, mst?: string): HoaDonInput => ({
  khoa,
  maBill: 'B001-00001',
  ngayLap: '2026-09-29',
  nguoiMua: mst ? { loai: 'COMPANY', maSoThue: mst, ten: 'X' } : null,
  dong: [{ ten: 'Phở', soLuong: 1, donGia: 65000, thanhTienTruocThue: 60185, thueSuatBp: 800, tienThue: 4815, giamGia: 0 }],
  tongTruocThue: 60185,
  tongThue: 4815,
  tongThanhToan: 65000,
  theoThueSuat: [{ thueSuatBp: 800, truocThue: 60185, tienThue: 4815 }],
});

describe('MockEInvoiceAdapter', () => {
  it('gửi lại cùng khóa → cùng hóa đơn, không phát hành trùng', async () => {
    const a = new MockEInvoiceAdapter();
    const r1 = await a.phatHanh(input('k1'));
    const r2 = await a.phatHanh(input('k1'));
    expect(r2).toEqual(r1);
    expect((await a.phatHanh(input('k2'))).soHoaDon).not.toBe(r1.soHoaDon);
  });

  it('MST sai → từ chối; mất kết nối → lỗi tạm thời', async () => {
    const a = new MockEInvoiceAdapter();
    await expect(a.phatHanh(input('k', '123'))).rejects.toBeInstanceOf(EInvoiceRejectedError);
    await expect(a.phatHanh(input('k', '9999999999'))).rejects.toBeInstanceOf(EInvoiceRejectedError);
    a.offline = true;
    await expect(a.phatHanh(input('k'))).rejects.toBeInstanceOf(EInvoiceUnavailableError);
  });

  it('tra cứu MST', async () => {
    expect((await new MockEInvoiceAdapter().traCuuMST('0100109106'))?.ten).toContain('Hoa Sen');
  });
});
