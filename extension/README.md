# Cào đa site — Chrome Extension

Bản extension của trang **"Cào đa site"** trong Walmart Scanner Pro: dán danh sách link
sản phẩm → cào tiêu đề / giá gốc + giá hiện tại / mô tả / ảnh theo variant **và size · màu ·
còn/hết hàng** → copy TSV (dán vào Excel) hoặc tải CSV theo **bố cục checklist eBay**
(21 cột: tiêu đề đã sửa · màu hiện tại · size còn/hết của variant đang xem · % giá đặt ·
định danh variant… — xem mục "Bảng xuất ra").
**Không cần cài Walmart Scanner Tool** — chỉ cần trình duyệt Chrome/Chromium, nên copy
sang bao nhiêu máy cũng được.

Ưu điểm so với tool desktop: extension chạy ngay TRONG trình duyệt nên không cần bật
cổng debug (CDP), không cần dò cổng — mở profile VMLogin có proxy US, bật extension là cào.

## Cài đặt (Load unpacked)

1. Tải `cao-da-site-extension.zip` bản mới nhất ở
   <https://github.com/mitvodich9x/cao-da-site-extension/releases/latest> rồi giải nén
   ra 1 thư mục.
2. Mở Chrome → gõ `chrome://extensions` → bật **Developer mode** (góc phải trên).
3. Bấm **Load unpacked** → chọn thư mục vừa giải nén.
4. Bấm icon extension trên thanh công cụ → side panel mở ra → dán link → **Bắt đầu cào**.

Với VMLogin: mở profile như bình thường (không cần bật debug port), rồi làm bước 2-4
trong cửa sổ profile đó. Nên bấm thử 1 link để chắc IP đang là US (phần lớn site chặn
IP ngoài Mỹ).

## Cấu trúc

- `extract.js` — **nguồn sự thật duy nhất** về luật cào 23 site (từ 2026-09-25 tính năng
  cào đa site tách khỏi WM tool, chỉ dùng extension). Sửa luật thì sửa thẳng file này;
  bản `app/services/site_crawler/extract.js` của tool đã đóng băng, không đồng bộ nữa.
  Luật chạy ở **isolated world** của extension: KHÔNG đọc được biến `window.*` của trang
  (phải moi từ chữ trong thẻ `<script>`), và `window.<id>` trả về chính PHẦN TỬ có id đó
  (VD `window.__NEXT_DATA__` là thẻ script — Walmart từng hỏng vì vậy).

- `background.js` — điều phối (mở tab nền, chờ render, poll extract, retry giữ kết quả
  tốt nhất) — logic mirror từ `app/services/site_crawler/crawler.py`.
- `panel.html/css/js` — giao diện side panel, 2 tab: **🌐 Cào site** (bảng kết quả, copy
  ảnh/TSV, tải CSV) và **🔗 Cào link** (bảng link theo nhà).
- `picker.js` — ô chọn sản phẩm của tab Cào link, gắn vào trang web bằng
  `chrome.scripting.executeScript` (lớp phủ shadow DOM, không sửa DOM/CSS của trang).

## Tab 🔗 Cào link — gom link sản phẩm từ trang danh mục

Chưa có sẵn danh sách link sản phẩm? Lấy thẳng từ **trang danh mục / trang tìm kiếm** của
site, không phải mở từng sản phẩm để copy link:

1. Mở panel → tab **🔗 Cào link** → tích **Hiện ô chọn trên các trang web**.
2. Mở trang danh mục của site. Mỗi sản phẩm hiện **1 ô vuông** ở góc ảnh, góc phải dưới có
   thanh nổi **Đã chọn N/M · Chọn tất cả · Bỏ chọn · Lấy link**. Bấm ô để tick, giữ **Shift**
   để tick cả dải.
3. Bấm **Lấy link** (trên thanh nổi, hoặc **🔗 Lấy link đã chọn** ở panel): link đã tick được
   **copy vào bộ nhớ tạm** và **thêm vào bảng** của panel. Link trùng tự bỏ; ô đã lấy chuyển
   viền xanh lá. Sang trang 2, sang site khác rồi lặp lại — bảng cứ nối thêm.
