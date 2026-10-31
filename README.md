# Typing Pro – thi gõ tiếng Việt đối kháng 1–1

## Chạy thử (2 máy cùng mạng LAN)
1. Cài Node.js 18+.
2. Trong thư mục này: `npm install` rồi `ADMIN_PASS=matkhau node server.js`
   (Windows PowerShell: `$env:ADMIN_PASS="matkhau"; node server.js`)
3. Mở `http://IP-máy-chủ:3000` trên cả hai máy (xem IP bằng `ipconfig` / `ifconfig`).

## Đưa lên internet
Dùng bất kỳ dịch vụ chạy Node.js: Render, Railway, Fly.io, VPS…
- Build: `npm install`   Start: `npm start`
- Biến môi trường: `ADMIN_PASS` (bắt buộc đổi), `PORT` (tự động).
- Bật HTTPS (các dịch vụ trên đều có sẵn); trang tự dùng wss://.
- Lưu ý: nếu host miễn phí không giữ ổ đĩa, config.json có thể bị reset khi khởi động lại.

## Giám thị
Trang chủ → “🛠 Giám thị” → nhập mật khẩu: chỉnh 1–5 phút, soạn đoạn văn, xem các phòng đang thi, xem/xuất CSV kết quả.
Lịch sử kết quả giữ trong bộ nhớ máy chủ (mất khi khởi động lại) – hãy xuất CSV sau buổi thi.
