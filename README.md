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
| POS thu ngân / lễ tân | http://localhost:5174/pos/ | `quanly`, `thungan`, `phucvu` / `sen123` |
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

E2E (`apps/api/test`) phủ các kịch bản bắt buộc ở mục 15 thuộc phạm vi lõi: bấm xác nhận 5 lần → 1 order; KDS không ACK → retry 3 lần → FALLBACK → nhập tay; chuyển bàn; hai thu ngân khóa cùng bill; thanh toán/webhook trùng; WebSocket rớt → bắt kịp bằng `lastEventId`; phân quyền. Unit test `packages/pricing` gồm golden test bill đồ ăn 8% + bia 10% và đổi thuế suất qua 01/01/2027.

## Cấu trúc

```
apps/api        NestJS + Prisma + BullMQ + Socket.IO
apps/tablet     React PWA – khách gọi món
apps/pos        React – thu ngân, lễ tân, cảnh báo bếp, tổng quan
apps/kds        React – màn hình bếp
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
| 5 | Tách/hủy tách bill, gộp phiên, hoàn tiền (bút toán âm), kết ca + duyệt chênh lệch, báo cáo doanh thu/KPI/điều chỉnh, chốt ngày + job đêm, xuất Excel/CSV/PDF | Backend xong + test; **chưa có giao diện** |
| 6 | Webhook thanh toán có chữ ký, chống trùng, đối soát định kỳ | Backend xong + test |
| 6 | Hóa đơn điện tử: gói `packages/einvoice-adapters` (interface + adapter giả lập), schema | **Đang làm**: chưa nối vào API |
| 11–13 | Robot: `packages/robot-adapters` (giả lập, MQTT, thủ công, khung OrionStar), điều phối (gom món, chọn robot, xác thực khay, lỗi → giao robot khác, chuyển nhân viên, đổi bàn đích), chỉ số giao món | Backend xong + test; **chưa có màn hình điều phối/sơ đồ** |
| 3 | Print agent ESC/POS | Chưa làm |
| 8 | AI tư vấn món (FastAPI) | Chưa làm |
| 9–10, 14 | Kho nguyên liệu, định lượng, trừ kho, kiểm kê, food cost | Chưa làm |
| 7 | Giám sát, sao lưu, k6, runbook | Chưa làm |
| — | i18n tablet, firmware mBot2/ESP32, dashboard/back-office | Chưa làm |

Robot giả lập: 3 robot `R01–R03` có sẵn sau `pnpm db:seed`; tốc độ chỉnh bằng `SIM_SPEED`. Robot OrionStar cần tài liệu OpenAPI + appid/secret từ nhà phân phối để hiện thực `OrionStarClient`.
