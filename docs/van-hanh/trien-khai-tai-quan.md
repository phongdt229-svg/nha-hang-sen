# Triển khai tại quán

Dành cho người lắp đặt và quản trị kỹ thuật. Hệ thống chạy trên **một server trong quán** (edge); mọi thiết bị nối qua LAN, **mất Internet vẫn phục vụ được** (mục 13.2).

## 1. Phần cứng

| Thiết bị | Gợi ý | Ghi chú |
|---|---|---|
| Server | Mini PC 4 nhân, 16 GB RAM, SSD 256 GB+, cổng LAN gigabit | Linux (Ubuntu 24.04) + Docker. Đặt nơi thoáng, xa bếp |
| UPS | ≥ 1000 VA cho server + router + switch | Đủ ≥ 15 phút. Nối cổng USB/network của UPS để server tự tắt đúng cách |
| Router + access point | Wi-Fi 6, tách **SSID nhân viên/thiết bị** khỏi **SSID khách** | Thiết bị quán dùng IP tĩnh hoặc DHCP reservation |
| Tablet bàn | Android 10+, 8–10 inch, đế chống trộm, sạc liên tục | Chế độ kiosk (mục 6) |
| Màn hình bếp (KDS) | Màn hình cảm ứng/All-in-one chịu nhiệt, gắn xa bếp lửa | Nối dây LAN nếu được |
| Máy in nhiệt | 80 mm, cổng LAN (RAW 9100): 1 ở quầy thu ngân, 1 mỗi trạm bếp | Hỗ trợ lệnh ESC/POS chuẩn Epson; in thử khi lắp đặt |
| Máy chạy print agent | Có thể chính là server, hoặc PC quầy thu ngân | Cùng LAN với máy in |

## 2. Cài đặt server

```bash
git clone <repo> nha-hang-sen && cd nha-hang-sen
git checkout <tag phát hành>
cp .env.example infra/.env        # rồi sửa các biến bên dưới
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
docker compose -f infra/docker-compose.yml exec api npx prisma db seed   # chỉ lần đầu: bàn, menu mẫu, tài khoản
```

**Bắt buộc đổi trước khi mở bán** (file `infra/.env`, không commit):

| Biến | Ý nghĩa |
|---|---|
| `JWT_SECRET` | Chuỗi ngẫu nhiên ≥ 32 ký tự (`openssl rand -hex 32`) |
| `POSTGRES_PASSWORD` | Mật khẩu database. Chỉ có tác dụng khi tạo volume lần đầu |
| `METRICS_TOKEN` | Token cho Prometheus đọc `/metrics` (ghi vào `infra/monitoring/metrics-token` và bật dòng `authorization` trong `prometheus.yml`) |
| `GRAFANA_ADMIN_PASSWORD` | Mật khẩu Grafana |
| `SEED_PASSWORD` | Mật khẩu tài khoản mẫu khi seed; **đổi mật khẩu từng người** sau khi đăng nhập lần đầu |
| `SHOP_NAME`, `SHOP_ADDRESS` | In trên phiếu thanh toán |
| `BUSINESS_DAY_CUTOFF_HOUR` | Giờ kết thúc ngày kinh doanh (mặc định 4h sáng) |

Kiểm tra: `http://<server>:3000/health/ready` → `"ok": true`; POS ở `http://<server>:8088/pos/`.

## 3. Cảnh báo qua Telegram / Zalo {#canh-bao}

Watchdog trong API kiểm tra mỗi phút: mất database/Redis, sự kiện kẹt, order không vào bếp, máy in lỗi, hóa đơn tồn đọng, robot lỗi. Mỗi sự cố báo **một lần**, nhắc lại sau 30 phút nếu còn, và báo "✅ Đã khắc phục" khi hết.

- **Telegram:** tạo bot qua `@BotFather` → đặt `TELEGRAM_BOT_TOKEN`; thêm bot vào nhóm quản lý, lấy `TELEGRAM_CHAT_ID` của nhóm.
- **Zalo OA / Slack / hệ thống khác:** đặt `NOTIFY_WEBHOOK_URL`, API gửi `POST {"title","text"}`.
- Thử: đăng nhập POS bằng tài khoản quản lý, gọi `POST /ops/watchdog` (Swagger `http://<server>:3000/docs`), hoặc rút dây một máy in và chờ 1–2 phút.

Mất Internet thì cảnh báo không ra ngoài được. Grafana (mục 4) trong LAN vẫn xem được.

## 4. Giám sát (Prometheus + Grafana)

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env --profile monitoring up -d
```

Grafana `http://<server>:3001` → thư mục "Nhà hàng Sen" → dashboard **Vận hành**:

- p95 order → KDS ACK (mục tiêu < 1 giây), p95 API (< 300 ms)
- số phiếu FALLBACK, sự kiện kẹt, kết nối WebSocket theo loại thiết bị
- hàng đợi, máy in, hóa đơn chưa phát hành, bàn theo trạng thái

