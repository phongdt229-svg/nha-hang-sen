# Hướng dẫn quản lý ca

Quản lý làm được mọi việc của thu ngân, phục vụ, cộng thêm các thao tác cần quyền dưới đây. Mọi thao tác này ghi **nhật ký (audit log)** kèm tên người làm và lý do.

## Theo dõi trong ca

- **Tổng quan:** doanh thu ngày kinh doanh, số bill, bàn đang dùng, tiền đang phục vụ chưa thu. Có dòng vàng "Doanh thu ≠ tổng hóa đơn" → xử lý hóa đơn trong **Cảnh báo**.
- **Cảnh báo** (số đỏ trên tab = có việc cần xử lý):
  - **Order chưa vào bếp:** bếp nấu theo phiếu giấy; bấm **Bếp đã nhận (nhập tay)** sau khi xác nhận với bếp.
  - **Máy in:** trạng thái từng máy, lệnh in đang chờ (hủy được), **In thử**.
  - **Hóa đơn điện tử cần xử lý.**
- Cảnh báo cũng gửi Telegram/Zalo cho nhóm quản lý; hết sự cố có tin "✅ Đã khắc phục".

## Thao tác cần quyền quản lý

| Việc | Ở đâu |
|---|---|
| Giảm giá bill | Bill đang mở → **Giảm giá** → số tiền + lý do |
| Mở khóa bill (khách gọi thêm sau khi đã khóa) | Bill đã khóa, chưa thu tiền → **Mở khóa bill** + lý do |
| Hủy tách bill | Bill đã tách, chưa phần nào trả → **Hủy tách** |
| Hoàn tiền | Bill đã thanh toán → **Hoàn tiền** → số tiền, hình thức, lý do. Không sửa bill cũ; khoản hoàn ghi vào ngày hoàn. Bill đã có hóa đơn điện tử thì tự lập hóa đơn điều chỉnh giảm |
| Duyệt chênh lệch kết ca | **Ca làm** → "Ca chờ duyệt chênh lệch" → **Duyệt** + lý do |
| Ghép thiết bị | Tablet: bấm bàn → **Ghép tablet cho bàn này**. Màn hình bếp / print agent: **Cảnh báo** → **Ghép màn hình bếp** / **Ghép print agent** |
| Thu hồi thiết bị mất/hỏng | **Thiết bị** → **Thu hồi** (token cũ hết hiệu lực ngay) |

## Cuối ngày

1. Mọi thu ngân đã **kết ca**; duyệt các ca lệch.
2. **Cảnh báo** không còn hóa đơn lỗi.
3. **Báo cáo** → **Chốt ngày** cho ngày kinh doanh vừa xong (hệ thống cũng tự chốt lúc đêm). Sau khi chốt, số liệu ngày đó không đổi; hoàn tiền sau đó ghi vào ngày hoàn.
4. Báo cáo tóm tắt tự gửi cho chủ quán.

## Báo cáo

**Báo cáo** → chọn khoảng ngày:
- **Doanh thu:** theo ngày, giờ, món, danh mục, phương thức, nguồn order, ca.
- **Chỉ số:** trung bình mỗi bill, doanh thu mỗi khách, vòng quay bàn, thời gian ngồi.
- **Giảm giá · hủy · hoàn:** ai làm, lúc nào, lý do.
- Mọi bảng **Xuất XLSX / CSV / PDF**.

## Sự cố

Xem [sổ tay xử lý sự cố](../van-hanh/runbook.md). Nguyên tắc: **khách không phải chờ vì máy** — chuyển sang giấy/tay trước, sửa máy sau.
