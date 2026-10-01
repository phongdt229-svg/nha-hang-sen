// Nội dung hướng dẫn lấy thẳng từ docs/ lúc build (HD-02): sửa file .md là app cập nhật theo, không chép tay.
import bep from '../../../../docs/huong-dan/bep.md?raw';
import chayThu from '../../../../docs/huong-dan/chay-thu.md?raw';
import daoTao from '../../../../docs/huong-dan/dao-tao.md?raw';
import keToan from '../../../../docs/huong-dan/ke-toan-chu-quan.md?raw';
import khachHang from '../../../../docs/huong-dan/khach-hang.md?raw';
import phucVu from '../../../../docs/huong-dan/phuc-vu.md?raw';
import quanLy from '../../../../docs/huong-dan/quan-ly.md?raw';
import thuNgan from '../../../../docs/huong-dan/thu-ngan.md?raw';
import robotDemo from '../../../../docs/robot/demo-mbot-v1.md?raw';
import runbook from '../../../../docs/van-hanh/runbook.md?raw';

export interface GuideDoc {
  id: GuideId;
  title: string;
  /** Đường dẫn trong docs/, để đổi link tương đối giữa các file thành link trong app. */
  path: string;
  markdown: string;
}

export type GuideId =
  | 'dao-tao'
  | 'chay-thu'
  | 'phuc-vu'
  | 'thu-ngan'
  | 'bep'
  | 'quan-ly'
  | 'ke-toan-chu-quan'
  | 'khach-hang'
  | 'runbook'
  | 'robot-demo';

const doc = (id: GuideId, title: string, path: string, markdown: string): GuideDoc => ({ id, title, path, markdown });

export const GUIDES: Record<GuideId, GuideDoc> = {
  'dao-tao': doc('dao-tao', 'Đào tạo nhân viên mới', 'huong-dan/dao-tao.md', daoTao),
  'chay-thu': doc('chay-thu', 'Chạy thử toàn bộ luồng', 'huong-dan/chay-thu.md', chayThu),
  'phuc-vu': doc('phuc-vu', 'Phục vụ / lễ tân', 'huong-dan/phuc-vu.md', phucVu),
  'thu-ngan': doc('thu-ngan', 'Thu ngân', 'huong-dan/thu-ngan.md', thuNgan),
  bep: doc('bep', 'Bếp (màn hình KDS)', 'huong-dan/bep.md', bep),
  'quan-ly': doc('quan-ly', 'Quản lý ca', 'huong-dan/quan-ly.md', quanLy),
  'ke-toan-chu-quan': doc('ke-toan-chu-quan', 'Kế toán, chủ quán', 'huong-dan/ke-toan-chu-quan.md', keToan),
  'khach-hang': doc('khach-hang', 'Khách gọi món trên tablet', 'huong-dan/khach-hang.md', khachHang),
  runbook: doc('runbook', 'Xử lý sự cố', 'van-hanh/runbook.md', runbook),
  'robot-demo': doc('robot-demo', 'Robot mBot demo (sa bàn)', 'robot/demo-mbot-v1.md', robotDemo),
};

/** Hướng dẫn chính theo vai trò đăng nhập POS. */
export const ROLE_GUIDE: Record<string, GuideId> = {
  WAITER: 'phuc-vu',
  CASHIER: 'thu-ngan',
  MANAGER: 'quan-ly',
  ADMIN: 'quan-ly',
  ACCOUNTANT: 'ke-toan-chu-quan',
};
