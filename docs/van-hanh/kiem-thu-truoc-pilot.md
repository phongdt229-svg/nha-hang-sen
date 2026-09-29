# Kiểm thử trước pilot (mục 15) và UAT

Đối chiếu từng kịch bản bắt buộc ở mục 15 của [tài liệu công nghệ](../tai-lieu-cong-nghe-nha-hang-thong-minh.md) với test tự động hiện có. Chạy lại toàn bộ: `pnpm test` (cần `pnpm infra:up`).

Ký hiệu cột "Tự động":
- ✅ đã có test tự động và xanh
- 🟡 có một phần
- 🔲 phải kiểm tra tay tại quán
- ⛔ chưa làm (ngoài phạm vi MVP)

| # | Kịch bản mục 15 | Tự động | Bằng chứng | Cần làm tại quán (UAT) |
|---|---|---|---|---|
| 1 | Khách bấm xác nhận 2 lần → chỉ 1 order | ✅ | `core`: "bấm xác nhận 5 lần song song"; k6: 0 order trùng khi gửi lại cùng khóa | Bấm đúp "Xác nhận gọi món" trên tablet thật |
| 2 | Ngắt mạng KDS → retry → phiếu giấy → nhập tay → luồng tiếp tục | ✅ | `core`: "KDS không ACK → gửi lại 3 lần → FALLBACK"; `print`: "tự in phiếu giấy ở trạm bếp" | Rút dây mạng màn hình bếp giữa giờ thử |
| 3 | Chuyển bàn giữa lúc bếp đang nấu → robot giao đúng bàn mới | ✅ | `robots`: "chuyển bàn giữa lúc bếp đang nấu", "chuyển bàn khi robot đang chạy" | Với robot thật (khi có) |
| 4 | Gộp bàn, tách bill theo món và theo nhóm → tổng khớp | ✅ | `sprint5`: tách/hủy tách/gộp; `pricing`: "tổng các bill con bằng bill gốc" | Thu ngân tách bill 3 phần trên POS |
| 5 | Robot kẹt / hết pin / mất kết nối → món quay lại hàng chờ | ✅ | `robots`: "robot kẹt", "robot mất kết nối", "chuyển nhân viên giao" | Với robot thật |
| 6 | Pickup quét sai khay → hệ thống chặn | ✅ | `robots`: "quét sai khay bị chặn" | |
| 7 | Webhook thanh toán gửi 2 lần → ghi nhận 1 lần | ✅ | `payments`: "webhook gửi 2 lần" | Với sandbox cổng thanh toán thật |
| 8 | Mất Internet toàn quán → gọi món, bếp, robot vẫn chạy qua LAN | 🔲 | Kiến trúc edge: mọi dịch vụ chạy trên server tại quán, không gọi ra ngoài trong luồng chính | **Rút dây WAN của router** 30 phút giờ thấp điểm: gọi món, bếp, thu tiền mặt, in phiếu |
| 9 | Tải giờ cao điểm: 40 bàn, 200 order/giờ, ACK < 1 giây | 🟡 | k6 trên máy dev: 30 bàn, ≈ 4.800 order/giờ, p95 ACK ≤ 0,5 giây ([kết quả](../../infra/k6/README.md#kết-quả)) | **Chạy lại 40 bàn trên server thật**, từ máy khác trong LAN |
| 10 | Đo Ready → Pickup → Delivered, tỷ lệ fallback, thời gian chế biến | 🟡 | `robots`: "báo cáo chỉ số giao món"; `/metrics`: độ trễ ACK, số FALLBACK; Grafana | Xem dashboard sau buổi chạy thử |
| 11 | Doanh thu = tổng thanh toán = tổng hóa đơn điện tử (theo ngày kinh doanh) | ✅ | `einvoice`: "doanh thu ngày kinh doanh = tổng hóa đơn" | Kế toán đối chiếu một ngày chạy thử |
| 12 | Hoàn tiền sau khi chốt ngày → ngày cũ không đổi, bút toán âm ở ngày hoàn | ✅ | `sprint5`: "hoàn tiền sau khi chốt ngày" | |
| 13 | Kết ca lệch tiền → cảnh báo, yêu cầu duyệt | ✅ | `sprint5`: "kết ca: tiền mặt đếm lệch vượt ngưỡng" | |
| 14 | Bán món → trừ đúng nguyên liệu; hủy trước/sau Preparing | ⛔ | Kho (Sprint 9–10) chưa làm | |
| 15 | Nguyên liệu về 0 → món tự báo hết, AI không gợi ý | ⛔ | Kho + AI chưa làm (hiện bếp báo hết món bằng tay: `core` "món hết → tablet không gọi được") | |
| 16 | Nhập kho đơn vị quy đổi → tồn và giá vốn đúng | ⛔ | Sprint 9 | |
| 17 | Kiểm kê → chênh lệch thành dòng điều chỉnh có duyệt | ⛔ | Sprint 14 | |
| 18 | Bill đồ ăn + bia → hóa đơn tách đúng từng mức thuế | ✅ | `einvoice`: "bill đồ ăn + bia tách đúng từng mức thuế"; `pricing`: golden test 8% + 10% | Kế toán kiểm tra hóa đơn sandbox của nhà cung cấp thật |
| 19 | Đổi ngày qua 01/01/2027 → thuế suất mới | ✅ | `pricing`: "qua 01/01/2027 tự áp dụng thuế suất mới" | Kế toán xác nhận thuế suất sau 2026 |
| 20 | Tách bill 2 phần → 2 hóa đơn, tổng khớp | ✅ | `einvoice`: "tách bill 2 phần → 2 hóa đơn" | |
| 21 | MST sai → báo lỗi, sửa, phát hành lại không trùng | ✅ | `einvoice`: "MST không tồn tại → Failed…" | Với nhà cung cấp thật |
| 22 | Mất Internet khi thanh toán → hóa đơn vào hàng đợi, tự phát hành | ✅ | `einvoice`: "mất Internet khi thanh toán" | Gộp vào kịch bản 8 |
| 23 | Hoàn tiền sau khi xuất hóa đơn → điều chỉnh giảm + bút toán âm | ✅ | `einvoice`: "hoàn tiền sau khi xuất hóa đơn"; `pricing`: phân bổ theo mức thuế | |
| 24 | Hai thu ngân cùng một bill → một thành công, bên kia được báo | ✅ | `core`: "hai thu ngân cùng khóa một bill" | |
| 25 | Ngắt WebSocket KDS 30 giây rồi nối lại → đủ order, không trùng | ✅ | `core`: "WebSocket rớt rồi nối lại → lấy đủ sự kiện qua lastEventId" | |
| 26 | Máy in hết giấy / mất kết nối → lệnh trong hàng đợi, POS báo lỗi | ✅ | `print`: "máy in hết giấy…", "agent treo…"; `print-agent` unit: máy in TCP giả hết giấy/tắt | **In thử và rút giấy trên máy in thật** |
| 27 | Webhook thanh toán không đến → đối soát tự hỏi lại | ✅ | `payments`: "webhook không đến → tác vụ đối soát" | |
| 28 | LLM trả món không tồn tại / sai giá → bị loại | ⛔ | AI (Sprint 8) chưa làm | |
| 29 | Mất điện server (có UPS) → khởi động lại, dữ liệu nguyên vẹn | 🟡 | `restart: unless-stopped`, WAL + Redis AOF; diễn tập khôi phục: RTO 4 giây, mất 0 sự kiện ([kết quả](../../infra/backup/README.md)) | **Rút điện server** (sau UPS) rồi cắm lại |

Bổ sung ngoài mục 15:
- **Giám sát, cảnh báo:** `ops` (chống gửi lặp, báo khắc phục).
- **Tài khoản:** `users` (khóa người nghỉ việc có hiệu lực ngay, thu hồi thiết bị).

## Buổi UAT chạy song song (mục 17.4 Sprint 7)

Một buổi phục vụ thật, **song song với cách làm cũ** (order giấy / máy POS cũ vẫn giữ):

1. **Trước buổi:**
   - Hoàn tất checklist [triển khai](trien-khai-tai-quan.md#8-checklist-trước-ngày-mở-bán).
   - Nhân viên đã đọc [hướng dẫn theo vai trò](../huong-dan/) và tập 30 phút.
2. **Trong buổi:**
   - Mọi order đi qua hệ thống mới; bếp vẫn nhận phiếu giấy cũ để đối chiếu.
   - Quản lý ghi lại mọi chỗ vướng vào sổ.
   - Làm các kịch bản 🔲 ở giờ thấp điểm: rút WAN (8), rút mạng KDS (2), rút giấy máy in (26).
3. **Sau buổi:**
   - Kế toán đối chiếu doanh thu hệ thống với cách cũ và với hóa đơn (11).
   - Xem dashboard Grafana: p95 ACK, số FALLBACK, lỗi 5xx.
   - Họp 30 phút: danh sách lỗi (chặn pilot / sửa sau) và danh sách cải tiến.

**Điều kiện bắt đầu pilot:**
- Mọi dòng ✅ vẫn xanh.
- Mọi dòng 🔲 và 🟡 trong phạm vi MVP đã kiểm tra tại quán.
- Không còn lỗi mức "chặn pilot".
