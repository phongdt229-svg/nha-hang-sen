# Nhà hàng Sen – Hệ thống nhà hàng thông minh

Mã nguồn MVP theo [tài liệu công nghệ](docs/tai-lieu-cong-nghe-nha-hang-thong-minh.md). Bản này làm phần **lõi** theo thứ tự giảm rủi ro ở mục 13.8:
Session → Order (idempotency) → KDS (ACK/retry) → Bill → Thanh toán.

## Chạy thử

Cần Node 20+, Docker, pnpm (`corepack enable pnpm`).

```bash
pnpm install
cp .env.example .env && cp .env apps/api/.env
pnpm infra:up          # PostgreSQL, Redis, MQTT
pnpm db:migrate        # tạo bảng
pnpm db:seed           # 12 bàn, menu mẫu, thuế suất, tài khoản
pnpm dev               # API :3000 + tablet :5173 + POS :5174 + KDS :5175
```

| Màn hình | Địa chỉ | Đăng nhập |
|---|---|---|
| POS thu ngân / lễ tân | http://localhost:5174/pos/ | `quanly`, `thungan`, `phucvu`, `ketoan` / `sen123` |
| Tablet gọi món | http://localhost:5173/tablet/ | Mã ghép 6 số tạo trên POS (bấm vào bàn → "Ghép tablet cho bàn này") |
| KDS bếp | http://localhost:5175/kds/ | Mã ghép tạo trên POS (Cảnh báo bếp → "Ghép màn hình bếp") |
| API docs (Swagger) | http://localhost:3000/docs | |

Chạy toàn bộ bằng Docker như tại quán: `docker compose -f infra/docker-compose.yml up --build`, rồi nạp dữ liệu mẫu bằng `pnpm db:seed`, mở http://localhost:8088/pos/.

**Luồng demo:** POS mở bàn → ghép tablet → khách gọi món → KDS tự ACK, tablet hiện "Bếp đã nhận" → bếp bấm Nấu/Xong → POS khóa bill → thu tiền mặt hoặc QR → bàn chuyển "Cần dọn" → Dọn xong.

## Kiểm thử

```bash
pnpm test        # unit test tính tiền + máy trạng thái, e2e API trên database nhs_test
pnpm typecheck
```

E2E (`apps/api/test`) phủ các kịch bản bắt buộc ở mục 15 thuộc phạm vi lõi: bấm xác nhận 5 lần → 1 order; KDS không ACK → retry 3 lần → FALLBACK → nhập tay; chuyển bàn; hai thu ngân khóa cùng bill; thanh toán/webhook trùng; in phiếu (hết giấy / mất kết nối → lệnh nằm trong hàng đợi, agent treo → giao lại, KDS fallback → in phiếu bếp); hóa đơn điện tử (tự phát hành, MST sai → sửa → phát hành lại, mất mạng → hàng đợi, tách bill → 2 hóa đơn, hoàn tiền → điều chỉnh giảm, doanh thu = tổng hóa đơn); WebSocket rớt → bắt kịp bằng `lastEventId`; phân quyền. Unit test `packages/pricing` gồm golden test bill đồ ăn 8% + bia 10% và đổi thuế suất qua 01/01/2027.

## Cấu trúc

```
apps/api        NestJS + Prisma + BullMQ + Socket.IO
apps/tablet     React PWA – khách gọi món
apps/pos        React – thu ngân, lễ tân, cảnh báo bếp, tổng quan
apps/kds        React – màn hình bếp
apps/print-agent Node.js chạy tại quán – nhận lệnh in qua LAN, gửi ESC/POS tới máy in nhiệt
packages/types  Kiểu dữ liệu, bảng chuyển trạng thái, danh sách sự kiện
packages/pricing Tính tiền: số nguyên đồng, VAT nhiều mức theo ngày hiệu lực, giảm giá, tách bill, ngày kinh doanh
packages/ui     API client, WebSocket có bắt kịp sự kiện, component dùng chung
infra/          docker-compose, nginx, mosquitto
```

## Các cơ chế tin cậy đã làm (mục 6)

- **Idempotency-Key** cho order và thanh toán (cột UNIQUE + kiểm tra lại sau khi giữ khóa).
- **Outbox:** thay đổi nghiệp vụ và sự kiện ghi cùng transaction vào `event_log`; bộ phát đọc bằng `FOR UPDATE SKIP LOCKED`, handler (gửi phiếu bếp) chạy trong cùng transaction với việc đánh dấu đã phát. `event_log` được trigger DB bảo vệ append-only.
- **ACK/retry bếp:** BullMQ kiểm tra ACK sau 3 giây, gửi lại tối đa 3 lần giãn cách tăng dần, hết lượt → FALLBACK + cảnh báo POS; thêm job quét định kỳ phòng khi Redis mất job.
- **Máy trạng thái tập trung** (`packages/types/src/states.ts`), khóa dòng `SELECT … FOR UPDATE`, optimistic locking bằng cột `version` cho bill.
- **Tablet mất mạng khi gửi:** giỏ bị khóa và tự gửi lại đúng khóa cũ khi có mạng, không mất và không trùng order.
- **Audit log** cho hủy món, giảm giá, mở khóa bill, thu tiền, sửa menu.