4. Lấy xong:
   - **📄 Copy bảng (dán Excel/Sheets)** — 4 cột `Nhà · Link · Tiêu đề · Ảnh`, tách bằng Tab
     nên dán vào bảng link theo nhà là tự chia đúng cột. Bảng xếp gom theo nhà.
   - **⬇️ Tải CSV** — cùng 4 cột, UTF-8 BOM mở thẳng bằng Excel.
   - **➡️ Đẩy sang Cào site** — tự dán link vào ô nhập link của tab Cào site (link đã có
     trong ô thì bỏ qua) rồi chuyển sang tab đó, bấm **🕷️ Bắt đầu cào** là xong.
   - Có tick dòng nào trong bảng thì các nút trên chỉ lấy dòng tick.

Chi tiết:

- **Nhà** = tên site, tự nhận theo tên miền (Staples, Revolve, Walmart…; site lạ thì lấy
  tên miền viết hoa chữ đầu).
- Ô chọn chỉ hiện ở ô có **ảnh** và link trông như trang sản phẩm (`/dp/`, `/products/`,
  `/ip/`, `/p/`, `/itm/`, `…-12345.html`…), hoặc ô có giá tiền. Menu, header, footer, link
  giỏ hàng/danh mục/hãng bị bỏ qua. Trang cuộn tải thêm sản phẩm thì ô chọn tự hiện thêm.
- Link được chuẩn hoá giống tab Cào site: bỏ tham số theo dõi (`utm_`, `ref`…), giữ tham số
  biến thể (`color`, `dwvar_…`); Amazon rút về `/dp/ASIN`, eBay `/itm/ID`, Etsy `/listing/ID`;
  link quảng cáo đi vòng (Amazon `/sspa/click`, Walmart `/sp/track`) được giải về link thật.
- Bật một lần là mọi tab đang mở và mở sau đều có ô chọn (nhớ qua lần mở Chrome sau). Tắt
  ô **Hiện ô chọn** là gỡ sạch khỏi mọi tab.
- Bảng lưu ở `chrome.storage.local` (`lp_links`), đóng panel/Chrome không mất; chỉ nút
  **🗑 Xoá bảng** / **➖ Xoá dòng tick** mới xoá.
- Ảnh sản phẩm lấy lúc bấm Lấy link; site tải ảnh lười (Target…) mà chưa cuộn tới thì có
  thể thiếu ảnh — cuộn qua trang trước khi lấy.

## Không mất kết quả cào khi nạp lại extension

Kết quả cào được ghi xuống `chrome.storage.local` (`sc_records`) sau mỗi dòng xong.
Nạp lại extension, đóng Chrome, hay Chrome tự tắt service worker khi rảnh — mở panel
lên là bảng kết quả vẫn còn. Bấm **♻️ Lấy lại kết quả cào** để nạp lại thủ công.

Bản nháp đang biên tập (`sc_drafts`) và bộ nhớ ảnh đã convert (`sc_cdn_map`) cũng
được giữ, nên khỏi convert lại ảnh. Chỉ nút **🗑 Xoá** mới xoá bảng kết quả đã lưu.

## Cập nhật extension

Bấm **🔄 Kiểm tra cập nhật** (panel tự kiểm tra 1 lần mỗi khi mở). Có bản mới thì hiện
khung thông báo với 2 nút: **⬇️ Tải bản mới** (tải thẳng file zip về Downloads) và
**🧩 Mở trang extension**.

Chrome **không cho** extension dạng *Load unpacked* tự thay code của chính nó (chỉ bản
cài từ Web Store/CRX mới tự cập nhật), nên còn đúng 2 bước tay: **giải nén đè lên thư
mục đang dùng** → bấm **↻ Reload** ở `chrome://extensions`.

Thông tin bản mới đọc từ `extension.json` trong repo phát hành công khai của tool.

## Biên tập & convert ảnh ngay trong extension

Bấm 1 dòng ở bảng kết quả (hoặc nút ✏️) để mở khung **Chi tiết sản phẩm** — làm được
gần đủ như "Bảng eBay" của bản desktop:

Ngay trên bảng kết quả, cột **Thao tác** có sẵn: **📋 Ảnh** (copy link ảnh) ·
**📐** (chụp bảng Size Guide: mở trang, bấm nút Size Guide, chờ bảng hiện rồi chụp và
đưa lên CDN — trang sẽ hiện ra vài giây rồi tự đóng, vì Chrome chỉ chụp được tab đang hiện) ·
**⚡** (convert ảnh sản phẩm này) · **➕** (thêm ảnh: chọn file / dán ảnh chụp màn hình) ·
**✏️** (mở khung biên tập) · **🔗** · **↻** (cào lại dòng này).

