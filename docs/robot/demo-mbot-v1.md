# Demo robot giao món bằng mBot v1

Theo tài liệu công nghệ v0.7 (MB-01 → MB-28). mBot v1 là robot **demo/prototype**; robot production vẫn là **LuckiBot Pro** (OrionStar). Hai robot dùng chung toàn bộ luồng nghiệp vụ `Order → KDS → Delivery Task → Robot Gateway → xác nhận đã giao`. Chỉ lớp adapter khác nhau (MB-25).

```
POS / KDS / Tablet ── API (Delivery Service → Robot Gateway → MbotV1Adapter)
                                   │ MQTT (mosquitto trên server)
                         Robot bridge (laptop cạnh sa bàn)
                                   │ serial 115200 (cáp USB hoặc Bluetooth)
                               mBot v1 (firmware/mbot-v1)
```

## 1. Sa bàn

In [docs/sa-ban-demo-robot-A1.pdf](../sa-ban-demo-robot-A1.pdf) khổ A1, **tỉ lệ 100%**. Kiểm tra thước in: vạch mẫu phải dài đúng 100 mm.

| Vạch | Vị trí | Mã vị trí trong hệ thống |
|---|---|---|
| Vạch đôi (0) | BẾP – điểm lấy món, vị trí gốc | `KITCHEN_PASS_01`, `ROBOT_HOME` |
| 1 – 4 | BÀN 1 – BÀN 4 | `TABLE_T01` … `TABLE_T04` |
| 5 | TRẠM SẠC | `CHARGER_01` |

- Robot chạy **một chiều theo chiều kim đồng hồ**: từ BÀN 3 về bếp phải đi qua BÀN 4 và trạm sạc.
- Bảng `robot_locations` giữ cách dịch mã vị trí sang số vạch (`vendor_mapping.MAKEBLOCK.stop`). Muốn đổi bàn demo, sửa bảng này, không sửa code.

## 2. Chuẩn bị

1. Server: `pnpm infra:up` (PostgreSQL, Redis, MQTT), `pnpm db:migrate`, `pnpm db:seed`.
   - Seed tạo **R01 = mBot v1** (MAKEBLOCK, mã thiết bị `mbot-01`), **R02/R03 = robot giả lập**, và vị trí sa bàn.
2. API cần `MQTT_URL=mqtt://localhost:1883` trong `apps/api/.env` (có sẵn trong `.env.example`). Rồi chạy `pnpm dev`.
3. Nạp firmware cho mBot: [firmware/mbot-v1/README.md](../../firmware/mbot-v1/README.md).
4. Chạy robot bridge trên laptop cạnh sa bàn:

   ```bash
   pnpm --filter @nhs/robot-bridge build
   # mBot thật (cổng COM của cáp USB hoặc Bluetooth đã ghép đôi):
   SERIAL=COM5 MQTT_URL=mqtt://<ip-server>:1883 node apps/robot-bridge/dist/main.js
   # Chưa có mBot: chạy mBot ảo cùng giao thức
   SERIAL=virtual MQTT_URL=mqtt://localhost:1883 node apps/robot-bridge/dist/main.js
   ```

   Thấy `Robot sẵn sàng: MBOT_V1 …` là được. Trên POS → **Robot**, thẻ R01 chuyển "Rảnh", pin có nhãn "giả lập" (mCore không đo pin, MB-15).
5. Muốn chỉ mBot nhận việc: trên thẻ R02, R03 bấm **Tạm ngưng**.
6. Đặt mBot ngay **sau** vạch đôi ở BẾP, mũi theo chiều chạy.

## 3. Sáu kịch bản bắt buộc (MB-21)

Mọi kịch bản đều xem được trên POS → **Robot**: sơ đồ sa bàn, thẻ robot, danh sách nhiệm vụ, **Nhật ký** từng bước. Các nút lỗi nằm ở mục **Giả lập lỗi** trên thẻ robot.

