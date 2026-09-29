# Cào đa site — Chrome Extension

Extension cào sản phẩm đa site (Staples, Williams-Sonoma, Revolve, Walmart…) chạy thẳng
trong trình duyệt, không cần cài Walmart Scanner Tool. Hướng dẫn dùng chi tiết:
[extension/README.md](extension/README.md).

Tách khỏi repo `walmart-scanner-tool` từ 2026-09-29 (trước đó nằm ở
`ext/site-crawler-extension`), phát hành riêng, không theo số bản của tool.

## Tải bản mới nhất

<https://github.com/mitvodich9x/cao-da-site-extension/releases/latest/download/cao-da-site-extension.zip>

Giải nén → `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư
mục vừa giải nén. Đã cài rồi thì giải nén đè lên thư mục cũ rồi bấm **↻ Reload**.

## Cấu trúc

- `extension/` — mã nguồn extension (thư mục để *Load unpacked* khi sửa code).
- `extension/lumi-default.js` — token CDN Lumi điền sẵn. **Không có trên git** (repo công
  khai); máy nào phát hành thì phải có file này:

  ```js
  window.LUMI_DEFAULT_TOKEN = '<token Lumi>';
  ```

- `tools/extract_harness.py` — chạy `extract.js` trên 1 file HTML đã lưu (không cần IP Mỹ).
- `extension.json` — thông tin bản mới cho nút **🔄 Kiểm tra cập nhật**; `release.ps1` tự ghi.

## Phát hành bản mới

1. Tăng `version` trong `extension/manifest.json`, commit.
2. Chạy:

   ```powershell
   powershell -File release.ps1 -Notes "Cao da site: ..."
   ```

   Script đóng zip, tạo GitHub Release `v<version>` kèm `cao-da-site-extension.zip`, ghi
   `extension.json` rồi commit + push. Thêm `-DryRun` để chạy thử không đăng gì.
