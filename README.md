# FPT POLYSCHOOL Typing Pro – thi gõ tiếng Việt

## Chạy thử
1. Cài Node.js 18+. Trong thư mục này: `npm install` rồi `ADMIN_PASS=matkhau node server.js`
   (Windows PowerShell: `$env:ADMIN_PASS="matkhau"; node server.js`)
2. Mở `http://localhost:3000` (hoặc `http://IP-máy-chủ:3000` từ máy khác cùng mạng).

## Deploy lên Render
- Build Command: `npm install`  |  Start Command: `npm start`
- Biến môi trường: `ADMIN_PASS` (giám thị 1, bắt buộc đổi), `PROCTOR_PASS` (giám thị 2, đặt mật khẩu khác ADMIN_PASS; không đặt thì tắt vai trò này), cùng 2 biến Upstash bên dưới.

## Lưu dữ liệu vĩnh viễn (Upstash Redis – miễn phí)
Ổ đĩa của Render gói Free bị xóa mỗi lần khởi động lại, nên dữ liệu (sinh viên, bảng xếp hạng, lịch sử, cấu hình) được lưu trên Upstash:
1. Đăng ký tại https://upstash.com → Create Database (Redis) → chọn vùng gần nhất (ví dụ Singapore).
2. Trong trang database, mục **REST API**, copy `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN`.
3. Trên Render: Environment → thêm 2 biến trên với đúng giá trị vừa copy → Save (Render tự deploy lại).
4. Vào “🛠 Giám thị”: thấy dòng xanh “✅ Dữ liệu được lưu vĩnh viễn” là xong. Dòng đỏ nghĩa là chưa kết nối.

Nếu đã cấu hình Upstash mà server không đọc được dữ liệu lúc khởi động, server sẽ tự dừng (thay vì chạy với dữ liệu rỗng và ghi đè). Xem tab Logs trên Render.

## Hai loại giám thị
Trang chủ → “🛠 Giám thị” → nhập mật khẩu; mật khẩu nào sẽ vào đúng loại đó:
- **Giám thị 1 (ADMIN_PASS)**: toàn quyền (mọi chức năng bên dưới).
- **Giám thị 2 (PROCTOR_PASS)**: chỉ quản lý thi theo lớp: tạo lớp + mật khẩu lớp (không chọn đoạn văn, đoạn văn lấy ngẫu nhiên từ kho của giám thị 1), chờ sinh viên vào, bấm bắt đầu / kết thúc / hủy, xem kết quả và tung hô. Không có quyền cấu hình, theo dõi phòng đối kháng, xóa/sửa dữ liệu, sao lưu.

## Chức năng của giám thị 1
- Chỉnh thời gian 1–5 phút, soạn đoạn văn.
- Theo dõi trực tiếp một phòng thi, tung hô người thắng.
- **Thi theo lớp**: tạo lớp (mã lớp, mật khẩu, sĩ số tối đa; **thời gian cố định 5 phút**; **mã lớp phải duy nhất**, không dùng lại mã của buổi thi đã lưu; giám thị 1 có thể chọn đoạn văn, giám thị 2 luôn nhận đoạn ngẫu nhiên từ kho do giám thị 1 quản lý) → sinh viên nhập mã + mật khẩu ở trang chủ vào phòng chờ → bấm “Bắt đầu thi” để cả lớp thi cùng lúc, xem bảng xếp hạng trực tiếp, tung hô người đứng đầu. Mỗi lúc chỉ có 1 lớp thi. Kết quả mỗi buổi được lưu thành thống kê (xem ở Bảng xếp hạng → “👥 Theo lớp”) và điểm cũng được ghi vào bảng xếp hạng chung. Nếu server khởi động lại giữa buổi thi, lớp đang mở sẽ mất và cần tạo lại.
- Quản lý dữ liệu: xóa từng dòng bảng xếp hạng, xóa theo mốc thời gian, xóa toàn bộ bảng xếp hạng, xóa lịch sử, xóa thống kê thi theo lớp, xóa từng sinh viên / sửa tên, **xóa toàn bộ dữ liệu** (gõ XOA để xác nhận).
- Tải bản sao lưu (.json) và khôi phục từ file.


## Đăng nhập giám thị được ghi nhớ
Sau khi nhập đúng mật khẩu, trình duyệt lưu một cookie (token ký số, hiệu lực 12 giờ). Tải lại trang vẫn là giám thị; bấm logo hoặc “Trang chủ” để về trang chủ mà không thoát. Muốn thoát hẳn thì bấm “Đăng xuất”. Đổi mật khẩu (ADMIN_PASS / PROCTOR_PASS) hoặc đặt biến `SESSION_SECRET` sẽ làm mọi token cũ hết hiệu lực.

## Chống gian lận (extension tự gõ, dán, bơm chữ)
Máy chủ là nơi quyết định, trình duyệt gửi kèm số liệu bàn phím thật:
- Chỉ tính phím do người dùng thật bấm (`isTrusted`); phím/sự kiện nhập do script hoặc extension tạo ra bị đếm và bị bỏ qua.
- Hủy điểm (hiện cờ 🚩, không vào bảng xếp hạng) khi: tốc độ vượt giới hạn con người (>35 ký tự/giây trong ~1,5 giây hoặc >18 ký tự/giây trong ~3–6 giây), chữ xuất hiện nhưng số phím thật quá ít, nhịp gõ đều như máy, có ≥3 sự kiện nhập giả lập, hoặc trình duyệt bị điều khiển tự động (webdriver).
- Cảnh báo mềm ⚠ (giám thị thấy, không tự hủy): rời tab/cửa sổ từ 4 lần, hoặc trình duyệt không gửi dữ liệu kiểm tra.
- Đoạn văn không nằm dạng chữ trong DOM (extension đọc nội dung trang sẽ không lấy được); chặn dán, sao chép, kéo thả, chuột phải.
- Lưu ý: không có cách nào ở trình duyệt chống tuyệt đối. Với kỳ thi quan trọng, nên **chặn cài extension bằng chính sách Chrome** trên máy phòng thi (ExtensionInstallBlocklist = "*") hoặc cho thi bằng cửa sổ Khách (Guest) không có extension, và dùng bộ gõ của hệ điều hành (Unikey, EVKey) thay vì extension gõ tiếng Việt.

## Ghi chú giao diện
- Phía trên cùng giữa trang luôn hiển thị số người đang online (số kết nối đang mở, cập nhật khoảng 1,5 giây).
- Thi một mình: nút “⏹ Kết thúc” ở góc phải. Kết thúc sớm sẽ hiện kết quả nhưng **không ghi vào bảng xếp hạng**; thi hết giờ hoặc gõ xong đoạn văn mới được ghi. Sau khi kết thúc, nút đó đổi thành “← Về trang chủ”.
