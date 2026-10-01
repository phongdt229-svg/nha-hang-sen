# Đào tạo nhân viên mới

Một buổi 2–3 giờ, quản lý ca hướng dẫn. Sau buổi này nhân viên tự làm được các việc của vai trò mình và biết xử lý các sự cố thường gặp.

Trên POS và màn hình bếp: **Hướng dẫn** → **Đào tạo nhân viên mới**. Bấm ô vuông để đánh dấu bài đã làm; tiến độ được nhớ theo tài khoản trên máy đó.

## Chuẩn bị (quản lý)

- **Tập trên hệ thống tập, không tập trên hệ thống đang bán.**
  - Bill tập sẽ vào doanh thu, hóa đơn điện tử và kết ca thật.
  - Hệ thống tập là bản chạy thử có dữ liệu mẫu, do người kỹ thuật dựng trên một máy riêng.
- Tạo tài khoản cho nhân viên mới, đúng vai trò: **Nhân viên & thiết bị** → **Thêm nhân viên**.
- Mở sẵn 3 màn hình: POS, màn hình bếp, tablet (xem mục "Chuẩn bị" của [chạy thử toàn bộ luồng](chay-thu.md#chuẩn-bị)).
- In sẵn hướng dẫn của vai trò để nhân viên ghi chú.

## Lộ trình buổi đầu

| Thời gian | Nội dung | Người làm |
|---|---|---|
| 15 phút | Giới thiệu luồng: khách gọi món trên tablet → bếp → robot giao → thanh toán → dọn bàn | Quản lý |
| 30 phút | Làm mẫu một vòng: POS → **Hướng dẫn** → **Chạy thử (theo dõi trực tiếp)** | Quản lý làm, nhân viên xem |
| 60 phút | Bài tập của vai trò (dưới đây) | Nhân viên tự làm |
| 20 phút | [Tình huống sự cố](#tình-huống-sự-cố) | Cùng làm |
| 15 phút | [Câu hỏi kiểm tra](#câu-hỏi-kiểm-tra) và [đánh giá](#đánh-giá-đạt) | Quản lý |

## Bài tập phục vụ / lễ tân

- [ ] **Mở bàn** cho 3 khách ở một bàn trống. Kết quả: bàn chuyển "Đang dùng".
- [ ] **Ghép tablet** cho bàn vừa mở: bấm bàn → **Ghép tablet cho bàn này** → nhập mã trên tablet.
- [ ] Trên tablet gọi 2 món, một món ghi chú "ít cay". Kết quả: tablet báo "Bếp đã nhận".
- [ ] **Gọi món hộ** thêm 1 món từ POS.
- [ ] **Hủy** 1 món bếp chưa nấu: **Món đã gọi** → **Hủy** → nhập lý do.
- [ ] **Chuyển bàn** sang một bàn trống. Kết quả: món đi theo khách, bàn cũ "Cần dọn".
- [ ] **Gộp bàn** hai bàn đang dùng. Kết quả: hai bàn dùng chung một bill.
- [ ] Robot tới bàn mà khách không bấm: mục **Robot** → **Xác nhận đã giao**.
- [ ] **Dọn bàn** sau khi thu ngân thu tiền: bấm bàn "Cần dọn" → **Đã dọn xong — bàn sẵn sàng**.

Chi tiết: [hướng dẫn phục vụ](phuc-vu.md).

## Bài tập thu ngân

- [ ] **Đổi mật khẩu** lần đầu: bấm tên mình ở góc trên.
- [ ] **Mở ca**: mục **Ca làm** → nhập tiền mặt đầu ca → **Mở ca**.
- [ ] Thu **tiền mặt** một bàn: **Khóa bill để thanh toán** → nhập tiền khách đưa → **Thu tiền mặt**. Đọc đúng tiền thừa trả khách.
- [ ] Thu **QR chuyển khoản** → bấm **Đã nhận tiền** (hệ thống tập không nối ngân hàng thật).
- [ ] **Tách bill** 2 phần theo món, thu tiền từng phần.
- [ ] Khách lấy **hóa đơn công ty**: nhập mã số thuế → **Tra cứu** → **Lưu thông tin hóa đơn**, làm **trước** khi thu tiền. Hệ thống tập dùng MST thử `0100109106`.
- [ ] **In phiếu thanh toán** (chưa có máy in thì **In bằng trình duyệt**).
- [ ] **Kết ca**: nhập tiền mặt đếm thực tế. Thử nhập lệch 100.000đ để thấy ca chờ quản lý duyệt.

Chi tiết: [hướng dẫn thu ngân](thu-ngan.md).

## Bài tập bếp

- [ ] **Bật âm báo**; nhận phiếu mới → **Nấu** → **Xong**.
- [ ] **Báo hết món** → **Báo hết** một món; nhờ phục vụ kiểm tra tablet không gọi được món đó; rồi **Bán lại**.
- [ ] Robot tới điểm lấy món: đặt món lên khay → **Đã đặt món lên robot**.
- [ ] Món không dùng robot: **Nhân viên mang**.
- [ ] Nói lại được: màn hình mất mạng thì nấu theo **phiếu giấy**; có mạng lại bấm **Bếp đã nhận phiếu**.

Chi tiết: [hướng dẫn bếp](bep.md).

## Bài tập quản lý ca

Làm hết bài tập phục vụ và thu ngân, thêm:

- [ ] **Giảm giá** một bill đang mở (số tiền + lý do).
- [ ] **Mở khóa bill** đã khóa để khách gọi thêm.
- [ ] **Hoàn tiền** một phần bill đã thanh toán.
- [ ] **Duyệt** ca kết lệch tiền: **Ca làm** → **Duyệt** + lý do.
- [ ] Robot lỗi: mục **Robot** → **Giả lập lỗi** → **Kẹt hẳn** trên robot đang giao → xử lý bằng **Thử lại** hoặc **Nhân viên giao**.
- [ ] **Ghép màn hình bếp** mới; **Thu hồi** một thiết bị ở mục **Thiết bị**.
- [ ] **Chạy thử toàn bộ luồng** một mình tới khi bảng bước báo "Hoàn tất".
- [ ] Đọc [sổ tay xử lý sự cố](../van-hanh/runbook.md) mục 1–4 và 7.

Chi tiết: [hướng dẫn quản lý ca](quan-ly.md).

## Tình huống sự cố

Người hướng dẫn tạo tình huống trên hệ thống tập, nhân viên xử lý:

| Tình huống | Cách tạo | Nhân viên phải làm |
|---|---|---|
| Màn hình bếp mất mạng | Tắt Wi-Fi máy bếp rồi gọi món | Bếp nấu theo phiếu giấy; quản lý bấm **Bếp đã nhận (nhập tay)** |
| Máy in hết giấy | Rút giấy máy in rồi in phiếu | Thay giấy, phiếu tự in tiếp; gấp thì **In bằng trình duyệt** |
| Robot gặp vật cản | **Robot** → **Giả lập lỗi** → **Vật cản** | Dọn lối đi → **Thử lại**, hoặc **Nhân viên giao** |
| Robot mất kết nối | **Giả lập lỗi** → **Mất kết nối** | Món chưa lên robot: **Giao robot khác**; món đã lên robot: **Nhân viên giao** |
| Khách vắng khi robot tới | Không bấm "Đã nhận món" trong 60 giây | Ra bàn mời khách lấy món → **Xác nhận đã giao** |
| Hai thu ngân cùng một bill | Hai máy cùng mở một bill rồi cùng khóa | Máy báo "Bill vừa được người khác thay đổi" → đóng và mở lại bill |

## Câu hỏi kiểm tra

Hỏi miệng; bấm "Đáp án" để xem.

**1. Mạng chậm, khách bấm "Xác nhận gọi món" hai lần. Có bị gọi trùng không?**

<details>
<summary>Đáp án</summary>

Không. Tablet gửi lại đúng lần gọi cũ, hệ thống chỉ tạo **một** order.

</details>

**2. Màn hình bếp mất mạng đúng lúc khách gọi món. Bếp biết có món mới bằng cách nào?**

<details>
<summary>Đáp án</summary>

Phiếu **in giấy** ở máy in của trạm. Bếp nấu theo phiếu; quản lý bấm **Bếp đã nhận (nhập tay)** trên POS.

</details>

**3. Robot đã tới bếp nhưng đứng yên, không chạy ra bàn. Vì sao?**

<details>
<summary>Đáp án</summary>

Robot chờ bếp đặt món lên khay và bấm **Đã đặt món lên robot**. Robot chỉ chạy ra bàn sau khi có người bấm nút này.

</details>

**4. Bill đã khóa, khách muốn gọi thêm món. Làm gì?**

<details>
<summary>Đáp án</summary>

Báo **quản lý**: **Mở khóa bill** (ghi lý do), rồi gọi thêm như bình thường.

</details>

**5. Khách lấy hóa đơn công ty: nhập mã số thuế lúc nào?**

<details>
<summary>Đáp án</summary>

**Trước** khi thu tiền: **Khách lấy hóa đơn công ty** → mã số thuế → **Tra cứu** → **Lưu thông tin hóa đơn**.

</details>

**6. Robot báo lỗi khi món đã ở trên khay. Chọn nút nào?**

<details>
<summary>Đáp án</summary>

**Nhân viên giao**: nhân viên lấy món trên robot mang ra bàn. **Giao robot khác** chỉ dùng khi món **chưa** đặt lên robot.

</details>

**7. Kết ca lệch tiền quá ngưỡng thì sao?**

<details>
<summary>Đáp án</summary>

Ca không tự đóng mà chờ **quản lý duyệt**. Báo quản lý và giải thích (hoàn tiền mặt, QR ghi nhầm tiền mặt…).

</details>

**8. Mất Internet toàn quán. Còn gọi món, bếp, robot được không?**

<details>
<summary>Đáp án</summary>

Được: mọi thứ chạy qua mạng trong quán. Thu **tiền mặt**, hoặc QR nhưng thu ngân xác nhận tay khi thấy tiền về. Hóa đơn điện tử tự phát hành khi có mạng lại.

</details>

**9. Có được dùng chung tài khoản với đồng nghiệp không?**

<details>
<summary>Đáp án</summary>

Không. Mỗi người một tài khoản; mọi thao tác tiền (giảm giá, hủy, hoàn) ghi tên người làm.

</details>

**10. Tablet báo mất mạng khi khách đang chọn món. Khách có phải chọn lại không?**

<details>
<summary>Đáp án</summary>

Không. Giỏ hàng được giữ nguyên và **tự gửi lại** khi có mạng, không bị gọi trùng. Gấp thì phục vụ **Gọi món hộ** trên POS.

</details>

## Đánh giá đạt

Quản lý xác nhận nhân viên:

- làm hết bài tập của vai trò mà không cần nhắc
- trả lời đúng ít nhất 8/10 câu hỏi kiểm tra
- xử lý đúng ít nhất 2 tình huống sự cố
- (thu ngân, quản lý) chạy thử toàn bộ luồng tới "Hoàn tất"

Ghi vào sổ đào tạo: họ tên, vai trò, ngày, người hướng dẫn, kết quả. Chưa đạt: hẹn buổi tập lại cho phần còn thiếu.

## Tuần đầu làm việc

- Ca đầu tiên làm cùng một nhân viên cũ cùng vai trò.
- Gặp tình huống lạ: bấm **Hướng dẫn** ở góc trên, gõ từ khóa vào ô tìm kiếm.
- Cuối tuần, quản lý hỏi lại những chỗ còn vướng và bổ sung vào hướng dẫn.
