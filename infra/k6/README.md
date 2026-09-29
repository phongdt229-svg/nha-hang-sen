# Kiểm thử tải giờ cao điểm (k6)

Kịch bản [peak.js](peak.js) mô phỏng giờ cao điểm theo mục 15, 17.2:

- **Mỗi bàn một người dùng ảo:** mở phiên → gọi món 3 lần (có ghi chú, 1/10 lần mạng gửi lại cùng `Idempotency-Key`) → khóa bill → thanh toán QR → xác nhận tiền về → dọn bàn → lặp lại.
- **Mỗi trạm bếp một KDS giả lập:** giữ kết nối WebSocket (giao thức socket.io) như màn hình bếp thật, ACK ngay khi nhận phiếu.
- **Ngưỡng đạt:**
  - p95 thời gian phản hồi API < 300 ms
  - p95 xác nhận order < 300 ms
  - p95 order → KDS ACK < 1 giây, đọc từ histogram `/metrics` của API
  - lỗi request < 1%
  - 0 order trùng

## Chạy

Dữ liệu cần đủ bàn trống: `SEED_TABLES=45 pnpm db:seed`.

```bash
docker run --rm -i --add-host host.docker.internal:host-gateway \
  -e API_URL=http://host.docker.internal:3000 -e TABLES=40 -e DURATION=10m -e THINK=20 \
  -v "$PWD/infra/k6:/scripts:ro" grafana/k6:0.57.0 run /scripts/peak.js
```

Tại quán, chạy từ một máy khác trong LAN với `API_URL=http://<ip-server>:3000` để đo đúng đường mạng thật. **Không chạy trong giờ phục vụ**: kịch bản tạo phiên, order, thanh toán thật (dùng database thử hoặc chạy trước ngày khai trương).

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `TABLES` | 40 | Số bàn phục vụ đồng thời |
| `DURATION` | 10m | Thời gian chạy (thêm tối đa 3 phút để các bàn đang ăn thanh toán xong) |
| `THINK` | 20 | Giây giữa hai lần gọi món của một bàn. 300 order/giờ với 40 bàn ≈ 480 giây; giá trị nhỏ để thử tải nặng hơn mục tiêu |
| `ORDERS_PER_SESSION` | 3 | Số lần gọi món mỗi phiên |
| `METRICS_TOKEN` | | Khi API đặt `METRICS_TOKEN` |

## Kết quả

**29/09/2026 — máy dev (Windows, API chạy `pnpm dev`, k6 trong Docker):** 30 bàn, `DURATION=3m`, `THINK=10`, 3 KDS qua WebSocket.

| Chỉ số | Kết quả | Mục tiêu |
|---|---|---|
| Order tạo thành công | 492 trong khoảng 6 phút (≈ 4.800 order/giờ) | 300 order/giờ |
| p95 thời gian phản hồi API | 109 ms | < 300 ms |
| p95 xác nhận order | 80 ms | < 300 ms |
| p95 order → KDS ACK | ≤ 0,5 giây (786 phiếu) | < 1 giây |
| Phiếu FALLBACK | 0 | 0 |
| Order trùng khi gửi lại cùng khóa | 0 | 0 |
| Request lỗi | 0,3% | < 1% |

0,3% request lỗi là `dial: i/o timeout`: kết nối từ container k6 sang máy Windows (Docker Desktop) không mở được, request chưa tới API, và API không ghi nhận lỗi 5xx nào. Đo lại trên server Linux thật tại quán, từ một máy khác trong LAN.

Bài học khi viết kịch bản:

- **KDS giả lập phải nhận phiếu qua WebSocket như KDS thật.** Bản đầu hỏi `GET /kitchen/tickets` mỗi 200 ms, danh sách phình tới hàng trăm phiếu vì món không bao giờ "xong". Việc này chiếm hết kết nối database, làm outbox chậm, p95 order → phiếu bếp lên 14 giây. Đó là tải giả không có ngoài thực tế.
- **`__VU` đánh số chung cho mọi scenario.** Dùng nó để chia trạm/bàn có thể trùng; kịch bản dùng `exec.scenario.iterationInTest` cho KDS và để mỗi bàn tự giành bàn trống qua API.