| # | Kịch bản | Cách diễn | Kết quả mong đợi |
|---|---|---|---|
| 1 | Happy path | Mở BÀN T01 → gọi món → KDS bấm Nấu/Xong | Robot nhận task, tới BẾP. KDS/POS bấm **Đã đặt món lên robot** → robot chạy tới vạch 1, bíp → tablet hiện "Robot đã tới bàn" → khách bấm **Đã nhận món** (hoặc nút trên mBot) → robot chạy tiếp về BẾP → **Hoàn tất** |
| 2 | Robot offline | Robot đang tới bếp → **Mất kết nối** (hoặc rút cáp/tắt Bluetooth) | Sau ~10 giây task **Lỗi – Robot mất kết nối**. **Thử lại** bị chặn khi robot còn offline; chọn **Giao robot khác** (robot giả lập nhận) hoặc **Nhân viên giao** |
| 3 | Vật cản | Robot đang tới bàn → đặt tay trước cảm biến siêu âm (hoặc **Vật cản**) | Robot dừng, task báo "Vật cản"; bỏ vật cản → hệ thống tự gửi lại lệnh (tối đa 2 lần) → robot đi tiếp. **Kẹt hẳn** → hết lượt thử → **Lỗi** → **Nhân viên giao** |
| 4 | Khách không có mặt | Robot tới bàn, không ai bấm nhận | Sau 60 giây task báo "Khách chưa nhận", POS và Telegram/Zalo nhắc nhân viên. Robot **không** tự coi là đã giao. Nhân viên bấm **Xác nhận đã giao** hoặc **Nhân viên giao** |
| 5 | Lệnh trùng | Bấm **Giao bằng robot** nhiều lần / gọi `POST …/assign` hai lần | Chỉ một delivery task, một lần gán robot |
| 6 | Server khởi động lại | Robot đang chạy tới bàn → tắt/bật lại API | mBot vẫn chạy (bridge giữ kết nối). API đối chiếu với robot rồi **chạy tiếp** (nhật ký `RECONCILED`). Robot giả lập mất trạng thái thì task **Lỗi – Máy chủ khởi động lại** → **Thử lại** |

Thêm:
- **Pin yếu:** task đang chạy chuyển Lỗi, robot về trạm sạc (vạch 5); dưới 30% không nhận task mới.
- **Lỗi API:** lệnh không được robot xác nhận → gateway tự thử lại 3 lần → vẫn lỗi thì task Lỗi.
- **Dừng khẩn / Tạm dừng / Về gốc / Về sạc:** các nút trên thẻ robot (MB-20).
- **Mã khay:** `confirm-loaded` nhận `trayCode` tùy chọn, sai mã khay bị chặn (mục 15).

Mọi kịch bản có test tự động: `apps/api/test/delivery.e2e-spec.ts` (robot giả lập) và `apps/api/test/mbot.e2e-spec.ts` (API ↔ MQTT ↔ bridge ↔ mBot ảo).

## 4. Tiêu chí demo thành công (MB-22)

| Tiêu chí | Cách kiểm |
|---|---|
| Ít nhất 1 mBot v1 chạy được | Thẻ R01 "Rảnh", online |
| 1 điểm lấy món, ít nhất 2 bàn demo | Sa bàn: BẾP + BÀN 1–4 |
| Tạo được Delivery Task, gán được mBot | Kịch bản 1: nhật ký `TASK_CREATED`, `ROBOT_ASSIGNED` |
| mBot tới pickup, nhân viên xác nhận loaded | `ARRIVED_PICKUP`, `ITEMS_LOADED` |
| mBot tới bàn, hệ thống nhận event arrived | `ARRIVED_TABLE`, `CUSTOMER_NOTIFIED` |
| Có xác nhận của khách/nhân viên | `CUSTOMER_CONFIRMED` / `STAFF_CONFIRMED` |
| mBot quay về home | `RETURN_STARTED`, `TASK_COMPLETED` |
| Có retry, có manual takeover | Kịch bản 2, 3 |
| Có log/audit các trạng thái chính | Nhật ký `delivery_events` + `audit_log` (reassign, takeover, cancel, dừng khẩn) |
| Chạy lại được sau khi backend restart | Kịch bản 6 |

## 5. Giới hạn đã biết

- **Firmware chưa chạy trên phần cứng thật:** chưa có mBot và Arduino trên máy phát triển. Lần đầu dựng sa bàn cần căn chỉnh tốc độ và ngưỡng nhận vạch ([firmware README](../../firmware/mbot-v1/README.md#căn-chỉnh-đầu-file-mbot_v1ino)).
- **Pin giả lập:** mCore không đo pin, nên pin là giả lập (hiển thị "giả lập").
- **Vị trí trên sơ đồ nhảy theo từng vạch:** mBot chỉ báo khi đi qua vạch, nên chấm robot trên sơ đồ nhảy theo vạch, không trượt mượt.
- **Ngoài phạm vi MVP mBot (MB-23):** SLAM, bản đồ động, nhiều tầng, thang máy, tối ưu đội robot, nhận diện món, tự sạc, màn hình trên robot.
- **LuckiBot Pro:** `LuckiBotProAdapter` mới là khung, chờ tài liệu OpenAPI và appid/secret từ OrionStar (LB-29).