## Tiến độ theo kế hoạch sprint

| Sprint | Nội dung | Trạng thái |
|---|---|---|
| 0–4 | Nền móng, bàn/phiên, order idempotency, KDS ACK/retry, bill & thanh toán | Xong (backend + tablet/POS/KDS) |
| 5 | Tách/hủy tách bill, gộp phiên, hoàn tiền (bút toán âm), kết ca + duyệt chênh lệch, báo cáo doanh thu/KPI/điều chỉnh, chốt ngày + job đêm, xuất Excel/CSV/PDF | Xong: backend + test + màn hình POS (tách/hủy tách bill, gộp bàn, hoàn tiền, mục Ca làm, mục Báo cáo có xuất file và chốt ngày) |
| 6 | Webhook thanh toán có chữ ký, chống trùng, đối soát định kỳ | Backend xong + test |
| 6 | Hóa đơn điện tử: tự phát hành sau thanh toán qua hàng đợi (idempotency theo bill), tra cứu MST, Failed → sửa người mua → gửi lại không trùng, mất mạng → xếp hàng + quét định kỳ, hoàn tiền → hóa đơn điều chỉnh giảm, điều chỉnh/thay thế (kế toán), bảng kê theo thuế suất, đối soát doanh thu = hóa đơn; POS nhập MST, in số/mã tra cứu, cảnh báo hóa đơn lỗi | Xong + test (adapter giả lập). **Chưa có:** adapter nhà cung cấp thật và webhook `/webhooks/einvoice/{provider}` — chờ sandbox |
| 11–13 | Robot: `packages/robot-adapters` (giả lập, MQTT, thủ công, khung OrionStar), điều phối (gom món, chọn robot, xác thực khay, lỗi → giao robot khác, chuyển nhân viên, đổi bàn đích), chỉ số giao món | Backend xong + test; **chưa có màn hình điều phối/sơ đồ** |
| 3 | Print agent ESC/POS (`apps/print-agent`): hàng đợi lệnh in có idempotency, agent hỏi việc mỗi giây kèm trạng thái máy in, hết giấy / mất kết nối → lệnh nằm lại hàng đợi + POS báo lỗi, agent treo → hết hạn giữ lệnh thì giao lại; tự in phiếu bếp khi KDS FALLBACK; POS in phiếu thanh toán, in lại phiếu bếp, in thử, ghép agent | Xong + test (máy in TCP giả lập) |
| 8 | AI tư vấn món (FastAPI) | Chưa làm |
| 9–10, 14 | Kho nguyên liệu, định lượng, trừ kho, kiểm kê, food cost | Chưa làm |
| 7 | Giám sát, sao lưu, k6, runbook | Chưa làm |
| — | i18n tablet, firmware mBot2/ESP32, dashboard/back-office | Chưa làm |

**Hóa đơn điện tử:** `EINVOICE_PROVIDER=mock` dùng adapter giả lập (MST thử: `0100109106`, `0312345678`; MST khác bị từ chối). `EINVOICE_AUTO=false` để thu ngân bấm phát hành thủ công. Cần xác nhận với kế toán theo NĐ 254/2026 trước khi dùng thật (mục 12).

**Print agent** (chạy trên một máy tính trong LAN của quán, không cần Internet):

```bash
pnpm --filter @nhs/print-agent build
# Lần đầu: tạo mã ghép trên POS (mục Cảnh báo → "Ghép print agent")
PAIRING_CODE=123456 API_URL=http://192.168.1.10:3000 PRINTERS="BEP_NONG=tcp://192.168.1.51:9100;QUAY_BAR=tcp://192.168.1.52:9100@58;RECEIPT=tcp://192.168.1.50:9100" node apps/print-agent/dist/main.js
```

Máy in mạng dùng cổng RAW 9100; `@58` cho giấy 58mm; `console:` in ra màn hình, `file:đường-dẫn` ghi lệnh ESC/POS ra file để thử không cần máy in. Mặc định bỏ dấu tiếng Việt (`PRINT_ENCODING=ascii`) vì nhiều máy in nhiệt không có bảng mã tiếng Việt; máy in hỗ trợ UTF-8 thì đặt `PRINT_ENCODING=utf8`. Token thiết bị lưu ở `.print-agent-token`, các lần sau không cần mã ghép.

Robot giả lập: 3 robot `R01–R03` có sẵn sau `pnpm db:seed`; tốc độ chỉnh bằng `SIM_SPEED`. Robot OrionStar cần tài liệu OpenAPI + appid/secret từ nhà phân phối để hiện thực `OrionStarClient`.