| Phần | Làm được gì |
|---|---|
| Tiêu đề · Giá hiện tại · % giá đặt | sửa tay, tự hiện **Giá ứng = giá hiện tại × %** (mặc định 70%; để trống ô % = dùng % trên page) |
| Ảnh size chart | link ảnh bảng size — Vionic tự có, site khác dán link ảnh đã lên CDN (vào cột "Ảnh size chart") |
| Mô tả · Size & Fit | sửa tay (mô tả đã gộp sẵn Description + Details + Fit & Care) |
| Còn/hết hàng | hiện ngay theo dữ liệu cào (size nào còn, size nào hết) |
| **Variant** | tự điền từ link cào; ➕ thêm dòng / ➖ xoá dòng; bảng **Variant chi tiết** bên dưới tự sinh: dòng đầu là variant chính, các dòng sau là từng tổ hợp (Màu đầu — Size cuối). **Mỗi màu chỉ ra size còn hàng của chính màu đó** — màu nào hết sạch size thì không sinh dòng. Màu tự gõ thêm (tool không biết tồn kho) thì trải đủ trục Size. |
| **Link ảnh** | xem/sửa/thêm link thiếu, mỗi dòng 1 link |
| **Convert ảnh → CDN** | convert 1 sản phẩm hoặc tất cả; tải ảnh không được thì tự mở tab sản phẩm để tải (vượt chặn hotlink) |
| **Link CDN** | bảng mỗi hàng 1 link, bấm 1 hàng là copy link đó |
| **Dán ảnh → CDN** | chụp màn hình (VD bảng **Size & Fit / Size Guide**) rồi bấm nút hoặc **Ctrl+V** ngay trong panel — ảnh lên CDN và nối vào cuối danh sách link. Không dán được thì bấm **Chọn file ảnh**. |

Mọi chỉnh sửa lưu vào `chrome.storage.local` theo link, đóng/mở lại panel vẫn còn.

### Cấu hình CDN Lumi — đã điền sẵn

Mục **⚙️ Cấu hình CDN Lumi** ở đầu panel **đã có sẵn URL + token**, cài xong là convert
ảnh được ngay, không phải nhập gì. Ảnh đi qua `POST /api/scanner/images` và trả link
`img.vgplay.vn`.

Muốn dùng token riêng thì nhập đè rồi **Lưu**; xoá trắng ô token sẽ quay về bản điền sẵn.

> ⚠️ Token điền sẵn nằm trong `lumi-default.js` — file này không đưa lên git, nhưng
> được đóng vào zip ở trang release **công khai**, nên coi như token đã lộ ra ngoài. Nên
> **đổi token định kỳ** trên web Lumi (đổi xong sửa `lumi-default.js` rồi phát hành bản mới).

## Size · màu · còn/hết hàng

Bảng kết quả có 2 cột **Size** và **Hàng**:

| Cột | Nội dung |
|---|---|
| **Size** | size còn hàng (không có thông tin tồn kho thì hiện toàn bộ size). Di chuột vào ô xem đủ **màu · size · variant · tồn kho theo màu**. |
| **Hàng** | ✅ Còn hàng · ❌ Hết hàng · ⚠️ Còn một phần · ❔ Không rõ · 🚫 Lỗi. Di chuột vào xem size nào còn size nào hết. |

Nút **📐 Copy size còn hàng** copy 3 cột `Tiêu đề · Size còn · Size hết` dán thẳng vào Excel.

### Không convert lại ảnh cũ

