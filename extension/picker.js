/**
 * picker.js — tab "Cào link": hiện ô vuông trên từng sản phẩm của trang danh mục /
 * trang tìm kiếm để tick chọn, rồi "Lấy link" -> copy vào bộ nhớ tạm + đẩy về bảng
 * link trong panel (background lưu ở chrome.storage.local, khoá lp_links).
 *
 * Nạp bằng chrome.scripting.executeScript (isolated world) nên chạy được trên mọi site
 * mà không đụng biến của trang. Nạp lại lần 2 chỉ hiện lại, không nhân đôi.
 *
 * Cách nhận sản phẩm (không cần luật riêng từng site):
 *   1. Gom mọi thẻ <a> cùng site, bỏ menu/header/footer, chuẩn hoá link.
 *   2. Link là "sản phẩm" khi đường dẫn giống trang sản phẩm (/dp/, /products/,
 *      /itm/, /p/, ...-12345.html...) HOẶC ô chứa nó có ảnh + giá tiền.
 *   3. Leo lên từ thẻ <a> tới khối lớn nhất chỉ chứa đúng 1 sản phẩm = ô sản phẩm,
 *      phải có ảnh. Ô vuông đặt ở góc trên bên trái ô đó.
 * Ô vuông nằm trong 1 lớp phủ riêng (shadow DOM) — không sửa DOM/CSS của trang, bấm ô
 * vuông không bấm nhầm vào link sản phẩm bên dưới.
 */
