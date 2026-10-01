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
| POS thu ngân / lễ tân | http://localhost:5174/pos/ | `admin`, `quanly`, `thungan`, `phucvu`, `ketoan` / `sen123` |
| Tablet gọi món | http://localhost:5173/tablet/ | Mã ghép 6 số tạo trên POS (bấm vào bàn → "Ghép tablet cho bàn này") |
| KDS bếp | http://localhost:5175/kds/ | Mã ghép tạo trên POS (Cảnh báo bếp → "Ghép màn hình bếp") |
| API docs (Swagger) | http://localhost:3000/docs | |

Chạy toàn bộ bằng Docker như tại quán (API chế độ production **từ chối khởi động** nếu `JWT_SECRET` ngắn hoặc là giá trị mặc định):

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml exec api npx prisma db seed   # dữ liệu mẫu, lần đầu
# mở http://localhost:8088/pos/ ; thêm --profile monitoring để có Grafana :3001
```

Triển khai thật tại quán, vận hành, sự cố: [docs/van-hanh/](docs/van-hanh/) · hướng dẫn nhân viên: [docs/huong-dan/](docs/huong-dan/) (cũng xem được trong app: nút **Hướng dẫn**).

**Luồng demo:** POS mở bàn → ghép tablet → khách gọi món → KDS tự ACK, tablet hiện "Bếp đã nhận" → bếp bấm Nấu/Xong → POS khóa bill → thu tiền mặt hoặc QR → bàn chuyển "Cần dọn" → Dọn xong.

## Kiểm thử

```bash
pnpm test        # unit test tính tiền + máy trạng thái, e2e API trên database nhs_test
pnpm typecheck
```

E2E (`apps/api/test`) phủ các kịch bản bắt buộc ở mục 15 (bảng đối chiếu: [kiem-thu-truoc-pilot.md](docs/van-hanh/kiem-thu-truoc-pilot.md)): bấm xác nhận 5 lần → 1 order; KDS không ACK → retry 3 lần → FALLBACK → nhập tay; chuyển bàn; hai thu ngân khóa cùng bill; thanh toán/webhook trùng; in phiếu (hết giấy / mất kết nối → lệnh nằm trong hàng đợi, agent treo → giao lại, KDS fallback → in phiếu bếp); hóa đơn điện tử (tự phát hành, MST sai → sửa → phát hành lại, mất mạng → hàng đợi, tách bill → 2 hóa đơn, hoàn tiền → điều chỉnh giảm, doanh thu = tổng hóa đơn); giám sát/cảnh báo; khóa tài khoản, thu hồi thiết bị; WebSocket rớt → bắt kịp bằng `lastEventId`; phân quyền. Unit test `packages/pricing` gồm golden test bill đồ ăn 8% + bia 10% và đổi thuế suất qua 01/01/2027.

Kiểm thử tải (k6, 40 bàn, KDS qua WebSocket): [infra/k6](infra/k6/README.md). Diễn tập sao lưu/khôi phục: [infra/backup](infra/backup/README.md).

## Cấu trúc

```
apps/api        NestJS + Prisma + BullMQ + Socket.IO
apps/tablet     React PWA – khách gọi món
apps/pos        React – thu ngân, lễ tân, cảnh báo bếp, tổng quan
apps/kds        React – màn hình bếp
apps/print-agent Node.js chạy tại quán – nhận lệnh in qua LAN, gửi ESC/POS tới máy in nhiệt
apps/robot-bridge Node.js cạnh sa bàn – nối mBot v1 (serial USB/Bluetooth) với API qua MQTT; có mBot ảo
firmware/mbot-v1 Arduino cho mBot v1 (mCore): dò line, đếm vạch dừng, siêu âm, nút khách
packages/types  Kiểu dữ liệu, bảng chuyển trạng thái, danh sách sự kiện
packages/pricing Tính tiền: số nguyên đồng, VAT nhiều mức theo ngày hiệu lực, giảm giá, tách bill, ngày kinh doanh
packages/ui     API client, WebSocket có bắt kịp sự kiện, component dùng chung
infra/          docker-compose, nginx, mosquitto, sao lưu (backup/), giám sát (monitoring/), kiểm thử tải (k6/)
```

## Các cơ chế tin cậy đã làm (mục 6)

- **Idempotency-Key** cho order và thanh toán (cột UNIQUE + kiểm tra lại sau khi giữ khóa).
- **Outbox:** thay đổi nghiệp vụ và sự kiện ghi cùng transaction vào `event_log`; bộ phát đọc bằng `FOR UPDATE SKIP LOCKED`, handler (gửi phiếu bếp) chạy trong cùng transaction với việc đánh dấu đã phát. `event_log` được trigger DB bảo vệ append-only.
- **ACK/retry bếp:** BullMQ kiểm tra ACK sau 3 giây, gửi lại tối đa 3 lần giãn cách tăng dần, hết lượt → FALLBACK + cảnh báo POS; thêm job quét định kỳ phòng khi Redis mất job.
- **Máy trạng thái tập trung** (`packages/types/src/states.ts`), khóa dòng `SELECT … FOR UPDATE`, optimistic locking bằng cột `version` cho bill.
- **Tablet mất mạng khi gửi:** giỏ bị khóa và tự gửi lại đúng khóa cũ khi có mạng, không mất và không trùng order.
- **Audit log** cho hủy món, giảm giá, mở khóa bill, thu tiền, sửa menu, tài khoản nhân viên, thu hồi thiết bị.

## Tiến độ theo kế hoạch sprint

| Sprint | Nội dung | Trạng thái |
|---|---|---|
| 0–4 | Nền móng, bàn/phiên, order idempotency, KDS ACK/retry, bill & thanh toán | Xong (backend + tablet/POS/KDS) |
| 5 | Tách/hủy tách bill, gộp phiên, hoàn tiền (bút toán âm), kết ca + duyệt chênh lệch, báo cáo doanh thu/KPI/điều chỉnh, chốt ngày + job đêm, xuất Excel/CSV/PDF | Xong: backend + test + màn hình POS (tách/hủy tách bill, gộp bàn, hoàn tiền, mục Ca làm, mục Báo cáo có xuất file và chốt ngày) |
| 6 | Webhook thanh toán có chữ ký, chống trùng, đối soát định kỳ | Backend xong + test |
| 6 | Hóa đơn điện tử: tự phát hành sau thanh toán qua hàng đợi (idempotency theo bill), tra cứu MST, Failed → sửa người mua → gửi lại không trùng, mất mạng → xếp hàng + quét định kỳ, hoàn tiền → hóa đơn điều chỉnh giảm, điều chỉnh/thay thế (kế toán), bảng kê theo thuế suất, đối soát doanh thu = hóa đơn; POS nhập MST, in số/mã tra cứu, cảnh báo hóa đơn lỗi | Xong + test (adapter giả lập). **Chưa có:** adapter nhà cung cấp thật và webhook `/webhooks/einvoice/{provider}` — chờ sandbox |
| 11–13 | Robot theo v0.7 (RD, MB): Delivery Task với máy trạng thái RD-11 dùng chung mBot/LuckiBot, Robot Gateway (`/internal/...` LB-22), `MbotV1Adapter` + robot bridge + firmware mBot v1, robot giả lập chạy theo sa bàn; retry vật cản, heartbeat offline, chờ khách 60 giây, pin 30/15%, retry/reassign/nhân viên giao/hủy, đối chiếu sau khi server khởi động lại, nhật ký `delivery_events`; POS tab **Robot** (sa bàn, điều khiển, giả lập lỗi), KDS "Đã đặt món lên robot", tablet "Đã nhận món" | Xong + test (6 kịch bản MB-21, đầu–cuối qua MQTT với mBot ảo). **Chưa có:** chạy firmware trên mBot thật; `LuckiBotProAdapter` chờ OpenAPI OrionStar |
| 3 | Print agent ESC/POS (`apps/print-agent`): hàng đợi lệnh in có idempotency, agent hỏi việc mỗi giây kèm trạng thái máy in, hết giấy / mất kết nối → lệnh nằm lại hàng đợi + POS báo lỗi, agent treo → hết hạn giữ lệnh thì giao lại; tự in phiếu bếp khi KDS FALLBACK; POS in phiếu thanh toán, in lại phiếu bếp, in thử, ghép agent | Xong + test (máy in TCP giả lập) |
| 8 | AI tư vấn món (FastAPI) | Chưa làm |
| 9–10, 14 | Kho nguyên liệu, định lượng, trừ kho, kiểm kê, food cost | Chưa làm |
| 7 | Giám sát: `/metrics` Prometheus + dashboard Grafana, `/health/ready`, watchdog cảnh báo Telegram/Zalo không gửi lặp; tự khởi động lại sau mất điện; sao lưu WAL liên tục + bản nền hằng đêm, diễn tập khôi phục đo RTO/RPO; k6 giờ cao điểm; quản lý nhân viên, đổi mật khẩu, thu hồi thiết bị; runbook, hướng dẫn triển khai + kiosk/MDM, hướng dẫn theo vai trò, checklist UAT | Xong + test. **Còn tại quán:** k6 trên server thật, diễn tập mất điện/mất WAN, UAT chạy song song |
| v0.8 | Hướng dẫn sử dụng trong app (HD): nút **Hướng dẫn** trên POS/KDS/tablet đọc thẳng `docs/huong-dan/*.md` + runbook, tìm không dấu, mở đúng mục theo màn hình và vai trò, in trang; POS **Chạy thử (theo dõi trực tiếp)**: bảng 9 bước mở bàn → gọi món → bếp → robot → thanh toán → dọn bàn tự đánh dấu theo dữ liệu thật; **Đào tạo nhân viên mới**: lộ trình buổi đầu, bài tập theo vai trò đánh dấu được (tiến độ theo tài khoản), tình huống sự cố, 10 câu kiểm tra có đáp án ẩn, tiêu chí đạt | Xong + test (link giữa các hướng dẫn, chạy trọn một bàn trên trình duyệt) |
| — | i18n tablet, firmware mBot2/ESP32, dashboard/back-office | Chưa làm |

**Hóa đơn điện tử:** `EINVOICE_PROVIDER=mock` dùng adapter giả lập (MST thử: `0100109106`, `0312345678`; MST khác bị từ chối). `EINVOICE_AUTO=false` để thu ngân bấm phát hành thủ công. Cần xác nhận với kế toán theo NĐ 254/2026 trước khi dùng thật (mục 12).

**Print agent** (chạy trên một máy tính trong LAN của quán, không cần Internet):

```bash
pnpm --filter @nhs/print-agent build
# Lần đầu: tạo mã ghép trên POS (mục Cảnh báo → "Ghép print agent")
PAIRING_CODE=123456 API_URL=http://192.168.1.10:3000 PRINTERS="BEP_NONG=tcp://192.168.1.51:9100;QUAY_BAR=tcp://192.168.1.52:9100@58;RECEIPT=tcp://192.168.1.50:9100" node apps/print-agent/dist/main.js
```

Máy in mạng dùng cổng RAW 9100; `@58` cho giấy 58mm; `console:` in ra màn hình, `file:đường-dẫn` ghi lệnh ESC/POS ra file để thử không cần máy in. Mặc định bỏ dấu tiếng Việt (`PRINT_ENCODING=ascii`) vì nhiều máy in nhiệt không có bảng mã tiếng Việt; máy in hỗ trợ UTF-8 thì đặt `PRINT_ENCODING=utf8`. Token thiết bị lưu ở `.print-agent-token`, các lần sau không cần mã ghép.

**Robot giao món:** sau `pnpm db:seed` có R01 = mBot v1 (qua robot bridge) và R02, R03 = robot giả lập (tốc độ chỉnh bằng `SIM_SPEED`). Demo trên sa bàn A1, chạy thử không cần phần cứng bằng `SERIAL=virtual`: [docs/robot/demo-mbot-v1.md](docs/robot/demo-mbot-v1.md). LuckiBot Pro cần tài liệu OpenAPI + appid/secret từ OrionStar để hiện thực `OrionStarClient`.
