"""Chạy extract.js trên 1 file HTML đã lưu bằng Edge/Chrome headless — không cần node,
không cần IP Mỹ. Dùng khi sửa adapter của 1 site: lưu HTML trang sản phẩm (Ctrl+S
hoặc curl) rồi:

    python tools/extract_harness.py <file.html> <hostname> [url]
    python tools/extract_harness.py scratch/staples.html www.staples.com https://www.staples.com/.../product_24569468

In ra các trường chính của record (title/giá/màu/size/định danh...) + trace từng tầng.
Script ngoài (React, tracking) bị gỡ để trang không tự vẽ lại; các script JSON
(__NEXT_DATA__, ld+json) giữ nguyên vì adapter đọc từ đó.

Lưu ý: trang React (Victoria's Secret, Talbots sau CAPTCHA) chỉ có khung rỗng khi tải
bằng curl — phải lưu HTML từ trình duyệt thật (Ctrl+S, "Webpage, Complete").
"""

import html
import io
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT_JS = os.path.join(ROOT, 'extension', 'extract.js')
BROWSERS = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
]
FIELDS = ('title', 'price', 'list_price', 'currency', 'source', 'brand', 'title_fixed',
          'identity_kind', 'current_color', 'variant_label', 'current_variant',
          'color_label', 'colors', 'size_label', 'sizes', 'sizes_in_stock',
          'sizes_out_of_stock', 'in_stock', 'variants', 'stock_matrix', 'fit_guide_images',
          'size_guide_url', 'size_guide_button', 'warnings')


def file_url(path: str) -> str:
    return 'file:///' + os.path.abspath(path).replace('\\', '/')


def build_page(src_html: str, hostname: str, url: str) -> str:
    def keep(m):
        tag = m.group(0)
        head = tag[:tag.find('>') + 1]
        # Giữ script DỮ LIỆU: JSON-LD, __NEXT_DATA__, x-magento-init (jsonConfig của Vionic/Danner)
        if re.search(r'type="(application/(json|ld\+json)|text/x-magento-init)"', head):
            return tag
        # Kho dữ liệu inline mang type KHÔNG phải JavaScript — trình duyệt cũng không chạy,
        # chỉ là chỗ chứa JSON (Free People: <script type="mime/invalid" id="urbnInitialPiniaState">).
        if 'src=' not in head:
            mt = re.search(r'type="([^"]*)"', head)
            if mt and not re.match(r'(text|application)/(java|ecma)script$|^module$', mt.group(1), re.I):
                return tag
        # Script inline CHỈ gán dữ liệu (window.__INITIAL_STATE__={...} của Williams-Sonoma):
        # giữ lại vì adapter đọc từ đó, và nó không chạy gì ngoài phép gán.
        # Academy: window.ASOData= window.ASOData || {}; window.ASOData['comp-…']={…}
        if 'src=' not in head and re.match(r'<script[^>]*>\s*window\.(__[A-Z_]+__\s*=\s*\{|ASOData\s*=)', tag):
            return tag
        return ''
    s = re.sub(r'<script\b[^>]*>.*?</script>', keep, src_html, flags=re.S | re.I)
    s = re.sub(r'<link\b[^>]*rel="?stylesheet[^>]*>', '', s, flags=re.I)
    s = re.sub(r'<iframe\b.*?</iframe>', '', s, flags=re.S | re.I)
    inject = (
        '<pre id="out">PENDING</pre><script type="module">'
        "import extract from '%s';"
        "try { const rec = await extract({debug: true, url: %s, hostname: %s});"
        " document.getElementById('out').textContent = JSON.stringify(rec, null, 1); }"
        " catch (e) { document.getElementById('out').textContent = 'ERROR: ' + (e && e.stack || e); }"
        '</script>' % (file_url(EXT_JS), json.dumps(url), json.dumps(hostname)))
    return s.replace('</body>', inject + '</body>', 1) if '</body>' in s else s + inject


def run(path: str, hostname: str, url: str = '') -> dict:
    browsers = [b for b in BROWSERS if os.path.isfile(b)]
    if not browsers:
        raise SystemExit('Không tìm thấy Edge/Chrome để chạy headless.')
    src = io.open(path, encoding='utf-8', errors='replace').read()
    work = tempfile.mkdtemp(prefix='sc_harness_')
    page = os.path.join(work, 'page.html')
    # Ghi kèm BOM: file:// không có header charset, meta charset nằm ngoài 1024 byte đầu
    # thì Chrome đoán cp1252 -> chữ ’ trong JSON thành "â€™". BOM được ưu tiên tuyệt đối.
    io.open(page, 'w', encoding='utf-8-sig').write(build_page(src, hostname, url or 'https://' + hostname + '/'))

    # Edge headless thỉnh thoảng treo hẳn với trang nặng (trang Free People kèm 280KB
    # script dữ liệu treo 100%) -> treo hoặc không ra #out thì thử trình duyệt kế tiếp.
    last = ''
    for i, browser in enumerate(browsers):
        cmd = [browser, '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
               '--user-data-dir=' + os.path.join(work, 'profile%d' % i),
               '--virtual-time-budget=10000', '--dump-dom', file_url(page)]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=120).stdout.decode('utf-8', 'replace')
        except subprocess.TimeoutExpired:
            last = '%s treo quá 120s' % os.path.basename(browser)
            continue
        m = re.search(r'<pre id="out">(.*?)</pre>', out, re.S)
        if not m:
            last = '%s không trả kết quả (không thấy #out)' % os.path.basename(browser)
            continue
        txt = html.unescape(m.group(1))
        if txt.strip() == 'PENDING':
            last = '%s chưa chạy xong extract.js' % os.path.basename(browser)
            continue
        if txt.startswith('ERROR'):
            raise SystemExit('extract.js lỗi:\n' + txt[:3000])
        return json.loads(txt)
    raise SystemExit('Không trình duyệt nào chạy được trang này — ' + last)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    rec = run(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '')
    enc = lambda v: json.dumps(v, ensure_ascii=False)[:300]     # noqa: E731
    for k in FIELDS:
        print('%-20s %s' % (k, enc(rec.get(k))))
    imgs = rec.get('images') or []
    print('%-20s %d %s' % ('images', len(imgs), enc(imgs[:2])))
    print('%-20s %d' % ('all_images', len(rec.get('all_images') or [])))
    print('%-20s %s' % ('description', enc((rec.get('description') or '')[:600])))
    print('trace:')
    for t in rec.get('trace') or []:
        print('   ', t)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