(() => {
    if (window.__lpPicker) { window.__lpPicker.show(); return; }

    // ==== chuẩn hoá link (mirror background.canonicalUrl) ======================
    const KEEP_PARAMS = new Set(['color', 'size', 'sizeval', 'choice', 'skuid', 'sku',
        'genericid', 'productid', 'variant', 'colorcode', 'attributes']);
    const KEEP_PARAM_RE = /^(dwvar_|variation\d+$|attr\d+$)/i;

    function registrable(host) {
        const parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
        return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
    }

    // Link quảng cáo đi vòng qua trang đếm click rồi mới tới trang sản phẩm thật:
    // Amazon /sspa/click?url=%2Fdp%2F... · Walmart /sp/track?...&rd=https%3A%2F%2F...%2Fip%2F...
    const REDIRECT_PARAMS = ['url', 'rd', 'redirect', 'redirect_url', 'dest', 'target', 'u'];
    function unwrap(u) {
        if (!/\/(sspa\/click|sp\/track|track|click|redirect|r)\/?$/i.test(u.pathname)) return u;
        for (const k of REDIRECT_PARAMS) {
            const v = u.searchParams.get(k);
            if (!v || !/^(https?:|\/)/i.test(v)) continue;
            try { return new URL(v, u.origin); } catch (e) { /* thử tham số khác */ }
        }
        return u;
    }

    function canonical(href) {
        let u;
        try { u = unwrap(new URL(href, location.href)); } catch (e) { return null; }
        if (!/^https?:$/.test(u.protocol)) return null;
        const host = u.hostname.toLowerCase();
        // Sàn lớn: rút về dạng ngắn nhất, bỏ slug/tham số theo dõi
        let m;
        if (/(^|\.)amazon\./.test(host) && (m = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i))) {
            return u.origin + '/dp/' + m[1].toUpperCase();
        }
        if (/(^|\.)ebay\./.test(host) && (m = u.pathname.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/))) {
            return u.origin + '/itm/' + m[1];
        }
        if (/(^|\.)etsy\.com$/.test(host) && (m = u.pathname.match(/\/listing\/(\d+)/))) {
            return u.origin + '/listing/' + m[1];
        }
        const kept = new URLSearchParams();
        for (const [k, v] of u.searchParams) {
            if (v && (KEEP_PARAMS.has(k.toLowerCase()) || KEEP_PARAM_RE.test(k))) kept.append(k, v);
        }
        u.search = kept.toString().replace(/%2C/gi, ',');
        u.hash = '';
        return u.toString();
    }

    // ==== nhận diện link sản phẩm ================================================
    const PRODUCT_PATH = new RegExp([
        '/dp/[a-z0-9-]+',                 // Amazon, Revolve (/dp/FREE-WJ291/)
        '/gp/product/',
        '/itm/\\d', '/listing/\\d',       // eBay, Etsy
        '/ip/',                           // Walmart
        '/products?/[^/]+',               // Shopify (/products/handle), Williams-Sonoma, Danner
        '/p/[^/]+',                       // Victoria's Secret, Target, Academy
        '/product_\\d+',                  // Staples
        '/site/[^/]+\\.p',                // BestBuy
        '/item/[^/]+',
        '/s\\d{5,}/?$',                   // Crate & Barrel
    ].join('|'), 'i');
    // Mẫu yếu (chỉ là mã số ở cuối, vd Duluth ...-work-pants-45507.html) — trang hãng/danh
    // mục cũng hay có dạng này (/brand/mainevent/20037119) nên phải qua NOT_PRODUCT trước
    const WEAK_PRODUCT_PATH = /-\d{4,}(\.html?)?\/?$|\/\d{6,}(\.html?)?\/?$/i;
    const PRODUCT_QUERY = /[?&](skuid|productid|pid|itemid|sku)=/i;
    // Trang /shop/<slug> là trang sản phẩm ở nhóm URBN, còn site khác thường là danh mục
    const SHOP_SLUG_SITES = /(^|\.)(freepeople|anthropologie|urbanoutfitters)\.com$/;
    const NOT_PRODUCT = /\/(cart|checkout|account|login|signin|register|help|customer-service|stores?|search|wishlist|reviews?|browse|category|categories|collections?|c|cp|departments?|brands?|shop-all[^/]*|sp)(\/|$)/i;
    const PRICE_RE = /(?:[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|€|£|đ|₫))/;

    function looksLikeProduct(url) {
        let u;
        try { u = new URL(url); } catch (e) { return false; }
        if (u.pathname === '/' || u.pathname === '') return false;
        // khớp mẫu trang sản phẩm là nhận luôn: /collections/bags/products/x vẫn là sản phẩm
        if (PRODUCT_PATH.test(u.pathname) || PRODUCT_QUERY.test(u.search)) return true;
        if (NOT_PRODUCT.test(u.pathname)) return false;
        if (WEAK_PRODUCT_PATH.test(u.pathname)) return true;
        if (SHOP_SLUG_SITES.test(u.hostname) && /^\/shop\/[^/]+\/?$/i.test(u.pathname)) return true;
        // Magento/Salesforce: /elara-slide-sandal.html — 3 từ trở lên mới là sản phẩm
        // (danh mục thường ngắn: /sandals.html, /womens-sandals.html)
        const last = u.pathname.split('/').filter(Boolean).pop() || '';
        return /\.html?$/i.test(last) && last.replace(/\.html?$/i, '').split('-').length >= 3;
    }

    // ==== tên "nhà" (site) ========================================================
    const HOUSES = {
        'staples.com': 'Staples', 'williams-sonoma.com': 'Williams-Sonoma',
        'victoriassecret.com': "Victoria's Secret", 'revolve.com': 'Revolve',
        'duluthtrading.com': 'Duluth Trading', 'danner.com': 'Danner',
        'vionicshoes.com': 'Vionic', 'talbots.com': 'Talbots', 'hernest.com': 'Hernest',
        'bando.com': 'Bando', 'oglmove.com': 'OGL Move', 'bestbuy.com': 'BestBuy',
        'freepeople.com': 'Free People', 'crateandbarrel.com': 'Crate & Barrel',
        'landsend.com': "Lands' End", 'tommybahama.com': 'Tommy Bahama',
        'eileenfisher.com': 'Eileen Fisher', 'personalcreations.com': 'Personal Creations',
        'academy.com': 'Academy', 'walmart.com': 'Walmart', 'etsy.com': 'Etsy',
        'amazon.com': 'Amazon', 'ebay.com': 'eBay', 'target.com': 'Target',
    };
    function houseOf(url) {
        let host = '';
        try { host = new URL(url).hostname; } catch (e) { /* để trống */ }
        const domain = registrable(host);
        if (HOUSES[domain]) return HOUSES[domain];
        const first = domain.split('.')[0] || 'Site';
        return first.charAt(0).toUpperCase() + first.slice(1);
    }

    // ==== đọc ô sản phẩm =========================================================
    const pageSite = registrable(location.hostname);
    const SKIP_AREA = 'header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-label*="breadcrumb" i]';

    function hasImage(el) {
        return !!el.querySelector('img, picture, [style*="background-image"]');
    }

    function imageOf(card) {
        // ảnh lười (lazy): chưa cuộn tới thì <img> chưa có src, lấy tạm từ <source srcset>
        const firstSrc = (s) => String(s || '').split(',')[0].trim().split(' ')[0];
        for (const img of card.querySelectorAll('img')) {
            const pic = img.closest('picture');
            const source = pic && pic.querySelector('source[srcset], source[data-srcset]');
            if (!img.currentSrc && !img.getAttribute('src') && source) {
                const s = firstSrc(source.getAttribute('srcset') || source.getAttribute('data-srcset'));
                if (s && !/^data:/i.test(s)) { try { return new URL(s, location.href).toString(); } catch (e) { /* tiếp */ } }
            }
            const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src')
                || (img.getAttribute('srcset') || img.getAttribute('data-srcset') || '').split(',')[0].trim().split(' ')[0];
            if (!src || /^data:/i.test(src)) continue;
            const r = img.getBoundingClientRect();
            if (r.width && r.width < 40) continue;        // icon, sao đánh giá, logo nhỏ
            try { return new URL(src, location.href).toString(); } catch (e) { /* thử ảnh sau */ }
        }
        return '';
    }

    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    // Chữ không phải tiêu đề: giá, nút, số màu/sao/đánh giá, nhãn quảng cáo
    const NOT_TITLE = /^(quick ?view|add to (cart|bag)|shop now|new|sale|sponsored|best ?seller|options?:.*)$|^\+?\d+ (other )?(colou?rs?|sizes?|options?|styles?)|(colou?rs?|patterns)\/|out of 5 stars|^\(?\d[\d.,]*\)?\s*(reviews?|ratings?)?$|^[$€£]\s?[\d.,]+|bought in past/i;

    function titleOf(card, anchors) {
        const text = (el) => clean(el && (el.getAttribute('aria-label') || el.textContent));
        // Chỉ lấy phần tử trong cùng: khối bọc "title__wrapper" còn chứa cả tên hãng, giá...
        const innermost = (sel) => {
            const els = [...card.querySelectorAll(sel)];
            return els.filter((el) => !els.some((o) => o !== el && el.contains(o))).map(text);
        };
        // Ưu tiên: thẻ tiêu đề -> class "title/name" -> thuộc tính của link -> alt ảnh -> chữ trong link.
        // Trong mỗi nhóm lấy dòng dài nhất hợp lệ (tiêu đề thường là chữ dài nhất của ô).
        const groups = [
            innermost('[itemprop="name"], h1, h2, h3, h4'),
            innermost('[data-testid*="title" i], [class*="title" i], [class*="name" i]'),
            anchors.flatMap((a) => [a.getAttribute('aria-label'), a.getAttribute('title')]).map(clean),
            [...card.querySelectorAll('img[alt]')].map((img) => clean(img.getAttribute('alt'))),
            anchors.map((a) => clean(a.textContent)),
        ];
        for (const group of groups) {
            const ok = group.filter((s) => s.length >= 6 && s.length <= 300 && !NOT_TITLE.test(s));
            if (ok.length) return ok.sort((a, b) => b.length - a.length)[0].slice(0, 200);
        }
        return '';
    }

    // Leo từ thẻ <a> lên khối lớn nhất vẫn chỉ chứa đúng 1 sản phẩm
    function cardOf(anchor, url, urlOf) {
        const vw = window.innerWidth, vh = window.innerHeight;
        let best = anchor, el = anchor;
        for (let depth = 0; depth < 12; depth++) {
            const p = el.parentElement;
            if (!p || p === document.body || p === document.documentElement) break;
            let other = false;
            for (const a of p.querySelectorAll('a[href]')) {
                const u = urlOf.get(a);
                if (u && u !== url) { other = true; break; }
            }
            if (other) break;
            const r = p.getBoundingClientRect();
            if (r.width > vw * 0.9 || r.height > vh * 1.5) break;     // khối cả trang/cả lưới
            best = p;
            el = p;
        }
        return best;
    }

    // ==== trạng thái =============================================================
    const selected = new Set();      // url đang tick
    const taken = new Set();         // url đã lấy trong phiên này
    let items = [];                  // [{url, card, anchors, box}] theo thứ tự trên trang
    let lastClicked = -1;
    let minimized = false;

    function scan() {
        const urlOf = new Map();     // thẻ <a> -> link sản phẩm ứng viên
        const groups = new Map();    // url -> [thẻ a]
        for (const a of document.querySelectorAll('a[href]')) {
            if (root.contains(a) || a.closest(SKIP_AREA)) continue;
            const raw = a.getAttribute('href') || '';
            if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
            const url = canonical(a.href);
            if (!url) continue;
            let host = '';
            try { host = new URL(url).hostname; } catch (e) { continue; }
            if (registrable(host) !== pageSite) continue;
            urlOf.set(a, url);
            if (!groups.has(url)) groups.set(url, []);
            groups.get(url).push(a);
        }
        const found = [];
        for (const [url, anchors] of groups) {
            const main = anchors.find(hasImage) || anchors[0];
            const card = cardOf(main, url, urlOf);
            if (!hasImage(card)) continue;
            const r = card.getBoundingClientRect();
            if (r.width < 60 || r.height < 60) continue;
            if (!looksLikeProduct(url)) {
                // site lạ: chấp nhận khi chính ô đó có giá tiền; link danh mục/giỏ hàng thì loại hẳn
                if (NOT_PRODUCT.test(new URL(url).pathname) || !PRICE_RE.test(card.innerText || '')) continue;
            }
            found.push({ url, card, anchors });
        }
        found.sort((x, y) => (x.card.compareDocumentPosition(y.card) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        // giữ ô vuông cũ của link đã có để không nháy
        const old = new Map(items.map((it) => [it.url, it]));
        items = found.map((f) => {
            const prev = old.get(f.url);
            if (prev) { prev.card = f.card; prev.anchors = f.anchors; old.delete(f.url); return prev; }
            return Object.assign(f, { box: makeBox(f.url) });
        });
        for (const gone of old.values()) gone.box.remove();
        place();
        updateBar();
    }

    function info(it) {
        return { url: it.url, house: houseOf(it.url), title: titleOf(it.card, it.anchors),
                 image: imageOf(it.card), page: location.href };
    }

    // ==== lớp phủ (shadow DOM) ===================================================
    const host = document.createElement('div');
    host.id = '__lp_picker_host';
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
<style>
  :host { all: initial; }
  .box { position: absolute; width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
         background: rgba(255,255,255,.95); border: 2px solid #1d4ed8; box-shadow: 0 1px 4px rgba(0,0,0,.35);
         display: flex; align-items: center; justify-content: center; font: bold 16px/1 Arial, sans-serif;
         color: #fff; user-select: none; pointer-events: auto; }
  .box:hover { transform: scale(1.12); }
  .box.on { background: #1d4ed8; }
  .box.on::after { content: '✓'; }
  .box.taken:not(.on) { border-color: #16a34a; background: #dcfce7; }
  .box.taken:not(.on)::after { content: '✓'; color: #16a34a; }
  .bar { position: fixed; right: 16px; bottom: 16px; left: auto; top: auto; margin: 0; border: 0;
         z-index: 2147483647; pointer-events: auto;
         display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 10px;
         background: #1f2937; color: #f9fafb; font: 13px/1.3 "Segoe UI", Arial, sans-serif;
         box-shadow: 0 4px 16px rgba(0,0,0,.35); }
  .bar b { color: #93c5fd; }
  .bar button { all: unset; cursor: pointer; padding: 5px 9px; border-radius: 6px; background: #374151;
                color: #f9fafb; font: 600 12px/1.2 "Segoe UI", Arial, sans-serif; }
  .bar button:hover { background: #4b5563; }
  .bar button.primary { background: #2563eb; }
  .bar button.primary:hover { background: #1d4ed8; }
  .bar .count { min-width: 92px; }
  .toast { position: fixed; right: 16px; bottom: 70px; left: auto; top: auto; margin: 0; border: 0;
           z-index: 2147483647; padding: 8px 12px;
           border-radius: 8px; background: #065f46; color: #ecfdf5; font: 13px/1.4 "Segoe UI", Arial, sans-serif;
           box-shadow: 0 4px 16px rgba(0,0,0,.35); max-width: 360px; }
  .toast.err { background: #7f1d1d; }
  .min .hide-min { display: none; }
</style>
<div class="layer"></div>
<div class="bar">
  <b>🔗 Cào link</b>
  <span class="count hide-min"></span>
  <button data-act="all" class="hide-min" title="Tick mọi sản phẩm đang có trên trang">Chọn tất cả</button>
  <button data-act="none" class="hide-min">Bỏ chọn</button>
  <button data-act="take" class="primary" title="Copy link đã tick vào bộ nhớ tạm và thêm vào bảng link của extension">Lấy link</button>
  <button data-act="min" title="Thu nhỏ / mở rộng thanh này">–</button>
</div>`;
    const layer = shadow.querySelector('.layer');
    const bar = shadow.querySelector('.bar');
    // Banner cookie / popup email của trang hay nằm đè góc dưới -> đưa thanh nổi lên
    // top layer (popover) để luôn nằm trên cùng. Trình duyệt cũ không có popover thì thôi.
    function toTop(el) {
        if (typeof el.showPopover !== 'function') return;
        el.popover = 'manual';
        try { if (el.isConnected && !el.matches(':popover-open')) el.showPopover(); } catch (e) { /* bỏ qua */ }
    }
    const countEl = shadow.querySelector('.count');

    function makeBox(url) {
        const box = document.createElement('div');
        box.className = 'box';
        box.title = 'Tick để chọn sản phẩm này (giữ Shift để chọn cả dải)';
        box.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = items.findIndex((it) => it.url === url);
            const on = !selected.has(url);
            if (e.shiftKey && lastClicked >= 0 && idx >= 0) {
                const [a, b] = lastClicked < idx ? [lastClicked, idx] : [idx, lastClicked];
                for (let i = a; i <= b; i++) setSel(items[i].url, on);
            } else {
                setSel(url, on);
            }
            lastClicked = idx;
            updateBar();
        }, true);
        // chặn cả mousedown/pointerdown để trang không tưởng là bấm vào ô sản phẩm
        for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
            box.addEventListener(ev, (e) => e.stopPropagation(), true);
        }
        layer.appendChild(box);
        return box;
    }

    function setSel(url, on) {
        if (on) selected.add(url); else selected.delete(url);
    }

    function place() {
        const sx = window.scrollX, sy = window.scrollY;
        for (const it of items) {
            const r = it.card.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0 && it.card.isConnected;
            it.box.style.display = visible ? '' : 'none';
            if (!visible) continue;
            it.box.style.left = (r.left + sx + 6) + 'px';
            it.box.style.top = (r.top + sy + 6) + 'px';
            it.box.classList.toggle('on', selected.has(it.url));
            it.box.classList.toggle('taken', taken.has(it.url));
        }
    }

    function updateBar() {
        const n = items.filter((it) => selected.has(it.url)).length;
        countEl.textContent = 'Đã chọn ' + n + '/' + items.length;
        place();
    }

    let toastTimer = 0;
    function toast(text, isErr) {
        let el = shadow.querySelector('.toast');
        if (!el) { el = document.createElement('div'); el.className = 'toast'; shadow.appendChild(el); toTop(el); }
        el.classList.toggle('err', !!isErr);
        el.textContent = text;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.remove(), 4000);
    }

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* thử cách cũ */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            shadow.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) { return false; }
    }

    // Lấy link đã tick: trả về danh sách, gửi về background để nối vào bảng link
    async function take(opts) {
        const chosen = items.filter((it) => selected.has(it.url)).map(info);
        if (!chosen.length) {
            toast('Chưa tick sản phẩm nào. Bấm vào ô vuông ở góc ảnh sản phẩm để chọn.', true);
            return { items: [], added: 0 };
        }
        const copied = !(opts && opts.noCopy) && await copyText(chosen.map((c) => c.url).join('\n'));
        let added = 0, total = 0;
        try {
            const res = await chrome.runtime.sendMessage({ cmd: 'lpAdd', items: chosen });
            added = (res && res.added) || 0;
            total = (res && res.total) || 0;
        } catch (e) {
            toast('Không gửi được về extension: ' + (e.message || e) + '. Nạp lại trang rồi thử lại.', true);
        }
        for (const c of chosen) { taken.add(c.url); selected.delete(c.url); }
        updateBar();
        toast('Đã lấy ' + chosen.length + ' link (' + added + ' mới, bảng có ' + total + ')'
            + (copied ? ' — đã copy vào bộ nhớ tạm.' : '.'));
        return { items: chosen, added, total };
    }

    bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'all') { for (const it of items) selected.add(it.url); updateBar(); }
        else if (act === 'none') { selected.clear(); updateBar(); }
        else if (act === 'take') take();
        else if (act === 'min') { minimized = !minimized; bar.classList.toggle('min', minimized); btn.textContent = minimized ? '+' : '–'; }
    });

    // ==== vòng cập nhật: trang tải thêm sản phẩm (cuộn vô hạn, lọc, chuyển trang SPA) ==
    let rafPending = false;
    const schedulePlace = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; place(); });
    };
    let scanTimer = 0;
    const scheduleScan = () => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 400); };
    const observer = new MutationObserver((muts) => {
        if (muts.every((m) => host.contains(m.target))) return;
        scheduleScan();
    });
    const interval = setInterval(scan, 2500);
    window.addEventListener('scroll', schedulePlace, { passive: true });
    window.addEventListener('resize', scheduleScan);

    function show() {
        if (!host.isConnected) document.documentElement.appendChild(host);
        toTop(bar);
        scan();
    }

    function destroy() {
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(scanTimer);
        window.removeEventListener('scroll', schedulePlace);
        window.removeEventListener('resize', scheduleScan);
        host.remove();
        delete window.__lpPicker;
    }

    window.__lpPicker = {
        show, destroy, take, scan,
        selectAll(on) { if (on) for (const it of items) selected.add(it.url); else selected.clear(); updateBar(); return items.length; },
        count() { return { total: items.length, selected: items.filter((it) => selected.has(it.url)).length }; },
        // dùng cho test: danh sách sản phẩm nhận ra được trên trang
        list() { return items.map(info); },
    };
    document.documentElement.appendChild(host);
    toTop(bar);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    scan();
})();