Luật cảnh báo xem ở Prometheus `http://<server>:9090/alerts`. Muốn xem từ xa: VPN (WireGuard/Tailscale) vào mạng quán. **Không mở cổng 3000/3001/9090 ra Internet.**

## 5. Print agent {#print-agent}

Chạy trên máy cùng LAN với máy in. Lần đầu cần mã ghép tạo trên POS (Cảnh báo → **Ghép print agent**).

```bash
pnpm install && pnpm --filter @nhs/print-agent build
PAIRING_CODE=123456 API_URL=http://<server>:3000 \
PRINTERS="RECEIPT=tcp://192.168.1.50:9100;BEP_NONG=tcp://192.168.1.51:9100;BEP_LANH=tcp://192.168.1.52:9100;QUAY_BAR=tcp://192.168.1.53:9100@58" \
node apps/print-agent/dist/main.js
```

- Mã máy in phải trùng mã trạm bếp trong menu (`BEP_NONG`, `BEP_LANH`, `QUAY_BAR`); `RECEIPT` là máy in quầy thu ngân. `@58` cho giấy 58 mm.
- Máy in không in được tiếng Việt có dấu: giữ `PRINT_ENCODING=ascii` (mặc định, bỏ dấu). Máy in hỗ trợ UTF-8: `PRINT_ENCODING=utf8`.
- **Chạy như dịch vụ** để tự khởi động:
  - **Linux:** systemd unit với `Restart=always`, `Environment=` các biến trên, `WorkingDirectory` chứa file token.
  - **Windows:** NSSM (`nssm install nhs-print-agent "C:\Program Files\nodejs\node.exe" apps\print-agent\dist\main.js`) và đặt biến môi trường trong tab Environment.
- Sau lần đầu, token lưu ở `.print-agent-token`; bỏ `PAIRING_CODE`.
- Kiểm tra: POS → Cảnh báo → Máy in → **In thử** từng máy.

## 6. Tablet bàn: chế độ kiosk và MDM

Mục tiêu: khách không thoát được app; tablet tự mở lại app khi treo; theo dõi pin tập trung (mục 13.4).

1. **Trình duyệt kiosk:** dùng trình duyệt kiosk cho Android (ví dụ Fully Kiosk Browser) hoặc MDM có chế độ kiosk web (Google Android Management API, Scalefusion, Hexnode…).
   - Trang khởi động `http://<server>:8088/tablet/`.
   - Khóa thanh điều hướng, thanh thông báo, nút nguồn/âm lượng.
   - Bật tự tải lại khi trang lỗi hoặc không tương tác quá 30 phút.
   - Tắt màn hình chờ khi đang cắm sạc.
2. **Ghép bàn:** trên POS bấm vào bàn → **Ghép tablet cho bàn này** → nhập mã 6 số trên tablet. Token lưu trong tablet, khởi động lại không cần ghép lại.
3. **MDM:**
   - Đẩy cùng một cấu hình cho mọi tablet: Wi-Fi nhân viên, trang khởi động, khóa cài đặt.
   - Theo dõi pin và trạng thái online.
   - Tắt cập nhật hệ điều hành tự động trong giờ phục vụ.
4. **Màn hình bếp (KDS):** làm tương tự với trang `http://<server>:8088/kds/`, ghép theo trạm (POS → Cảnh báo → **Ghép màn hình bếp**). Để màn hình luôn sáng.

## 7. Sao lưu

Tự chạy khi `docker compose up` (dịch vụ `backup` + lưu trữ WAL). **Bắt buộc** cấu hình bản sao ngoài server (`BACKUP_SYNC_CMD`) và diễn tập khôi phục trước khi pilot. Xem [infra/backup/README.md](../../infra/backup/README.md).

## 8. Checklist trước ngày mở bán

- [ ] Đổi toàn bộ biến ở mục 2; tạo tài khoản thật cho từng nhân viên, đổi mật khẩu mẫu
- [ ] Nhập menu, giá, **nhóm thuế** từng món; kế toán xác nhận bảng thuế suất và cách làm tròn (mục 12.3, 18)
- [ ] Sơ đồ bàn đúng thực tế; ghép tablet từng bàn, ghép KDS từng trạm
- [ ] In thử mọi máy in; thử rút giấy → POS báo lỗi → lắp lại → phiếu tự in tiếp
- [ ] Cảnh báo Telegram/Zalo tới đúng nhóm
- [ ] Sao lưu đêm đầu thành công; diễn tập khôi phục "ĐẠT"; bản sao đã lên cloud
- [ ] Kiểm thử tải k6 trên server thật đạt ngưỡng ([infra/k6](../../infra/k6/README.md))
- [ ] Rút điện server (có UPS) → cắm lại → hệ thống tự chạy, dữ liệu đủ
- [ ] Chạy UAT theo [kiem-thu-truoc-pilot.md](kiem-thu-truoc-pilot.md)
- [ ] Phát [hướng dẫn nhân viên](../huong-dan/) và tập dượt một buổi
