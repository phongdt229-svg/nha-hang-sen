# Hướng dẫn kế toán và chủ quán

## Kế toán

Đăng nhập POS bằng tài khoản kế toán: chỉ thấy mục **Báo cáo** (xem và xuất, **không sửa bill**).

**Hằng ngày / hằng tháng:**
- **Báo cáo → Doanh thu** theo ngày kinh doanh (ngày kết thúc lúc 4h sáng hôm sau). Doanh thu thuần = đã thu − hoàn tiền.
- **Báo cáo → Bảng kê hóa đơn:** tiền trước thuế, tiền thuế theo từng mức (8%, 10%…), gồm cả hóa đơn điều chỉnh giảm → dùng để kê khai. **Xuất XLSX** để đưa vào phần mềm kế toán.
- **Giảm giá · hủy · hoàn:** đối chiếu các khoản giảm trừ.
- Đối soát: **doanh thu = tổng thanh toán thành công = tổng hóa đơn điện tử** theo từng ngày kinh doanh. Lệch thì kiểm tra hóa đơn chưa phát hành (quản lý xử lý trong mục Cảnh báo).

**Điều chỉnh / thay thế hóa đơn điện tử** (sai thông tin người mua, sai số tiền): chỉ kế toán hoặc quản lý được làm, qua API `POST /einvoices/{id}/adjust` và `/replace` (màn hình riêng sẽ có ở bản sau). Không bao giờ xóa hay sửa hóa đơn đã phát hành.

**Thuế suất:** bảng thuế suất có ngày hiệu lực (ví dụ đồ ăn 8% đến 31/12/2026, từ 01/01/2027 cần xác nhận lại). Khi chính sách thay đổi, báo đơn vị triển khai thêm dòng thuế suất mới **trước** ngày hiệu lực.

## Chủ quán

Tài khoản chủ quán có mọi quyền, cộng thêm:

- **Nhân viên & thiết bị → Nhân viên:**
  - **Thêm nhân viên**: tên đăng nhập, họ tên, vai trò, mật khẩu tạm. Nhắc nhân viên đổi mật khẩu ngay lần đầu (bấm vào tên mình ở góc trên).
  - **Sửa**: đổi vai trò, **đặt lại mật khẩu** khi nhân viên quên.
  - **Khóa** khi nhân viên nghỉ việc: bị đăng xuất ngay trên mọi máy.
- Nhận **báo cáo cuối ngày** và **cảnh báo sự cố** qua Telegram/Zalo.
- Xem dashboard vận hành trên Grafana (qua VPN nếu ở ngoài quán).

Mật khẩu: tối thiểu 8 ký tự, mỗi người một tài khoản, **không dùng chung**. Như vậy nhật ký thao tác mới có ý nghĩa.
