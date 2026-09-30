# Firmware mBot v1 – sa bàn demo robot giao món

Firmware cho **Makeblock mBot v1 (bo mạch mCore)**, chạy trên sa bàn [docs/sa-ban-demo-robot-A1.pdf](../../docs/sa-ban-demo-robot-A1.pdf) theo tài liệu công nghệ v0.7 (MB-05, MB-19).

> **Trạng thái:** viết theo bộ mBot v1 tiêu chuẩn. **Chưa biên dịch và chưa chạy trên robot thật**, vì máy phát triển chưa có Arduino/arduino-cli và chưa có mBot. Lần đầu nạp cần căn chỉnh các hằng số ở đầu file (mục Căn chỉnh). Giao thức và luồng đã được kiểm thử đầu–cuối bằng mBot ảo (`apps/robot-bridge`, chế độ `SERIAL=virtual`).

## Phần cứng

| Bộ phận | Cổng | Ghi chú |
|---|---|---|
| Me Line Follower (2 mắt) | PORT_2 | Mặc định của bộ mBot |
| Me Ultrasonic Sensor | PORT_3 | Phát hiện vật cản < 8 cm |
| Động cơ trái / phải | M1 / M2 | Động cơ trái lắp ngược chiều (đã xử lý trong code) |
| Nút trên mCore | A7 | Khách bấm "đã nhận món" |
| LED RGB trên mCore | pin 13 | Xanh dương = đang chạy, xanh lá = đã tới, cam = vật cản, đỏ = dừng/mất line |
| Kết nối máy tính | USB (CH340) hoặc module Bluetooth | Cả hai hiện ra thành cổng COM, 115200 baud |

mCore không có mạch đo pin: firmware gửi `mV = -1` và robot bridge **giả lập pin** (`SIMULATED_TELEMETRY`, MB-15). Hệ thống hiển thị nhãn "pin giả lập".

## Nạp firmware

1. Cài Arduino IDE (hoặc `arduino-cli`) và thư viện **Makeblock-Libraries** (Sketch → Include Library → Add .ZIP Library, tải từ github.com/Makeblock-official/Makeblock-Libraries).
2. Board: **Arduino/Genuino Uno**; cổng: COM của mBot (cắm cáp USB, bật công tắc robot).
3. Mở `mbot_v1.ino` → Upload.
4. Mở Serial Monitor 115200, **Newline**: thấy `HELLO MBOT_V1 1.0` và mỗi giây một dòng `ST 0 I -1`. Gõ `G 1 t1` → robot trả `OK t1` rồi chạy tới vạch 1.

## Cách robot chạy trên sa bàn

- **Bám mép phải đường chạy:** mắt trái trên nền đen, mắt phải trên nền trắng. Đường rộng 20 mm, nên đi giữa đường thì cả hai mắt luôn đen và không phân biệt được vạch.
- **Nhận vạch dừng:** vạch 15 × 64 mm cắt ngang đường làm **cả hai mắt cùng đen** ít nhất `MARK_MIN_MS` → đếm một vạch và gửi `PASS n`. Tới vạch đích thì dừng, gửi `ARR n`, bíp, đèn xanh lá.
- **Vạch đôi ở BẾP:** hai vạch cách nhau dưới `DOUBLE_WINDOW_MS` → đặt lại bộ đếm = 0. Nhờ vậy robot **tự sửa** nếu lỡ đếm sót một vạch trong vòng trước.
- **Chạy một chiều:** từ BÀN 3 về BẾP, robot đi tiếp qua BÀN 4 và TRẠM SẠC, đúng mũi tên trên sa bàn.
- **Vật cản:** robot dừng, gửi `OBS`. Khi thông đường liên tục `CLEAR_MS`, gửi `CLR` rồi **đứng chờ**; Delivery Service gửi lại lệnh `G` để đi tiếp (RD-16 retry).
- **Mất line quá `LOST_MS`:** robot tự dừng, gửi `LOST`. Hệ thống chuyển task sang lỗi để nhân viên xử lý.

**Đặt robot khi khởi động:** ngay **sau** vạch đôi ở BẾP (phía BÀN 1), mũi hướng theo chiều chạy, rồi bật nguồn. Bộ đếm bắt đầu từ 0.

## Căn chỉnh (đầu file `mbot_v1.ino`)

| Hằng số | Mặc định | Khi nào chỉnh |
|---|---|---|
| `SPEED_BASE`, `SPEED_TURN` | 110, 70 | Robot lắc nhiều / văng khỏi khúc cua |
| `MARK_MIN_MS` | 90 ms | Đếm thừa vạch khi robot lệch line → tăng; bỏ sót vạch → giảm, hoặc giảm tốc |
| `DOUBLE_WINDOW_MS` | 700 ms | Vạch đôi không được nhận ra → tăng; hai bàn gần nhau bị nhầm là vạch đôi → giảm |
| `OBSTACLE_CM` | 8 cm | Dừng quá sớm/quá muộn |

Gỡ lỗi: chạy robot bridge với `DEBUG_SERIAL=1` để thấy mọi dòng robot gửi lên (`PASS`, `ARR`, `ST`…).

## Giao thức serial

Xem [apps/robot-bridge/src/protocol.ts](../../apps/robot-bridge/src/protocol.ts). Tóm tắt:

- **Bridge → robot:** `G <vạch> <id>`, `S <id>` (dừng khẩn), `P <id>` / `R <id>` (tạm dừng / chạy tiếp), `C <id>` (hủy đích), `Q`.
- **Robot → bridge:** `HELLO`, `OK <id>`, `ERR <id> <lý do>`, `PASS <n>`, `ARR <n>`, `OBS`, `CLR`, `BTN`, `LOST`, `ST <vạch> <I|M|P|O|S> <mV>`.
