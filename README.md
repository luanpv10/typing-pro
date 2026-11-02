# FPT POLYSCHOOL Typing Pro – thi gõ tiếng Việt

## Chạy thử
1. Cài Node.js 18+. Trong thư mục này: `npm install` rồi `ADMIN_PASS=matkhau node server.js`
   (Windows PowerShell: `$env:ADMIN_PASS="matkhau"; node server.js`)
2. Mở `http://localhost:3000` (hoặc `http://IP-máy-chủ:3000` từ máy khác cùng mạng).

## Deploy lên Render
- Build Command: `npm install`  |  Start Command: `npm start`
- Biến môi trường: `ADMIN_PASS` (bắt buộc đổi), cùng 2 biến Upstash bên dưới.

## Lưu dữ liệu vĩnh viễn (Upstash Redis – miễn phí)
Ổ đĩa của Render gói Free bị xóa mỗi lần khởi động lại, nên dữ liệu (sinh viên, bảng xếp hạng, lịch sử, cấu hình) được lưu trên Upstash:
1. Đăng ký tại https://upstash.com → Create Database (Redis) → chọn vùng gần nhất (ví dụ Singapore).
2. Trong trang database, mục **REST API**, copy `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN`.
3. Trên Render: Environment → thêm 2 biến trên với đúng giá trị vừa copy → Save (Render tự deploy lại).
4. Vào “🛠 Giám thị”: thấy dòng xanh “✅ Dữ liệu được lưu vĩnh viễn” là xong. Dòng đỏ nghĩa là chưa kết nối.

Nếu đã cấu hình Upstash mà server không đọc được dữ liệu lúc khởi động, server sẽ tự dừng (thay vì chạy với dữ liệu rỗng và ghi đè). Xem tab Logs trên Render.

## Giám thị
Trang chủ → “🛠 Giám thị” → nhập mật khẩu:
- Chỉnh thời gian 1–5 phút, soạn đoạn văn.
- Theo dõi trực tiếp một phòng thi, tung hô người thắng.
- Quản lý dữ liệu: xóa từng dòng bảng xếp hạng, xóa theo mốc thời gian, xóa toàn bộ bảng xếp hạng, xóa lịch sử, xóa từng sinh viên / sửa tên, **xóa toàn bộ dữ liệu** (gõ XOA để xác nhận).
- Tải bản sao lưu (.json) và khôi phục từ file.