Mỗi ảnh convert xong được nhớ theo cặp **link gốc → link CDN** (`chrome.storage.local`,
khoá `sc_cdn_map`). Cào lại đúng link đó — kể cả sau khi bấm **🗑 Xoá** hay đóng Chrome —
tool **lấy lại link CDN cũ, không upload lên CDN lần nữa** (nhật ký ghi rõ *"N ảnh dùng
lại link cũ"*). Muốn ép convert lại thì xoá khoá `sc_cdn_map` trong storage của extension.

### Bảng xuất ra: bố cục checklist eBay

Nút **📄 Copy bảng đầy đủ (Excel)** (hoặc **⬇️ Tải CSV**) xuất đúng 21 cột của file
"Check list ebay - Tổ chức database cào về" + 4 cột đuôi (`panel.js buildRows`, mirror
`exporter.py` của tool desktop — 2 bên ra bảng giống hệt nhau):

`Link · Tiêu đề gốc · Tiêu đề đã sửa · Mô tả · Giá gốc · Giá hiện tại · Màu hiện tại ·
Màu tổng · Ảnh của variant đang lấy · Ảnh size chart · Tên màu · Ảnh của toàn bộ variant ·
Size hiện tại còn · Chi tiết size · Size của tất cả variant · Cảnh báo hết size · (trống) ·
% giá đặt · Giá ứng với % giá đặt · Định danh variant gốc · SKU các acc` + `Trạng thái ·
Ghi chú · Ảnh đã convert · Mô tả HTML`

**Mô tả HTML** (cột đuôi cuối): mô tả gốc của site dạng HTML — lấy **đủ mọi phần mô tả**
(VD Danner: Key Details · Description · Specifications · Features; Staples: Details +
bảng Specifications; Hernest: Description · Material · Specification; Talbots: Details ·
Features · Fit and Material; Revolve: Description · Size & Fit · About The Brand; W-S:
Summary · Dimensions & More Info · Use & Care; VS: HTML trong JSON-LD). Chỉ giữ thẻ định
dạng (p, ul/li, b/strong, h3, bảng...), bỏ class/style/ảnh/nút/link, và **chỉ xoá phần
liên hệ** (email · SĐT · địa chỉ · website) — không lọc bảo hành/ship như cột Mô tả chữ.
Tab chính sách cửa hàng (Shipping + Returns, Price Match, Warranty & Returns) không lấy.
Site chưa khai `descriptionSections` trong extract.js thì HTML dựng từ bản chữ.

- Mỗi sản phẩm nhiều hàng: **ảnh của variant đang lấy**, **ảnh của toàn bộ variant** và
  **dòng size của tất cả variant** mỗi thứ 1 hàng; ô chung (link, tiêu đề, giá, mô tả,
  định danh…) **chỉ điền ở hàng đầu**, các hàng sau để trống — nhìn gọn như bảng gộp ô.
- **Tiêu đề đã sửa** = `<Brand> <tiêu đề gốc>, <màu đang xem> Color, New`, tối đa 80 ký tự.
- **Size hiện tại còn** = 1 dòng của đúng variant đang xem, chỉ size còn:
  `Color:=Black Suede | Men's Width:=MED | Size:=7;8;9`; **Size của tất cả variant** =
  mỗi tổ hợp màu × width 1 dòng cùng format; **Cảnh báo hết size** = size hết của variant
  đang xem (preorder / giao quá 4 ngày cũng tính là hết).
- **% giá đặt** nhập ở ô trên thanh tuỳ chọn (mặc định 70); **Giá ứng** = giá hiện tại × %.
  Sản phẩm đã chỉnh % riêng trong khung Chi tiết thì lấy % đó.
- **Định danh variant gốc** = mã `<Site>_<DDMMYY>_a001` + các dòng khoá (domain · tiêu đề ·
  màu · width…) — cấp lúc xuất bảng, nhớ trong `chrome.storage.local` (`sc_variant_ids`),
  xuất lại cùng variant giữ nguyên mã; bấm 🗑 Xoá không mất. Dòng lỗi/bị chặn không có mã.
- 2 ô tích **Ẩn cột Ảnh của toàn bộ variant** / **Ẩn cột Size của tất cả variant** bỏ hẳn
  cột đó (và các hàng chỉ sinh ra để chứa nó); nhớ ở `sc_opts`.
- Ô nhiều dòng (mô tả, định danh, dòng size) được bọc nháy kép nên dán vào Excel là
  **xuống dòng thật trong ô**.
- Ảnh **dán tay** (bảng Size & Fit) là hàng riêng chỉ có cột *Ảnh đã convert*.
- Sản phẩm chưa có ảnh vẫn có đúng 1 hàng, không mất dữ liệu.
- Nút **📄 Copy bảng SP này** trong khung Chi tiết chỉ copy các hàng của sản phẩm đang chọn.

Nguồn dữ liệu giống hệt tool desktop vì dùng chung `extract.js`: chi tiết từng size /
variant có ở Vionic · Duluth · Revolve · Danner · Staples · Hernest · Talbots; site khác
chỉ biết còn/hết cả sản phẩm (JSON-LD `offers.availability` hoặc Shopify `available`);
site không khai gì thì ghi "Không rõ".

## Cào thủ công — tự mở trang rồi bấm cào

Dành cho site chặn bot rất nhạy (Crate & Barrel, Talbots, Vionic...) hoặc khi muốn
lấy **đúng màu/size đang xem**: tự mở trang sản phẩm ở tab thường như người mua hàng
— tự giải captcha, giữ đăng nhập, bấm chọn màu/size — rồi bấm **🖐 Cào tab đang mở**.

Panel liệt kê mọi tab `http(s)` đang mở (cả cửa sổ khác), **tick sẵn** tab trông như
trang sản phẩm, tab khác (Gmail, YouTube...) để trống cho tự tick thêm. Chọn xong bấm
**🕷️ Cào tab đã chọn**.

- Chạy extract.js **ngay trên tab đó**: không mở tab mới, **không tải lại trang**,
  **không đóng tab nào** — nên trang đã qua được tường chặn thì cào được luôn.
- Luật cào y hệt cào tự động: đủ màu · size còn/hết · ma trận tồn kho theo từng màu ·
  mô tả · toàn bộ ảnh. Màu trong link (`?color=`, `dwvar_..._color=`) được giữ nguyên
  nên cào đúng variant đang xem.
- Kết quả **nối tiếp** vào bảng đang có, không xoá kết quả cũ — mở thêm vài tab rồi
  bấm cào tiếp bao nhiêu đợt cũng được.
- Chrome hay giải phóng tab để tiết kiệm RAM; tab đó hiện cảnh báo và không tick sẵn —
  bấm vào tab cho trang hiện lại rồi bấm **↻ Tải lại danh sách**.

Cào tab nào là cào đúng tab đó, nên nếu tick nhầm tab trang danh mục thì dòng kết quả
sẽ là trang danh mục — xem lại tiêu đề ở bảng trước khi xuất.

## Giá lạc đơn vị tiền

Vài site đổi giá theo IP: Revolve trả **2.290.728 VND** thay cho $228 khi proxy không
phải US. Gặp ca đó dòng bị hạ xuống **Thiếu dữ liệu** kèm ghi chú *"Giá đang là VND chứ
không phải USD"* — đổi sang proxy US rồi bấm ↻ cào lại, đừng lấy số đó xuất ra bảng.

## Khác biệt so với tool desktop

- Không có fallback API BestBuy khi bị chặn IP (tool desktop cần API key riêng);
  extension chỉ báo "Bị chặn" — đổi proxy US rồi bấm ↻ cào lại.
- Xuất CSV/TSV thay vì .xlsx (dán TSV vào Excel cho kết quả tương đương).
- Chụp bảng Size Guide phải mở tab hiện lên vài giây (Chrome chỉ chụp được tab đang
  hiện); bản desktop chụp ngầm qua CDP nên không làm phiền màn hình. Bảng quá cao thì
  extension tự thu nhỏ trang cho lọt khung ảnh.
- Không có trang **Kiểm tra hàng** hằng ngày (cần tài khoản Lumi) — extension chỉ cho
  biết còn/hết **ngay lúc cào**.

## Riêng 2 site mới

- **Free People** — mỗi màu 1 link (`?color=011`). Lấy đủ màu · size còn/hết · ảnh mọi
  màu · Size & Fit · nút Size Guide (chụp được bằng nút 📐).
- **Crate & Barrel** — mỗi màu/kích thước là 1 link riêng nên cột màu/size để trống là
  đúng. Site **không cần IP Mỹ**, nhưng chặn bot rất nhạy: mở liên tiếp nhiều trang sản
  phẩm là bị "Access Denied". Nên cào **ít link một lượt**; dòng nào báo Bị chặn thì
  nghỉ một lúc rồi bấm ↻ cào lại. Proxy VMLogin đang dùng cho các site khác có thể bị
  chặn hẳn ở site này — khi đó dùng trình duyệt thường.
