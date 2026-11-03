# App Làm Video Liền Mạch — bản độc lập ngoài Muse

Đây là bộ khung ứng dụng web độc lập cho mô hình **mỗi nhân viên có kho riêng, quản trị viên xem tất cả**.

## Đã có trong giai đoạn 1

- Thiết lập tài khoản quản trị đầu tiên, đăng nhập/đăng xuất bằng cookie phiên an toàn.
- Quản trị tạo, khóa/mở và đặt lại mật khẩu tài khoản nhân viên.
- Vai trò `admin`, `staff`, `viewer`.
- Dự án và phân cảnh tách theo chủ sở hữu; nhân viên không truy cập được kho của người khác.
- Quản trị xem được mọi dự án và tải được mọi file.
- Khóa một giọng đọc cho mỗi dự án; sửa lời thoại làm cảnh mất trạng thái đã thu.
- Quy trình duyệt cảnh: cảnh có clip mới được duyệt đạt; ghi chú chỉnh sửa theo từng cảnh.
- Tải ảnh gốc, clip cảnh và video hoàn chỉnh; phát video theo Range và tải về máy.
- Hàng đợi tác vụ cho phân tích/sinh clip/thu giọng/ghép. Khi chưa cấu hình nhà cung cấp AI/TTS, tác vụ ở trạng thái `waiting_provider`, không giả vờ hoàn thành.

## Chạy thử

Yêu cầu Node.js 22.5 trở lên.

```bash
npm run check
npm start
```

Mở `http://localhost:4173`. Lần đầu chạy, ứng dụng yêu cầu tạo tài khoản quản trị.

## Dữ liệu cục bộ

- SQLite: `data/app.db`
- File người dùng tải lên: `data/media/`

Sao lưu cả thư mục `data/` khi chạy thử nội bộ. Khi triển khai thật, chuyển SQLite sang cơ sở dữ liệu máy chủ và `data/media/` sang object storage.

## Biến môi trường

- `PORT` — cổng chạy, mặc định `4173`.
- `HOST` — mặc định `0.0.0.0`.
- `DATA_DIR` — thư mục dữ liệu, mặc định `./data`.
- `MAX_UPLOAD_MB` — giới hạn một file tải lên, mặc định `512`.
- `SESSION_TTL_DAYS` — thời hạn phiên, mặc định `7`.

## Việc chưa làm trong giai đoạn 1

- Chưa kết nối nhà cung cấp phân tích ảnh, tạo ảnh/video AI hoặc TTS thật.
- Chưa có worker FFmpeg ghép tự động; tác vụ ghép được kiểm tra điều kiện và đưa vào hàng đợi.
- Chưa chuyển dữ liệu từ app Muse hiện tại.
- Chưa có tên miền, HTTPS và hạ tầng sao lưu production.
