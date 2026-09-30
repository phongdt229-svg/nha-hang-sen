# Sổ tay xử lý sự cố (runbook)

Dành cho **quản lý ca** và **người phụ trách kỹ thuật** của quán. Mỗi mục: dấu hiệu → làm ngay → kiểm tra.

Nguyên tắc chung:

- **Khách không phải chờ vì hệ thống.** Luôn có đường dự phòng bằng tay: phiếu giấy cho bếp, nhân viên bưng món thay robot, tiền mặt/QR xác nhận tay.
- **Không sửa dữ liệu trực tiếp trong database.** Mọi điều chỉnh tiền đi qua POS (hoàn tiền, giảm giá, mở khóa bill) để có `audit_log`.
- Cảnh báo tự động gửi qua Telegram/Zalo (xem [triển khai](trien-khai-tai-quan.md#canh-bao)). Khi sự cố hết, hệ thống gửi tin "✅ Đã khắc phục".

Địa chỉ trên server tại quán (thay `server` bằng IP, ví dụ `192.168.1.10`):

| Việc | Địa chỉ / lệnh |
|---|---|
| POS | `http://server:8088/pos/` |
| Tình trạng hệ thống | `http://server:3000/health/ready` → `"ok": true` |
| Dashboard Grafana | `http://server:3001` (tài khoản `admin`) |
| Xem dịch vụ | `docker compose -f infra/docker-compose.yml ps` |
| Xem log API | `docker compose -f infra/docker-compose.yml logs --tail 200 api` |

---

## 1. Mất Internet toàn quán

**Dấu hiệu:** không vào được web bên ngoài; cảnh báo Telegram không tới; thanh toán QR không tự xác nhận.

**Hệ thống vẫn chạy** vì server nằm trong quán: gọi món, bếp, robot, bill, tiền mặt, in phiếu đều qua mạng LAN.

1. Thu **tiền mặt**, hoặc QR nhưng **thu ngân xác nhận tay** khi thấy tiền về trên app ngân hàng (nút "Đã nhận tiền").
2. Hóa đơn điện tử tự nằm trong hàng đợi, **có mạng lại sẽ tự phát hành**.
3. Báo nhà mạng.

Có mạng lại: POS → Cảnh báo → "Hóa đơn điện tử cần xử lý" → **Gửi lại hóa đơn đang chờ** nếu còn tồn.

## 2. Mất mạng LAN / Wi-Fi (tablet hoặc KDS mất kết nối)

**Dấu hiệu:** chấm kết nối trên POS/KDS chuyển đỏ; tablet báo "Mất mạng. Giỏ hàng được giữ nguyên…".

- **Tablet:** giỏ hàng không mất, tự gửi lại khi có mạng và **không tạo order trùng**. Nhân viên có thể gọi món hộ từ POS ("Gọi món hộ").
- **KDS mất kết nối:** hệ thống gửi lại phiếu 3 lần (sau 3, 6, 12 giây). Hết lượt → phiếu chuyển **FALLBACK**: tự in ra máy in bếp (nếu có print agent) và POS hiện cảnh báo.
  - Bếp nấu theo phiếu giấy. Quản lý bấm **Bếp đã nhận (nhập tay)** trên POS để luồng tiếp tục.
  - KDS kết nối lại tự lấy các phiếu bị lỡ, **không hiện trùng**.
- **Kiểm tra:** router/access point, dây mạng máy bếp. Khởi động lại access point nếu nhiều thiết bị cùng mất.

## 3. Máy in hết giấy / kẹt giấy / mất kết nối

**Dấu hiệu:** POS → Cảnh báo → Máy in hiện "Hết giấy" / "Mất kết nối"; tin cảnh báo "Máy in … gặp sự cố".

1. Thay giấy / gỡ kẹt / kiểm tra dây mạng và nguồn máy in.
2. **Lệnh in không mất**: nằm trong hàng đợi và tự in khi máy sẵn sàng (trong khoảng 5 giây).
3. Cần gấp: bấm **In bằng trình duyệt** trên phiếu thanh toán / phiếu bếp.
4. Lệnh không cần in nữa: **Hủy** trong "Lệnh in đang chờ".

**"Agent mất kết nối"** (mọi máy in cùng báo): máy tính chạy print agent tắt hoặc mất mạng.
- Bật lại máy / kiểm tra mạng. Agent cài dạng dịch vụ nên tự khởi động (xem [triển khai](trien-khai-tai-quan.md#print-agent)).
- Agent báo "Token thiết bị không hợp lệ": xóa file `.print-agent-token`, tạo mã mới trên POS (Cảnh báo → **Ghép print agent**), chạy lại với `PAIRING_CODE`.

## 4. Robot giao món gặp sự cố

**Dấu hiệu:** POS → **Robot**, task viền đỏ "Lỗi – cần xử lý"; cảnh báo "Giao món … bị lỗi" hoặc "Robot chờ khách bàn …".

Hệ thống **không để món kẹt**: task lỗi chờ nhân viên chọn một trong bốn cách (MB-17):

| Nút | Khi nào dùng |
|---|---|
| **Thử lại** | Robot đã ổn (vật cản đã dọn, có mạng lại): gửi lại lệnh cho cùng robot, chạy tiếp từ bước đang dở |
| **Giao robot khác** | Món **chưa** đặt lên robot, robot hỏng/mất kết nối |
| **Nhân viên giao** | Món đã ở trên robot, hoặc cần giao ngay: nhân viên lấy món trên robot mang ra |
| **Hủy** | Món chưa đặt lên robot, không cần robot giao nữa (món về hàng chờ) |

Theo từng lỗi:

- **Vật cản:**
  - hệ thống tự thử lại 2 lần
  - vẫn kẹt → dọn lối đi rồi **Thử lại**, hoặc **Nhân viên giao**
  - không tháo khay khi robot chưa dừng hẳn
- **Mất kết nối** (robot tắt, hết pin, mất Wi-Fi/Bluetooth, laptop chạy robot bridge tắt):
  - kiểm tra robot và robot bridge
  - có lại thì **Thử lại**; chưa có thì **Giao robot khác** hoặc **Nhân viên giao**
- **Pin yếu:**
  - robot tự về trạm sạc
  - món trên robot: **Nhân viên giao**
  - dưới 30% robot không nhận việc mới
- **Khách chưa nhận** (robot chờ ở bàn quá 60 giây): nhân viên ra bàn, mời khách lấy món rồi bấm **Xác nhận đã giao**.
- **Robot chạy sai / nguy hiểm:** bấm **Dừng khẩn** trên thẻ robot, rồi xử lý như task lỗi.
- **Máy chủ khởi động lại khi robot đang giao:**
  - robot thật tiếp tục chạy, hệ thống tự đối chiếu
  - nếu task báo "Máy chủ khởi động lại" thì bấm **Thử lại**

mBot demo trên sa bàn: xem [docs/robot/demo-mbot-v1.md](../robot/demo-mbot-v1.md).

## 5. Cổng thanh toán lỗi / QR không tự xác nhận

- Webhook ngân hàng đến trễ hoặc không đến: **tác vụ đối soát** tự hỏi lại mỗi phút. Có thể chờ 1–2 phút.
- Thu ngân **thấy tiền về** trên app ngân hàng: bấm **Đã nhận tiền**.
- Chuyển sai số tiền: không tự ghi nhận. Hủy QR, tạo QR đúng số hoặc thu phần chênh bằng tiền mặt.
- Webhook gửi trùng **không** cộng tiền hai lần.

## 6. Hóa đơn điện tử lỗi

**Dấu hiệu:** POS → Cảnh báo → "Hóa đơn điện tử cần xử lý", trạng thái **Lỗi** kèm lý do.

- **Sai MST / tên:** bấm **Sửa thông tin người mua & gửi lại**. Hóa đơn phát hành lại cùng khóa, **không trùng**.
- **Đang chờ** (mất mạng, nhà cung cấp bảo trì): tự gửi lại; bấm **Gửi lại hóa đơn đang chờ** để thử ngay.
- **Đã phát hành mà sai:** chỉ **kế toán** lập hóa đơn điều chỉnh/thay thế. Không xóa, không sửa hóa đơn đã phát hành.
- Tổng quan báo **doanh thu ≠ tổng hóa đơn**: thường do còn hóa đơn chưa phát hành. Xử lý hết danh sách rồi kiểm tra lại.

## 7. Order không vào bếp (FALLBACK)

**Dấu hiệu:** tab **Cảnh báo** có số đỏ; cảnh báo "Order chưa vào bếp".

1. Bếp nấu theo **phiếu giấy** (tự in; hoặc **In lại ở máy in bếp** / **In bằng trình duyệt**).
2. Quản lý bấm **Bếp đã nhận (nhập tay)**.
3. Kiểm tra màn hình bếp (mục 2).

## 8. Server tại quán mất điện / khởi động lại

- Server cắm qua **UPS**: mất điện ngắn không ảnh hưởng. UPS báo pin yếu → dừng dịch vụ (`docker compose -f infra/docker-compose.yml stop`) trước khi hết pin.
- Có điện lại: mọi dịch vụ **tự khởi động** (`restart: unless-stopped`). Dữ liệu an toàn nhờ PostgreSQL (WAL) và Redis (AOF).
- Kiểm tra: `http://server:3000/health/ready` → `"ok": true`; POS chấm kết nối xanh; tablet/KDS tự kết nối lại.
- Order gửi dở lúc mất điện: tablet tự gửi lại đúng khóa cũ, **không trùng**.

## 9. Server hỏng / mất dữ liệu → khôi phục từ sao lưu

Mục tiêu: **RTO < 15 phút, RPO < 5 phút**. Sao lưu = bản nền hằng đêm + WAL lưu liên tục (tối đa 60 giây dữ liệu chưa lưu).

Diễn tập mỗi tháng, ngoài giờ phục vụ:

```bash
docker compose -f infra/docker-compose.yml --profile drill run --rm restore-drill
```

Kết quả "ĐẠT" kèm RTO/RPO đo được — ghi vào sổ vận hành.

Khôi phục thật: làm theo [infra/backup/README.md](../../infra/backup/README.md#khoi-phuc-that). Sau đó kiểm tra `health/ready`, đăng nhập POS, **đối chiếu bill gần nhất với biên lai giấy** quanh thời điểm sự cố.

## 10. Cập nhật phần mềm và quay lại bản trước

- Cập nhật **ngoài giờ phục vụ**, sau khi chắc bản sao lưu đêm trước thành công (`docker compose -f infra/docker-compose.yml logs --tail 20 backup`).
- Cập nhật: lấy đúng tag phát hành → `docker compose -f infra/docker-compose.yml up -d --build`. Migration tự chạy khi API khởi động.
- Lỗi sau cập nhật: quay về tag trước → `up -d --build`. Migration chỉ thêm bảng/cột nên bản cũ vẫn chạy trên database mới. Nếu ghi chú phát hành báo migration **không tương thích ngược**, phải khôi phục database về trước lúc cập nhật (mục 9).

## 11. Hai thu ngân cùng thao tác một bill

POS báo "Bill vừa được người khác thay đổi, vui lòng tải lại" — **cơ chế bảo vệ**, không phải lỗi. Tải lại bill rồi làm tiếp.

## 12. Kết ca lệch tiền

- Lệch trong ngưỡng: ca tự đóng.
- Vượt ngưỡng (mặc định 50.000đ): ca chờ **quản lý duyệt** (mục Ca làm) kèm lý do. Kiểm tra lại két, các khoản hoàn tiền mặt, thanh toán QR bị ghi nhầm là tiền mặt.

---

Hỗ trợ kỹ thuật (điền khi triển khai): `…………………`
