# App Làm Video Liền Mạch — bản độc lập ngoài Muse

Đây là bộ khung ứng dụng web độc lập cho mô hình **mỗi nhân viên có kho riêng, quản trị viên xem tất cả**.

## Đã có

- Thiết lập tài khoản quản trị đầu tiên, đăng nhập/đăng xuất bằng cookie phiên an toàn.
- Quản trị tạo, khóa/mở và đặt lại mật khẩu tài khoản nhân viên.
- Vai trò `admin`, `staff`, `viewer`.
- Dự án và phân cảnh tách theo chủ sở hữu; nhân viên không truy cập được kho của người khác.
- Quản trị xem được mọi dự án và tải được mọi file.
- Khóa một giọng đọc cho mỗi dự án; sửa lời thoại làm cảnh mất trạng thái đã thu.
- Quy trình duyệt cảnh: cảnh có clip mới được duyệt đạt; ghi chú chỉnh sửa theo từng cảnh.
- Tải ảnh gốc, clip cảnh và video hoàn chỉnh; phát video theo Range và tải về máy.
- **Tách kịch bản phân cảnh** từ văn bản dán vào (nhận diện “Cảnh N”, thời lượng, dòng Lời thoại/Chữ).
- **Đổi thứ tự cảnh**, **co giãn thời lượng** mọi cảnh theo tổng mới, **xóa dự án**.
- **Ảnh tham chiếu giống 100%**: dùng chính ảnh gốc của dự án làm ảnh tham chiếu cho cảnh; chế độ AI và “Sửa nắp & nhãn” đi vào hàng đợi nhà cung cấp kèm chỉ dẫn khóa nhãn nguyên văn.
- **Thư viện nhạc nền**: tải nhạc lên kho, gán cho từng dự án.
- **Worker ghép FFmpeg thật**: ghép các clip có sẵn theo thứ tự với crossfade, trộn giọng đọc theo vị trí cảnh và nhạc nền, xuất MP4 `+faststart` và tự đăng ký thành video hoàn chỉnh.
- **API callback cho worker ngoài** (`/api/worker/jobs/:id/complete|fail`, xác thực bằng `WORKER_TOKEN`) để dịch vụ AI/TTS bên ngoài giao clip, file giọng hoặc báo lỗi — tương đương các callback của bản Muse.
- Hàng đợi tác vụ cho phân tích/sinh clip/thu giọng. Khi chưa cấu hình nhà cung cấp AI/TTS, tác vụ ở trạng thái `waiting_provider`, không giả vờ hoàn thành.

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
- `WORKER_TOKEN` — khóa bí mật cho API callback của worker/dịch vụ ngoài; để trống thì callback bị tắt.

## Việc chưa làm

- Chưa kết nối nhà cung cấp phân tích ảnh, tạo ảnh/video AI hoặc TTS thật; các tác vụ đó đang chờ ở hàng đợi và nhận kết quả qua API callback khi có dịch vụ.
- Chưa chuyển dữ liệu từ app Muse hiện tại.
- Chưa có tên miền, HTTPS và hạ tầng sao lưu production.
- Tải file hiện đọc toàn bộ vào bộ nhớ trước khi lưu; khi triển khai production với file rất lớn nên chuyển sang tải lên dạng streaming/object storage.
