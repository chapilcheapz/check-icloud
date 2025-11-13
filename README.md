# Check iPhone Tool (libimobiledevice)

Công cụ web đơn giản để tự động unpair/pair và lấy thông tin iPhone bằng `libimobiledevice`.

**Yêu cầu**
- Node.js (>=14)
- `libimobiledevice` và `idevicepair`, `ideviceinfo` trên hệ thống:
  - macOS: `brew install libimobiledevice --HEAD usbmuxd`
  - Ubuntu/Debian: `sudo apt-get install libimobiledevice-utils usbmuxd`
  - Windows: cài WSL + apt hoặc cài bộ công cụ tương ứng (khuyến nghị dùng WSL)
- Cắm iPhone qua USB và **mở khóa màn hình** trước khi bấm Bắt đầu.

**Cách cài**
```bash
cd check_iphone_tool
npm install
npm start
```

Mở trình duyệt tới `http://localhost:3000` rồi bấm **Bắt đầu kiểm tra**.

**Lưu ý về quyền Trust**
- Khi chạy `idevicepair pair`, iPhone sẽ hiển thị popup "Tin cậy máy tính này?". Người dùng phải bấm **Tin cậy** trên iPhone.
- Nếu device báo "Password protected" hoặc lỗi pairing, thử rút cáp, unlock màn hình, thử lại.

**Tính năng**
- Unpair cũ → Pair lại → Lấy `ideviceinfo` → Hiển thị kết quả
- Tải PDF mẫu báo cáo `/pdf`

**Gợi ý mở rộng**
- Tự động export PDF với logo cửa hàng
- Hỗ trợ xử lý hàng loạt (queue) nhiều máy
- Gọi API kiểm tra blacklist/IMEI nếu cần (ví dụ imei.info)
