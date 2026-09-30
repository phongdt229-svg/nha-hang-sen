# Chạy thử toàn bộ luồng phục vụ

Dùng để tập huấn nhân viên mới và kiểm tra hệ thống trước giờ mở bán: **mở bàn → gọi món → bếp → robot giao → thanh toán → dọn bàn**.

Trên POS có bản **tương tác**: mục **Hướng dẫn** → **Chạy thử (theo dõi trực tiếp)**. Chọn một bàn, hệ thống tự đánh dấu từng bước khi bạn làm xong và chỉ chỗ cần bấm tiếp theo.

## Chuẩn bị

Mở 3 màn hình (3 thiết bị hoặc 3 tab trình duyệt):

| Màn hình | Đăng nhập |
|---|---|
| **POS** | Tài khoản nhân viên (quản lý, thu ngân hoặc phục vụ) |
| **Bếp (KDS)** | Mã ghép 6 số: POS → **Cảnh báo** → **Ghép màn hình bếp** |
| **Tablet** (nên có) | Mã ghép 6 số: POS → bấm bàn → **Ghép tablet cho bàn này** |

- Chọn một **bàn trống**.
- Muốn tiền mặt vào đúng ca: thu ngân **Mở ca** trước (mục **Ca làm**).
- Gọi món của **trạm bếp đã ghép màn hình**. Món của trạm chưa có màn hình (ví dụ quầy bar) sẽ ra phiếu giấy thay vì hiện trên KDS.

## 1. Mở bàn

POS → **Sơ đồ bàn** → bấm bàn trống → nhập **Số khách** → **Mở bàn**.

Kết quả: bàn chuyển **Đang dùng**; tablet của bàn hiện thực đơn.

## 2. Gọi món

- **Khách tự gọi:** tablet → chọn món → **Giỏ hàng** → **Xác nhận gọi món**.
- **Nhân viên gọi hộ:** POS → bấm bàn → **Gọi món hộ** → chọn món → xác nhận.

Kết quả: tablet báo **"Bếp đã nhận"**; POS → bàn → **Món đã gọi** có món vừa gọi.

## 3. Bếp làm món

Màn hình bếp hiện phiếu của bàn kèm chuông → **Nấu** → **Xong**.

Kết quả: món chuyển xuống dải **Giao món** cuối màn hình bếp.

## 4. Robot giao món

Theo dõi ở POS → **Robot**:

| Trạng thái | Việc cần làm |
|---|---|
| Có task **DT… · Bàn …**, robot chạy về bếp | Chờ — hệ thống tự chọn robot |
| **Tới điểm lấy món** | Đặt món lên khay → **Đã đặt món lên robot** (màn hình bếp hoặc POS) |
| Robot chạy ra bàn | Chờ |
| **Tới bàn / Chờ khách nhận** | Khách bấm **Đã nhận món** trên tablet, hoặc nhân viên bấm **Xác nhận đã giao** trên POS |
| Robot quay về, task **Hoàn tất** | Xong |

Không dùng robot: ở **Món xong chờ giao** bấm **Nhân viên mang**. Robot báo lỗi: xem [sổ tay xử lý sự cố](../van-hanh/runbook.md#4-robot-giao-món-gặp-sự-cố).

## 5. Thanh toán

POS → bấm bàn → **Bill & thanh toán**:

1. Kiểm tra món, VAT, tổng tiền.
2. **Khóa bill để thanh toán** (bàn chuyển "Thanh toán", tablet tạm dừng gọi món).
3. Nhập **Tiền mặt khách đưa** → **Thu tiền mặt**; hoặc **QR chuyển khoản** → khi thấy tiền về bấm **Đã nhận tiền**.
4. Cần phiếu: **In phiếu thanh toán**.

Kết quả: bill **Đã thanh toán**, bàn chuyển **Cần dọn**.

## 6. Dọn bàn

POS → bấm bàn "Cần dọn" → **Đã dọn xong — bàn sẵn sàng**.

Kết quả: bàn về **Trống**, sẵn sàng đón khách mới.

## Kiểm tra sau buổi chạy thử

- **Tổng quan / Báo cáo:** doanh thu có bill vừa thu.
- **Robot** → task → **Nhật ký:** đủ các bước từ tạo task đến hoàn tất.
- **Ca làm** → **Kết ca:** tiền mặt dự kiến có khoản vừa thu.
