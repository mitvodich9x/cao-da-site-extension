// Luật cào đa site của EXTENSION — nguồn sự thật duy nhất (từ 2026-09-25 tính năng cào
// đa site tách khỏi WM tool, chỉ dùng extension; bản app/services/site_crawler/extract.js
// của tool đã đóng băng, KHÔNG đồng bộ 2 chiều nữa). Sửa luật thì sửa thẳng file này.
export default /**
 * extract.js — NGUỒN SỰ THẬT DUY NHẤT cho luật cào 14 site.
 *
 * File này được nạp vào trang thật qua CDP (Playwright page.evaluate) trong
 * crawler.py. KHÔNG viết lại luật site ở chỗ nào khác.
 *
 * Trả về: {ok, url, title, price, currency, description, images[], source, warnings[], trace[]}
 *
 * Cơ chế 3 tầng — tầng sau chỉ BÙ vào ô còn trống của tầng trước:
 *   1. ADAPTERS[domain]  — selector/JSON-path đã kiểm chứng trên trang thật
 *   2. Structured data   — JSON-LD @type=Product, rồi OpenGraph
 *   3. DOM heuristic     — h1 / text $ / khối mô tả dài nhất / container gallery
 *
 * Sửa 1 site khi site đổi giao diện = sửa đúng 1 khối trong ADAPTERS bên dưới.
 */
async (opts) => {
    opts = opts || {};
    const DEBUG = !!opts.debug;
    const trace = [];
    const warnings = [];
    const log = (m) => { if (DEBUG) trace.push(m); };

    // ================= helpers =================
    const S = (v) => (v == null ? '' : String(v));

    const decodeHtml = (s) => {
        const t = document.createElement('textarea');
        t.innerHTML = S(s);
        return t.value.trim();
    };

    const stripHtml = (s) => {
        const d = document.createElement('div');
        d.innerHTML = S(s);
        return S(d.textContent).replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    };

    // HTML -> chữ, XUỐNG DÒNG tại ranh giới khối (<p>, <li>, <br>, <h*>, <tr>). stripHtml
    // (textContent) dán các đoạn liền nhau không có khoảng trắng — dùng cho mô tả dạng HTML
    // (shortDescription của Duluth, pipTabs của Williams-Sonoma).
    const htmlToText = (html) => {
        const s = S(html)
            // Ô bảng liền nhau ("<td>Waist</td><td>24.5</td>") -> "Waist: 24.5". Xuống dòng
            // của hàng phải nằm TRONG ô cuối: chữ đặt giữa các <tr> bị trình duyệt đẩy ra
            // trước bảng (foster parenting) -> các hàng dính thành 1 dòng.
            .replace(/<\/t([dh])>(?=\s*<t[dh][\s>])/gi, ': </t$1>')
            .replace(/<\/t([dh])>(?=\s*<\/tr>)/gi, '\n</t$1>')
            .replace(/<br\s*\/?>/gi, '\n')
            // GIỮ thẻ đóng: bỏ </table> thì phần sau bị đẩy lên trước bảng
            .replace(/<\/(p|li|h[1-6]|div|ul|ol|table|section|dd|dt)>/gi, '</$1>\n');
        return stripHtml(s).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    };

    // Cắt đúng 1 object JSON bắt đầu tại vị trí `start` (dấu '{') trong chữ của script —
    // dùng khi biến của trang không đọc được (isolated world của extension) mà chỉ moi
    // được chữ: window.__INITIAL_STATE__={...} của Williams-Sonoma.
    const jsonObjectAt = (txt, start) => {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < txt.length; i++) {
            const ch = txt[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) return txt.slice(start, i + 1);
        }
        return '';
    };

    const abs = (u) => {
        u = S(u).trim();
        if (!u) return '';
        if (u.indexOf('//') === 0) return 'https:' + u;
        if (/^https?:\/\//i.test(u)) return u;
        // VS trả "www.victoriassecret.com/p/..." — thiếu hẳn scheme
        if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(u)) return 'https://' + u;
        try { return new URL(u, location.href).href; } catch (e) { return u; }
    };

    const parsePrice = (raw) => {
        const s = S(raw).replace(/ /g, ' ').trim();
        if (!s) return null;
        const m = s.match(/\d[\d.,]*/);
        if (!m) return null;
        let n = m[0];
        if (n.indexOf(',') >= 0 && n.indexOf('.') >= 0) n = n.replace(/,/g, '');
        else if (n.indexOf(',') >= 0) n = n.replace(/,/g, '');
        const v = parseFloat(n);
        if (!isFinite(v)) return null;
        return { value: v, currency: /€/.test(s) ? 'EUR' : (/£/.test(s) ? 'GBP' : 'USD') };
    };

    const meta = (prop) => {
        const el = document.querySelector(
            'meta[property="' + prop + '"], meta[name="' + prop + '"]');
        return el ? S(el.getAttribute('content')).trim() : '';
    };

    const selText = (sel) => {
        if (!sel) return '';
        const el = document.querySelector(sel);
        return el ? S(el.innerText).trim() : '';
    };

    // Nhiều site có vài phần tử cùng khớp selector mô tả, phần tử ĐẦU thường là
    // vỏ tab rỗng -> lấy phần tử có nội dung dài nhất mới ra đúng mô tả.
    // Mô tả nằm trong tab ẩn (display:none) thì innerText trả rỗng -> lùi về
    // textContent, nếu không sẽ mất mô tả của những site dùng tab (VD Revolve).
    const nodeText = (el) => {
        if (!el) return '';
        const t = S(el.innerText).trim();
        return t || S(el.textContent).replace(/[ \t ]+/g, ' ').trim();
    };

    const selTextBest = (sel) => {
        let best = '';
        [].slice.call(document.querySelectorAll(sel || '')).forEach((el) => {
            const t = nodeText(el);
            if (t.length > best.length) best = t;
        });
        return best;
    };

    // Lấy phần tử ĐẦU TIÊN khớp selector — dùng khi thứ tự có nghĩa, VD Revolve
    // xếp các tab theo thứ tự Description / Size & Fit / About The Brand, lấy
    // "dài nhất" sẽ ra nhầm bảng số đo người mẫu.
    const selTextFirst = (sel) => nodeText(document.querySelector(sel || ''));

    const jsonLdNodes = () => {
        const out = [];
        document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
            let j;
            try { j = JSON.parse(s.textContent); } catch (e) { return; }
            const arr = Array.isArray(j) ? j : (j && j['@graph'] ? j['@graph'] : [j]);
            arr.forEach((x) => { if (x && typeof x === 'object') out.push(x); });
        });
        return out;
    };

    const typeOf = (x) => {
        const t = x['@type'];
        return Array.isArray(t) ? t.join(',') : S(t);
    };

    let _ldCache;
    const ldProduct = () => {
        if (_ldCache === undefined) {
            _ldCache = jsonLdNodes().find((x) => /product/i.test(typeOf(x))) || null;
        }
        return _ldCache;
    };

    const ldPrice = () => {
        const p = ldProduct();
        if (!p) return null;
        let o = p.offers;
        if (Array.isArray(o)) o = o[0];
        if (!o) return null;
        const v = o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : null);
        if (v == null) return null;
        const n = parseFloat(v);
        if (!isFinite(n)) return null;
        return { value: n, currency: S(o.priceCurrency) || 'USD' };
    };

    // Còn hàng hay hết — đọc offers.availability của JSON-LD (chuẩn schema.org,
    // gần như site nào cũng khai). Nhiều offer thì còn 1 cái còn hàng là còn.
    const ldStock = () => {
        const p = ldProduct();
        if (!p) return null;
        const read = (o) => {
            const v = S(o && o.availability);
            if (!v) return null;
            return /InStock|LimitedAvailability|PreOrder|BackOrder|OnlineOnly|InStoreOnly/i.test(v);
        };
        let o = p.offers;
        if (Array.isArray(o)) {
            const vals = o.map(read).filter((x) => x !== null);
            return vals.length ? vals.some(Boolean) : null;
        }
        return read(o);
    };

    const ldImages = () => {
        const p = ldProduct();
        if (!p || !p.image) return [];
        const arr = Array.isArray(p.image) ? p.image : [p.image];
        return arr.map((x) => abs(typeof x === 'string' ? x : (x && x.url))).filter(Boolean);
    };

    const ldDesc = () => {
        const p = ldProduct();
        return p ? stripHtml(p.description) : '';
    };

    // Lọc thông tin liên hệ theo yêu cầu đăng bán: dòng nào chứa website/email/SĐT
    // là XOÁ cả dòng (nội dung mô tả có kèm liên hệ của hãng không được giữ lại).
    const hasContact = (line) => {
        if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(line)) return true;                 // email
        if (/https?:\/\/|www\./i.test(line)) return true;                          // link
        if (/\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|us|uk|shop|store|info|biz)\b/i.test(line)) return true;
        // SĐT: chuỗi số dài (>=8 chữ số) — không dính "sizes 7-14" hay "Heel Height: 1.5"
        // Dòng khai MÃ sản phẩm ("Style No. 110072741", "Item Number: 24569468", UPC/GTIN)
        // cũng là dãy số dài nhưng là thông tin cần giữ -> không tính là SĐT.
        if (!/\b(style|item|model|part|sku|upc|ean|gtin|isbn)\s*(no\.?|number|code|#|:)/i.test(line)) {
            // Hàng số đo của bảng size ("XS (0-2) 36.2 23.2 11.9 15.4", "Hips 34 35 36 37 38")
            // cũng là dãy số dài -> SĐT thật chỉ có tối đa 4 nhóm số và không có số thập
            // phân đứng trước 1 số khác (Amazon/Lands' End mất sạch bảng size vì luật cũ).
            const phoneLike = (x) => (x.match(/\d/g) || []).length >= 8
                && x.split(/\D+/).filter(Boolean).length <= 4
                && !/\d\.\d+\s+\d/.test(x);
            const runs = line.match(/\+?\d[\d\s().-]{6,}\d/g);
            if (runs && runs.some(phoneLike)) return true;
        }
        // Địa chỉ: "1234 NW Front Ave", "P.O. Box 123", "Portland, OR 97210". Tên đường
        // phải viết hoa để không dính "3 way lamp" / "5 Year Warranty".
        if (/\b\d{1,6}\s+(?:[A-Z][\w.'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Parkway|Pkwy|Highway|Hwy|Suite|Ste)\b/.test(line)) return true;
        if (/\bP\.?\s?O\.?\s+Box\s+\d+/i.test(line)) return true;
        if (/\b[A-Z][a-z]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(line)) return true;
        return false;
    };

    // Ngoài liên hệ, checklist eBay còn yêu cầu BỎ dòng nói về bảo hành, thời gian
    // giao hàng, đổi trả và thông tin doanh nghiệp (không phải mô tả sản phẩm).
    // Chỉ bỏ theo DÒNG — mô tả giữ nguyên xuống dòng/dãn cách của site.
    const NOISE_LINE = [
        /\bwarrant(y|ies)\b|\b(money[- ]back|satisfaction|lifetime|\d+[- ]year)\s+guarantee/i,
        /\bshipping\b|\bships?\s+(in|within|from|free|separately|out|by)\b/i,
        /\bdelivery\s+(time|date|estimate|window|within|in|by)\b|\barriv(es?|al)\b[^\n]{0,40}\b(day|week)s?\b/i,
        /\bbusiness days?\b|\bin[- ]store pickup\b|\bcurbside\b|\bexpedited\b/i,
        /©|\bcopyright\b|\ball rights reserved\b|\b(inc|llc|ltd|corp)\.?\s*$|\bheadquarter/i,
        /\bfounded in\b|\bfamily[- ]owned\b|\bour (company|story|mission|team)\b|\babout (us|the brand)\b|\bproudly (made|based)\b/i,
        /\b(call us|contact us|customer (service|care|support)|hotline|toll[- ]free|live chat|text us)\b/i,
        /\breturns?\s+(policy|within|are|accepted|must)\b|\brefund/i,
    ];
    const isListingNoise = (line) => hasContact(line) || NOISE_LINE.some((re) => re.test(line));
    const scrubListing = (text) => S(text).split('\n')
        .filter((l) => !isListingNoise(l)).join('\n')
        .replace(/\n{3,}/g, '\n\n').trim();

    // ================= mô tả dạng HTML (cột "Mô tả HTML") =================
    // Giữ nguyên cấu trúc HTML của site (đoạn, gạch đầu dòng, bảng thông số, in đậm) nhưng
    // bỏ hết class/style/script/ảnh/nút/link, và lọc GIỐNG cột "Mô tả" chữ thường: xoá phần
    // liên hệ, bảo hành, ship, đổi trả, thông tin doanh nghiệp (isListingNoise — khách
    // 2026-09-28). Lọc theo khối lá; khối có <br> thì lọc từng dòng giữa các <br>.
    const escHtml = (s) => S(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const HTML_DROP = /^(script|style|noscript|template|svg|img|picture|source|video|audio|iframe|object|embed|canvas|button|input|select|option|textarea|form|label|link|meta|nav|header|footer|hr)$/;
    const HTML_KEEP = /^(p|br|ul|ol|li|dl|dt|dd|strong|b|em|i|u|sup|sub|small|h[1-6]|table|thead|tbody|tfoot|tr|th|td|caption|blockquote|pre|div)$/;
    const HTML_AS_DIV = /^(section|article|main|aside|figure|figcaption|center)$/;
    const HTML_BLOCK_SEL = 'p, div, ul, ol, li, dl, dt, dd, table, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, section, article';
    const HTML_BLOCK_TAG = 'p|div|ul|ol|li|dl|dt|dd|h[1-6]|table|thead|tbody|tfoot|tr|th|td|caption|blockquote|pre|br';
    const LINK_ONLY = /^\s*(learn more|click here|here|see details|shop now|view more|read more|more)\.?\s*$/i;

    const cleanHtmlNode = (node) => {
        if (node.nodeType === 3) {
            const t = S(node.nodeValue).replace(/\s+/g, ' ');
            return isListingNoise(t) ? '' : escHtml(t);
        }
        if (node.nodeType !== 1) return '';
        let tag = S(node.tagName).toLowerCase();
        if (HTML_DROP.test(tag)) return '';
        if (tag === 'br') return '<br>';
        const txt = S(node.textContent).replace(/\s+/g, ' ').trim();
        const kids = [].slice.call(node.childNodes);
        const brSplit = kids.some((c) => c.nodeType === 1 && S(c.tagName).toLowerCase() === 'br');
        // Khối lá (không chứa khối con) có dòng rác -> bỏ cả khối, như lọc theo dòng của bản chữ
        if (!brSplit && isListingNoise(txt) && !(node.querySelector && node.querySelector(HTML_BLOCK_SEL))) return '';
        if (tag === 'a' && LINK_ONLY.test(txt)) return '';
        let inner = '';
        if (brSplit) {
            // Nhiều dòng trong 1 khối (<p>a<br>ships in 3 days<br>c</p>) -> chỉ bỏ dòng rác
            const lines = [[]];
            kids.forEach((c) => {
                if (c.nodeType === 1 && S(c.tagName).toLowerCase() === 'br') lines.push([]);
                else lines[lines.length - 1].push(c);
            });
            inner = lines.filter((ln) => !isListingNoise(ln.map((c) => S(c.textContent)).join('').replace(/\s+/g, ' ').trim()))
                .map((ln) => ln.map(cleanHtmlNode).join('')).join('<br>');
        } else {
            kids.forEach((c) => { inner += cleanHtmlNode(c); });
        }
        if (HTML_AS_DIV.test(tag)) tag = 'div';
        // span, a, font... -> chỉ giữ nội dung (giữ cả khoảng trắng 2 đầu: "<b>Fit: </b>Misses")
        if (!HTML_KEEP.test(tag)) return inner;
        if (/^(strong|b|em|i|u|sup|sub|small)$/.test(tag)) {
            const lead = /^\s/.test(inner) ? ' ' : '', tail = /\s$/.test(inner) ? ' ' : '';
            return inner.trim() ? lead + '<' + tag + '>' + inner.trim() + '</' + tag + '>' + tail : inner;
        }
        inner = inner.trim();
        const isCell = tag === 'td' || tag === 'th';
        if (!isCell && !inner.replace(/<br>/g, '').trim()) return '';
        // Lớp div chỉ bọc các khối khác -> bỏ lớp bọc cho gọn
        if (tag === 'div' && new RegExp('^<(' + HTML_BLOCK_TAG + ')\\b').test(inner)
                && new RegExp('</(' + HTML_BLOCK_TAG + ')>$').test(inner)) return inner;
        let attrs = '';
        if (isCell) {
            ['colspan', 'rowspan'].forEach((a) => {
                const v = S(node.getAttribute(a)).trim();
                if (/^\d+$/.test(v) && v !== '1') attrs += ' ' + a + '="' + v + '"';
            });
        }
        return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
    };

    // Phần tử DOM (lấy phần BÊN TRONG, bỏ vỏ) hoặc chuỗi HTML -> HTML sạch.
    // Chuỗi HTML parse bằng <template> (không chạy script, không tải ảnh).
    const cleanHtml = (src) => {
        let nodes = [];
        if (src && src.nodeType) {
            nodes = [].slice.call(src.childNodes);
        } else {
            const tpl = document.createElement('template');
            tpl.innerHTML = S(src);
            nodes = [].slice.call(tpl.content.childNodes);
        }
        let out = '';
        nodes.forEach((n) => { out += cleanHtmlNode(n); });
        out = out.replace(new RegExp('\\s*(</?(?:' + HTML_BLOCK_TAG + ')\\b[^>]*>)\\s*', 'g'), '$1').trim();
        // Chỉ có chữ trơn (VD tab Summary của Williams-Sonoma) -> bọc <p>
        if (out && !/^</.test(out)) out = '<p>' + out + '</p>';
        return out;
    };

    // Chữ thường -> HTML: mỗi dòng 1 <p>, dòng bắt đầu bằng gạch đầu dòng gom vào <ul>
    const textToHtml = (text) => {
        let out = '', inList = false;
        S(text).split('\n').map((l) => l.trim()).forEach((l) => {
            const m = l.match(/^[•·*–-]\s+(.+)$/);
            if (m) {
                if (!inList) { out += '<ul>'; inList = true; }
                out += '<li>' + escHtml(m[1]) + '</li>';
                return;
            }
            if (inList) { out += '</ul>'; inList = false; }
            if (l) out += '<p>' + escHtml(l) + '</p>';
        });
        return inList ? out + '</ul>' : out;
    };

    // Ghép các phần mô tả: nhiều phần thì mỗi phần có tiêu đề <h3> (phần không có tiêu đề
    // riêng là vì HTML của site đã tự có tiêu đề bên trong).
    const sectionsHtml = (secs) => {
        const list = (secs || []).filter((s) => s.html);
        if (list.length === 1) return list[0].html;
        return list.map((s) => (s.title ? '<h3>' + escHtml(s.title) + '</h3>' : '') + s.html).join('');
    };

    // Bảng "Tên | Giá trị" từ dữ liệu JSON (thông số Staples / Hernest)
    const specTableHtml = (rows) => {
        const tr = (rows || []).filter((r) => r && S(r[0]).trim() && S(r[1]).trim())
            .map((r) => '<tr><th>' + escHtml(S(r[0]).trim()) + '</th><td>' + escHtml(S(r[1]).trim()) + '</td></tr>');
        return tr.length ? '<table><tbody>' + tr.join('') + '</tbody></table>' : '';
    };

    // ================= bố cục chuẩn (checklist eBay) =================
    // Domain chính, bỏ subdomain: global.danner.com -> danner.com (2 link là 1 sản phẩm)
    const registrableDomain = () => {
        const host = S(opts.hostname || location.hostname).toLowerCase();
        const parts = host.split('.').filter(Boolean);
        return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
    };
    // Tên site viết hoa chữ đầu, dùng cho mã định danh: vionicshoes.com -> Vionicshoes
    const siteName = () => {
        const first = registrableDomain().split('.')[0] || 'Site';
        return first.charAt(0).toUpperCase() + first.slice(1);
    };
    // Brand điền vào "Tiêu đề đã sửa" (mirror ebay_prep.SITE_BRANDS). Site đa hãng
    // (Revolve, Staples...) lấy brand từ JSON-LD, không có nữa thì lấy tên site.
    const SITE_BRANDS = {
        'vionicshoes.com': 'Vionic', 'williams-sonoma.com': 'Williams-Sonoma',
        'victoriassecret.com': "Victoria's Secret", 'danner.com': 'Danner',
        'bando.com': 'ban.do', 'oglmove.com': 'OGL Move',
        'duluthtrading.com': 'Duluth Trading Co.', 'talbots.com': 'Talbots',
        'hernest.com': 'Hernest', 'freepeople.com': 'Free People',
    };
    const ldBrand = () => {
        const p = ldProduct();
        const b = p && p.brand;
        if (!b) return '';
        return decodeHtml(typeof b === 'string' ? b : (b.name || ''));
    };
    const resolveBrand = () => SITE_BRANDS[registrableDomain()] || ldBrand() || siteName();

    // "Tiêu đề đã sửa": <Brand> <tiêu đề gốc>, <màu> Color, New — tối đa 80 ký tự.
    // Quá dài thì cắt phần tiêu đề tại ranh giới từ, LUÔN giữ đuôi màu + New.
    const fixedTitle = (brand, title, color, limit) => {
        limit = limit || 80;
        // eBay không cho ký hiệu ®/™ trong tiêu đề — bỏ khỏi bản đã sửa,
        // "Tiêu đề gốc" vẫn giữ nguyên như trên trang nguồn.
        title = S(title).replace(/[\u00ae\u2122\u00a9]/g, ' ').replace(/\s+/g, ' ').trim();
        brand = S(brand).replace(/\s+/g, ' ').trim();
        // Tiêu đề gốc đã kết thúc bằng "New" (eBay: "... edp New") -> bỏ để không thành "New, New"
        title = title.replace(/[\s,\-–—]*\bNew\s*$/i, '').trim() || title;
        if (!title) return '';
        let base = title;
        if (brand && title.toLowerCase().indexOf(brand.toLowerCase()) !== 0) base = brand + ' ' + title;
        // Tiêu đề đã chứa sẵn tên màu ("Element 8\" Brown") thì không lặp ", Brown Color"
        color = S(color).trim();
        const hasColor = color && new RegExp('(^|[^a-z])' + color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            + '([^a-z]|$)', 'i').test(title);
        const suffix = (color && !hasColor ? ', ' + color + ' Color' : '') + ', New';
        if (base.length + suffix.length > limit) {
            let cut = base.slice(0, Math.max(0, limit - suffix.length));
            const sp = cut.lastIndexOf(' ');
            if (sp > 0) cut = cut.slice(0, sp);
            base = cut.replace(/[\s,.;:\-–—]+$/, '') || base.slice(0, Math.max(0, limit - suffix.length));
        }
        return base + suffix;
    };

    // Số ngày tới mốc giao hàng MUỘN NHẤT trong đoạn chữ + có phải preorder không.
    // Nhận "Aug 28 - Aug 29", "10/15/26", "ships in 5-7 business days", "arrives in 2 weeks".
    // Dạng tương đối chỉ tính khi có chữ ship/deliver/arrive đứng trước — tránh dính
    // "30 day returns". Giao quá 4 ngày = coi như hết hàng (Revolve, Hernest, W-S).
    const deliveryDaysFromText = (text) => {
        text = S(text);
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
                         jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const now = new Date();
        let days = 0;
        let m;
        const re = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})/gi;
        while ((m = re.exec(text)) !== null) {
            const mon = months[m[1].toLowerCase()];
            if (mon === undefined) continue;
            let d = new Date(now.getFullYear(), mon, parseInt(m[2], 10));
            if (d - now < -15 * 86400000) d = new Date(now.getFullYear() + 1, mon, parseInt(m[2], 10));
            days = Math.max(days, Math.round((d - now) / 86400000));
        }
        const re2 = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
        while ((m = re2.exec(text)) !== null) {
            const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
            const d = new Date(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10));
            days = Math.max(days, Math.round((d - now) / 86400000));
        }
        const re3 = /(?:ship|deliver|arriv|receive|dispatch|leave)[^.\n]{0,40}?(\d{1,2})(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s*(business|working)?\s*(day|week)s?\b/gi;
        while ((m = re3.exec(text)) !== null) {
            let n = parseInt(m[2] || m[1], 10);
            if (!isFinite(n)) continue;
            if (/week/i.test(m[4])) n *= 7;
            else if (m[3]) n = Math.ceil(n * 1.4);       // ngày làm việc -> ngày lịch
            days = Math.max(days, n);
        }
        return { days: days, preorder: /\b(pre|back)[- ]?order/i.test(text) };
    };

    // Mô tả chuẩn = Description + Details + Fit & Care (+ Size & Fit) gộp lại,
    // mỗi phần có dòng tiêu đề " - <Tên phần>" như mẫu trong checklist. Chỉ 1 phần
    // thì giữ nguyên, không thêm tiêu đề.
    const mergeDescription = (rec) => {
        const sections = [['Description', rec.description], ['Details', rec.details],
                          ['Fit & Care', rec.fit_care], ['Size & Fit', rec.size_fit]]
            .map((s) => [s[0], S(s[1]).trim()]).filter((s) => s[1]);
        if (sections.length <= 1) return sections.length ? sections[0][1] : '';
        return sections.map((s) => ' - ' + s[0] + '\n' + s[1]).join('\n');
    };

    // Giá gạch (giá gốc) đọc từ DOM khi adapter không cho biết: phần tử gạch ngang /
    // "Was $..." / compare-at có số tiền LỚN HƠN giá đang bán. Không biết giá đang
    // bán thì không đoán (số tiền bất kỳ trên trang có thể là phí ship).
    const domListPrice = (price) => {
        if (price == null) return null;
        const els = [].slice.call(document.querySelectorAll(
            's, del, strike, [class*=strike], [class*=was-price], [class*=wasPrice], [class*=compare], '
            + '[class*=original-price], [class*=originalPrice], [class*=regular-price], [class*=regularPrice], '
            + '[class*=list-price], [class*=listPrice], [class*=old-price], [class*=oldPrice], '
            + '[data-price-type="oldPrice"]'));
        // Bỏ phần tử nằm trong khối "sản phẩm gợi ý / đã xem" — giá gạch ở đó là của
        // sản phẩm KHÁC (Revolve từng trả 190 cho quần short 40).
        const ASIDE = '[class*=recommend], [class*=related], [class*=similar], [class*=you-may], '
            + '[class*=recently], [class*=carousel], [class*=slider], [class*=upsell], [class*=cross-sell], '
            + '[class*=minicart], [class*=mini-cart], [class*=cart], [class*=bag], [id*=cart], [id*=bag], '
            + '[class*=plp], footer, nav, header';
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const t = S(el.innerText || el.textContent).trim();
            if (!t || t.length > 40 || !/[$€£]\s?\d/.test(t)) continue;
            if (el.closest && el.closest(ASIDE)) continue;
            const p = parsePrice(t);
            if (p && p.value > price) return p.value;
        }
        return null;
    };

    // Tham số màu trên 1 URL: ?color=BRN, ?colorcode=..., ?dwvar_45507_color=BRN (SFRA)
    const colorParamOf = (u) => {
        let sp;
        try { sp = new URL(S(u), location.href).searchParams; } catch (e) { return ''; }
        let v = S(sp.get('color') || sp.get('colorcode') || sp.get('colour')).trim();
        if (!v) {
            sp.forEach((val, key) => {
                if (!v && /(^|_)colou?r$/i.test(key)) v = S(val).trim();
            });
        }
        return v;
    };
    // Màu đang xem theo URL: trình duyệt trước, rồi tới link người dùng dán (site
    // redirect có thể làm rơi query).
    const currentColorFromUrl = () => colorParamOf(location.href) || colorParamOf(opts.url);

    // Ảnh rác cần loại: swatch màu, icon, logo, sprite, placeholder, ảnh 1px
    const BAD_IMG = /(swatch|sprite|placeholder|\/icon|logo|badge|spacer|transparent|blank\.gif)/i;

    const cleanImages = (list) => {
        const seen = new Set();
        const out = [];
        (list || []).forEach((raw) => {
            const u = abs(raw);
            if (!u || u.indexOf('data:') === 0) return;
            if (BAD_IMG.test(u)) return;
            const key = u.split('?')[0];          // khử trùng theo path, bỏ query resize
            if (seen.has(key)) return;
            seen.add(key);
            out.push(u);
        });
        return out;
    };

    // Magento swatch config (Vionic, Danner): tìm script x-magento-init chứa jsonConfig,
    // đào sâu tới object có .attributes — đó là nguồn màu/size/tồn kho/gallery.
    let _vioCfgCache;
    const magentoCfg = () => {
        if (_vioCfgCache !== undefined) return _vioCfgCache;
        _vioCfgCache = null;
        const scripts = document.querySelectorAll('script[type="text/x-magento-init"]');
        for (let i = 0; i < scripts.length && !_vioCfgCache; i++) {
            const txt = scripts[i].textContent || '';
            if (txt.indexOf('jsonConfig') < 0) continue;
            let j;
            try { j = JSON.parse(txt); } catch (e) { continue; }
            const walk = (o) => {
                if (!o || typeof o !== 'object' || _vioCfgCache) return;
                if (o.jsonConfig && o.jsonConfig.attributes) { _vioCfgCache = o.jsonConfig; return; }
                Object.keys(o).forEach((k) => walk(o[k]));
            };
            walk(j);
        }
        return _vioCfgCache;
    };
    const vionicCfg = magentoCfg;

    // Giá gạch trên trang Magento: [data-price-type=oldPrice] hoặc jsonConfig.prices.oldPrice
    const magentoListPrice = (price) => {
        const old = document.querySelector('[data-price-type="oldPrice"] .price, [data-price-type="oldPrice"]');
        const p = old ? parsePrice(old.textContent) : null;
        if (p && p.value > 0 && (price == null || p.value > price)) return p.value;
        const cfg = magentoCfg();
        const pr = cfg && cfg.prices;
        if (pr && pr.oldPrice && pr.finalPrice) {
            const o = Number(pr.oldPrice.amount);
            const f = Number(pr.finalPrice.amount);
            if (isFinite(o) && isFinite(f) && o > f) return o;
        }
        return null;
    };

    // Toàn bộ biến thể của 1 trang Magento: trục màu / size / trục còn lại (width),
    // tồn kho theo product id (qty > 0; dự phòng union các list salable) và ma trận
    // màu × width -> size còn / size hết. Vionic và Danner dùng chung.
    const magentoVariants = (cfg) => {
        if (!cfg || !cfg.attributes) return null;
        const attrs = cfg.attributes || {};
        let colorA = null, sizeA = null;
        const variantAs = [];
        Object.keys(attrs).forEach((id) => {
            const a = attrs[id] || {};
            const code = S(a.code).toLowerCase();
            if (code === 'color') colorA = a;
            else if (code.indexOf('size') >= 0) sizeA = a;
            else variantAs.push(a);
        });

        const qty = {};
        Object.keys(cfg.in_stock_products || {}).forEach((pid) => {
            qty[pid] = (cfg.in_stock_products[pid] || {}).qty || 0;
        });
        let inStock;
        if (Object.keys(qty).length) {
            inStock = (pid) => (qty[pid] || 0) > 0;
        } else {
            const ok = new Set();
            Object.keys(cfg.salable || {}).forEach((aid) => {
                Object.keys(cfg.salable[aid] || {}).forEach((oid) => {
                    (cfg.salable[aid][oid] || []).forEach((pid) => ok.add(S(pid)));
                });
            });
            inStock = (pid) => ok.has(S(pid));
        }
        const anyInStock = (pids) => (pids || []).some(inStock);
        const inter = (a, b) => {
            const sb = new Set(b || []);
            return (a || []).filter((x) => sb.has(x));
        };

        const sizesAll = [], sizesOk = [], sizesOut = [];
        ((sizeA && sizeA.options) || []).forEach((o) => {
            sizesAll.push(S(o.label));
            (anyInStock(o.products) ? sizesOk : sizesOut).push(S(o.label));
        });

        const colorOpts = (colorA && colorA.options) || [{ label: '', products: null }];
        const widthA = variantAs.length && variantAs[0].options && variantAs[0].options.length
            ? variantAs[0] : null;
        const widthOpts = widthA ? widthA.options : [{ label: '', products: null }];
        const matrix = [];
        colorOpts.forEach((c) => {
            widthOpts.forEach((w) => {
                let base = c.products || null;
                if (w.products) base = base ? inter(base, w.products) : w.products;
                const ok = [], out = [];
                ((sizeA && sizeA.options) || []).forEach((s) => {
                    const pids = base ? inter(s.products, base) : s.products;
                    (anyInStock(pids) ? ok : out).push(S(s.label));
                });
                matrix.push({ color: S(c.label), variant: S(w.label),
                              sizes_in_stock: ok, sizes_out_of_stock: out });
            });
        });

        const variants = [];
        variantAs.forEach((a) => {
            (a.options || []).forEach((o) => {
                variants.push(S(a.label || a.code) + ':' + S(o.label));
            });
        });

        return {
            color_label: S(colorA && colorA.label) || 'Color',
            size_label: S(sizeA && sizeA.label) || 'Size',
            variant_label: widthA ? S(widthA.label || widthA.code) : '',
            colors: colorOpts.map((o) => S(o.label)).filter(Boolean),
            sizes: sizesAll,
            sizes_in_stock: sizesOk,
            sizes_out_of_stock: sizesOut,
            variants: variants,
            stock_matrix: matrix,
        };
    };

    // Màu đang xem trên trang Magento -> TÊN màu: ?color=<id option> (nhận cả tên
    // màu) -> swatch đang chọn -> màu đầu dãy swatch.
    const magentoCurrentColor = (cfg, mv) => {
        const labels = vionicColorLabels(cfg);
        const raw = currentColorFromUrl();
        if (raw) {
            if (labels[raw]) return labels[raw];
            const byName = Object.keys(labels).find(
                (id) => labels[id].toLowerCase() === raw.toLowerCase());
            if (byName) return labels[byName];
        }
        const sel = document.querySelector(
            '.swatch-option.selected[data-option-label], .swatch-option.selected[option-label]');
        const selLabel = sel ? S(sel.getAttribute('data-option-label')
                                 || sel.getAttribute('option-label')).trim() : '';
        if (selLabel) return selLabel;
        // ?color= không phải id màu có thật (link cũ) -> site hiện màu MẶC ĐỊNH
        // (color_variants[id].is_default), không có thì màu đầu dãy swatch.
        const cv = (cfg && cfg.color_variants) || {};
        const def = Object.keys(cv).find((id) => /^true$/i.test(S(cv[id] && cv[id].is_default)));
        if (def && labels[def]) return labels[def];
        const first = cfg && cfg.color_variants ? vionicColorOrder(cfg)[0] : '';
        return (first && labels[first]) || (mv && mv.colors[0]) || '';
    };

    // Dòng tồn kho của (màu đang xem, trục giữa đang xem): ưu tiên tổ hợp CÒN hàng
    // đầu tiên của màu đó — link chung mọi width nên không có gì để chọn width "đang xem".
    const currentMatrixRow = (matrix, color) => {
        const rows = (matrix || []).filter((m) => !color || m.color === color);
        return rows.find((m) => (m.sizes_in_stock || []).length) || rows[0] || null;
    };

    // {mã màu: tên màu} lấy từ khai báo thuộc tính color
    const vionicColorLabels = (cfg) => {
        const attrs = (cfg && cfg.attributes) || {};
        const aid = Object.keys(attrs).find((k) => S(attrs[k].code).toLowerCase() === 'color');
        const out = {};
        ((aid && attrs[aid].options) || []).forEach((o) => {
            out[S(o.id)] = S(o.label).trim();
        });
        return out;
    };

    // Thứ tự màu đúng như dãy swatch trên site (option đầu -> cuối).
    const vionicColorOrder = (cfg) => {
        const attrs = (cfg && cfg.attributes) || {};
        const aid = Object.keys(attrs).find((k) => S(attrs[k].code).toLowerCase() === 'color');
        const ordered = aid
            ? (attrs[aid].options || []).map((o) => S(o.id)).filter((id) => cfg.color_variants[id])
            : [];
        // Màu có trong color_variants nhưng thiếu ở attributes vẫn phải lấy ảnh.
        Object.keys(cfg.color_variants || {}).forEach((id) => {
            if (ordered.indexOf(id) < 0) ordered.push(id);
        });
        return ordered;
    };

    // ================= ADAPTERS (đã kiểm chứng trên trang thật) =================
    // ============================================================
    // REVOLVE — màu / size (còn-hết) / Description / Size & Fit / Size Guide
    // ============================================================
    // Trang khai sẵn mọi thứ trong DOM, KHÔNG cần bấm gì:
    //   · màu: li.js-product-swatch > input.product-swatches__radio[value]
    //   · size: input.js-size-option với data-qty, data-is-preorder, disabled
    //   · Size & Fit: các tham số trong window.rcProps.pdpSizeGuideUrl
    // 3 dấu hiệu size HẾT (theo đúng cách người bán vẫn nhìn):
    //   1. size đang là preorder            -> data-is-preorder="true"
    //   2. size bị gạch giữa / bấm không được -> input disabled, qty 0,
    //      label mang class cantfindsize
    //   3. giao hàng quá 4 ngày             -> #regularDelivery / #deliveryDate
    const revolveCode = () => {
        const m = location.pathname.match(/\/dp\/([A-Za-z0-9._-]+)\/?/);
        return m ? m[1] : '';
    };

    // Màu đang xem: swatch đang chọn; sản phẩm 1 màu không có swatch thì lấy đuôi
    // " in <màu>" của tiêu đề ("... Mini Skort in Moonlight Combo").
    const revolveCurrentColor = (title) => {
        const swatch = document.querySelector('input.product-swatches__radio:checked');
        const v = swatch ? S(swatch.value).trim() : '';
        if (v) return v;
        const t = S(title || meta('og:title')).replace(/\s*(\|\s*REVOLVE|from\s+Revolve\.com)\s*$/i, '');
        const m = t.match(/\s+in\s+([A-Za-z0-9][^|]{1,40}?)\s*$/);
        return m ? m[1].trim() : '';
    };

    const revolveRcProps = () => {
        try {
            if (window.rcProps && window.rcProps.pdpSizeGuideUrl) return window.rcProps;
        } catch (e) { /* trang chặn truy cập biến toàn cục */ }
        return null;
    };

    // rcProps nằm trong script inline; đọc thẳng biến trước, không được thì moi
    // bằng regex (page context của extension không thấy biến của trang).
    const revolveSizeGuideUrl = () => {
        const rc = revolveRcProps();
        if (rc && rc.pdpSizeGuideUrl) return abs(rc.pdpSizeGuideUrl);
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const m = html.match(/pdpSizeGuideUrl\s*:\s*'([^']+)'/);
        return m ? abs(m[1].replace(/\\\//g, '/')) : '';
    };

    // "Aug 28" / "Aug 28 - Aug 29" / "10/15/26" -> số ngày từ hôm nay tới mốc MUỘN NHẤT
    const revolveDeliveryDays = (text) => deliveryDaysFromText(text).days;

    // Mã của hãng nằm ở window.rcProps.fitPredictor.code ("FREE-OB1697499")
    const revolveManufacturerCode = () => {
        const rc = revolveRcProps();
        let code = rc && rc.fitPredictor ? S(rc.fitPredictor.code) : '';
        if (!code) {
            const html = document.documentElement ? document.documentElement.innerHTML : '';
            const m = html.match(/fitPredictor\s*=\s*\{[^}]*code:\s*'([^']+)'/);
            code = m ? m[1] : '';
        }
        return code.indexOf('-') > 0 ? code.split('-').slice(1).join('-') : '';
    };

    // Khối Description là tab nạp sau (#product-details rỗng, đường dẫn nằm ở
    // #details-markup-holder[data-uri]). Gọi thẳng cùng origin rồi đổ vào DOM —
    // khỏi phải chờ trang tự nạp, và bản extension cũng dùng được y hệt.
    const revolvePrefetch = async () => {
        const holder = document.querySelector('#details-markup-holder[data-uri]');
        const target = document.querySelector('#product-details');
        if (!holder || !target || nodeText(target).length > 40) return;
        const uri = S(holder.getAttribute('data-uri'));
        if (!uri) return;
        const res = await fetch(abs(uri), { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        target.innerHTML = await res.text();
        log('revolve: đã nạp khối Description (' + nodeText(target).length + ' ký tự)');
    };

    const revolveDescription = () => {
        // Tab Description nằm RIÊNG trong #product-details__description. Nếu lấy cả
        // cụm #product-details sẽ dính luôn nhãn tab + tab "size & fit" + "about the
        // brand" -> mô tả lẫn lộn. Ưu tiên đọc đúng danh sách gạch đầu dòng của tab.
        const panel = document.querySelector(
            '#product-details__description, .product-details__description');
        if (panel) {
            const items = [].slice.call(panel.querySelectorAll('li'))
                .map((li) => nodeText(li)).filter(Boolean);
            if (items.length) return items.join('\n');
            const text = nodeText(panel);
            if (text.length > 40) return text;
        }
        const rendered = selTextBest('[class*=product-details__content]');
        if (rendered && rendered.length > 40) return rendered;

        // Chưa kịp nạp -> dựng lại từ chuỗi mô tả nhúng sẵn cho widget đánh giá
        const el = document.querySelector('[data-yotpo-description]');
        const raw = el ? S(el.getAttribute('data-yotpo-description')) : '';
        // Chuỗi này gộp cả thông số lẫn câu quảng cáo; chỉ giữ dòng thông số
        // (câu quảng cáo dài và có động từ, không phải thứ cần cho listing).
        const lines = decodeHtml(raw).split('.')
            .map((x) => x.trim())
            .filter((x) => x.length > 1 && x.length <= 70
                && !/\b(looks?|looked|showcases?|gives?|oozing|perfect(ly)?)\b/i.test(x));
        const code = revolveCode();
        if (code) lines.push('Revolve Style No. ' + code);
        const manufacturer = revolveManufacturerCode();
        if (manufacturer) lines.push('Manufacturer Style No. ' + manufacturer);
        return lines.join('\n');
    };

    // Size & Fit lấy từ chính tham số của link Size Guide — chuẩn hơn đọc DOM tab ẩn
    const revolveSizeFit = () => {
        const url = revolveSizeGuideUrl();
        if (!url) return '';
        let params;
        try { params = new URL(url).searchParams; } catch (e) { return ''; }
        const get = (k) => S(params.get(k)).trim();
        const model = [get('modelIsWearing'), get('modelMeasurements')].filter(Boolean);
        const product = get('productMeasurements');
        const out = [];
        if (model.length) out.push('Model Info', model.join('\n'));
        if (product) {
            out.push('', 'Product measurements',
                     product.split('/').map((x) => x.trim()).filter(Boolean).join('\n'));
        }
        return out.join('\n').trim();
    };

    // Mô tả HTML: đủ 3 tab của khối #product-details (đã nạp ở prefetch)
    const revolveDescSections = () => [
        ['#product-details__description', 'Description', 'description'],
        ['#product-details__size-fit', 'Size & Fit', 'size_fit'],
        ['#product-details__about-brand', 'About The Brand', 'brand'],
    ].map((x) => ({ el: document.querySelector(x[0]), title: x[1], kind: x[2] }))
        .filter((s) => s.el);

    const revolveExtra = (images) => {
        const swatches = [].slice.call(
            document.querySelectorAll('.js-product-swatch input.product-swatches__radio, '
                + 'input.product-swatches__radio'));
        const colors = [];
        swatches.forEach((i) => {
            const v = S(i.value).trim();
            if (v && colors.indexOf(v) < 0) colors.push(v);
        });

        // Giao hàng quá 4 ngày -> coi như không có hàng (dấu hiệu 3)
        const deliveryEl = document.querySelector('#regularDelivery');
        const deliveryHidden = !!deliveryEl
            && /display:\s*none/i.test(S(deliveryEl.getAttribute('style')));
        const deliveryText = deliveryHidden ? '' : nodeText(deliveryEl);
        const deliveryDays = revolveDeliveryDays(deliveryText);
        const slowDelivery = deliveryDays > 4;

        const sizes = [];
        const inStock = [];
        const outStock = [];
        [].slice.call(document.querySelectorAll('input.js-size-option')).forEach((input) => {
            const label = S(input.getAttribute('data-size') || input.value).trim();
            if (!label || sizes.indexOf(label) >= 0) return;
            sizes.push(label);

            const qty = parseInt(input.getAttribute('data-qty') || '0', 10) || 0;
            const preorder = S(input.getAttribute('data-is-preorder')) === 'true'
                || !!S(input.getAttribute('data-preorder-date')).trim();
            const disabled = input.disabled || input.hasAttribute('disabled');
            const lbl = document.querySelector('label[for="' + input.id + '"]');
            const struck = !!lbl && /cantfindsize|is-oos|sold-?out|unavailable/i.test(
                S(lbl.className) + ' ' + S(lbl.getAttribute('class')));

            if (preorder || disabled || struck || qty <= 0 || slowDelivery) outStock.push(label);
            else inStock.push(label);
        });

        if (slowDelivery && sizes.length) {
            warnings.push('Giao hàng dự kiến ' + deliveryDays + ' ngày (>4) — coi như hết hàng: '
                + deliveryText.replace(/\s+/g, ' ').trim());
        }

        // Ảnh của Revolve lấy theo mã sản phẩm trong đường dẫn (/dp/<mã>/) nên CẢ
        // gallery đều là của đúng màu đang xem.
        const cur = revolveCurrentColor();
        if (cur && colors.indexOf(cur) < 0) colors.push(cur);      // sp 1 màu không có swatch
        const imgColors = {};
        if (cur) (images || []).forEach((u) => { imgColors[u] = cur; });

        // Mỗi màu của Revolve là 1 mã / 1 link riêng (FREE-WJ291, FREE-WJ302...). Ảnh
        // "toàn bộ variant" dựng từ mã của từng swatch với cùng dãy _V của mã đang xem
        // (cùng 1 style chụp cùng số góc). Không moi được mã thì bỏ qua màu đó.
        const vNums = (images || []).map((u) => {
            const mm = S(u).match(/_V(\d+)\.jpe?g/i);
            return mm ? mm[1] : '';
        }).filter(Boolean);
        const allImages = [];
        const seenCode = {};
        const pushCode = (code, color) => {
            if (!code || seenCode[code]) return;
            seenCode[code] = 1;
            (vNums.length ? vNums : ['1']).forEach((n) => {
                const u = 'https://is4.revolveassets.com/images/p4/n/uv/' + code + '_V' + n + '.jpg';
                allImages.push(u);
                if (color) imgColors[u] = color;
            });
        };
        pushCode(revolveCode(), cur);
        swatches.forEach((input) => {
            const color = S(input.value).trim();
            const li = (input.closest && input.closest('li, label, div')) || input;
            const html = S(li.outerHTML);
            let code = '';
            const a = li.querySelector ? li.querySelector('a[href*="/dp/"]') : null;
            if (a) {
                const mm = S(a.getAttribute('href')).match(/\/dp\/([A-Za-z0-9._-]+)/);
                code = mm ? mm[1] : '';
            }
            if (!code) { const mm = html.match(/\/dp\/([A-Za-z0-9._-]+)/); code = mm ? mm[1] : ''; }
            if (!code) { const mm = html.match(/([A-Z0-9]+-[A-Z0-9]+)_V\d+\.jpe?g/i); code = mm ? mm[1] : ''; }
            if (!code) {
                ['data-code', 'data-product-code', 'data-productcode', 'data-sku'].forEach((k) => {
                    if (!code) {
                        code = S(input.getAttribute(k)
                                 || (li.getAttribute ? li.getAttribute(k) : '')).trim();
                    }
                });
            }
            pushCode(code, color);
        });

        // Giá gạch: #retailPriceStrikethrough (hoặc #retailPrice) khi lớn hơn giá đang bán
        // #markdownPrice. KHÔNG dùng heuristic chung — trang có minicart với giá gạch của
        // sản phẩm khác trong giỏ (từng trả 190 cho quần short 40).
        const retail = parsePrice(nodeText(document.querySelector('#retailPriceStrikethrough'))
            || nodeText(document.querySelector('#retailPrice')));
        const sale = parsePrice(nodeText(document.querySelector('#markdownPrice')))
            || parsePrice(nodeText(document.querySelector('#retailPrice')));
        const listPrice = retail && sale && retail.value > sale.value ? retail.value : null;

        return {
            image_colors: imgColors,
            all_images: allImages.length ? allImages : null,
            current_color: cur,
            list_price: listPrice,
            color_label: 'Color',
            colors: colors,
            size_label: 'Size',
            sizes: sizes,
            sizes_in_stock: inStock,
            sizes_out_of_stock: outStock,
            size_fit: revolveSizeFit(),
            size_guide_url: revolveSizeGuideUrl(),
            // Nút mở bảng Size Guide — tool bấm rồi chụp lại bảng đó
            size_guide_button: document.querySelector('#js-sizeguide-focus') ? '#js-sizeguide-focus' : '',
        };
    };

    // ============================================================
    // DULUTH TRADING — tên / giá / màu / size (còn-hết) / mô tả / ảnh
    // ============================================================
    // Trang là app React (Salesforce Commerce + Mobify): HTML trả về CHỈ có khung
    // rỗng, không h1, không nút màu, không nút size. Nhưng TOÀN BỘ dữ liệu sản phẩm
    // nằm sẵn trong <script id="mobify-data"> ngay từ lượt tải đầu -> đọc thẳng JSON
    // đó vừa đủ vừa nhanh, không phải chờ trang render.
    // BẪY 1: JSON-LD offers.price là giá THẤP NHẤT của mọi màu (41.99) chứ không phải
    //   giá màu đang xem (84.95) -> phải lấy pricing của đúng màu trong ?color=.
    // BẪY 2: JSON-LD description là đoạn quảng cáo, không phải khối Features /
    //   Fit + Sizing / Fabrication + Care mà người bán cần -> lấy từ c_copy*.
    // BẪY 3: mảng variants CHỈ chứa tổ hợp CÒN BÁN (không có cái nào orderable=false)
    //   -> "size hết" = dải size đầy đủ (gộp mọi màu) trừ đi size còn của màu đang xem.
    let _dtProduct;

    const duluthProduct = () => {
        if (_dtProduct !== undefined) return _dtProduct;
        _dtProduct = null;
        try {
            const el = document.getElementById('mobify-data');
            const st = el ? JSON.parse(S(el.textContent)) : null;
            const pre = st && st.__PRELOADED_STATE__;
            const lib = pre && pre.__STATE_MANAGEMENT_LIBRARY;
            const store = lib && lib.store && lib.store.productStore;
            const byId = store && store.productsById;
            if (byId) {
                const ids = Object.keys(byId);
                // Mã sản phẩm nằm cuối đường dẫn: …-cargo-work-pants-45507.html
                const m = location.pathname.match(/-(\d{4,})\.html/);
                const want = m && byId[m[1]] ? m[1] : ids[0];
                if (want) _dtProduct = byId[want];
            }
            if (_dtProduct) log('duluth: đọc mobify-data OK, id=' + S(_dtProduct.id));
        } catch (e) {
            log('duluth: không đọc được mobify-data — ' + S(e.message || e));
        }
        return _dtProduct;
    };

    const duluthValues = (id) => {
        const p = duluthProduct();
        const list = (p && p.variationAttributes) || [];
        const a = list.filter((x) => x.id === id)[0];
        return (a && a.values) || [];
    };

    // Mã màu của 1 nhóm ảnh: imageGroups[].variationAttributes[color].values[0]
    const dtGroupColor = (g) => {
        const va = (g && g.variationAttributes) || [];
        const vals = va[0] && va[0].values ? va[0].values : [];
        return vals[0] ? S(vals[0].value).toUpperCase() : '';
    };

    // Tham số màu trên 1 URL: ?color=BRN (PWA) hoặc ?dwvar_45507_color=BRN (SFRA)
    const dtColorParam = colorParamOf;

    // Mã trên URL phải là màu CÓ THẬT của sản phẩm mới tin (nhận cả tên: ?color=Black).
    // Site gặp mã lạ thì tự rơi về màu mặc định — mình cũng không được lấy bừa.
    const dtKnownColor = (raw) => {
        raw = S(raw).trim();
        if (!raw) return '';
        const hit = duluthValues('color').filter((v) =>
            S(v.value).toUpperCase() === raw.toUpperCase()
            || S(v.name).trim().toLowerCase() === raw.toLowerCase())[0];
        return hit ? S(hit.value).toUpperCase() : '';
    };

    // Màu của ảnh gallery ĐANG HIỆN trên trang: khớp src của <img> với nhóm ảnh
    // theo màu trong JSON (so theo path, rồi theo tên file 45507_BRN.jpg).
    const dtColorFromDom = () => {
        const p = duluthProduct();
        if (!p) return '';
        const byPath = {};
        const byFile = {};
        const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return S(u).split('?')[0]; } };
        (p.imageGroups || []).forEach((g) => {
            const c = dtGroupColor(g);
            if (!c) return;
            (g.images || []).forEach((im) => {
                [S(im.link), S(im.disBaseLink)].forEach((raw) => {
                    const u = abs(raw);
                    if (!u) return;
                    const path = pathOf(u);
                    byPath[path] = c;
                    const file = path.split('/').pop();
                    // Tên file trùng ở 2 màu thì không dùng được để phân biệt
                    byFile[file] = (file in byFile && byFile[file] !== c) ? '' : c;
                });
            });
        });
        const imgs = [].slice.call(document.querySelectorAll('img'));
        for (let i = 0; i < imgs.length; i++) {
            const src = abs(imgs[i].currentSrc || imgs[i].src);
            if (!src) continue;
            const path = pathOf(src);
            const file = path.split('/').pop();
            const c = byPath[path] || byFile[file];
            if (c) return c;
            // Ảnh chụp phụ theo màu đang hiện: 45507_BRN_alt_01.jpg -> BRN (JSON chỉ ghi
            // tên chung 45507_alt_01.jpg nên không có trong byFile)
            const m = file.match(/^\d+_([A-Za-z0-9]{2,5})_alt_\d+\.jpe?g$/);
            if (m && dtKnownColor(m[1])) return dtKnownColor(m[1]);
        }
        return '';
    };

    // Màu đang xem — thứ tự tin cậy:
    //   1. ?color= trên URL trình duyệt đang mở
    //   2. ?color= trên LINK NGƯỜI DÙNG DÁN (opts.url): site redirect sang slug
    //      chuẩn có thể làm rơi query, lúc đó location không còn ?color= nữa
    //   3. ảnh gallery đang hiện khớp nhóm ảnh của màu nào
    //   4. biến thể mặc định c_defaultVariant, rồi màu đầu danh sách
    // Trước đây chỉ có 1 và 4 -> link nào rơi ?color= là ảnh + giá + size đều
    // ra của màu mặc định (BRN), nhìn vào tưởng "chỉ đúng màu đầu tiên".
    let _dtColor;
    const duluthColor = () => {
        if (_dtColor !== undefined) return _dtColor;
        const p = duluthProduct();
        if (!p) return dtColorParam(location.href).toUpperCase();   // chưa có JSON, chưa cache
        let from = 'URL trình duyệt';
        let c = dtKnownColor(dtColorParam(location.href));
        if (!c) { c = dtKnownColor(dtColorParam(opts.url)); from = 'link đã dán'; }
        if (!c) { c = dtColorFromDom(); from = 'ảnh đang hiện'; }
        if (!c) {
            const def = S(p['c_defaultVariant']).trim();
            const v = (p.variants || []).filter((x) => S(x.id) === def)[0];
            if (v && v.variationValues) c = S(v.variationValues.color).toUpperCase();
            from = 'biến thể mặc định';
        }
        if (!c) {
            const first = duluthValues('color')[0];
            c = first ? S(first.value).toUpperCase() : '';
            from = 'màu đầu danh sách';
        }
        log('duluth: màu đang xem = ' + (c || '?') + ' (' + from + ')');
        _dtColor = c;
        return c;
    };

    const duluthColorValue = () => {
        const code = duluthColor();
        return duluthValues('color').filter(
            (v) => S(v.value).toUpperCase() === code)[0] || null;
    };

    const duluthPrice = () => {
        const p = duluthProduct();
        if (!p) return null;
        const cv = duluthColorValue();
        const pr = cv && cv.pricing ? cv.pricing : null;
        const v = pr && pr.price != null ? pr.price : p.price;
        if (v == null) return null;
        return { value: Number(v), currency: S(p.currency) || 'USD' };
    };

    // "030" -> "30"; giữ nguyên chữ (S, M, L…)
    const dtNum = (v) => (/^\d+$/.test(v) ? String(parseInt(v, 10)) : v);

    const DT_WORD_SIZES = ['xxxs', 'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl',
                           '3xl', '4xl', '5xl'];

    const dtSizeCmp = (a, b) => {
        const pa = S(a).split('x');
        const pb = S(b).split('x');
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const sa = S(pa[i]);
            const sb = S(pb[i]);
            const na = parseFloat(sa);
            const nb = parseFloat(sb);
            if (isFinite(na) && isFinite(nb)) {
                if (na !== nb) return na - nb;
                continue;
            }
            const ia = DT_WORD_SIZES.indexOf(sa.toLowerCase());
            const ib = DT_WORD_SIZES.indexOf(sb.toLowerCase());
            if (ia >= 0 && ib >= 0) {
                if (ia !== ib) return ia - ib;
                continue;
            }
            const c = sa.localeCompare(sb);
            if (c) return c;
        }
        return 0;
    };

    // Ô "Customers say true to size" là widget đánh giá, không có trong JSON
    const duluthFitNote = () => {
        const t = document.body ? S(document.body.innerText) : '';
        const m = t.match(/Customers say[^\n]{0,60}/i);
        return m ? m[0].trim() : '';
    };

    const duluthDescription = () => {
        const p = duluthProduct();
        if (!p) return '';
        const bullets = (raw) => stripHtml(decodeHtml(S(raw))).split(/\r?\n/)
            .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
            .filter(Boolean);
        const out = [];
        // Trang hiện TIÊU ĐỀ + ĐOẠN GIỚI THIỆU (c_descriptionTitle1 + shortDescription)
        // phía trên 3 khối Features / Fit + Sizing / Fabrication + Care. Trước đây chỉ
        // lấy 3 khối nên mô tả thiếu hẳn phần mở đầu.
        const intro = decodeHtml(S(p['c_descriptionTitle1'])).replace(/\s+/g, ' ').trim();
        const para = htmlToText(S(p.shortDescription));
        if (intro) out.push(intro);
        if (para) out.push(para);
        const push = (head, raw, note) => {
            const items = bullets(raw);
            if (!items.length && !note) return;
            if (out.length) out.push('');
            out.push(head, '');
            if (note) out.push(note, '');
            items.forEach((l) => out.push(l));
        };
        push('Features', p['c_copyFeature']);
        push('Fit + Sizing', p['c_copyFitSize'], duluthFitNote());
        push('Fabrication + Care', p['c_copyFabricationCare']);
        // Sản phẩm cũ chưa có khối c_copy* -> lùi về mô tả dài (gạch đầu dòng)
        if (!bullets(p['c_copyFeature']).length && !bullets(p['c_copyFitSize']).length
                && !bullets(p['c_copyFabricationCare']).length) {
            const long = htmlToText(S(p.longDescription));
            if (long) {
                if (out.length) out.push('');
                out.push(long);
            }
        }
        return out.join('\n');
    };

    // ---- Ảnh: ảnh chụp phụ có BẢN RIÊNG CHO TỪNG MÀU ----
    // JSON chỉ ghi ảnh chụp phụ dùng chung (45507_alt_01.jpg) nhưng trang HIỆN bản riêng
    // theo màu (45507_BRN_alt_01.jpg — site tự chèn mã màu vào tên file, giữ nguyên đoạn
    // dw<hash>). Màu không có bản riêng (HTTP 404, VD 45507_BRN_alt_04) thì trang dùng
    // ảnh chung. Không có cách nào biết trước ngoài hỏi server -> prefetch HEAD song song
    // mọi ứng viên (~1s cho 60 ảnh), nhớ kết quả trên window để lần poll sau khỏi hỏi lại.
    // Trước đây cột "Ảnh của toàn bộ variant" chỉ có 1 ảnh chính mỗi màu + ảnh chung.
    const dtLargeGroups = (p) => (p.imageGroups || []).filter(
        (g) => !g.viewType || /large|hi-?res|zoom/i.test(S(g.viewType)));
    const dtGroupLinks = (g) => (g.images || [])
        .map((im) => abs(S(im.link) || S(im.disBaseLink))).filter(Boolean);
    const dtFile = (u) => S(u).split('?')[0].split('/').pop().toLowerCase();
    // 45507_alt_01.jpg -> 45507_BRN_alt_01.jpg (không phải ảnh chụp phụ thì giữ nguyên)
    const dtAltForColor = (u, code) => S(u).replace(/(\/\d+)_(alt_\d+\.jpe?g)$/i, '$1_' + code + '_$2');
    const dtSharedAlts = (p) => {
        const out = [];
        dtLargeGroups(p).filter((g) => !dtGroupColor(g)).forEach((g) => {
            dtGroupLinks(g).forEach((u) => { if (out.indexOf(u) < 0) out.push(u); });
        });
        return out;
    };
    const dtLiveColors = () => duluthValues('color').filter((v) => v.orderable !== false)
        .map((v) => S(v.value).toUpperCase()).filter(Boolean);
    // {tên file thường: true (có thật) | false (404) | null (không hỏi được)}
    const dtAltCache = () => {
        try {
            return window.__scDuluthAltImages || (window.__scDuluthAltImages = {});
        } catch (e) { return {}; }
    };
    const duluthPrefetch = async () => {
        const p = duluthProduct();
        if (!p) return;
        const cache = dtAltCache();
        // Ảnh đang hiện trên trang là bằng chứng chắc nhất -> ghi nhận luôn, khỏi hỏi
        [].slice.call(document.querySelectorAll('img')).forEach((im) => {
            const f = dtFile(im.currentSrc || im.src);
            if (/^\d+_[a-z0-9]{2,5}_alt_\d+\.jpe?g$/.test(f)) cache[f] = true;
        });
        const todo = [];
        dtLiveColors().forEach((code) => dtSharedAlts(p).forEach((u) => {
            const cu = dtAltForColor(u, code);
            if (cu !== u && !(dtFile(cu) in cache)) todo.push(cu);
        }));
        if (!todo.length) return;
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 8000);
        await Promise.all(todo.map((u) => fetch(u, { method: 'HEAD', signal: ctl ? ctl.signal : undefined })
            .then((r) => { cache[dtFile(u)] = r.ok; })
            .catch(() => { cache[dtFile(u)] = null; })));
        clearTimeout(timer);
        const ok = todo.filter((u) => cache[dtFile(u)] === true).length;
        log('duluth: dò ' + todo.length + ' ảnh chụp phụ theo màu, có thật ' + ok);
    };
    // Gallery của 1 màu đúng như trang hiện khi bấm ô màu đó: ảnh chính của màu + ảnh
    // chụp phụ (bản riêng theo màu nếu có thật, không thì bản dùng chung).
    const duluthColorGallery = (code) => {
        const p = duluthProduct();
        if (!p || !code) return [];
        const cache = dtAltCache();
        const out = [];
        dtLargeGroups(p).filter((g) => dtGroupColor(g) === code).forEach((g) => {
            dtGroupLinks(g).forEach((u) => { if (out.indexOf(u) < 0) out.push(u); });
        });
        dtSharedAlts(p).forEach((u) => {
            const cu = dtAltForColor(u, code);
            const pick = cu !== u && cache[dtFile(cu)] === true ? cu : u;
            if (out.indexOf(pick) < 0) out.push(pick);
        });
        return out;
    };

    // Ảnh của MÀU TRONG LINK (cột "Ảnh của variant đang lấy") — đúng dãy ảnh trang đang hiện.
    const duluthImages = () => {
        const p = duluthProduct();
        if (!p) return [];
        const out = duluthColorGallery(duluthColor());
        // Không xác định được màu đang xem -> thà lấy ảnh mọi màu còn bán hơn là rỗng.
        return out.length ? out : duluthAllImages();
    };

    // Ảnh của TOÀN BỘ màu còn bán (cột "Ảnh của toàn bộ variant"): từng màu một, mỗi màu
    // đủ ảnh chính + ảnh chụp phụ của màu đó — như bấm lần lượt từng ô màu trên trang.
    const duluthAllImages = () => {
        const p = duluthProduct();
        if (!p) return [];
        const out = [];
        dtLiveColors().forEach((code) => {
            duluthColorGallery(code).forEach((u) => { if (out.indexOf(u) < 0) out.push(u); });
        });
        if (!out.length) dtSharedAlts(p).forEach((u) => out.push(u));
        return out;
    };

    // Ảnh nào của màu nào: ảnh chính + ảnh chụp phụ bản riêng của màu đó. Ảnh chụp phụ
    // dùng chung (45507_alt_04.jpg) không gán màu.
    const duluthImageColors = () => {
        const p = duluthProduct();
        if (!p) return {};
        const names = {};
        duluthValues('color').forEach((v) => {
            names[S(v.value).toUpperCase()] = S(v.name || v.value).trim();
        });
        const map = {};
        dtLiveColors().forEach((code) => {
            const own = new RegExp('^\\d+_' + code.toLowerCase().replace(/[^a-z0-9]/g, '') + '(_alt_\\d+)?\\.jpe?g$');
            duluthColorGallery(code).forEach((u) => {
                if (own.test(dtFile(u))) map[u] = names[code];
            });
        });
        return map;
    };

    const duluthExtra = () => {
        const p = duluthProduct();
        if (!p) return null;
        const code = duluthColor();

        const colorVals = duluthValues('color');
        const colors = [];
        const deadColors = [];
        colorVals.forEach((v) => {
            const name = S(v.name || v.value).trim();
            if (!name) return;
            // Màu đã ngừng bán (orderable=false) không tính vào "Màu tổng"
            if (v.orderable === false) { deadColors.push(name); return; }
            if (colors.indexOf(name) < 0) colors.push(name);
        });

        // Trục size = mọi thuộc tính khác màu (quần: waist + inseam -> "30x30")
        const axes = (p.variationAttributes || []).filter((a) => a.id !== 'color');
        const axisIds = axes.map((a) => a.id);
        const label = (vv) => axisIds.map((a) => dtNum(S(vv[a])))
            .filter(Boolean).join('x');

        const all = [];
        const seen = {};
        const hereBy = {};              // mã màu -> {size: 1}, chỉ tổ hợp CÒN BÁN
        (p.variants || []).forEach((v) => {
            const vv = v.variationValues || {};
            const s = label(vv);
            if (!s) return;
            if (!seen[s]) { seen[s] = 1; all.push(s); }
            if (v.orderable === false) return;
            const c = S(vv.color).toUpperCase();
            (hereBy[c] = hereBy[c] || {})[s] = 1;
        });
        const sizes = all.sort(dtSizeCmp);
        const here = hereBy[code] || {};
        const inStock = sizes.filter((s) => here[s]);
        const outStock = sizes.filter((s) => !here[s]);

        // Ma trận tồn kho: mỗi màu còn bán 1 dòng (trục giữa rỗng vì waist×inseam
        // đã gộp vào size) — cột "Size của tất cả variant" dựng từ đây.
        const matrix = colorVals.filter((v) => v.orderable !== false).map((v) => {
            const h = hereBy[S(v.value).toUpperCase()] || {};
            return { color: S(v.name || v.value).trim(), variant: '',
                     sizes_in_stock: sizes.filter((s) => h[s]),
                     sizes_out_of_stock: sizes.filter((s) => !h[s]) };
        });

        const cv = duluthColorValue();
        if (deadColors.length) warnings.push('Màu đã ngừng bán: ' + deadColors.join(', '));
        const pr = cv && cv.pricing ? cv.pricing : null;
        const strike = pr ? Number(pr.strikePrice || pr.list || pr.listPrice || 0) : 0;
        const allImgs = duluthAllImages();
        log('duluth: màu ' + (cv ? S(cv.name || cv.value) : '?') + ', giá gạch '
            + (strike > 0 ? strike : 'không') + ', ' + allImgs.length + ' ảnh mọi màu');

        return {
            image_colors: duluthImageColors(),
            current_color: cv ? S(cv.name || cv.value).trim() : '',
            list_price: strike > 0 && (!pr.price || strike > Number(pr.price)) ? strike : null,
            all_images: allImgs.length ? allImgs : null,
            color_label: 'Color',
            colors: colors,
            size_label: axes.map((a) => S(a.name || a.id)).join(' x ') || 'Size',
            sizes: sizes,
            sizes_in_stock: inStock,
            sizes_out_of_stock: outStock,
            stock_matrix: matrix,
            in_stock: inStock.length > 0,
            // Nút mở bảng size của Duluth mang class băm (_1fkhros…) đổi mỗi lần
            // build -> không bám được. Khai '@text' để tool tìm nút theo đúng chữ
            // trên nút ("Size Chart" / "Size Guide") ngay lúc sắp chụp.
            size_guide_button: '@text',
        };
    };

    // ============================================================
    // GIAO HÀNG CHẬM = HẾT HÀNG (Hernest, Williams-Sonoma; Revolve có luật riêng)
    // ============================================================
    // Đọc mọi khối chữ nói về giao hàng đang HIỆN trên trang, lấy mốc muộn nhất.
    const slowDeliveryInfo = (selector) => {
        const els = [].slice.call(document.querySelectorAll(selector));
        let best = { days: 0, preorder: false, text: '' };
        els.forEach((el) => {
            const text = S(el.innerText).replace(/\s+/g, ' ').trim();
            if (!text || text.length > 400) return;
            const info = deliveryDaysFromText(text);
            if (info.days > best.days || (info.preorder && !best.preorder)) {
                best = { days: Math.max(best.days, info.days), preorder: best.preorder || info.preorder, text: text };
            }
        });
        return best;
    };
    const DELIVERY_SEL = '[class*=shipping-information], [class*=eta-tag], [class*=delivery], '
        + '[class*=Delivery], [class*=ship-msg], [class*=shipping-msg], [class*=ships], '
        + '[data-testid*=delivery], [data-test-id*=delivery], [data-testid*=ship], [data-test-id*=ship]';

    // ============================================================
    // STAPLES — toàn bộ nằm trong <script id="__NEXT_DATA__"> (skuState.skuData)
    // ============================================================
    // Mỗi variant (màu) là 1 link riêng. skuSetData.productProperties.Swatch[] là dãy
    // màu (available=false = gạch xám), selectedSwatch là màu đang xem, items[0].price
    // có listPrice (giá gạch) + finalPrice, items[0].inventory cho biết còn/hết.
    const staplesState = () => {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            const j = el ? JSON.parse(S(el.textContent)) : null;
            const st = j && j.props && j.props.initialStateOrStore;
            return st && st.skuState ? st.skuState : null;
        } catch (e) {
            log('staples: không đọc được __NEXT_DATA__ — ' + S(e.message || e));
            return null;
        }
    };

    const staplesExtra = () => {
        const st = staplesState();
        const sd = st && st.skuData;
        const item = sd && sd.items && sd.items[0];
        const set = sd && sd.skuSetData;
        const props = (set && set.productProperties) || {};

        let curColor = S(set && set.selectedSwatch).trim()
            || S(item && item.product && item.product.swatchLabel).trim()
            || S(st && st.swatchState && st.swatchState.swatchColor).trim();
        if (!curColor) {
            const sel = document.querySelector('[class*=swatch_selected], [class*=swatch-selected]');
            curColor = sel ? S(sel.getAttribute('aria-label') || sel.getAttribute('title')
                              || sel.textContent).trim() : '';
        }

        const colors = [], colorsOut = [];
        (props.Swatch || []).forEach((v) => {
            const n = S(v.variantValue).trim();
            if (!n || colors.indexOf(n) >= 0) return;
            colors.push(n);
            if (v.available === false) colorsOut.push(n);
        });
        // Trục khác màu (Collection, Size...) -> "Tên:Giá trị"; trục đầu tiên dùng làm
        // "variant đang xem" khi sản phẩm không có màu.
        const variants = [];
        let otherName = '';
        const otherVals = [], otherOut = [];
        Object.keys(props).forEach((k) => {
            if (/swatch/i.test(k)) return;
            (props[k] || []).forEach((v) => {
                const val = S(v.variantValue).trim();
                if (!val) return;
                const name = S(v.variantName || k);
                const tag = name + ':' + val;
                if (variants.indexOf(tag) < 0) variants.push(tag);
                if (!otherName) otherName = name;
                if (name === otherName) {
                    if (otherVals.indexOf(val) < 0) otherVals.push(val);
                    if (v.available === false && otherOut.indexOf(val) < 0) otherOut.push(val);
                }
            });
        });
        const selected = (set && set.selectedProperties) || [];
        const otherSel = selected.filter((p) => !/swatch|colou?r/i.test(S(p.variantName)))[0];
        const otherCur = otherSel ? S(otherSel.variantValue).trim() : '';
        // DOM: nút gạch xám (dự phòng khi JSON không có cờ available)
        [].slice.call(document.querySelectorAll('[class*=swatch_unavailable]')).forEach((el) => {
            const n = S(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent).trim();
            if (n && colorsOut.indexOf(n) < 0) colorsOut.push(n);
        });

        const pi = item && item.price && item.price.item && item.price.item[0];
        const listPrice = pi && pi.listPrice != null ? Number(pi.listPrice) : null;
        const finalPrice = pi && pi.finalPrice != null ? Number(pi.finalPrice) : null;

        const inv = item && item.inventory && item.inventory.items && item.inventory.items[0];
        let inStock = null;
        if (inv) inStock = !(inv.outofstock || inv.productIsOutOfStock) && inv.instock !== false;
        else if (item && item.mapItemToProductTile
                 && typeof item.mapItemToProductTile.isOutOfStock === 'boolean') {
            inStock = !item.mapItemToProductTile.isOutOfStock;
        }
        if (!sd && !colors.length && inStock === null) return null;

        // Với Staples "variant" = màu; sản phẩm không có màu thì lấy trục đầu tiên
        // (Collection/Size...). Danh sách còn/hết chỉ tính trên đúng trục đó.
        const hasColor = colors.length > 0;
        const allVals = hasColor ? colors : otherVals;
        const outVals = hasColor ? colorsOut : otherOut;
        const cur = hasColor ? curColor : otherCur;
        if (inStock === false && cur && outVals.indexOf(cur) < 0) outVals.push(cur);
        log('staples: variant đang xem = ' + (cur || '?') + ', ' + allVals.length + ' variant, '
            + outVals.length + ' hết, giá gạch ' + (listPrice || 'không'));
        return {
            current_color: hasColor ? curColor : '',
            variant_label: hasColor ? '' : otherName,
            current_variant: hasColor ? '' : otherCur,
            list_price: listPrice != null && (finalPrice == null || listPrice > finalPrice) ? listPrice : null,
            color_label: hasColor ? 'Color' : '',
            colors: colors,
            size_label: allVals.length ? 'Variant' : '',
            sizes: allVals,
            sizes_in_stock: allVals.filter((v) => outVals.indexOf(v) < 0),
            sizes_out_of_stock: outVals,
            variants: variants,
            in_stock: inStock,
        };
    };

    // Mô tả HTML: khối Details trên trang (đoạn giới thiệu + gạch đầu dòng) + tab
    // Specifications (chỉ có trong __NEXT_DATA__, tab chưa bấm thì DOM không có).
    const staplesDescSections = () => {
        const out = [];
        const box = document.querySelector('[class*=product-details-ux2dot0__detail_container]');
        if (box) out.push({ el: box, title: 'Details', kind: 'description' });
        const st = staplesState();
        const item = st && st.skuData && st.skuData.items && st.skuData.items[0];
        const desc = item && item.product && item.product.description;
        const specs = ((desc && desc.specification) || []).map((x) => [x.name, x.value]);
        const table = specTableHtml(specs);
        if (table) out.push({ html: table, title: 'Specifications', kind: 'details' });
        return out;
    };

    // ============================================================
    // HERNEST — trang React, dữ liệu đủ trên DOM
    // ============================================================
    // h1.detailProName · #detail-price-main (giá bán) · .original-price (giá gạch) ·
    // .detail-sku .sku-item (nhóm option: .sku-options-name + nút, nút đang chọn
    // .sku-button-active) · .shipping-information .eta-tag-label-html "Sep 3-Sep 8"
    // (giao quá 4 ngày = hết hàng) · gallery #detail-img-list img · mô tả .descarea-collapse
    const hernestExtra = () => {
        const groups = [].slice.call(document.querySelectorAll('.detail-sku .sku-item'));
        let label = '', current = '';
        const values = [], outVals = [], variants = [];
        // Nhóm ĐẦU (Size / Color / Fabric) là variant đang xem; các nhóm sau (Quantity...)
        // chỉ ghi vào `variants` dạng "Tên:Giá trị", không trộn vào danh sách còn/hết.
        groups.forEach((g, gi) => {
            const lbl = nodeText(g.querySelector('.sku-options-name')).replace(/:\s*$/, '').trim();
            const selected = nodeText(g.querySelector('.sku-selected-name'));
            const btns = [].slice.call(g.querySelectorAll('button'));
            btns.forEach((b) => {
                const v = S(b.getAttribute('aria-label') || b.textContent).trim();
                if (!v) return;
                if (gi > 0) {
                    const tag = (lbl || 'Variant') + ':' + v;
                    if (variants.indexOf(tag) < 0) variants.push(tag);
                    return;
                }
                if (values.indexOf(v) < 0) values.push(v);
                const dead = b.disabled || b.hasAttribute('disabled')
                    || /disabled|sold-?out|unavailable/i.test(S(b.className));
                if (dead && outVals.indexOf(v) < 0) outVals.push(v);
            });
            if (gi === 0) {
                label = lbl;
                const active = g.querySelector('.sku-button-active');
                current = selected || (active ? S(active.getAttribute('aria-label') || active.textContent).trim() : '');
            }
        });

        const sale = parsePrice(nodeText(document.querySelector('#detail-price-main')));
        const orig = parsePrice(nodeText(document.querySelector('.original-price')));
        const listPrice = orig && (!sale || orig.value > sale.value) ? orig.value : null;

        const ship = slowDeliveryInfo('.shipping-information, .eta-tag-label-html');
        let inStock = null;
        if (ship.days > 4 || ship.preorder) {
            inStock = false;
            if (current && outVals.indexOf(current) < 0) outVals.push(current);
            warnings.push('Giao hàng dự kiến ' + (ship.preorder ? 'preorder' : ship.days + ' ngày (>4)')
                + ' — coi như hết hàng: ' + ship.text);
        } else if (ship.text) {
            inStock = true;
        }
        if (!values.length && !sale && !ship.text) return null;
        log('hernest: ' + (label || 'variant') + ' đang xem = ' + (current || '?') + ', giao '
            + ship.days + ' ngày, giá gạch ' + (listPrice || 'không'));
        return {
            variant_label: label || (values.length ? 'Variant' : ''),
            current_variant: current,
            list_price: listPrice,
            size_label: values.length ? (label || 'Variant') : '',
            sizes: values,
            sizes_in_stock: values.filter((v) => outVals.indexOf(v) < 0),
            sizes_out_of_stock: outVals,
            variants: variants,
            in_stock: inStock,
        };
    };

    // Mô tả Hernest: các panel DESCRIPTION / MATERIAL / SPECIFICATION (bảng thông số
    // ghi "Tên: giá trị" mỗi dòng). Panel đóng nên đọc textContent.
    const hernestDescription = () => {
        const items = [].slice.call(document.querySelectorAll('.descarea-collapse .ant-collapse-item'));
        const out = [];
        items.forEach((it) => {
            const head = nodeText(it.querySelector('.ant-collapse-header')).trim();
            const body = it.querySelector('.ant-collapse-content') || it;
            const lines = [];
            const rows = [].slice.call(body.querySelectorAll('tr'));
            if (rows.length) {
                rows.forEach((tr) => {
                    const cells = [].slice.call(tr.querySelectorAll('th, td')).map(nodeText)
                        .map((t) => t.replace(/^\s*:\s*|\s*:\s*$/g, '').trim()).filter(Boolean);
                    if (cells.length) lines.push(cells.join(': '));
                });
            }
            [].slice.call(body.querySelectorAll('p, li')).forEach((el) => {
                if (el.closest('table')) return;
                const t = nodeText(el);
                if (t && lines.indexOf(t) < 0) lines.push(t);
            });
            if (!lines.length) {
                const t = nodeText(body);
                if (t) lines.push(t);
            }
            if (!lines.length) return;
            if (head) out.push(head);
            lines.forEach((l) => out.push(l));
            out.push('');
        });
        return out.join('\n').trim();
    };

    // Dữ liệu sản phẩm Hernest trong script inline window.__sandwich__={...}:
    // page[<đường dẫn>].data.productInfo — collectionDesc + sellingPoint[] (DESCRIPTION),
    // paramsAttrs[] + care[] (MATERIAL), specInfo.specItemList[] (SPECIFICATION).
    // Panel MATERIAL / SPECIFICATION đóng thì DOM không dựng nội dung -> phải đọc JSON.
    // (productsDescription có khi là mô tả của sản phẩm KHÁC -> không dùng.)
    let _hnInfo;
    const hernestInfo = () => {
        if (_hnInfo !== undefined) return _hnInfo;
        _hnInfo = null;
        let st = null;
        try { st = window.__sandwich__ || null; } catch (e) { /* isolated world */ }
        const scripts = st ? [] : document.querySelectorAll('script:not([src])');
        for (let i = 0; i < scripts.length && !st; i++) {
            const txt = scripts[i].textContent || '';
            const m = /window\.__sandwich__\s*=\s*\{/.exec(txt);
            if (!m) continue;
            try { st = JSON.parse(jsonObjectAt(txt, m.index + m[0].length - 1)); } catch (e) {
                log('hernest: không parse được __sandwich__ — ' + S(e.message));
            }
        }
        const pages = (st && st.page) || {};
        const hasInfo = (k) => pages[k] && pages[k].data && pages[k].data.productInfo;
        const key = Object.keys(pages).find((k) => hasInfo(k) && location.pathname.indexOf(k) === 0)
            || Object.keys(pages).find(hasInfo);
        _hnInfo = key ? pages[key].data.productInfo : null;
        return _hnInfo;
    };

    const hernestDescSections = () => {
        const pi = hernestInfo();
        if (!pi) return [];
        const out = [];
        const points = (pi.sellingPoint || []).map((x) => S(x && x.title).trim()).filter(Boolean);
        const desc = (pi.collectionDesc ? '<p>' + escHtml(pi.collectionDesc) + '</p>' : '')
            + (points.length ? '<ul>' + points.map((x) => '<li>' + escHtml(x) + '</li>').join('') + '</ul>' : '');
        if (desc) out.push({ html: desc, title: 'Description', kind: 'description' });

        const params = specTableHtml((pi.paramsAttrs || []).map((a) => [a.productsOptionsName,
            [S(a.productsOptionsValuesName).trim(), S(a.valueUnit).trim()].filter(Boolean).join(' ')]));
        // care[]: type 1 = dòng tiêu đề ("CARE & MAINTENANCE OF METAL"), type 2 = nội dung
        const care = (pi.care || []).map((c) => (S(c.type) === '1'
            ? '<h4>' + escHtml(htmlToText(c.text)) + '</h4>' : S(c.text))).join('');
        if (params || care) out.push({ html: params + care, title: 'Material', kind: 'details' });

        const specRows = [];
        ((pi.specInfo && pi.specInfo.specItemList) || []).forEach((it) => {
            const v = Array.isArray(it.value) ? it.value.join(', ') : S(it.value);
            specRows.push([it.name, v]);
            const pop = it.showExtraPopup;
            if (pop && Array.isArray(pop.value)) {
                pop.value.forEach((p) => specRows.push([S(p.name) || S(pop.type),
                    Array.isArray(p.value) ? p.value.join(', ') : S(p.value)]));
            }
        });
        const spec = specTableHtml(specRows);
        if (spec) out.push({ html: spec, title: 'Specification', kind: 'details' });
        return out;
    };

    // ============================================================
    // WILLIAMS-SONOMA — window.__INITIAL_STATE__ (Vue SSR). Kiểm chứng 2026-09-03.
    // ============================================================
    // Trang KHÔNG còn JSON-LD Product (chỉ WebSite / Organization / FAQPage /
    // BreadcrumbList) -> adapter cũ rơi xuống heuristic: mất giá, mất mô tả, ảnh lẫn
    // sản phẩm gợi ý ("Shop Similar Items"). Toàn bộ dữ liệu nằm ở script inline
    // `window.__INITIAL_STATE__={...}`:
    //   product.assetUris.images            'https://assets.wsimgs.com/wsimgs/rk/images/dp/'
    //   product.productDetails.title / leaderSku (sku trang hiện mặc định) / pipTabs[]
    //     (Summary · Dimensions & More Info · Use & Care · Shipping + Returns...) /
    //     images[] (ảnh chung của cả nhóm: altview + prodimage)
    //   product.productDetails.subsets[0]
    //     .selections[] {label 'Select Size' | 'Select Color', selectionValueIds[]} — các trục
    //     .definitions.skus{id: name, price{regularPrice, sellingPrice}, availability{available},
    //         inventory{availability ON_HAND | NLA}, media.images[] (prodimage / swatch),
    //         media.copyBlocks[shipinfo "usually arrives within 1 to 2 weeks"],
    //         selectionValueIds[], rank}
    //     .definitions.selectionValues{id: TEXT -> text.attributeId | SKU_SWATCH -> skuSwatch.attributeIds}
    //     .definitions.attributes{id: typeName, valueName}
    //     .definitions.imageSizeGroups{id: {suffix 'xl.jpg' 2000px | 'z.jpg' 1000px | 'o.jpg' 710px, width}}
    // Link ảnh = assetUris.images + path + suffix của nhóm RỘNG NHẤT trong sizeGroupIds
    // (đã kiểm: bản xl 2000px có thật cho cả prodimage lẫn altview).
    // Extension chạy ở isolated world không thấy biến của trang -> moi JSON từ chữ của
    // script inline rồi JSON.parse (như rcProps của Revolve).
    let _wsState;
    const wsState = () => {
        if (_wsState !== undefined) return _wsState;
        _wsState = null;
        try {
            const w = window.__INITIAL_STATE__;
            if (w && w.product && w.product.productDetails) _wsState = w;
        } catch (e) { /* isolated world của extension */ }
        const scripts = _wsState ? [] : document.querySelectorAll('script:not([src])');
        for (let i = 0; i < scripts.length && !_wsState; i++) {
            const txt = scripts[i].textContent || '';
            const m = /window\.__INITIAL_STATE__\s*=\s*\{/.exec(txt);
            if (!m) continue;
            const body = jsonObjectAt(txt, m.index + m[0].length - 1);
            if (!body) continue;
            try {
                const j = JSON.parse(body);
                if (j && j.product && j.product.productDetails) _wsState = j;
            } catch (e) { log('wsonoma: không parse được __INITIAL_STATE__ — ' + S(e.message)); }
        }
        if (_wsState) log('wsonoma: đọc __INITIAL_STATE__ OK');
        return _wsState;
    };
    const wsProduct = () => { const st = wsState(); return st ? st.product : null; };
    const wsDetails = () => { const p = wsProduct(); return (p && p.productDetails) || null; };
    const wsSubset = () => {
        const d = wsDetails();
        const subs = (d && d.subsets) || [];
        return subs.filter((s) => s && s.definitions && s.definitions.skus
            && Object.keys(s.definitions.skus).length)[0] || subs[0] || null;
    };
    const wsDefs = () => { const s = wsSubset(); return (s && s.definitions) || {}; };
    // Dãy sku theo rank (thứ tự site xếp)
    let _wsSkus;
    const wsSkus = () => {
        if (_wsSkus) return _wsSkus;
        const skus = wsDefs().skus || {};
        _wsSkus = Object.keys(skus).map((id) => Object.assign({ id: id }, skus[id]))
            .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0));
        return _wsSkus;
    };
    const wsAxisName = (label) => S(label).replace(/^\s*select\s+/i, '').replace(/\s+/g, ' ').trim();
    const wsAttrValue = (a) => decodeHtml(S(a.valueName || a.valueId)).replace(/\s+/g, ' ').trim();
    const wsAttrIds = (sv) => (sv.text ? [sv.text.attributeId]
        : ((sv.skuSwatch && sv.skuSwatch.attributeIds) || []));
    // Giá trị thuộc tính của 1 sku: [{axis: 'Color', value: 'Cerise Red'}, ...]
    const wsSkuAttrs = (sku) => {
        const defs = wsDefs();
        const sv = defs.selectionValues || {};
        const attrs = defs.attributes || {};
        const out = [];
        (sku.selectionValueIds || []).forEach((id) => {
            if (!sv[S(id)]) return;
            wsAttrIds(sv[S(id)]).forEach((aid) => {
                const a = attrs[S(aid)];
                if (a) out.push({ axis: wsAxisName(a.typeName || a.typeId), value: wsAttrValue(a) });
            });
        });
        return out;
    };
    // Các trục theo thứ tự trên trang, giá trị theo đúng thứ tự site xếp
    const wsAxes = () => {
        const sub = wsSubset();
        const defs = wsDefs();
        const sv = defs.selectionValues || {};
        const attrs = defs.attributes || {};
        return ((sub && sub.selections) || []).map((sel) => {
            const values = [];
            (sel.selectionValueIds || []).forEach((id) => {
                if (!sv[S(id)]) return;
                wsAttrIds(sv[S(id)]).forEach((aid) => {
                    const val = attrs[S(aid)] ? wsAttrValue(attrs[S(aid)]) : '';
                    if (val && values.indexOf(val) < 0) values.push(val);
                });
            });
            return { name: wsAxisName(sel.label || sel.id), values: values };
        }).filter((a) => a.name && a.values.length);
    };
    const wsImageUrl = (im) => {
        const p = wsProduct();
        if (!p || !im || !im.path) return '';
        if (/animation|swatch|video/i.test(S(im.type))) return '';
        const base = S(p.assetUris && p.assetUris.images) || 'https://assets.wsimgs.com/wsimgs/rk/images/dp/';
        const groups = wsDefs().imageSizeGroups || {};
        let best = null;
        (im.sizeGroupIds || []).forEach((id) => {
            const g = groups[S(id)];
            if (g && /\.(jpe?g|png|webp)$/i.test(S(g.suffix))
                    && (!best || Number(g.width || 0) > Number(best.width || 0))) best = g;
        });
        return abs(base + S(im.path) + (best ? S(best.suffix) : 'z.jpg'));
    };
    const wsSkuImages = (sku) => ((sku.media && sku.media.images) || [])
        .map(wsImageUrl).filter(Boolean);
    const wsSharedImages = () => ((wsDetails() && wsDetails().images) || [])
        .map(wsImageUrl).filter(Boolean);
    // "This item usually arrives within 1 to 2 weeks." — giao quá 4 ngày = hết (luật W-S)
    const wsSkuShipInfo = (sku) => {
        const blocks = (sku.media && sku.media.copyBlocks) || [];
        const b = blocks.filter((x) => /ship/i.test(S(x.id) + ' ' + S(x.name)))[0];
        return b ? stripHtml(b.value) : '';
    };
    const wsSkuInStock = (sku) => {
        const inv = S(sku.inventory && sku.inventory.availability).toUpperCase();
        if (/NLA|OUT|SOLD|DISCONTINU/.test(inv)) return false;
        const av = sku.availability || {};
        if (av.available === false) return false;
        const ship = deliveryDaysFromText(wsSkuShipInfo(sku));
        if (ship.days > 4 || ship.preorder) return false;
        if (av.available === true) return true;
        return inv ? inv === 'ON_HAND' : null;
    };
    // Sku đang xem: ?sku= trên link -> ô đang chọn trên trang (label/ô swatch mang class
    // "...-selected") -> selectedSkuId -> leaderSku (sku trang hiện mặc định) -> sku đầu
    let _wsCur;
    const wsCurrentSku = () => {
        if (_wsCur !== undefined) return _wsCur;
        _wsCur = null;
        const skus = wsSkus();
        if (!skus.length) return null;
        const p = wsProduct() || {};
        const det = wsDetails() || {};
        const byId = (id) => skus.filter((s) => S(s.id) === S(id))[0] || null;
        let want = '';
        [location.href, opts.url].forEach((u) => {
            if (want) return;
            try {
                const sp = new URL(S(u), location.href).searchParams;
                want = S(sp.get('sku') || sp.get('skuId') || sp.get('skuid')).trim();
            } catch (e) { /* link hỏng */ }
        });
        let hit = want ? byId(want) : null;
        if (!hit) {
            const known = {};
            wsAxes().forEach((a) => a.values.forEach((v) => { known[v.toLowerCase()] = 1; }));
            const chosen = [];
            [].slice.call(document.querySelectorAll(
                '[class*="label-selected"], [class*="swatch-selected"], [class*="selected-swatch"], '
                + '[aria-checked="true"], [aria-pressed="true"]')).forEach((el) => {
                const t = S(el.getAttribute('aria-label') || el.getAttribute('title')
                            || el.innerText || el.textContent).replace(/\s+/g, ' ').trim().toLowerCase();
                if (t && known[t] && chosen.indexOf(t) < 0) chosen.push(t);
            });
            if (chosen.length) {
                const cands = skus.filter((s) => {
                    const vals = wsSkuAttrs(s).map((a) => a.value.toLowerCase());
                    return chosen.every((c) => vals.indexOf(c) >= 0);
                });
                hit = cands.filter((s) => S(s.id) === S(det.leaderSku))[0] || cands[0] || null;
                if (hit) log('wsonoma: sku đang xem theo ô đã chọn trên trang (' + chosen.join(', ') + ')');
            }
        }
        if (!hit && p.selectedSkuId) hit = byId(p.selectedSkuId);
        if (!hit && det.leaderSku) hit = byId(det.leaderSku);
        _wsCur = hit || skus[0];
        return _wsCur;
    };
    const wsPrice = () => {
        const sku = wsCurrentSku();
        const pr = sku && sku.price;
        const v = pr && pr.sellingPrice != null ? Number(pr.sellingPrice) : NaN;
        return isFinite(v) && v > 0 ? { value: v, currency: 'USD' } : null;
    };
    // Tab mô tả theo tên: Summary -> Description, Dimensions & More Info -> Details,
    // Use & Care -> Fit & Care. Shipping / Price Match / Registry / Warranty bỏ (không phải mô tả).
    const wsTab = (re) => {
        const tabs = (wsDetails() && wsDetails().pipTabs) || [];
        const t = tabs.filter((x) => re.test(S(x.title)))[0];
        return t ? htmlToText(t.value) : '';
    };
    // Mô tả HTML: các tab mô tả sản phẩm; bỏ tab chính sách / khuyến mãi của cửa hàng
    // (Shipping + Returns · Price Match Guarantee · Wedding Registry Gift).
    const wsDescSections = () => ((wsDetails() && wsDetails().pipTabs) || [])
        .filter((t) => t && t.value && !/ship|return|price match|registry|gift|warrant/i.test(S(t.title)))
        .map((t) => ({
            html: S(t.value), title: decodeHtml(t.title),
            kind: /care/i.test(S(t.title)) ? 'fit_care'
                : (/summary|overview|description/i.test(S(t.title)) ? 'description' : 'details'),
        }));
    const wsImages = () => {
        const sku = wsCurrentSku();
        const out = [];
        (sku ? wsSkuImages(sku) : []).concat(wsSharedImages()).forEach((u) => {
            if (out.indexOf(u) < 0) out.push(u);
        });
        return out;
    };
    const wsExtra = () => {
        const det = wsDetails();
        const sub = wsSubset();
        if (!det || !sub) return null;
        const skus = wsSkus();
        const cur = wsCurrentSku();
        const axes = wsAxes();
        const colorAxis = axes.filter((a) => /colou?r|finish|pattern/i.test(a.name))[0] || null;
        const rest = axes.filter((a) => a !== colorAxis);
        const sizeAxis = rest.filter((a) => /size|capacity|dimension|\bqt\b|quart|pack|set/i.test(a.name))[0]
            || rest[rest.length - 1] || null;
        const midAxes = rest.filter((a) => a !== sizeAxis);
        const attrsOf = (sku) => {
            const m = {};
            wsSkuAttrs(sku).forEach((a) => { m[a.axis.toLowerCase()] = a.value; });
            return m;
        };
        const key = (m, axis) => (axis ? S(m[axis.name.toLowerCase()]) : '');
        const midOf = (m) => midAxes.map((a) => key(m, a)).filter(Boolean).join(' / ');

        // Ma trận tồn kho: (màu × trục giữa) -> size còn / size hết
        const sizes = sizeAxis ? sizeAxis.values.slice() : [];
        const colors = colorAxis ? colorAxis.values.slice() : [];
        const midCombos = [];
        skus.forEach((s) => {
            const mv = midOf(attrsOf(s));
            if (midCombos.indexOf(mv) < 0) midCombos.push(mv);
        });
        const rows = {};
        const order = [];
        (colors.length ? colors : ['']).forEach((c) => midCombos.forEach((mv) => {
            const k = c + '|' + mv;
            rows[k] = { color: c, variant: mv, sizes_in_stock: [], sizes_out_of_stock: [] };
            order.push(k);
        }));
        const okBy = {};
        skus.forEach((s) => {
            const m = attrsOf(s);
            const k = key(m, colorAxis) + '|' + midOf(m);
            if (rows[k] && wsSkuInStock(s)) (okBy[k] = okBy[k] || {})[key(m, sizeAxis)] = 1;
        });
        order.forEach((k) => {
            const ok = okBy[k] || {};
            sizes.forEach((sz) => (ok[sz] ? rows[k].sizes_in_stock : rows[k].sizes_out_of_stock).push(sz));
        });

        const curM = cur ? attrsOf(cur) : {};
        const curColor = key(curM, colorAxis);
        const curMid = midOf(curM);
        const curSize = key(curM, sizeAxis);
        const curRow = rows[curColor + '|' + curMid] || null;
        let inStock = cur ? wsSkuInStock(cur) : null;
        if (cur && /NLA/.test(S(cur.inventory && cur.inventory.availability).toUpperCase())) {
            warnings.push('Site ghi sản phẩm đã ngừng bán (NLA).');
        }
        // Giao hàng quá 4 ngày (chữ trên trang hoặc shipinfo của sku) = coi như hết hàng
        const shipTxt = cur ? wsSkuShipInfo(cur) : '';
        const shipSku = deliveryDaysFromText(shipTxt);
        const ship = slowDeliveryInfo(DELIVERY_SEL);
        const preorder = ship.preorder || shipSku.preorder;
        const days = Math.max(ship.days, shipSku.days);
        if (days > 4 || preorder) {
            inStock = false;
            warnings.push('Giao hàng dự kiến ' + (preorder ? 'preorder' : days + ' ngày (>4)')
                + ' — coi như hết hàng: ' + (ship.days >= shipSku.days ? ship.text : shipTxt));
            if (curRow && curSize && curRow.sizes_in_stock.indexOf(curSize) >= 0) {
                curRow.sizes_in_stock.splice(curRow.sizes_in_stock.indexOf(curSize), 1);
                curRow.sizes_out_of_stock.push(curSize);
            }
        }

        // Ảnh: toàn bộ = ảnh riêng của từng sku (theo rank) + ảnh chung; gán màu theo sku
        const imgColors = {};
        const all = [];
        skus.forEach((s) => {
            const c = key(attrsOf(s), colorAxis);
            wsSkuImages(s).forEach((u) => {
                if (all.indexOf(u) < 0) all.push(u);
                if (c && !imgColors[u]) imgColors[u] = c;
            });
        });
        wsSharedImages().forEach((u) => { if (all.indexOf(u) < 0) all.push(u); });

        const pr = cur && cur.price;
        const selling = pr && pr.sellingPrice != null ? Number(pr.sellingPrice) : null;
        const regular = pr && pr.regularPrice != null ? Number(pr.regularPrice) : null;
        const variants = [];
        midAxes.forEach((a) => a.values.forEach((v) => variants.push(a.name + ':' + v)));
        log('wsonoma: sku đang xem = ' + (cur ? cur.id : '?') + ' (' + (curColor || 'không màu')
            + (curMid ? ' / ' + curMid : '') + (curSize ? ' / ' + curSize : '') + '), '
            + skus.length + ' sku, ' + colors.length + ' màu, ' + sizes.length + ' size, '
            + all.length + ' ảnh mọi variant');
        return {
            current_color: curColor,
            variant_label: midAxes.map((a) => a.name).join(' / '),
            current_variant: curMid,
            list_price: regular != null && selling != null && regular > selling ? regular : null,
            all_images: all.length ? all : null,
            image_colors: imgColors,
            color_label: colorAxis ? colorAxis.name : '',
            size_label: sizeAxis ? sizeAxis.name : '',
            colors: colors,
            sizes: sizes,
            sizes_in_stock: curRow ? curRow.sizes_in_stock.slice() : [],
            sizes_out_of_stock: curRow ? curRow.sizes_out_of_stock.slice() : [],
            variants: variants,
            stock_matrix: sizes.length ? order.map((k) => rows[k]) : [],
            in_stock: inStock,
            details: wsTab(/dimensions|more info|details|specification/i),
            fit_care: wsTab(/care/i),
        };
    };


    // ============================================================
    // FREE PEOPLE (URBN) — toàn bộ dữ liệu nằm trong state Pinia của trang
    // ============================================================
    // Trang là app Vue (URBN "pwa"): HTML đầu tiên đã kèm <script id="urbnInitialPiniaState">
    // chứa NGUYÊN state — không phải chờ render, không phải bấm accordion.
    // BẪY 1: nội dung script là chuỗi JSON ĐÃ MÃ HOÁ 2 LẦN (JSON.parse ra string,
    //   parse tiếp mới ra object).
    // BẪY 2: JSON-LD chỉ có ảnh + mô tả của MÀU ĐANG XEM, không có size/tồn kho ->
    //   size còn/hết phải lấy từ includedSkus của đúng màu trong ?color=.
    // BẪY 3: mô tả trên trang là 3 accordion ĐÓNG (Details / Size + Fit / Contents),
    //   innerText trả rỗng -> dựng lại từ state.
    // BẪY 4: ảnh trong state chỉ là MÃ GÓC CHỤP ('k', 'i', 'h'...), phải ghép thành
    //   link images.urbndata.com; wid=2000 cho ảnh 2000x3000 (mặc định trang chỉ 640).
    let _fpState;

    const fpState = () => {
        if (_fpState !== undefined) return _fpState;
        _fpState = null;
        try {
            const el = document.getElementById('urbnInitialPiniaState');
            let st = el ? JSON.parse(S(el.textContent)) : null;
            let guard = 0;
            while (typeof st === 'string' && guard++ < 3) st = JSON.parse(st);
            _fpState = st && typeof st === 'object' ? st : null;
        } catch (e) {
            _fpState = null;
        }
        return _fpState;
    };

    // Node sản phẩm trong catalog: ưu tiên slug đang xem, không có thì lấy node đầu.
    const fpNode = () => {
        const st = fpState();
        const products = st && st.catalog && st.catalog.products;
        if (!products) return null;
        const slug = st.product && st.product.currentSlug;
        if (slug && products[slug]) return products[slug];
        const keys = Object.keys(products);
        return keys.length ? products[keys[0]] : null;
    };

    const fpProduct = () => (fpNode() || {}).product || null;
    const fpSkuInfo = () => (fpNode() || {}).skuInfo || null;

    // Mã màu đang xem: ?color=011 trên link -> state.product.selectedColor; link không
    // có ?color= thì trang mở màu mặc định (defaultColorCode).
    const fpColorCode = () => {
        const st = fpState();
        const sel = st && st.product && S(st.product.selectedColor).trim();
        if (sel) return sel;
        const p = fpProduct();
        return p ? S(p.defaultColorCode).trim() : '';
    };

    const fpColorItems = () => {
        const si = fpSkuInfo();
        const slice = si && si.primarySlice;
        return (slice && Array.isArray(slice.sliceItems)) ? slice.sliceItems : [];
    };

    const fpCurrentColorItem = () => {
        const items = fpColorItems();
        const code = fpColorCode();
        for (let i = 0; i < items.length; i++) {
            if (S(items[i].code).trim() === code) return items[i];
        }
        return items.length ? items[0] : null;
    };

    // <mã style>_<mã màu>_<mã góc chụp> -> link ảnh 2000px.
    const fpImageUrl = (colorCode, view) => {
        const p = fpProduct();
        const style = p ? S(p.styleNumber).trim() : '';
        if (!style || !colorCode || !view) return '';
        return 'https://images.urbndata.com/is/image/FreePeople/'
            + style + '_' + colorCode + '_' + view + '?wid=2000&qlt=90';
    };

    const fpImagesOf = (item) => {
        if (!item) return [];
        const code = S(item.code).trim();
        return (Array.isArray(item.images) ? item.images : [])
            .map((v) => fpImageUrl(code, S(v).trim()))
            .filter(Boolean);
    };

    // Thứ tự size chuẩn của trang (XS;S;M;L;XL) nằm ở secondarySlice, KHÔNG phải thứ tự
    // của includedSkus (mảng đó xếp lộn xộn: L, M, XS, S, XL).
    const fpSizeOrder = () => {
        const si = fpSkuInfo();
        const slice = si && si.secondarySlice;
        const items = (slice && Array.isArray(slice.sliceItems)) ? slice.sliceItems : [];
        const order = [];
        items.forEach((t) => {
            (Array.isArray(t.includedSizes) ? t.includedSizes : []).forEach((s) => {
                const id = S(s.id).trim();
                if (id && order.indexOf(id) < 0) order.push(id);
            });
        });
        return order;
    };

    // Nhóm size theo LOẠI size (Regular / Petite / Plus) — phần lớn sản phẩm chỉ có 1 loại.
    const fpSizeTypes = () => {
        const si = fpSkuInfo();
        const slice = si && si.secondarySlice;
        const items = (slice && Array.isArray(slice.sliceItems)) ? slice.sliceItems : [];
        return items.map((t) => ({
            name: decodeHtml(t.displayName) || S(t.code),
            ids: (Array.isArray(t.includedSizes) ? t.includedSizes : []).map((s) => S(s.id).trim()),
        })).filter((t) => t.ids.length);
    };

    // Còn hàng = availableStatus 1000 (hoặc còn tồn kho thật). Status 1111 = hết;
    // backorder chỉ là hàng đặt trước nên KHÔNG tính là còn (giống Revolve/W-S).
    const fpSkuInStock = (sku) => {
        if (!sku) return false;
        const stock = Number(sku.stockLevel);
        if (isFinite(stock) && stock > 0) return true;
        return Number(sku.availableStatus) === 1000;
    };

    // {tên size còn, tên size hết} của 1 màu, lọc theo bộ mã size (1 loại size) nếu có.
    const fpSizesOf = (item, idFilter) => {
        const order = fpSizeOrder();
        const skus = (item && Array.isArray(item.includedSkus)) ? item.includedSkus.slice() : [];
        skus.sort((a, b) => {
            const ia = order.indexOf(S(a.sizeId).trim());
            const ib = order.indexOf(S(b.sizeId).trim());
            return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        });
        const all = [];
        const inStock = [];
        const outStock = [];
        skus.forEach((sku) => {
            const sizeId = S(sku.sizeId).trim();
            if (idFilter && idFilter.indexOf(sizeId) < 0) return;
            const name = S(sku.size).trim();
            if (!name || all.indexOf(name) >= 0) return;
            all.push(name);
            (fpSkuInStock(sku) ? inStock : outStock).push(name);
        });
        return { sizes: all, in_stock: inStock, out_of_stock: outStock };
    };

    // Mô tả = đúng 3 accordion của trang, dựng lại từ state (accordion đóng nên
    // không đọc được bằng innerText).
    const fpDescription = () => {
        const p = fpProduct();
        if (!p) return '';
        const lines = [];
        const style = S(p.styleNumber).trim();
        const code = fpColorCode();
        if (style) lines.push('Style No. ' + style + (code ? '; Color Code: ' + code : ''));
        // longDescription: 1 đoạn văn rồi tới các gạch đầu dòng dạng "* ..."
        S(p.longDescription).split('\n').forEach((raw) => {
            const line = raw.replace(/^\s*\*\s*/, '').trim();
            if (line) lines.push(line);
        });
        return lines.join('\n');
    };

    const fpSizeFit = () => {
        const p = fpProduct();
        if (!p) return '';
        const rows = Array.isArray(p.measurements) ? p.measurements : [];
        if (!rows.length) return '';
        const sample = S(p.sampleSize).trim();
        const lines = sample ? ['Measurements for size ' + sample] : [];
        rows.forEach((m) => {
            const label = decodeHtml(m.measurementTitle);
            const us = S(m.us).trim();
            if (label && us) lines.push(label + ': ' + us + ' in');
        });
        return lines.length > (sample ? 1 : 0) ? lines.join('\n') : '';
    };

    const fpFitCare = () => {
        const p = fpProduct();
        if (!p) return '';
        const lines = [];
        const care = S(p.care).trim();
        const contents = (Array.isArray(p.contents) ? p.contents : [])
            .map((c) => S(c).trim()).filter(Boolean).join('; ');
        const origin = S(p.origin).trim();
        if (care) lines.push('Care: ' + care);
        if (contents) lines.push('Contents: ' + contents);
        if (origin) lines.push('Origin: ' + origin);
        return lines.join('\n');
    };

    const fpExtra = () => {
        const si = fpSkuInfo();
        const p = fpProduct();
        if (!si || !p) return null;                 // state chưa có -> để crawler poll tiếp

        const items = fpColorItems();
        const cur = fpCurrentColorItem();
        const colors = items.map((it) => decodeHtml(it.displayName)).filter(Boolean);
        const curColor = cur ? decodeHtml(cur.displayName) : '';

        // Ảnh: gallery của màu đang xem, rồi gallery mọi màu (cột "Ảnh của toàn bộ variant")
        const imgColors = {};
        const allImages = [];
        items.forEach((it) => {
            const color = decodeHtml(it.displayName);
            fpImagesOf(it).forEach((u) => {
                if (allImages.indexOf(u) < 0) allImages.push(u);
                if (color) imgColors[u] = color;
            });
        });

        const types = fpSizeTypes();
        const single = types.length <= 1;
        const curSizes = fpSizesOf(cur, null);

        // Ma trận tồn kho: mỗi màu (× loại size nếu sản phẩm có nhiều loại) 1 dòng
        const matrix = [];
        items.forEach((it) => {
            const color = decodeHtml(it.displayName);
            if (single) {
                const s = fpSizesOf(it, null);
                if (s.sizes.length) {
                    matrix.push({ color: color, variant: '',
                                  sizes_in_stock: s.in_stock, sizes_out_of_stock: s.out_of_stock });
                }
                return;
            }
            types.forEach((t) => {
                const s = fpSizesOf(it, t.ids);
                if (s.sizes.length) {
                    matrix.push({ color: color, variant: t.name,
                                  sizes_in_stock: s.in_stock, sizes_out_of_stock: s.out_of_stock });
                }
            });
        });

        const listLow = Number(si.listPriceLow);
        const saleLow = Number(si.salePriceLow);
        const listPrice = (isFinite(listLow) && isFinite(saleLow) && listLow > saleLow)
            ? listLow : null;

        log('freepeople: màu ' + (fpColorCode() || '?') + ' = ' + (curColor || '?') + ', '
            + items.length + ' màu, ' + curSizes.sizes.length + ' size ('
            + curSizes.in_stock.length + ' còn), ' + allImages.length + ' ảnh mọi màu');

        return {
            current_color: curColor,
            color_label: decodeHtml((si.primarySlice || {}).displayLabel) || 'Color',
            colors: colors,
            size_label: decodeHtml((si.secondarySlice || {}).displayLabel) || 'Size',
            sizes: curSizes.sizes,
            sizes_in_stock: curSizes.in_stock,
            sizes_out_of_stock: curSizes.out_of_stock,
            variant_label: single ? '' : 'Size Type',
            current_variant: '',
            stock_matrix: matrix,
            in_stock: curSizes.sizes.length ? curSizes.in_stock.length > 0 : null,
            list_price: listPrice,
            all_images: allImages.length ? allImages : null,
            image_colors: imgColors,
            size_fit: fpSizeFit(),
            fit_care: fpFitCare(),
            // Nút "Size Guide" ngay dưới bảng size — tool bấm rồi chụp lại bảng
            size_guide_button: document.querySelector('button.c-pwa-size-guide-link')
                ? 'button.c-pwa-size-guide-link' : '',
        };
    };

    // ============================================================
    // CRATE & BARREL — JSON-LD + khối .details-* của trang
    // ============================================================
    // Mỗi màu/kích thước là 1 SKU 1 LINK riêng (".../ninja-...-in-midnight-mocha/s555845")
    // nên trang không có bảng size/màu -> chỉ cần tiêu đề, giá, mô tả, ảnh, còn/hết.
    // BẪY 1: JSON-LD offers CHỈ có giá đang bán; giá gạch nằm ở meta og:price:standard_amount
    //   (và .regPrice trên DOM, nhãn đổi theo loại khuyến mãi: "reg." / "open stock").
    // BẪY 2: .salePrice/.regPrice còn xuất hiện trong các thẻ sản phẩm gợi ý -> phải
    //   bám trong khối giá chính .shop-bar-price-area.
    // BẪY 3: JSON-LD description gộp hết gạch đầu dòng thành 1 đoạn liền; khối
    //   .details-description + ul.details-list trên trang mới giữ đúng từng dòng.
    // BẪY 4: ảnh trong JSON-LD là link scene7 TRẦN (800x800); thêm ?wid=2000&qlt=90
    //   mới ra 2000x2000. Preset $web_pdp_main_carousel_med$ chỉ cho 920px.
    // BẪY 5: accordion "Dimensions" đóng sẵn -> số đo lấy từ width/depth/height của JSON-LD.
    const cbMainPrice = (sel) => {
        const box = document.querySelector('.shop-bar-price-area');
        const el = box ? box.querySelector(sel) : null;
        return el ? parsePrice(nodeText(el)) : null;
    };

    const cbDescription = () => {
        const lines = [];
        const push = (t) => {
            S(t).split('\n').forEach((raw) => {
                const line = raw.trim();
                if (line && lines.indexOf(line) < 0) lines.push(line);
            });
        };
        push(nodeText(document.querySelector('.details-description')));
        [].slice.call(document.querySelectorAll('ul.details-list li')).forEach((li) => {
            push(nodeText(li));
        });
        push(nodeText(document.querySelector('.details-vendor-number')));
        if (lines.length) return lines.join('\n');
        // Trang chưa render xong khối Details -> tạm dùng mô tả JSON-LD (1 đoạn liền)
        return ldDesc();
    };

    // "Dimensions": accordion đóng nên đọc từ JSON-LD; mở sẵn thì lấy chữ thật.
    const cbDimensions = () => {
        const open = nodeText(document.querySelector('.dimension-container'));
        const cleaned = S(open).split('\n').map((l) => l.trim())
            .filter((l) => l && !/^dimensions$/i.test(l)).join('\n');
        if (cleaned) return cleaned;
        const p = ldProduct();
        if (!p) return '';
        const rows = [['Width', p.width], ['Depth', p.depth], ['Height', p.height]];
        const lines = [];
        rows.forEach((r) => {
            const v = r[1] && r[1].value != null ? r[1].value : null;
            if (v != null && isFinite(Number(v))) lines.push(r[0] + ': ' + v + '"');
        });
        return lines.length ? lines.join('\n') : '';
    };

    const cbImages = () => {
        const p = ldProduct();
        let list = [];
        if (p && Array.isArray(p.image)) list = p.image.slice();
        else if (p && p.image) list = [p.image];
        if (!list.length) {
            list = [].slice.call(document.querySelectorAll(
                '[class*=carousel i] img, [class*=gallery i] img'))
                .map((i) => i.currentSrc || i.src)
                .filter((u) => /cb\.scene7\.com/i.test(S(u)));
        }
        const seen = {};
        const out = [];
        list.forEach((raw) => {
            const base = S(raw).split('?')[0].replace(/\/\$[^/]*\$\/.*$/, '');
            if (!base || !/cb\.scene7\.com/i.test(base) || seen[base]) return;
            seen[base] = 1;
            out.push(base + '?wid=2000&qlt=90');
        });
        return out;
    };

    const cbExtra = () => {
        const p = ldProduct();
        if (!p) return null;                        // JSON-LD chưa có -> poll tiếp
        // Giá gạch: meta chuẩn của trang, rơi về .regPrice trong khối giá chính
        const std = parsePrice(meta('og:price:standard_amount'));
        const reg = std || cbMainPrice('.regPrice');
        const sale = parsePrice(meta('og:price:amount')) || cbMainPrice('.salePrice') || ldPrice();
        const listPrice = reg && sale && reg.value > sale.value ? reg.value : null;
        log('crateandbarrel: giá ' + (sale ? sale.value : '?')
            + (listPrice ? ' (gạch ' + listPrice + ')' : '') + ', ' + cbImages().length + ' ảnh');
        return {
            list_price: listPrice,
            in_stock: ldStock(),
            details: cbDimensions(),
        };
    };

    // ================= LANDS' END =================
    // ============================================================
    // LANDS' END — Angular SSR, 1 link chung cho MỌI màu (giống Duluth)
    // ============================================================
    // Toàn bộ sản phẩm nằm sẵn trong <script id="app-root-state" type="application/json">
    // (Angular TransferState) dưới khoá "/le-api/pub/product-lookup/product?productId=<id>"
    // -> productDetail.skus[]: MỖI SKU 1 dòng (màu × Size Range/Cup size × size) có
    // colorCode, color.values[0] {number, label}, attributeTypes[] (trục giữa), size.values[0],
    // price {currentPrice, originalPrice, promotionalPrice}, inventoryStatus, images[].
    // productCopies[] (theo styleNumber) có featureBullets / fitBullets / fabricBullets /
    // subHeader / overview = 3 ngăn kéo Product Details / Fit & Size / Fabric & Care.
    // BẪY 1: JSON-LD không có; og:image chỉ 1 ảnh 500px -> tầng chung ra "1 ảnh, không giá,
    //   không mô tả". Ảnh scene7 gốc 2000x2000: thêm ?wid=2000&hei=2000.
    // BẪY 2: ?attributes=6749,43321,... là DÃY SỐ giá trị đã chọn (màu = color.values[0].number,
    //   Regular/Petite = attributeTypes[].values[0].number) — không phải mã màu MV9.
    //   crawler.canonical_url() đang BỎ tham số này -> phải thêm 'attributes' vào KEEP_PARAMS.
    // BẪY 3: SKU hết hàng KHÔNG có trong mảng skus (chỉ thấy A = còn, B/F = backorder có
    //   backorderDate, trang vẫn cho chọn và ghi "Size Backorder") -> size hết = dải size
    //   của trục giữa đó (gộp mọi màu) trừ size còn của màu.
    // BẪY 4: giá 3 tầng: originalPrice (gạch) / currentPrice (đang bán, đã gồm sale) /
    //   promotionalPrice = giá SAU KHI NHẬP MÃ ("$22.78 with code: FALLWEATHER"). Chữ "with
    //   code" render TRỄ -> đọc sớm tưởng promo tự áp. Luôn lấy currentPrice, promo báo kèm.
    // BẪY 5: ngăn kéo mô tả chỉ render khi bấm (mousedown) -> không đọc DOM, đọc JSON.
    let _leProduct;
    const leProductId = () => {
        const m = S(location.pathname).match(/\/id_(\d+)/) || S(opts.url).match(/\/id_(\d+)/);
        return m ? m[1] : '';
    };
    const leProduct = () => {
        if (_leProduct) return _leProduct;
        let p = null;
        try {
            const el = document.getElementById('app-root-state');
            let txt = el ? S(el.textContent) : '';
            if (txt) {
                let st;
                try { st = JSON.parse(txt); } catch (e) { st = JSON.parse(txt.replace(/&q;/g, '"')); }
                const id = leProductId();
                const keys = Object.keys(st || {}).filter((k) => k.indexOf('product-lookup/product') >= 0);
                const k = keys.filter((x) => id && x.indexOf('productId=' + id) >= 0)[0] || keys[0];
                p = k && st[k] ? st[k].productDetail : null;
            }
        } catch (e) {
            log('landsend: không đọc được app-root-state — ' + S(e.message || e));
        }
        if (!p) { try { p = window.__scLandsEnd || null; } catch (e) { p = null; } }
        if (p && p.skus && p.skus.length) { _leProduct = p; return p; }
        return null;
    };
    // Trang chưa có state (điều hướng phía client) -> gọi đúng API trang dùng, cùng origin
    const lePrefetch = async () => {
        if (leProduct()) return;
        const id = leProductId();
        if (!id) return;
        const r = await fetch('/le-api/pub/product-lookup/product?productId=' + id, { credentials: 'include' });
        if (!r.ok) { log('landsend: API HTTP ' + r.status); return; }
        const j = await r.json();
        if (j && j.productDetail) {
            try { window.__scLandsEnd = j.productDetail; } catch (e) { /* ignore */ }
            log('landsend: lấy productDetail qua API');
        }
    };
    const leColorOf = (s) => ((s.color && s.color.values) || [])[0] || {};
    const leSizeOf = (s) => ((s.size && s.size.values) || [])[0] || null;
    const leAxes = (s) => (s.attributeTypes || []).filter((a) => a.isDifferentiator !== false && a.values && a.values[0]);
    const leAttrParam = () => {
        const get = (u) => { try { return S(new URL(u, location.href).searchParams.get('attributes')); } catch (e) { return ''; } };
        const raw = get(location.href) || get(opts.url);
        return raw.split(',').map((x) => x.trim()).filter(Boolean);
    };
    let _leModel;
    const leModel = () => {
        if (_leModel) return _leModel;
        const p = leProduct();
        if (!p) return null;
        const skus = p.skus.filter((s) => !s.isSuppressed);
        const hasSize = skus.some((s) => leSizeOf(s));
        // Trục giữa: mọi thuộc tính phân biệt (Size Range, Cup size...). Sản phẩm KHÔNG có
        // size (túi: Item Size / Handle Length / Bag Style) -> các thuộc tính đó chính là "size".
        const axisLabels = [];
        skus.forEach((s) => leAxes(s).forEach((a) => {
            if (axisLabels.indexOf(S(a.label)) < 0) axisLabels.push(S(a.label));
        }));
        const vals = {};           // label giá trị -> sequence (để xếp)
        const axisVal = (s) => {
            const m = {};
            leAxes(s).forEach((a) => {
                m[S(a.label)] = a.values[0];
                vals[S(a.values[0].label)] = a.values[0].sequenceNumber || 0;
            });
            return axisLabels.map((l) => m[l]).filter(Boolean);
        };
        const sizeSeq = {};
        const colors = [];                 // [{name, code, number}]
        const rows = skus.map((s) => {
            const c = leColorOf(s);
            const av = axisVal(s);
            const sz = leSizeOf(s);
            let size, variant;
            if (hasSize) {
                size = sz ? S(sz.label).trim() : '';
                variant = av.map((v) => S(v.label).trim()).join(' / ');
                if (sz) sizeSeq[size] = sz.sequenceNumber || 0;
            } else {
                size = av.map((v) => S(v.label).trim()).join(' / ');
                variant = '';
                sizeSeq[size] = av.reduce((t, v) => t * 100 + (v.sequenceNumber || 0), 0);
            }
            const name = S(c.label).trim() || S(s.colorCode);
            if (!colors.some((x) => x.name === name)) colors.push({ name: name, code: S(s.colorCode), number: S(c.number) });
            return { s: s, color: name, variant: variant, size: size, avNums: av.map((v) => S(v.number)),
                     ok: /^[ABF]$/.test(S(s.inventoryStatus).toUpperCase()) };
        });
        const vseq = (v) => S(v).split(' / ').reduce((t, x) => t * 100 + (vals[x] || 0), 0);
        const variants = [];
        rows.forEach((r) => { if (variants.indexOf(r.variant) < 0) variants.push(r.variant); });
        variants.sort((a, b) => vseq(a) - vseq(b));
        const sizeCmp = (a, b) => (sizeSeq[a] - sizeSeq[b]) || S(a).localeCompare(S(b));
        // Dải size của mỗi trục giữa = gộp mọi màu (Tall không có 2/4 thì không tính là hết)
        const sizesOf = (variant) => {
            const out = [];
            rows.forEach((r) => { if (r.variant === variant && r.size && out.indexOf(r.size) < 0) out.push(r.size); });
            return out.sort(sizeCmp);
        };
        // Màu + trục giữa đang xem: ?attributes= (trình duyệt, rồi link đã dán) -> ô đang chọn trên trang -> đầu danh sách
        const want = leAttrParam();
        let cur = colors.filter((c) => want.indexOf(c.number) >= 0)[0];
        let from = '?attributes=';
        if (!cur) {
            const dom = S(selText('product-colors .attribute-value'));
            cur = colors.filter((c) => c.name.toLowerCase() === dom.toLowerCase())[0];
            from = 'ô màu đang chọn';
        }
        if (!cur) {
            const sel = document.querySelector('product-colors .selector.selected[digital-data-selection]');
            const code = sel ? S(sel.getAttribute('digital-data-selection')) : '';
            cur = colors.filter((c) => c.code === code)[0];
        }
        if (!cur) { cur = colors[0]; from = 'màu đầu danh sách'; }
        const vOfColor = variants.filter((v) => rows.some((r) => r.color === cur.name && r.variant === v));
        let curVariant = '';
        const domSel = [].slice.call(document.querySelectorAll('product-differentiators li.selected[digital-data-selection]'))
            .map((li) => S(li.getAttribute('digital-data-selection')));
        if (variants.length > 1 || variants[0]) {
            const pick = (nums) => vOfColor.filter((v) => rows.some((r) => r.variant === v
                && r.avNums.length && r.avNums.every((n) => nums.indexOf(n) >= 0)))[0];
            curVariant = pick(want) || pick(domSel) || vOfColor[0] || variants[0] || '';
        }
        // Dòng SKU đại diện cho lựa chọn đang xem (tiêu đề / Item # / giá / ảnh). Sản phẩm
        // không có size (túi): mỗi tổ hợp Item Size/Handle/Bag Style là 1 style riêng (tiêu đề,
        // ảnh, giá khác nhau) -> chọn theo ?attributes= / ô đang chọn, không thì style đầu.
        const curRows = rows.filter((r) => r.color === cur.name && r.variant === curVariant);
        const byNums = (nums) => curRows.filter((r) => r.avNums.length && r.avNums.every((n) => nums.indexOf(n) >= 0))[0];
        const curRow = (!hasSize && (byNums(want) || byNums(domSel)))
            || curRows.filter((r) => r.ok)[0] || curRows[0] || rows[0];
        const curStyle = hasSize ? '' : S(curRow && curRow.size);
        log('landsend: màu đang xem = ' + cur.name + ' [' + cur.code + '] (' + from + '), trục giữa = '
            + (curVariant || '-') + (curStyle ? ', kiểu = ' + curStyle : ''));
        _leModel = { p: p, rows: rows, colors: colors, variants: variants, sizesOf: sizesOf,
                     cur: cur, curVariant: curVariant, curRow: curRow, curStyle: curStyle, hasSize: hasSize,
                     axisLabels: axisLabels, sizeLabel: hasSize ? (S(skus.map((s) => s.size && s.size.label).filter(Boolean)[0]) || 'Size') : axisLabels.join(' / ') };
        return _leModel;
    };
    const leRowsOf = (color, variant) => {
        const m = leModel();
        return m ? m.rows.filter((r) => r.color === color && (variant == null || r.variant === variant)) : [];
    };
    // Mã khuyến mãi đang hiện cạnh giá ("with code: FALLWEATHER") — render trễ, có thể rỗng
    const lePromoCode = () => {
        const t = [].slice.call(document.querySelectorAll('product-price .promo-description'))
            .map((e) => S(e.textContent)).join(' ');
        const m = t.match(/with\s+code:?\s*([A-Z0-9_-]+)/i);
        return m ? m[1] : '';
    };
    // Giá đang bán = currentPrice (đã gồm sale). promotionalPrice là giá SAU KHI NHẬP MÃ
    // (trang ghi "with code: XXX", chữ này render trễ) -> không lấy làm giá, chỉ báo kèm.
    const lePriceOf = (rows) => {
        const r = rows.filter((x) => x.ok)[0] || rows[0];
        const pr = r && r.s.price;
        if (!pr) return null;
        const price = Number(pr.currentPrice || pr.originalPrice || 0);
        const orig = Number(pr.originalPrice || 0);
        const promo = Number(pr.promotionalPrice || 0);
        return { price: price || null, list_price: orig > price ? orig : null,
                 promo_price: promo > 0 && promo < price ? promo : null };
    };
    const leCurPrice = () => {
        const m = leModel();
        if (!m) return null;
        return lePriceOf([m.curRow]);
    };
    const leImgUrl = (u) => {
        u = S(u).trim().split('?')[0];
        if (!u) return '';
        if (u.indexOf('//') === 0) u = 'https:' + u;
        else if (!/^https?:/i.test(u)) u = 'https://' + u;
        return u + '?wid=2000&hei=2000';
    };
    // Gallery 1 màu = ảnh của SKU cùng trục giữa đang xem (Regular/Petite/Plus chụp người mẫu
    // khác nhau; túi: cùng kiểu Item Size/Bag Style). Bỏ ô SWATCH_.
    // BẪY 6: images[] của 1 SKU kèm cả ảnh chụp MÀU KHÁC (isAuthoredInSelectedColor=false, VD
    //   màu 51E kèm 511556_LEPP_Z8_DQ7) -> chỉ lấy ảnh authored=true.
    // BẪY 7: có màu × trục giữa chỉ có 1 ảnh riêng (Supima tee Plus/Baltic Teal) -> lấy thêm
    //   ảnh cùng màu của trục giữa khác, nếu không crawler thấy <2 ảnh sẽ poll đủ 6 lần (~13s).
    const leCollect = (rows) => {
        const own = [];
        const any = [];
        rows.forEach((r) => (r.s.images || []).forEach((im) => {
            const raw = S(im && im.imageUrl);
            if (!raw || /\/SWATCH_/i.test(raw)) return;
            const u = leImgUrl(raw);
            if (any.indexOf(u) < 0) any.push(u);
            if (im.isAuthoredInSelectedColor !== false && own.indexOf(u) < 0) own.push(u);
        }));
        return own.length ? own : any;
    };
    // wide=true: gộp ảnh mọi trục giữa của màu đó (cột "Ảnh của toàn bộ variant")
    const leColorImages = (color, wide) => {
        const m = leModel();
        if (!m) return [];
        const rows = leRowsOf(color);
        let first;
        if (m.hasSize) first = rows.filter((r) => r.variant === m.curVariant);
        else {
            first = rows.filter((r) => r.size === m.curStyle);
            if (!first.length && rows.length) first = rows.filter((r) => r.size === rows[0].size);
        }
        let out = leCollect(first);
        if (m.hasSize && (wide || out.length < 2)) {
            leCollect(first.concat(rows)).forEach((u) => { if (out.indexOf(u) < 0) out.push(u); });
        }
        return out;
    };
    const leImages = () => {
        const m = leModel();
        return m ? leColorImages(m.cur.name, false) : [];
    };
    const leAllImages = () => {
        const m = leModel();
        if (!m) return [];
        const out = [];
        m.colors.forEach((c) => leColorImages(c.name, true).forEach((u) => { if (out.indexOf(u) < 0) out.push(u); }));
        return out;
    };
    // Ảnh nào của màu nào: ảnh chỉ xuất hiện ở ĐÚNG 1 màu mới gán (ảnh dùng chung thì bỏ)
    const leImageColors = () => {
        const m = leModel();
        if (!m) return {};
        const owner = {};
        m.colors.forEach((c) => leColorImages(c.name, true).forEach((u) => {
            owner[u] = (u in owner && owner[u] !== c.name) ? '' : c.name;
        }));
        const map = {};
        Object.keys(owner).forEach((u) => { if (owner[u]) map[u] = owner[u]; });
        return map;
    };
    const leCopy = () => {
        const m = leModel();
        if (!m) return null;
        const r = m.curRow;
        const copies = m.p.productCopies || [];
        return { copy: copies.filter((c) => S(c.number) === S(r && r.s.styleNumber))[0] || copies[0] || null, row: r };
    };
    const leTitle = () => {
        const c = leCopy();
        if (c && c.copy && c.copy.description) return decodeHtml(c.copy.description);
        return selText('h1');
    };
    const leDescSections = () => {
        const c = leCopy();
        const cp = c && c.copy;
        if (!cp) return [];
        const li = (arr) => (arr || []).map((x) => S(x).trim())
            .filter((x) => x && !/^new colou?rs?( added)?!?$/i.test(stripHtml(x))).map((x) => '<li>' + x + '</li>');
        const secs = [];
        const det = li(cp.featureBullets).concat(li(cp.calloutBullets));
        const item = S(c.row && (c.row.s.styleItemNumber || c.row.s.styleNumber)).trim();
        if (item) det.push('<li>Item #' + item + '</li>');
        let html = det.length ? '<ul>' + det.join('') + '</ul>' : '';
        if (S(cp.subHeader).trim()) html += '<p><strong>' + S(cp.subHeader).trim() + '</strong></p>';
        if (S(cp.overview).trim()) html += '<p>' + S(cp.overview).trim() + '</p>';
        if (html) secs.push({ title: 'Product Details', kind: 'description', html: html });
        const fit = li(cp.fitBullets);
        if (fit.length) secs.push({ title: 'Fit & Size', kind: 'size_fit', html: '<ul>' + fit.join('') + '</ul>' });
        const fab = li(cp.fabricBullets);
        if (fab.length) secs.push({ title: 'Fabric & Care', kind: 'fit_care', html: '<ul>' + fab.join('') + '</ul>' });
        return secs;
    };
    const leDescription = () => leDescSections().map((s) => s.title + '\n' + htmlToText(s.html)).join('\n\n');
    const leExtra = () => {
        const m = leModel();
        if (!m) return null;
        const matrix = [];
        m.colors.forEach((c) => m.variants.forEach((v) => {
            const rows = leRowsOf(c.name, v);
            if (!rows.length) return;          // màu không may trục này (hoặc hết sạch)
            const all = m.sizesOf(v);
            const ok = {};
            rows.forEach((r) => { if (r.ok) ok[r.size] = 1; });
            matrix.push({ color: c.name, variant: v,
                          sizes_in_stock: all.filter((s) => ok[s]), sizes_out_of_stock: all.filter((s) => !ok[s]) });
        }));
        const here = matrix.filter((r) => r.color === m.cur.name && r.variant === m.curVariant)[0]
            || { sizes_in_stock: [], sizes_out_of_stock: m.sizesOf(m.curVariant) };
        const sizes = m.sizesOf(m.curVariant).filter((s) => s);
        const colorCodes = {};
        const colorPrices = {};
        m.colors.forEach((c) => {
            colorCodes[c.name] = c.code;
            // Giá theo màu ở CÙNG trục giữa / kiểu đang xem (túi: mỗi kiểu 1 giá)
            const all = leRowsOf(c.name);
            const same = all.filter((r) => (m.hasSize ? r.variant === m.curVariant : r.size === m.curStyle));
            const pr = lePriceOf(same.length ? same : all);
            if (pr) colorPrices[c.name] = { price: pr.price, list_price: pr.list_price };
        });
        const pr = leCurPrice();
        const curRows = leRowsOf(m.cur.name, m.curVariant);
        const all = leAllImages();
        log('landsend: ' + m.colors.length + ' màu, ' + m.variants.length + ' trục giữa, '
            + matrix.length + ' dòng ma trận, ' + all.length + ' ảnh mọi màu');
        log('landsend: color_codes=' + JSON.stringify(colorCodes));
        log('landsend: color_prices=' + JSON.stringify(colorPrices));
        return {
            current_color: m.cur.name,
            colors: m.colors.map((c) => c.name),
            color_label: 'Color',
            variant_label: m.hasSize ? m.axisLabels.join(' / ') : '',
            current_variant: m.curVariant,
            size_label: m.sizeLabel,
            sizes: sizes,
            sizes_in_stock: here.sizes_in_stock,
            sizes_out_of_stock: here.sizes_out_of_stock,
            stock_matrix: matrix,
            in_stock: m.hasSize ? curRows.some((r) => r.ok) : !!(m.curRow && m.curRow.ok),
            list_price: pr ? pr.list_price : null,
            all_images: all,
            image_colors: leImageColors(),
            size_guide_button: sizes.length ? 'a.size-chart-link' : '',
            // sizeChartUrl (/_size_charts/core_12_...) mở ra trang 404 -> KHÔNG khai size_guide_url,
            // nếu không crawler sẽ chụp nhầm trang "Oops" khi bấm nút chưa kịp mở ngăn kéo.
            color_codes: colorCodes,
            color_prices: colorPrices,
            promo_price: pr ? pr.promo_price : null,
            promo_code: lePromoCode() || null,
        };
    };

    // ================= TOMMY BAHAMA =================
    // ============================================================
    // TOMMY BAHAMA (SAP Hybris + trang PDP tự dựng bằng Handlebars "tbr-pdp") — kiểm 2026-09-24
    // ============================================================
    // 1 LINK CHUNG MỌI MÀU: /p/<style>-<mã màu> (VD SS200417-22754). Trang dựng lại toàn bộ
    // PDP bằng JS (template <script id="tbr-pdp--template">) nên HTML gốc KHÔNG có giá/size.
    // Nguồn dữ liệu chắc nhất: API cùng origin mà chính trang gọi
    //   GET /en/p/<style>/detailSummary/getProductFeedEom.json?currency=USD&ts=<7 số đầu Date.now()>
    //   -> [{productCode, colorName, price "$69.65", listPrice "99.50", salePrice "69.65"|null,
    //        isFinal, scene7Url (ảnh _main), altImageUrls[], sizeChartUrl,
    //        sizes:[{desc, availability (số lượng), productSKUCode}]}]  — MỌI màu 1 lần gọi.
    // BẪY 1: JSON-LD là ProductGroup chỉ của MÀU ĐANG XEM (variesBy size) -> ldPrice của tầng
    //   chung không đọc được (không có offers ở gốc) => "Không lấy được giá" trước đây.
    // BẪY 2: /getSwatchInfo.json (pdp.ajaxGetSwatchInfoJSON) trả availableQty=8 giả cho mọi
    //   size -> KHÔNG dùng để xét tồn kho; dùng availability của feed (0 = hết).
    // BẪY 3: màu mà mọi size availability=0 thì trang ẨN ô màu (VD White của SS200417) -> không
    //   tính vào "Màu tổng", chỉ cảnh báo.
    // BẪY 4: giá khác nhau theo màu (Citrus Coral sale $69.65, màu khác $99.50) -> giá/giá gạch
    //   lấy theo đúng màu đang xem; trả thêm color_prices.
    // Ảnh scene7: bỏ preset ($v26_pdp_alt_desktop$ = 800x1000), thêm ?scl=1 = ảnh gốc (2400x3000).
    const tbStyle = () => {
        const d = document.querySelector('[tbr-pdp--data="styleCode"]');
        let s = d ? S(d.textContent).trim() : '';
        try { if (!s && window.productDataBootstrap) s = S(window.productDataBootstrap.baseStyleCode).trim(); } catch (e) { /* bỏ */ }
        if (!s) {
            const m = location.pathname.match(/\/p\/([A-Za-z0-9]+)/);
            s = m ? m[1] : '';
        }
        return s;
    };
    const tbFeedStore = () => {
        try { return window.__scTbFeed || (window.__scTbFeed = {}); } catch (e) { return {}; }
    };
    const tbFeed = () => {
        const f = tbFeedStore()[tbStyle()];
        return Array.isArray(f) && f.length ? f : null;
    };
    const tbPrefetch = async () => {
        const style = tbStyle();
        if (!style || tbFeed()) return;
        const ts = Date.now().toString().substring(0, 7);
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 8000);
        try {
            const r = await fetch('/en/p/' + encodeURIComponent(style)
                + '/detailSummary/getProductFeedEom.json?currency=USD&ts=' + ts,
                { credentials: 'include', signal: ctl ? ctl.signal : undefined });
            if (r.ok) {
                const j = await r.json();
                if (Array.isArray(j) && j.length) tbFeedStore()[style] = j;
                log('tb: feed ' + style + ' -> ' + (Array.isArray(j) ? j.length : 0) + ' màu');
            } else {
                log('tb: feed HTTP ' + r.status);
            }
        } catch (e) {
            log('tb: không gọi được feed — ' + S(e.message || e));
        }
        clearTimeout(timer);
    };
    const tbNum = (v) => {
        const n = parseFloat(S(v).replace(/[^0-9.]/g, ''));
        return isFinite(n) && n > 0 ? n : null;
    };
    // Mã màu đang xem = đoạn /p/<style>-<màu> trên link; không có thì ô màu đang chọn
    const tbCurrentCode = () => {
        const codes = [];
        const feed = tbFeed();
        if (feed) feed.forEach((c) => codes.push(S(c.productCode)));
        [].slice.call(document.querySelectorAll('[tbr-pdp--select-color]')).forEach((b) => {
            codes.push(S(b.getAttribute('tbr-pdp--select-color')));
        });
        const known = (c) => c && codes.indexOf(c) >= 0;
        for (const u of [location.href, opts.url]) {
            const m = S(u).match(/\/p\/([A-Za-z0-9]+-[A-Za-z0-9]+)/);
            if (m && known(m[1].toUpperCase())) return m[1].toUpperCase();
            if (m && known(m[1])) return m[1];
        }
        const sel = document.querySelector('[tbr-pdp--select-color][aria-checked="true"]');
        if (sel) return S(sel.getAttribute('tbr-pdp--select-color'));
        try {
            const b = window.productDataBootstrap;
            if (b && b.selectedSwatchCode) return S(b.baseStyleCode) + '-' + S(b.selectedSwatchCode);
        } catch (e) { /* bỏ */ }
        return codes[0] || '';
    };
    const tbBig = (u) => {
        u = S(u).trim();
        if (!u) return '';
        if (u.indexOf('//') === 0) u = 'https:' + u;
        else if (!/^https?:/i.test(u)) u = 'https://' + u;
        return u.split('?')[0] + '?scl=1';
    };
    const tbColorImages = (c) => {
        if (!c) return [];
        const out = [];
        [c.scene7Url].concat(c.altImageUrls || []).forEach((u) => {
            if (!u || /_video|_thumb/i.test(S(u))) return;
            const b = tbBig(u);
            if (b && out.indexOf(b) < 0) out.push(b);
        });
        return out;
    };
    const tbFeedColor = (code) => (tbFeed() || []).filter((c) => S(c.productCode) === code)[0] || null;
    const tbTitle = () => {
        const h = document.querySelector('[tbr-pdp--product-name]');
        const t = h ? S(h.textContent).replace(/\s+/g, ' ').trim() : '';
        if (t) return t;
        const p = ldProduct() || jsonLdNodes().find((x) => /ProductGroup/i.test(typeOf(x)));
        return p ? decodeHtml(p.name) : S(meta('og:title')).split(' | ')[0];
    };
    const tbPriceOf = (code) => {
        const c = tbFeedColor(code);
        if (c) {
            const sale = tbNum(c.salePrice);
            const list = tbNum(c.listPrice);
            const cur = sale || tbNum(c.price) || list;
            return cur ? { price: cur, list_price: list && list > cur ? list : null } : null;
        }
        // Dự phòng DOM: <div tbr-pdp--price="<mã>"> regular + discount
        const box = document.querySelector('[tbr-pdp--price="' + code + '"]')
            || document.querySelector('[tbr-pdp--price][active]');
        if (!box) return null;
        const reg = parsePrice(nodeText(box.querySelector('[tbr-pdp--regular-price]')) || S((box.querySelector('[tbr-pdp--regular-price]') || {}).textContent));
        const dis = parsePrice(S((box.querySelector('[tbr-pdp--discount-price]') || {}).textContent));
        const cur = dis || reg;
        if (!cur) return null;
        return { price: cur.value, list_price: dis && reg && reg.value > dis.value ? reg.value : null };
    };
    const tbDescSections = () => [].slice.call(document.querySelectorAll('[tbr-pdp--details-container]')).map((box) => {
        const lab = box.querySelector('[tbr-pdp--details-label]');
        const title = S(lab && (lab.getAttribute('title') || lab.textContent)).replace(/\s+/g, ' ').trim();
        const el = box.querySelector('[tbr-pdp--details-contents]');
        if (!el || !S(el.textContent).trim()) return null;
        const kind = /^description$/i.test(title) ? 'description'
            : (/material|care|fabric/i.test(title) ? 'fit_care' : 'details');
        // Lượt dựng đầu, khối Description còn là HTML bị escape ("<p>..." dạng chữ)
        const raw = S(el.textContent).trim();
        if (!el.querySelector('*:not(div)') && /^<[a-z]/i.test(raw)) return { title: title, kind: kind, html: raw };
        return { title: title, kind: kind, el: el };
    }).filter(Boolean);
    const tbExtra = () => {
        // Trang dựng PDP bằng JS sau khi tải: chưa có khối mô tả / nút Size Chart thì chờ
        // (tối đa 4 lượt poll để không kẹt khi trang đổi bố cục)
        if (!document.querySelector('[tbr-pdp--details-contents]')) {
            let n = 0;
            try { n = window.__scTbWait = (window.__scTbWait || 0) + 1; } catch (e) { n = 99; }
            if (n <= 4) { log('tb: PDP chưa dựng xong — poll tiếp'); return null; }
        }
        const feed = tbFeed();
        const code = tbCurrentCode();
        const rows = [];               // {code, name, sizes:[{s, qty}], images, price}
        if (feed) {
            feed.forEach((c) => rows.push({
                code: S(c.productCode), name: S(c.colorName).trim(),
                sizes: (c.sizes || []).map((z) => ({ s: S(z.desc).trim(), qty: Number(z.availability) || 0 }))
                    .filter((z) => z.s),
                images: tbColorImages(c), final: !!c.isFinal,
            }));
        } else {
            // Dự phòng DOM: ô màu + nút size (size-availability) của từng màu
            [].slice.call(document.querySelectorAll('[tbr-pdp--colors] [tbr-pdp--select-color]')).forEach((b) => {
                const cc = S(b.getAttribute('tbr-pdp--select-color'));
                if (!cc || rows.some((r) => r.code === cc)) return;
                const sizes = [].slice.call(document.querySelectorAll('[tbr-pdp--sizes="' + cc + '"] [tbr-pdp--size]'))
                    .map((z) => ({ s: S(z.getAttribute('size-value')).trim(),
                                   qty: z.hasAttribute('disabled') ? 0 : (Number(z.getAttribute('size-availability')) || 0) }));
                rows.push({ code: cc, name: S(b.getAttribute('color-name')).trim(), sizes: sizes, images: [], final: false });
            });
            if (!rows.length) { log('tb: chưa có feed lẫn ô màu'); return null; }
            const cur = rows.filter((r) => r.code === code)[0];
            if (cur) cur.images = ldImages().map(tbBig);
        }
        const live = rows.filter((r) => r.code === code || r.sizes.some((z) => z.qty > 0));
        const dead = rows.filter((r) => live.indexOf(r) < 0).map((r) => r.name);
        if (dead.length) warnings.push('Màu hết sạch mọi size (trang ẩn ô màu): ' + dead.join(', '));
        const cur = rows.filter((r) => r.code === code)[0] || live[0] || rows[0];
        const sizes = cur ? cur.sizes.map((z) => z.s) : [];
        const inStock = cur ? cur.sizes.filter((z) => z.qty > 0).map((z) => z.s) : [];
        // Trục Fit (Men's Fit / Big and Tall Fit) — mỗi fit là 1 style/link RIÊNG (BT124524),
        // nên chỉ ghi fit đang xem làm trục giữa, không gộp tồn kho fit khác.
        const fitBtns = [].slice.call(document.querySelectorAll('[tbr-pdp--fits] [tbr-pdp--fit]'));
        const fitName = (b) => S(b.getAttribute('aria-label') || b.textContent).replace(/\s+/g, ' ').trim();
        const fitCur = fitBtns.filter((b) => b.getAttribute('aria-checked') === 'true' || b.hasAttribute('active'))[0];
        const fit = fitCur ? fitName(fitCur) : '';
        const matrix = live.map((r) => ({
            color: r.name, variant: fit,
            sizes_in_stock: r.sizes.filter((z) => z.qty > 0).map((z) => z.s),
            sizes_out_of_stock: r.sizes.filter((z) => z.qty <= 0).map((z) => z.s),
        }));
        const allImages = [];
        const imgColors = {};
        const colorCodes = {};
        const colorPrices = {};
        (cur ? [cur] : []).concat(live.filter((r) => r !== cur)).forEach((r) => {
            colorCodes[r.name] = r.code;
            const p = tbPriceOf(r.code);
            if (p) colorPrices[r.name] = p;
            r.images.forEach((u) => {
                if (allImages.indexOf(u) < 0) { allImages.push(u); imgColors[u] = r.name; }
            });
        });
        const cp = cur ? tbPriceOf(cur.code) : null;
        if (cur && cur.final) warnings.push('Màu ' + cur.name + ' là Final Sale (không đổi trả)');
        const chartBtn = document.querySelector('[tbr-pdp--size-chart]');
        const chartData = document.querySelector('[tbr-pdp--data="sizeChartUrl"]');
        const fc = cur ? tbFeedColor(cur.code) : null;
        const chartUrl = S((fc && fc.sizeChartUrl) || (chartBtn && chartBtn.getAttribute('tbr-pdp--size-chart'))
            || (chartData && chartData.textContent)).trim();
        log('tb: màu ' + (cur ? cur.name + ' (' + cur.code + ')' : '?') + ', ' + live.length + ' màu còn bán, '
            + sizes.length + ' size (' + inStock.length + ' còn), giá ' + (cp ? cp.price + '/' + cp.list_price : '?')
            + ', ' + allImages.length + ' ảnh mọi màu | color_codes=' + JSON.stringify(colorCodes)
            + ' | color_prices=' + JSON.stringify(colorPrices));
        return {
            current_color: cur ? cur.name : '',
            color_label: 'Color',
            colors: live.map((r) => r.name),
            variant_label: fit ? 'Fit' : '',
            current_variant: fit,
            variants: fitBtns.map((b) => 'Fit:' + fitName(b)),
            size_label: sizes.length ? 'Size' : '',
            sizes: sizes,
            sizes_in_stock: inStock,
            sizes_out_of_stock: sizes.filter((s) => inStock.indexOf(s) < 0),
            stock_matrix: matrix,
            in_stock: sizes.length ? inStock.length > 0 : null,
            list_price: cp ? cp.list_price : null,
            all_images: allImages.length ? allImages : null,
            image_colors: Object.keys(imgColors).length ? imgColors : null,
            color_codes: colorCodes,
            color_prices: colorPrices,
            size_guide_url: chartUrl,
            size_guide_button: chartBtn ? '[tbr-pdp--size-chart]' : '',
        };
    };

    // ================= EILEEN FISHER =================
    // ============================================================
    // EILEEN FISHER (Salesforce Commerce SFRA) — kiểm 2026-09-24
    // ============================================================
    // 1 trang chung mọi màu: /<slug>/<PID>.html?dwvar_<PID>_color=<mã 3 số> (204 = HAZELWOOD).
    // Đổi màu chỉ đổi tham số dwvar -> coi như chung link (giống Talbots), lấy đủ mọi màu.
    // Nguồn: API SFRA cùng origin mà trang gọi khi bấm ô màu
    //   GET /on/demandware.store/Sites-ef-Site/en_US/Product-Variation?pid=<PID>&dwvar_<PID>_color=<mã>
    //   -> product {price.sales/list, variationAttributes[color|size].values[{displayValue,value,
    //      selectable}], images.pdpZoomDesktop[] (1680x2240 — cỡ LỚN NHẤT server cho phép)}
    //   Gọi song song 1 lần/màu trong prefetch (~5 màu ≈ 0.5s), nhớ trên window.
    // BẪY 1: JSON-LD brand = "EF" (không phải tên hãng) -> khai brand cứng 'Eileen Fisher'.
    // BẪY 2: ảnh dw/image chỉ nhận đúng các bộ sw/sh site dùng (sw=1680&sh=2240, 525x700...);
    //   sw=2000 / sw=3000 / ảnh gốc demandware.static đều 404 -> giữ nguyên URL pdpZoomDesktop.
    // BẪY 3: mã size trong JSON là XSML/SML/MED/LRG, chữ hiện trên trang là XS/S/M/L -> dùng
    //   displayValue. Size Petite (PP/PS/PM/PL) chung 1 dãy, màu không có petite thì selectable=false.
    // BẪY 4: link Size Chart (Product-SizeChart?cid=...) trả JSON chứ không phải trang -> chỉ
    //   khai nút bấm; 2 ảnh "The Fit" / "Measurement Guide" trong hộp size chart -> fit_guide_images.
    // Mô tả = đoạn giới thiệu (.r-copy, có "Style No.") + khối Design + khối Fabric.
    const efPid = () => {
        const m = location.pathname.match(/\/([A-Z0-9]+-[A-Z0-9]+)\.html/i);
        if (m) return m[1];
        const el = document.querySelector('.product-detail[data-pid], [data-pid]');
        return el ? S(el.getAttribute('data-pid')) : '';
    };
    const efStore = () => {
        try { return window.__scEfVar || (window.__scEfVar = {}); } catch (e) { return {}; }
    };
    const efSwatches = () => [].slice.call(document.querySelectorAll('button.color-attribute[data-attr-value]'));
    const efTitleCase = (s) => S(s).toLowerCase().replace(/(^|[\s\-/&])([a-z])/g, (m, a, b) => a + b.toUpperCase()).trim();
    const efPrefetch = async () => {
        const pid = efPid();
        if (!pid) return;
        const store = efStore()[pid] = efStore()[pid] || {};
        const codes = efSwatches().map((b) => S(b.getAttribute('data-attr-value'))).filter(Boolean);
        const url = currentColorFromUrl();
        if (url && codes.indexOf(url) < 0) codes.unshift(url);
        const todo = codes.filter((c, i) => codes.indexOf(c) === i && !store[c]);
        if (!todo.length) return;
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 8000);
        await Promise.all(todo.map((c) => fetch('/on/demandware.store/Sites-ef-Site/en_US/Product-Variation?pid='
                + encodeURIComponent(pid) + '&dwvar_' + encodeURIComponent(pid) + '_color=' + encodeURIComponent(c)
                + '&quantity=1', { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' },
                                   signal: ctl ? ctl.signal : undefined })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (j && j.product) store[c] = j.product; })
            .catch(() => {})));
        clearTimeout(timer);
        log('ef: Product-Variation ' + Object.keys(store).length + '/' + codes.length + ' màu');
    };
    const efVar = (code) => (efStore()[efPid()] || {})[code] || null;
    const efAttr = (p, id) => ((p && p.variationAttributes) || []).filter((a) => a.id === id)[0] || null;
    // Mã màu đang xem: dwvar trên link -> ô màu .selected -> màu đầu
    const efCurrentCode = () => {
        const codes = efSwatches().map((b) => S(b.getAttribute('data-attr-value')));
        const u = currentColorFromUrl();
        if (u && (codes.indexOf(u) >= 0 || efVar(u))) return u;
        const sel = efSwatches().filter((b) => /\bselected\b/.test(S(b.className)))[0];
        if (sel) return S(sel.getAttribute('data-attr-value'));
        return codes[0] || '';
    };
    const efImages = (p) => {
        const im = (p && p.images) || {};
        const list = im.pdpZoomDesktop || im.large || im.pdpMainDesktop || [];
        return list.filter((x) => x && x.url && !x.noImage).map((x) => abs(x.url));
    };
    const efPriceOf = (p) => {
        const pr = p && p.price;
        if (!pr) return null;
        const pick = (o) => (o && o.value != null && isFinite(Number(o.value)) ? Number(o.value) : null);
        // Giá khoảng (range) -> lấy mức thấp
        const sales = pick(pr.sales) || (pr.min ? pick(pr.min.sales) : null);
        const list = pick(pr.list) || (pr.min ? pick(pr.min.list) : null);
        if (!sales) return null;
        return { price: sales, list_price: list && list > sales ? list : null };
    };
    const efDomPrice = () => {
        const box = document.querySelector('.product-detail .prices .price, .prices .price');
        if (!box) return null;
        const v = (sel) => {
            const el = box.querySelector(sel);
            return el ? parsePrice(el.getAttribute('content') || el.textContent) : null;
        };
        const sales = v('.sales .value');
        const list = v('.strike-through .value, del .value');
        if (!sales) return null;
        return { price: sales.value, list_price: list && list.value > sales.value ? list.value : null };
    };
    // Khối mô tả: clone rồi bỏ phần ẩn (dòng "SKU:" d-none) và nút accordion
    const efClean = (el) => {
        if (!el) return null;
        const c = el.cloneNode(true);
        [].slice.call(c.querySelectorAll('.d-none, button, svg, script, style')).forEach((x) => x.remove());
        return S(c.textContent).trim() ? c : null;
    };
    const efDescSections = () => {
        const out = [];
        // .r-copy = chữ trần + <div>Style No. …</div> -> tách thành từng đoạn <p>
        const intro = efClean(document.querySelector('.r-copy'));
        if (intro) {
            const paras = [];
            let buf = '';
            [].slice.call(intro.childNodes).forEach((n) => {
                const block = n.nodeType === 1 && /^(div|p|ul|ol)$/i.test(n.tagName);
                if (block) {
                    if (buf.trim()) paras.push('<p>' + buf.trim() + '</p>');
                    buf = '';
                    paras.push(/^(ul|ol)$/i.test(n.tagName) ? n.outerHTML : '<p>' + n.innerHTML.trim() + '</p>');
                } else {
                    buf += n.nodeType === 1 ? n.outerHTML : escHtml(n.textContent);
                }
            });
            if (buf.trim()) paras.push('<p>' + buf.trim() + '</p>');
            out.push({ title: 'Description', kind: 'description', html: paras.join('') });
        }
        const design = efClean(document.querySelector('#design'));
        if (design) out.push({ title: 'Design', kind: 'details', el: design });
        const fabric = efClean(document.querySelector('#fabric'));
        if (fabric) out.push({ title: 'Fabric', kind: 'fit_care', el: fabric });
        return out;
    };
    const efExtra = () => {
        const pid = efPid();
        const code = efCurrentCode();
        const sw = efSwatches();
        const codes = sw.map((b) => S(b.getAttribute('data-attr-value')));
        if (!codes.length && !efVar(code)) { log('ef: chưa thấy ô màu'); return null; }
        if (code && codes.indexOf(code) < 0) codes.unshift(code);
        const nameOf = {};
        sw.forEach((b) => { nameOf[S(b.getAttribute('data-attr-value'))] = efTitleCase(b.getAttribute('data-display-value')); });
        const rows = codes.map((c) => {
            const p = efVar(c);
            let name = nameOf[c] || '';
            const ca = efAttr(p, 'color');
            const cv = ca && (ca.values || []).filter((v) => S(v.value) === c)[0];
            if (!name && cv) name = efTitleCase(cv.displayValue || cv.value);
            const sa = efAttr(p, 'size');
            const sizes = sa ? (sa.values || []).map((v) => ({ s: S(v.displayValue || v.value).trim(), ok: v.selectable !== false }))
                .filter((z) => z.s) : null;
            return { code: c, name: name || c, p: p, sizes: sizes, images: efImages(p) };
        });
        const cur = rows.filter((r) => r.code === code)[0] || rows[0];
        // Chưa gọi được API cho màu đang xem -> đọc nút size trên trang
        if (cur && !cur.sizes) {
            cur.sizes = [].slice.call(document.querySelectorAll('[data-attr="size"] button[data-attr-value], [data-attr="size"] .size-attribute'))
                .map((b) => ({ s: S(b.getAttribute('data-display-value') || b.textContent).replace(/\s+/g, ' ').trim(),
                               ok: !/unselectable|disabled/i.test(S(b.className)) && !b.disabled }))
                .filter((z) => z.s);
        }
        const live = rows.filter((r) => r === cur || !r.sizes || r.sizes.some((z) => z.ok));
        const dead = rows.filter((r) => live.indexOf(r) < 0).map((r) => r.name);
        if (dead.length) warnings.push('Màu hết sạch mọi size: ' + dead.join(', '));
        const missing = rows.filter((r) => !r.p).map((r) => r.name);
        if (missing.length) warnings.push('Không gọi được dữ liệu màu: ' + missing.join(', '));
        const sizes = cur && cur.sizes ? cur.sizes.map((z) => z.s) : [];
        const inStock = cur && cur.sizes ? cur.sizes.filter((z) => z.ok).map((z) => z.s) : [];
        const matrix = live.filter((r) => r.sizes).map((r) => ({
            color: r.name, variant: '',
            sizes_in_stock: r.sizes.filter((z) => z.ok).map((z) => z.s),
            sizes_out_of_stock: r.sizes.filter((z) => !z.ok).map((z) => z.s),
        }));
        const allImages = [];
        const imgColors = {};
        const colorCodes = {};
        const colorPrices = {};
        (cur ? [cur] : []).concat(live.filter((r) => r !== cur)).forEach((r) => {
            colorCodes[r.name] = r.code;
            const pr = efPriceOf(r.p);
            if (pr) colorPrices[r.name] = pr;
            r.images.forEach((u) => {
                if (allImages.indexOf(u) < 0) { allImages.push(u); imgColors[u] = r.name; }
            });
        });
        const cp = (cur && efPriceOf(cur.p)) || efDomPrice();
        const guide = [].slice.call(document.querySelectorAll('.size-chart--collapsible img'))
            .map((i) => abs(i.getAttribute('src') || i.src)).filter(Boolean);
        log('ef: ' + pid + ' màu ' + (cur ? cur.name + ' (' + cur.code + ')' : '?') + ', ' + live.length
            + ' màu còn bán, ' + sizes.length + ' size (' + inStock.length + ' còn), giá '
            + (cp ? cp.price + '/' + cp.list_price : '?') + ', ' + allImages.length + ' ảnh mọi màu');
        return {
            current_color: cur ? cur.name : '',
            color_label: 'Color',
            colors: live.map((r) => r.name),
            size_label: sizes.length ? 'Size' : '',
            sizes: sizes,
            sizes_in_stock: inStock,
            sizes_out_of_stock: sizes.filter((s) => inStock.indexOf(s) < 0),
            stock_matrix: matrix,
            in_stock: sizes.length ? inStock.length > 0 : null,
            list_price: cp ? cp.list_price : null,
            all_images: allImages.length ? allImages : null,
            image_colors: Object.keys(imgColors).length ? imgColors : null,
            color_codes: colorCodes,
            color_prices: colorPrices,
            fit_guide_images: guide,
            size_guide_button: document.querySelector('.size-chart a') ? '.size-chart a' : '',
        };
    };

    // ================= MACKENZIE-CHILDS =================
    // ============================================================
    // MACKENZIE-CHILDS (Salesforce Commerce SFRA) — kiểm 2026-09-30
    // ============================================================
    // Link /<slug>/<id variant>.html (8922SET1115 = Pretty As A Bow × Set of 3). Trang có 2 trục
    // swatch: matrixPattern (hoa văn = "màu") và matrixSize (Small/Medium/Large/Set of 3), bấm
    // ô chỉ gọi API chứ không đổi trang -> coi như 1 link chung mọi màu, tách mỗi hoa văn 1 dòng.
    // Nguồn: API SFRA cùng origin
    //   GET /on/demandware.store/Sites-MacKenzie-Childs-Site/en_US/Product-Variation?pid=<id>&quantity=1
    //   -> product {id, productName (RIÊNG từng hoa văn: "Strawberry Canisters, Set of 3"),
    //      price.sales/list, available, images['hi-res'][] (width=1000), variationAttributes[]
    //      {id, values[{value, displayValue, selectable, selected, url}]}, shortDescription,
    //      dimensions / materialDescription / careAndUse + pdpAttributes (tên hiển thị)}
    //   values[].url = sẵn link API của hoa văn đó × size đang chọn -> gọi 1 lần/hoa văn.
    // Size còn/hết của 1 hoa văn = values[matrixSize].selectable trong JSON của hoa văn đó
    // (size đang chọn thì xét thêm available). Giá mỗi dòng = giá size của link.
    // Ảnh CDN nhận width tuỳ ý (3000 vẫn ra) -> lấy width=2000.
    // BẪY: khối mô tả trên trang lồng nhau (Materials nằm TRONG Dimensions) -> dựng mô tả
    //   từ JSON, không cắt DOM.
    const mcStore = () => {
        try { return window.__scMcVar || (window.__scMcVar = {}); } catch (e) { return {}; }
    };
    const mcDetail = () => document.querySelector('.product-detail[data-pid]');
    const mcPid = () => {
        const el = mcDetail();
        if (el) return S(el.getAttribute('data-pid'));
        const m = location.pathname.match(/\/([A-Z0-9]+)\.html$/i);
        return m ? m[1] : '';
    };
    const mcApiBase = () => {
        const b = document.querySelector('button[data-url*="/Product-Variation"]');
        const m = b && S(b.getAttribute('data-url')).match(/^(.*\/Product-Variation)\?/);
        return m ? m[1] : '/on/demandware.store/Sites-MacKenzie-Childs-Site/en_US/Product-Variation';
    };
    const mcFetch = (url, signal) => fetch(url, { credentials: 'include', signal: signal,
            headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.product) || null).catch(() => null);
    const mcAxes = (p) => {
        const list = (p && p.variationAttributes) || [];
        const color = list.filter((a) => /pattern|colou?r/i.test(S(a.id)))[0] || null;
        const size = list.filter((a) => a !== color && /size/i.test(S(a.id)))[0] || null;
        return { color: color, size: size };
    };
    const mcSel = (a) => (a && (a.values || []).filter((v) => v.selected)[0]) || null;
    const mcPrefetch = async () => {
        const pid = mcPid();
        if (!pid) return;
        const st = mcStore();
        if (st.pid === pid && st.cur && st.done) return;
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 10000);
        const sig = ctl ? ctl.signal : undefined;
        if (st.pid !== pid || !st.cur) {
            st.pid = pid;
            st.byColor = {};
            st.cur = await mcFetch(mcApiBase() + '?pid=' + encodeURIComponent(pid) + '&quantity=1', sig);
        }
        const cur = st.cur;
        const ax = mcAxes(cur);
        if (cur && ax.color) {
            const curSel = mcSel(ax.color);
            if (curSel) st.byColor[S(curSel.value)] = cur;
            const todo = (ax.color.values || []).filter((v) => v.url && !st.byColor[S(v.value)]);
            await Promise.all(todo.map((v) => mcFetch(v.url, sig).then((p) => { if (p) st.byColor[S(v.value)] = p; })));
        }
        clearTimeout(timer);
        st.done = true;
        log('mc: Product-Variation ' + (cur ? cur.id : 'lỗi') + ', '
            + Object.keys(st.byColor || {}).length + '/' + (ax.color ? (ax.color.values || []).length : 0) + ' hoa văn');
    };
    const mcCur = () => { const st = mcStore(); return st.pid === mcPid() ? st.cur : null; };
    const mcImages = (p) => {
        const im = (p && p.images) || {};
        const list = im['hi-res'] || im.large || [];
        return list.filter((x) => x && x.url).map((x) => abs(S(x.url).replace(/([?&]width=)\d+/, (m, a) => a + '2000')));
    };
    const mcPriceOf = (p) => {
        const pr = p && p.price;
        if (!pr) return null;
        const pick = (o) => (o && o.value != null && isFinite(Number(o.value)) ? Number(o.value) : null);
        const sales = pick(pr.sales) || (pr.min ? pick(pr.min.sales) : null);
        const list = pick(pr.list) || (pr.min ? pick(pr.min.list) : null);
        return sales ? { price: sales, list_price: list && list > sales ? list : null } : null;
    };
    // Size của 1 hoa văn: [{s: 'Set of 3', ok: true}] theo thứ tự site
    const mcSizes = (p) => {
        const a = mcAxes(p).size;
        if (!a) return null;
        return (a.values || []).map((v) => ({ s: S(v.displayValue || v.value).trim(),
            ok: v.selectable !== false && (!v.selected || p.available !== false) })).filter((z) => z.s);
    };
    const mcDescSections = () => {
        const p = mcCur();
        const out = [];
        const intro = p ? S(p.shortDescription).trim() : '';
        const introEl = document.querySelector('.description-and-detail .short-description');
        if (intro) out.push({ title: 'Details', kind: 'description', html: /<[a-z]/i.test(intro) ? intro : '<p>' + escHtml(decodeHtml(intro)) + '</p>' });
        else if (introEl) out.push({ title: 'Details', kind: 'description', el: introEl });
        if (!p) return out;
        const names = {};
        (p.pdpAttributes || []).forEach((a) => { names[S(a.attributeName)] = S(a.displayName); });
        [['dimensions', 'Dimensions', 'details'], ['materialDescription', 'Materials', 'fit_care'],
         ['careAndUse', 'Care and Use', 'fit_care']].forEach((d) => {
            const v = typeof p[d[0]] === 'string' ? p[d[0]].trim() : '';
            if (!v) return;
            out.push({ title: names[d[0]] || d[1], kind: d[2],
                       html: /<[a-z]/i.test(v) ? v : '<p>' + escHtml(decodeHtml(v)).replace(/\r?\n/g, '<br>') + '</p>' });
        });
        return out;
    };
    const mcExtra = () => {
        const cur = mcCur();
        if (!cur) { log('mc: chưa gọi được Product-Variation'); return null; }
        const st = mcStore();
        const ax = mcAxes(cur);
        const curSel = mcSel(ax.color);
        const curName = curSel ? S(curSel.displayValue || curSel.value).trim() : '';
        const rows = ax.color ? (ax.color.values || []).map((v) => {
            const p = (st.byColor || {})[S(v.value)] || null;
            return { code: S(v.value), name: S(v.displayValue || v.value).trim(), p: p, sizes: p ? mcSizes(p) : null };
        }) : [];
        const me = rows.filter((r) => r.name === curName)[0] || null;
        const curSizes = mcSizes(cur) || [];
        const live = rows.filter((r) => r === me || !r.sizes || r.sizes.some((z) => z.ok));
        const dead = rows.filter((r) => live.indexOf(r) < 0).map((r) => r.name);
        if (dead.length) warnings.push('Hoa văn hết sạch mọi size: ' + dead.join(', '));
        const missing = rows.filter((r) => !r.p).map((r) => r.name);
        if (missing.length) warnings.push('Không gọi được dữ liệu hoa văn: ' + missing.join(', '));
        const matrix = live.filter((r) => r.sizes).map((r) => ({
            color: r.name, variant: '',
            sizes_in_stock: r.sizes.filter((z) => z.ok).map((z) => z.s),
            sizes_out_of_stock: r.sizes.filter((z) => !z.ok).map((z) => z.s),
        }));
        const allImages = [], imgColors = {}, codes = {}, prices = {}, titles = {};
        (me ? [me] : []).concat(live.filter((r) => r !== me)).forEach((r) => {
            if (!r.p) return;
            // Mã màu = id variant (8922SET1145): panel thay id này vào link -> link riêng của hoa văn
            codes[r.name] = S(r.p.id);
            titles[r.name] = decodeHtml(S(r.p.productName));
            const pr = mcPriceOf(r.p);
            if (pr) prices[r.name] = pr;
            mcImages(r.p).forEach((u) => { if (allImages.indexOf(u) < 0) { allImages.push(u); imgColors[u] = r.name; } });
        });
        const sizes = curSizes.map((z) => z.s);
        const inStock = curSizes.filter((z) => z.ok).map((z) => z.s);
        const cp = mcPriceOf(cur);
        log('mc: ' + cur.id + ' ' + (curName || '?') + ', ' + live.length + ' hoa văn còn bán, '
            + sizes.length + ' size (' + inStock.length + ' còn), giá ' + (cp ? cp.price : '?'));
        return {
            current_color: curName,
            color_label: ax.color ? S(ax.color.displayName || 'Pattern') : '',
            colors: live.map((r) => r.name),
            size_label: ax.size ? S(ax.size.displayName || 'Size') : '',
            sizes: sizes,
            sizes_in_stock: inStock,
            sizes_out_of_stock: sizes.filter((s) => inStock.indexOf(s) < 0),
            stock_matrix: matrix,
            in_stock: sizes.length ? inStock.length > 0 : cur.available !== false,
            list_price: cp ? cp.list_price : null,
            all_images: allImages.length ? allImages : null,
            image_colors: Object.keys(imgColors).length ? imgColors : null,
            color_codes: codes,
            color_prices: prices,
            color_titles: titles,
        };
    };

    // ================= PERSONAL CREATIONS =================
    // ============================================================
    // PERSONAL CREATIONS (PlanetArt, PHP + jQuery) — kiểm chứng 2026-09-24
    // ============================================================
    // Toàn bộ dữ liệu option nằm trong `var product_options = {...}` (script inline, server
    // render). Hàng cá nhân hoá: KHÔNG có màu/size mà có các trục "Design" / "Options"
    // (VD tất: Design Angel/Santa/... × Options Stocking/Tree Skirt; túi Halloween: Options
    // Bat/Cat/Owl...). 1 link chung cho mọi design; bấm design thì URL thêm ?attr9=16610.
    //   · product_selections[]   các trục {key 'attr9', caption 'Design', select_options[]
    //                            {value_id, label, out_of_stock, is_active}}
    //   · product_designs{}      mỗi tổ hợp 1 SKU: attr_value_mapping {9:'16602',17:'16599'},
    //                            startAtPrice (= giá "Comp. Value" = giá gạch), is_out_of_stock,
    //                            front_sample (ảnh chính của design, bản /thumbs/ 1000px)
    //   · product_design_objects{} description + listed_description (JSON bullet)
    //   · discount               % giảm toàn site (25) -> giá bán = startAtPrice × (1 - d%)
    // Ảnh gallery: .product-thumbnails img[ref] = .../pc_product/thumbs/mips_N_x.jpg (1000px);
    // BỎ "/thumbs/" -> bản gốc 1500px (src "small_mips_" chỉ 160px). Ảnh Scene7
    // (cimages.personalcreations.com/is/image/...) trả 403 khi đổi wid -> giữ nguyên.
    let _pcCache;
    const pcOptions = () => {
        if (_pcCache !== undefined) return _pcCache;
        _pcCache = null;
        try {
            if (window.product_options && window.product_options.product_selections) {
                _pcCache = window.product_options;
                return _pcCache;
            }
        } catch (e) { /* isolated world */ }
        const KEY = 'var product_options = ';
        const sc = [].slice.call(document.scripts).find((s) => S(s.textContent).indexOf(KEY) >= 0);
        if (!sc) return null;
        const txt = S(sc.textContent);
        const i = txt.indexOf(KEY) + KEY.length;
        try { _pcCache = JSON.parse(jsonObjectAt(txt, txt.indexOf('{', i))); } catch (e) {
            log('pc: không parse được product_options — ' + S(e.message || e));
        }
        return _pcCache;
    };
    // Ảnh lớn nhất: bỏ /thumbs/ (1000px -> 1500px); small_mips_ -> mips_
    const pcBig = (u) => S(u).replace(/\/thumbs\/(mips_)/, '/$1').replace(/\/small_(mips_)/, '/$1');
    // Trục "màu" = trục tên Design/Color/Style, không có thì trục nhiều giá trị nhất
    const pcAxes = () => {
        const po = pcOptions();
        const sels = ((po && po.product_selections) || []).filter((s) => (s.select_options || []).length);
        if (!sels.length) return { color: null, other: [] };
        let color = sels.find((s) => /design|colou?r|style|pattern|theme/i.test(S(s.caption)));
        if (!color) color = sels.slice().sort((a, b) => b.select_options.length - a.select_options.length)[0];
        return { color: color, other: sels.filter((s) => s !== color) };
    };
    const pcAttrId = (sel) => S(sel && sel.key).replace(/^attr/, '');
    const pcLabel = (sel, vid) => {
        const o = ((sel && sel.select_options) || []).find((x) => S(x.value_id) === S(vid));
        return o ? S(o.label).trim() : '';
    };
    // Giá trị đang chọn của 1 trục: ?attr9=16610 trên URL -> ô đang chọn trên trang
    const pcSelected = (sel) => {
        if (!sel) return '';
        let vid = '';
        [location.href, opts.url].forEach((u) => {
            if (vid) return;
            try { vid = S(new URL(S(u), location.href).searchParams.get(sel.key)); } catch (e) { /* bỏ */ }
        });
        if (vid) return pcLabel(sel, vid);
        const el = document.querySelector('[data-key="' + sel.key + '"] .container-option-item.selected');
        return el ? S(el.getAttribute('data-caption')).trim() : '';
    };
    const pcSalePrice = (list) => {
        const po = pcOptions();
        const d = Number((po && (po.discount != null ? po.discount : po.site_wide_discount)) || 0);
        if (!(list > 0)) return null;
        return d > 0 && d < 100 ? Math.round(list * (100 - d)) / 100 : list;
    };
    const pcGallery = () => [].slice.call(document.querySelectorAll('.product-thumbnails .thumbnail-item'))
        .filter((t) => !/video/i.test(S(t.getAttribute('data-media-type'))))
        .map((t) => { const im = t.querySelector('img'); return im ? (im.getAttribute('ref') || im.src) : ''; })
        .filter((u) => u && !/^data:/.test(u)).map(pcBig);
    const pcDesignOf = (d, colorSel) => pcLabel(colorSel, (d.attr_value_mapping || {})[pcAttrId(colorSel)]);
    const pcDescSections = () => {
        const el = document.querySelector('.component-bullets-description .product-description');
        // Đoạn giới thiệu là chữ TRẦN ngay trong div, liền sau là <ul> -> bọc chữ trần vào
        // <p> riêng (để nguyên thì cleanHtml bọc cả <ul> vào <p> và chữ dính "come.Choose").
        if (el && S(el.textContent).trim()) {
            let html = '';
            [].slice.call(el.childNodes).forEach((n) => {
                if (n.nodeType === 3) {
                    const t = S(n.nodeValue).replace(/\s+/g, ' ').trim();
                    if (t) html += '<p>' + escHtml(t) + '</p>';
                } else if (n.nodeType === 1) html += n.outerHTML;
            });
            return [{ html: html, title: 'Product Description', kind: 'description' }];
        }
        // Dự phòng: dựng từ JSON (description + listed_description)
        const po = pcOptions();
        const obj = po && po.default_design && po.product_design_objects
            ? po.product_design_objects[po.default_design.id] : null;
        if (!obj) return [];
        let html = obj.description ? '<p>' + escHtml(obj.description) + '</p>' : '';
        try {
            JSON.parse(S(obj.listed_description) || '[]').forEach((g) => {
                if (g.title) html += '<h4>' + escHtml(g.title) + '</h4>';
                if ((g.items || []).length) html += '<ul>' + g.items.map((x) => '<li>' + escHtml(x) + '</li>').join('') + '</ul>';
            });
        } catch (e) { /* bỏ */ }
        return html ? [{ html: html, title: 'Product Description', kind: 'description' }] : [];
    };
    const pcExtra = () => {
        const po = pcOptions();
        if (!po || !po.product_designs) return null;
        const ax = pcAxes();
        const cs = ax.color;
        const os = ax.other[0] || null;          // trục thứ 2 (Options) làm "size"
        const designs = Object.keys(po.product_designs).map((k) => po.product_designs[k]);
        const colors = [], colorsOut = [], codes = {}, prices = {}, imgColors = {}, allImgs = [];
        const sizeVals = os ? os.select_options.map((o) => S(o.label).trim()) : [];
        const rows = {};
        const variants = [];
        (cs ? cs.select_options : []).forEach((o) => {
            const n = S(o.label).trim();
            if (!n || colors.indexOf(n) >= 0) return;
            colors.push(n);
            codes[n] = S(o.value_id);
            if (o.out_of_stock || o.is_active === 0) colorsOut.push(n);
        });
        designs.forEach((d) => {
            const map = d.attr_value_mapping || {};
            const color = cs ? pcDesignOf(d, cs) : '';
            const size = os ? pcLabel(os, map[pcAttrId(os)]) : '';
            const list = Number(d.retail_price || d.startAtPrice || 0);
            const sale = pcSalePrice(list);
            const oos = !!Number(d.is_out_of_stock || 0);
            variants.push([color, size].filter(Boolean).join(' / ') + (sale != null ? ' — $' + sale : '') + (oos ? ' (hết)' : ''));
            if (color) {
                if (!prices[color]) prices[color] = { price: sale, list_price: list > (sale || 0) ? list : null };
                const r = rows[color] = rows[color] || { color: color, variant: '', sizes_in_stock: [], sizes_out_of_stock: [] };
                if (size) (oos ? r.sizes_out_of_stock : r.sizes_in_stock).push(size);
                else if (!sizeVals.length) (oos ? r.sizes_out_of_stock : r.sizes_in_stock).push('One Size');
                const img = d.front_sample || d.design_sample;
                if (img) {
                    const big = pcBig(img);
                    imgColors[big] = color;
                    if (allImgs.indexOf(big) < 0) allImgs.push(big);
                }
            }
        });
        // all_images: gallery chung của trang trước, rồi ảnh chính từng design
        const gallery = pcGallery();
        gallery.slice().reverse().forEach((u) => { if (allImgs.indexOf(u) < 0) allImgs.unshift(u); });
        const cur = pcSelected(cs);
        const curSize = pcSelected(os);
        const matrix = colors.map((c) => rows[c] || { color: c, variant: '', sizes_in_stock: [], sizes_out_of_stock: sizeVals.slice() });
        // "Size" của design đang xem (hoặc mọi tổ hợp nếu chưa chọn design)
        const here = cur && rows[cur] ? [rows[cur]] : matrix;
        const inS = [], outS = [];
        here.forEach((r) => {
            r.sizes_in_stock.forEach((s) => { if (inS.indexOf(s) < 0) inS.push(s); });
            r.sizes_out_of_stock.forEach((s) => { if (outS.indexOf(s) < 0 && inS.indexOf(s) < 0) outS.push(s); });
        });
        const pageOos = !!po.is_out_of_stock;
        const anyIn = matrix.some((r) => r.sizes_in_stock.length);
        log('pc: trục màu=' + (cs ? cs.caption : '-') + ' (' + colors.length + '), trục size='
            + (os ? os.caption : '-') + ', đang chọn=' + (cur || '(chưa chọn)') + ', ' + gallery.length + ' ảnh gallery');
        log('pc: color_codes=' + JSON.stringify(codes) + ' color_prices=' + JSON.stringify(prices));
        return {
            color_label: cs ? S(cs.caption) : '',
            colors: colors,
            current_color: cur,
            size_label: os ? S(os.caption) : (colors.length ? 'Size' : ''),
            sizes: sizeVals.length ? sizeVals : (inS.concat(outS)),
            sizes_in_stock: inS,
            sizes_out_of_stock: outS,
            stock_matrix: matrix,
            variants: variants,
            image_colors: imgColors,
            all_images: allImgs,
            in_stock: !pageOos && (anyIn || !designs.length),
            color_codes: codes,
            color_prices: prices,
            current_variant: curSize,
        };
    };

    // ================= ACADEMY =================
    // ============================================================
    // ACADEMY SPORTS + OUTDOORS (React SSR) — kiểm chứng 2026-09-24
    // ============================================================
    // Toàn bộ dữ liệu sản phẩm được server nhúng sẵn trong 1 script inline:
    //   window.ASOData['comp-bltXXXX'] = {"rcn":"pdp240", ..., "api": {productItem, inventory,
    //   product-info, ...}}   (key comp-… đổi theo CMS -> tìm theo "rcn":"pdp" + productItem)
    // Đọc JSON này là đủ, KHÔNG phải chờ DOM render (DOM hydrate chậm = lý do "cào chậm").
    //   productItem.identifiersMap   {Color:[{itemId 'ColorBlack', text, imageURL}], 'Shoe Size':[..],
    //                                'Shoe Width':[..]} — thứ tự hiển thị của từng trục
    //   productItem.sKUs[]           mỗi SKU: skuId, skuIdentifier ('10-d-black-bright-green' = giá
    //                                trị ?sku= trên URL), defining_attribute[{name,value}], price
    //                                {salePrice, listPrice, priceMessage}
    //   productItem.inventory.online[] {skuId, inventoryStatus IN_STOCK/OUT_OF_STOCK}
    //   productItem.alternateImageMap {'Color<tên>': [{imageURL}]} — gallery TỪNG MÀU
    //   productItem.selectedIdentifier  tổ hợp đang chọn (theo ?sku=, không có thì SKU mặc định)
    //   productItem.productSpecifications  featureBenefits[] / specifications{} / whatsInTheBox[]
    //   productItem.longDescription, sizeChartURL (PDF Scene7)
    // 1 link chung mọi màu (?sku= chỉ chọn sẵn 1 tổ hợp) -> identity color+variant, nhưng
    // extra chỉ trả MÀU CỦA LINK (không tách ra mọi màu — khách 2026-09-29).
    // BẪY: hàng MAP "priceInCart" — trang hiện listPrice ($74.99 "Our Price in Cart"), giá thật
    // salePrice chỉ thấy trong giỏ -> price = giá đang hiện, cảnh báo kèm giá trong giỏ.
    // Ảnh Scene7 gốc không tham số = 1500px ngang; ?wid=2000&hei=2000 ra 2000x2000.
    let _acCache;
    const acData = () => {
        if (_acCache !== undefined) return _acCache;
        _acCache = null;
        try {
            const aso = window.ASOData;
            if (aso) {
                const c = Object.keys(aso).map((k) => aso[k])
                    .find((x) => x && x.api && x.api.productItem && x.api.productItem.sKUs);
                if (c) { _acCache = c.api; return _acCache; }
            }
        } catch (e) { /* isolated world -> đọc chữ của script */ }
        const sc = [].slice.call(document.scripts).find((s) => {
            const t = S(s.textContent);
            return t.indexOf('"rcn":"pdp') >= 0 && t.indexOf('"productItem"') >= 0;
        });
        if (!sc) return null;
        const txt = S(sc.textContent);
        const at = txt.indexOf('={"rcn":"pdp');
        try {
            const j = JSON.parse(jsonObjectAt(txt, at + 1));
            _acCache = (j && j.api && j.api.productItem) ? j.api : null;
        } catch (e) { log('academy: không parse được ASOData — ' + S(e.message || e)); }
        return _acCache;
    };
    const acItem = () => { const a = acData(); return a ? a.productItem : null; };
    // BẪY: longDescription của vài SP bị lỗi mã hoá ngay trong dữ liệu site ("UA Techâ„¢" =
    // byte UTF-8 của ™ bị đọc theo cp1252) — sửa lại khi thấy dấu hiệu mojibake.
    const AC_CP1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
        0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E,
        0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
        0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
    const acFixMojibake = (s) => S(s).replace(/[Â-ô][\u0080-¿Œ-™]{1,3}/g, (m) => {
        const bytes = [];
        for (let i = 0; i < m.length; i++) {
            const c = m.charCodeAt(i);
            const b = c < 0x100 ? c : AC_CP1252[c];
            if (b === undefined) return m;
            bytes.push(b);
        }
        try {
            const out = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
            return out.length < m.length ? out : m;
        } catch (e) { return m; }
    });
    const acText = (s) => acFixMojibake(decodeHtml(S(s)));
    const acImg = (u) => abs(S(u).split('?')[0]) + '?wid=2000&hei=2000';
    const acAttrs = (sku) => {
        const o = {};
        (sku.defining_attribute || []).forEach((a) => { o[S(a.name)] = S(a.value).trim(); });
        return o;
    };
    // Trục: màu = tên có "color", size = trục có "size" (không có thì trục đầu còn lại),
    // các trục còn lại (Shoe Width, Fit, Length...) gộp làm trục giữa variant.
    const acAxes = () => {
        const p = acItem();
        const names = ((p && p.productAttributeGroups) || Object.keys((p && p.identifiersMap) || {}))
            .filter((n) => ((p.identifiersMap || {})[n] || []).length);
        const color = names.find((n) => /colou?r/i.test(n)) || '';
        const rest = names.filter((n) => n !== color);
        const size = rest.find((n) => /size/i.test(n)) || rest[0] || '';
        return { color: color, size: size, other: rest.filter((n) => n !== size) };
    };
    const acValues = (axis) => (((acItem() || {}).identifiersMap || {})[axis] || [])
        .map((x) => S(x.text).trim()).filter(Boolean);
    const acInv = () => {
        const p = acItem();
        const a = acData();
        const inv = {};
        const list = ((p && p.inventory && p.inventory.online) || (a && a.inventory && a.inventory.online) || []);
        list.forEach((o) => { inv[S(o.skuId)] = /IN_STOCK|LIMITED|BACKORDER/i.test(S(o.inventoryStatus))
            && !/OUT_OF/i.test(S(o.inventoryStatus)); });
        return inv;
    };
    // SKU đang xem: ?sku= trên URL (tab đã bấm đổi màu vẫn đúng) -> selectedIdentifier của SSR
    const acCurrentSku = () => {
        const p = acItem();
        if (!p) return null;
        const skus = p.sKUs || [];
        let id = '';
        [location.href, opts.url].forEach((u) => {
            if (id) return;
            try { id = S(new URL(S(u), location.href).searchParams.get('sku')).toLowerCase(); } catch (e) { /* bỏ */ }
        });
        let s = id ? skus.find((x) => S(x.skuIdentifier).toLowerCase() === id) : null;
        if (!s && p.selectedIdentifier) {
            const sel = p.selectedIdentifier;
            s = skus.find((x) => (x.defining_attribute || []).every((a) => !sel[a.name] || sel[a.name] === S(a.name) + S(a.value)));
        }
        return s || skus.find((x) => S(x.skuId) === S(p.skuId || p.defaultSku)) || skus[0] || null;
    };
    const acPriceOf = (sku) => {
        const pr = (sku && sku.price) || (acItem() || {}).price || null;
        if (!pr) return null;
        const sale = Number(pr.salePrice), list = Number(pr.listPrice);
        if (/incart/i.test(S(pr.priceMessage)) && list > 0) {
            return { price: list, list_price: null, in_cart: sale > 0 && sale < list ? sale : null };
        }
        if (!(sale > 0)) return list > 0 ? { price: list, list_price: null } : null;
        return { price: sale, list_price: list > sale ? list : null };
    };
    const acColorImages = (color) => {
        const p = acItem();
        const m = (p && p.alternateImageMap) || {};
        const list = m['Color' + color] || [];
        const out = list.map((x) => acImg(x.imageURL || x.thumbnail)).filter(Boolean);
        if (!out.length) {
            const it = ((p && p.identifiersMap && p.identifiersMap[acAxes().color]) || [])
                .find((x) => S(x.text).trim() === color);
            if (it && it.imageURL) out.push(acImg(it.imageURL));
        }
        return out;
    };
    const acCurrentColor = () => {
        const s = acCurrentSku();
        const ax = acAxes();
        return s && ax.color ? S(acAttrs(s)[ax.color]).trim() : '';
    };
    const acDescSections = () => {
        const p = acItem();
        if (!p) return [];
        const out = [];
        const long = acText(S(p.longDescription));
        if (long) out.push({ title: 'Details & Specs', kind: 'description',
                             html: /<[a-z]/i.test(long) ? long : '<p>' + escHtml(long) + '</p>' });
        const specs = {};
        (p.productSpecifications || []).forEach((g) => Object.keys(g).forEach((k) => { specs[k] = g[k] && g[k].value; }));
        const ul = (arr) => '<ul>' + arr.map((x) => '<li>' + escHtml(acText(x)) + '</li>').join('') + '</ul>';
        if ((specs.featureBenefits || []).length) out.push({ title: 'Features and Benefits', kind: 'details', html: ul(specs.featureBenefits) });
        if (specs.specifications && typeof specs.specifications === 'object') {
            const rows = Object.keys(specs.specifications).map((k) => {
                const v = specs.specifications[k];
                return [k, acText(Array.isArray(v) ? v.join(', ') : S(v))];
            });
            const t = specTableHtml(rows);
            if (t) out.push({ title: 'Specifications', kind: 'details', html: t });
        }
        if ((specs.whatsInTheBox || []).length) out.push({ title: "What's in the Box", kind: 'details', html: ul(specs.whatsInTheBox) });
        return out;
    };
    const acExtra = () => {
        const p = acItem();
        if (!p || !(p.sKUs || []).length) return null;
        const ax = acAxes();
        const inv = acInv();
        // Có khối inventory (kể cả online: [] rỗng) thì SKU vắng mặt = hết hàng online — hàng
        // clearance ngừng bán (BCG Cotton T-shirt) có online: [] mà sKUs vẫn sellable=1,
        // trang ghi "Out Of Stock". Chỉ khi không có khối inventory mới lùi về sellable.
        const invBox = (p.inventory && Array.isArray(p.inventory.online)) ? p.inventory
            : ((acData() || {}).inventory || null);
        const hasInv = !!(invBox && Array.isArray(invBox.online));
        const colors = ax.color ? acValues(ax.color) : [];
        const sizes = ax.size ? acValues(ax.size) : [];
        const cur = acCurrentSku();
        const curA = cur ? acAttrs(cur) : {};
        const curColor = ax.color ? S(curA[ax.color]) : '';
        const variantOf = (a) => ax.other.map((n) => S(a[n])).filter(Boolean).join(' / ');
        const curVariant = variantOf(curA);
        // bảng: màu -> variant -> {size: true(còn)/false(hết)}
        const tbl = {}, variantsSeen = [], codes = {}, prices = {};
        (p.sKUs || []).forEach((s) => {
            const a = acAttrs(s);
            const c = ax.color ? S(a[ax.color]) : '';
            const v = variantOf(a);
            const z = ax.size ? S(a[ax.size]) : 'One Size';
            const ok = hasInv ? !!inv[S(s.skuId)] : s.sellable !== false && s.sellable !== 0;
            if (variantsSeen.indexOf(v) < 0) variantsSeen.push(v);
            const row = ((tbl[c] = tbl[c] || {})[v] = tbl[c][v] || {});
            row[z] = row[z] || ok;
            if (c && (!codes[c] || (ok && !codes[c + '\u0000ok']))) {
                codes[c] = S(s.skuIdentifier);
                if (ok) codes[c + '\u0000ok'] = 1;
            }
            if (c && !prices[c]) {
                const pr = acPriceOf(s);
                if (pr) prices[c] = { price: pr.price, list_price: pr.list_price };
            }
        });
        // CHỈ màu của link (?sku=): mỗi màu Academy có link riêng, khách không muốn 1 link
        // sinh ra mọi màu (bảng tự tách mỗi màu 1 sản phẩm khi thấy >= 2 màu) — 2026-09-29.
        // Trục giữa (Shoe Width...) của cùng màu vẫn giữ.
        const onlyCur = (c) => !curColor || S(c) === curColor;
        Object.keys(codes).forEach((k) => { if (k.indexOf('\u0000') >= 0 || !onlyCur(k)) delete codes[k]; });
        Object.keys(prices).forEach((k) => { if (!onlyCur(k)) delete prices[k]; });
        const allSizes = sizes.length ? sizes : ['One Size'];
        const matrix = [];
        const colorList = colors.length ? (curColor ? [curColor] : colors) : [''];
        colorList.forEach((c) => variantsSeen.forEach((v) => {
            const row = (tbl[c] || {})[v];
            if (!row) return;
            matrix.push({ color: c, variant: v,
                sizes_in_stock: allSizes.filter((z) => row[z] === true),
                sizes_out_of_stock: allSizes.filter((z) => row[z] !== true) });
        }));
        const here = (tbl[curColor] || {})[curVariant] || {};
        const inS = allSizes.filter((z) => here[z] === true);
        const outS = allSizes.filter((z) => here[z] !== true);
        const deadColors = colorList.filter((c) => c && !matrix.some((r) => r.color === c && r.sizes_in_stock.length));
        if (deadColors.length) warnings.push('Màu hết sạch size: ' + deadColors.join(', '));
        const imgColors = {}, allImgs = [];
        colorList.forEach((c) => {
            if (!c) return;
            acColorImages(c).forEach((u) => {
                if (allImgs.indexOf(u) < 0) allImgs.push(u);
                if (!imgColors[u]) imgColors[u] = c;
            });
        });
        const pr = acPriceOf(cur);
        if (pr && pr.in_cart) {
            warnings.push('Academy ẩn giá (MAP "Our Price in Cart"): trang hiện $' + pr.price
                + ', giá thật trong giỏ $' + pr.in_cart + '.');
        }
        log('academy: màu đang xem=' + (curColor || '?') + ' / ' + (curVariant || '-') + ', '
            + colors.length + ' màu, ' + sizes.length + ' size, ' + (p.sKUs || []).length + ' sku, '
            + (hasInv ? 'tồn kho online' : 'không có tồn kho -> theo sellable'));
        log('academy: color_codes=' + JSON.stringify(codes) + ' color_prices=' + JSON.stringify(prices));
        const guide = S(p.sizeChartURL || '').trim();
        return {
            color_label: ax.color || '',
            colors: curColor ? [curColor] : colors,
            current_color: curColor,
            variant_label: ax.other.join(' / '),
            current_variant: curVariant,
            size_label: ax.size || '',
            sizes: sizes,
            sizes_in_stock: inS,
            sizes_out_of_stock: outS,
            stock_matrix: matrix,
            in_stock: matrix.some((r) => r.sizes_in_stock.length) && inS.length > 0,
            list_price: pr ? pr.list_price : null,
            image_colors: imgColors,
            all_images: allImgs,
            size_guide_url: guide ? abs(guide) : '',
            color_codes: codes,
            color_prices: prices,
        };
    };

    // ================= WALMART =================
    // ============================================================
    // WALMART (marketplace, Next.js) — kiểm chứng 2026-09-24
    // ============================================================
    // Toàn bộ dữ liệu nằm trong <script id="__NEXT_DATA__"> ngay lượt tải đầu:
    //   props.pageProps.initialData.data.product  — name, brand, priceInfo, variantCriteria
    //       (trục màu/size, mỗi màu có images = id ảnh), variantsMap (mỗi tổ hợp 1 item id
    //       riêng, giá + tồn kho riêng), imageMap {id ảnh: {url}}
    //   props.pageProps.initialData.data.idml     — shortDescription (Product details),
    //       longDescription (Key item features), specifications, productImages (tag ảnh)
    // BẪY:
    //   · document.title / og:title có đuôi " - Walmart.com"; JSON-LD KHÔNG có Product ->
    //     tầng chung lấy brand = "Walmart" (tên site). Brand thật là product.brand.
    //   · DOM có hàng trăm ảnh 288px của sản phẩm GỢI Ý -> không quét DOM, lấy ảnh theo
    //     id trong variantCriteria[màu].images rồi tra imageMap; link bỏ query = ảnh gốc.
    //   · Giá khác nhau THEO TỪNG VARIANT (cùng màu, size L 18.59 còn size S 19.79) ->
    //     giá = priceInfo của đúng item id trên URL, không lấy giá "từ" của cả nhóm.
    //   · Mỗi variant 1 link /ip/<slug>/<usItemId>; state trong trang là của lượt tải
    //     đầu (bấm đổi màu phía client không cập nhật __NEXT_DATA__) -> đọc item id
    //     từ URL rồi tra variantsMap, không tin selectedVariantIds khi 2 cái lệch nhau.
    let _wmCache;
    const wmData = () => {
        if (_wmCache) return _wmCache;
        let nd = null;
        try { nd = window.__NEXT_DATA__ || null; } catch (e) { nd = null; }
        // Extension chạy ở isolated world: window.__NEXT_DATA__ KHÔNG phải biến của trang mà
        // là chính thẻ <script id="__NEXT_DATA__"> (trình duyệt tự gắn tên theo id) -> bỏ,
        // đọc chữ trong thẻ. Trước đây extension không cào được Walmart vì chỗ này.
        if (nd && nd.nodeType) nd = null;
        if (!nd) {
            const el = document.getElementById('__NEXT_DATA__');
            if (el) { try { nd = JSON.parse(el.textContent); } catch (e) { nd = null; } }
        }
        const data = nd && nd.props && nd.props.pageProps && nd.props.pageProps.initialData
            && nd.props.pageProps.initialData.data;
        if (!data || !data.product) return null;
        _wmCache = { product: data.product, idml: data.idml || {} };
        return _wmCache;
    };
    const wmProduct = () => { const d = wmData(); return d ? d.product : null; };
    const wmItemIdOf = (u) => { const m = S(u).split('?')[0].match(/\/ip\/(?:[^/]+\/)?(\d+)(?:[/?#]|$)/); return m ? m[1] : ''; };
    const wmNum = (x) => { const n = Number(x && x.price); return x && x.price != null && isFinite(n) && n > 0 ? n : null; };
    const wmPriceOf = (pi) => {
        pi = pi || {};
        const price = wmNum(pi.currentPrice);
        const was = wmNum(pi.wasPrice) || wmNum(pi.listPrice);
        return { price: price, list_price: price != null && was != null && was > price ? was : null };
    };
    const wmImgUrl = (u) => S(u).split('?')[0];           // bỏ odnHeight/odnWidth = ảnh gốc
    const wmColorAxis = (p) => (p.variantCriteria || []).filter(
        (c) => /colou?r/i.test(S(c.id)) || /colou?r/i.test(S(c.name)))[0] || null;
    // Trục khác màu: trục có chữ "size" là Size, còn lại gộp thành trục giữa (variant)
    const wmOtherAxes = (p) => {
        const col = wmColorAxis(p);
        const rest = (p.variantCriteria || []).filter((c) => c !== col);
        let size = rest.filter((c) => /size/i.test(S(c.id) + ' ' + S(c.name)))[0] || null;
        if (!size && rest.length) size = rest[rest.length - 1];
        return { color: col, size: size, mids: rest.filter((c) => c !== size) };
    };
    const wmValName = (axis, ids) => {
        if (!axis) return '';
        const v = (axis.variantList || []).filter((x) => (ids || []).indexOf(x.id) >= 0)[0];
        return v ? S(v.name).trim() : '';
    };
    // Mọi tổ hợp (variantsMap) -> {id, item_id, color, size, mid, price, list_price, in_stock}
    const wmVariants = () => {
        const p = wmProduct();
        if (!p) return [];
        const ax = wmOtherAxes(p);
        return Object.keys(p.variantsMap || {}).map((k) => {
            const v = p.variantsMap[k];
            const ids = v.variants || [];
            const pr = wmPriceOf(v.priceInfo);
            return {
                id: S(v.id || k), item_id: S(v.usItemId), url: abs(v.productUrl || ''),
                color: wmValName(ax.color, ids), size: wmValName(ax.size, ids),
                mid: ax.mids.map((a) => wmValName(a, ids)).filter(Boolean).join(' / '),
                price: pr.price, list_price: pr.list_price,
                in_stock: /IN_STOCK|AVAILABLE/i.test(S(v.availabilityStatus)) && !/OUT/i.test(S(v.availabilityStatus)),
            };
        });
    };
    // Variant đang xem: item id trên URL trình duyệt -> link người dùng dán -> state
    const wmCurrent = () => {
        const p = wmProduct();
        if (!p) return null;
        const vs = wmVariants();
        const ids = [wmItemIdOf(location.href), wmItemIdOf(opts.url), S(p.usItemId)].filter(Boolean);
        for (let i = 0; i < ids.length; i++) {
            const hit = vs.filter((v) => v.item_id === ids[i])[0];
            if (hit) return hit;
        }
        const disp = vs.filter((v) => v.id === S(p.displayVariantProductId))[0];
        return disp || null;
    };
    const wmColorImages = (p, colorName) => {
        const ax = wmColorAxis(p);
        const map = p.imageMap || {};
        const val = ax && (ax.variantList || []).filter((x) => S(x.name).trim() === colorName)[0];
        if (!val) return [];
        return (val.images || []).map((id) => map[id] && map[id].url).filter(Boolean).map(wmImgUrl);
    };
    const wmImages = () => {
        const p = wmProduct();
        if (!p) return [];
        const cur = wmCurrent();
        let list = cur && cur.color ? wmColorImages(p, cur.color) : [];
        if (!list.length && cur) {
            const v = (p.variantsMap || {})[cur.id];
            list = ((v && v.imageInfo && v.imageInfo.allImages) || []).map((x) => wmImgUrl(x.url));
        }
        if (!list.length) list = ((p.imageInfo && p.imageInfo.allImages) || []).map((x) => wmImgUrl(x.url));
        return list.filter(Boolean);
    };
    // Size theo thứ tự site khai trong variantCriteria (S, M, L, XL...)
    const wmSizeOrder = (p) => {
        const ax = wmOtherAxes(p).size;
        return ax ? (ax.variantList || []).map((x) => S(x.name).trim()) : [];
    };
    // Product details giữ NGUYÊN mô tả của người bán, kể cả "👗 Size Chart" + "Note"
    // (khách 2026-09-28: thiếu mục Size Chart / câu note "1-3cm deviation" là sai).
    // Directions: idml.directions = [{name: "Fabric Care Instructions", value: "..."}].
    // (Warranty KHÔNG lấy: bảo hành bị lọc khỏi cả mô tả chữ lẫn HTML.)
    const wmTextHtml = (v) => {
        v = S(v).trim();
        if (!v) return '';
        return /<[a-z][^>]*>/i.test(v) ? v : '<p>' + escHtml(decodeHtml(v)).replace(/\r?\n/g, '<br>') + '</p>';
    };
    const wmDescSections = () => {
        const d = wmData();
        if (!d) return [];
        const idml = d.idml || {};
        const p = d.product;
        const hasText = (h) => stripHtml(h).replace(/[\s ﻿]/g, '');
        const secs = [];
        const details = [idml.shortDescription || p.shortDescription || '', idml.longDescription || '']
            .filter(hasText).join('');
        if (details) secs.push({ title: 'Product details', kind: 'description', html: details });
        // Specifications: bỏ hàng nói về size (Clothing size / Clothing size group / Shoe size...)
        const rows = (idml.specifications || []).filter((r) => r && !/size/i.test(S(r.name)))
            .map((r) => [decodeHtml(r.name), decodeHtml(r.value)]);
        const tbl = specTableHtml(rows);
        if (tbl) secs.push({ title: 'Specifications', kind: 'details', html: tbl });
        const dir = (idml.directions || []).filter((r) => r && S(r.value).trim())
            .map((r) => (S(r.name).trim() ? '<p><strong>' + escHtml(decodeHtml(r.name)) + '</strong></p>' : '')
                + wmTextHtml(r.value)).join('');
        if (dir) secs.push({ title: 'Directions', kind: 'fit_care', html: dir });
        return secs;
    };
    const wmExtra = () => {
        const p = wmProduct();
        if (!p) return null;
        const idml = (wmData() || {}).idml || {};
        const ax = wmOtherAxes(p);
        const vs = wmVariants();
        const cur = wmCurrent();
        const sizeOrder = wmSizeOrder(p);
        const colors = ax.color ? (ax.color.variantList || []).map((x) => S(x.name).trim()).filter(Boolean) : [];
        const mids = [];
        vs.forEach((v) => { if (v.mid && mids.indexOf(v.mid) < 0) mids.push(v.mid); });
        const sizeIdx = (s) => { const i = sizeOrder.indexOf(s); return i < 0 ? 999 : i; };
        // Ma trận tồn kho: mỗi (màu, trục giữa) 1 dòng; size không bán/hết = out
        const matrix = [];
        (colors.length ? colors : ['']).forEach((c) => {
            (mids.length ? mids : ['']).forEach((m) => {
                const rows = vs.filter((v) => v.color === c && v.mid === m);
                if (!rows.length) return;
                const inS = sizeOrder.filter((s) => rows.some((v) => v.size === s && v.in_stock));
                matrix.push({ color: c, variant: m, sizes_in_stock: inS,
                              sizes_out_of_stock: sizeOrder.filter((s) => inS.indexOf(s) < 0) });
            });
        });
        const here = matrix.filter((r) => r.color === (cur ? cur.color : '') && r.variant === (cur ? cur.mid : ''))[0]
            || { sizes_in_stock: [], sizes_out_of_stock: [] };
        // Mã định danh mỗi màu = item id của link ĐẦU TIÊN của màu đó (size nhỏ nhất theo
        // thứ tự site) — cố định dù người dùng dán link size nào của màu đó.
        const colorCodes = {};
        const colorPrices = {};
        colors.forEach((c) => {
            const rows = vs.filter((v) => v.color === c)
                .sort((a, b) => sizeIdx(a.size) - sizeIdx(b.size));
            if (!rows.length) return;
            colorCodes[c] = rows[0].item_id;
            const prices = rows.map((v) => v.price).filter((x) => x != null);
            colorPrices[c] = { price: rows[0].price, list_price: rows[0].list_price,
                               min_price: prices.length ? Math.min.apply(null, prices) : null,
                               max_price: prices.length ? Math.max.apply(null, prices) : null };
        });
        // Ảnh mọi màu + tên màu từng ảnh (ảnh dùng chung nhiều màu -> không gán)
        const all = [], owner = {};
        colors.forEach((c) => {
            wmColorImages(p, c).forEach((u) => {
                if (all.indexOf(u) < 0) all.push(u);
                owner[u] = owner[u] === undefined ? c : (owner[u] === c ? c : null);
            });
        });
        const imageColors = {};
        Object.keys(owner).forEach((u) => { if (owner[u]) imageColors[u] = owner[u]; });
        // Ảnh bảng size của người bán: productImages tag "graphics-sizeguide"
        const map = p.imageMap || {};
        const guide = (idml.productImages || []).filter((x) => /size/i.test(S(x.tag)))
            .map((x) => map[x.assetId] && wmImgUrl(map[x.assetId].url)).filter(Boolean);
        const pr = cur ? { price: cur.price, list_price: cur.list_price } : wmPriceOf(p.priceInfo);
        return {
            current_color: cur ? cur.color : '',
            color_label: ax.color ? S(ax.color.name) : '',
            colors: colors,
            size_label: ax.size ? S(ax.size.name) : '',
            sizes: sizeOrder,
            sizes_in_stock: here.sizes_in_stock,
            sizes_out_of_stock: here.sizes_out_of_stock,
            variant_label: ax.mids.map((a) => S(a.name)).join(' / '),
            current_variant: cur ? cur.mid : '',
            stock_matrix: matrix,
            in_stock: vs.length ? here.sizes_in_stock.length > 0
                : /IN_STOCK/i.test(S(p.availabilityStatus)),
            list_price: pr.list_price,
            all_images: all.length ? all : null,
            image_colors: imageColors,
            fit_guide_images: guide,
            // Trường MỚI (chờ tích hợp vào rec)
            color_codes: colorCodes,
            color_prices: colorPrices,
            item_id: cur ? cur.item_id : S(p.usItemId),
            variant_items: vs.map((v) => ({ item_id: v.item_id, color: v.color, size: v.size,
                variant: v.mid, price: v.price, list_price: v.list_price, in_stock: v.in_stock })),
            seller: S(p.sellerDisplayName || p.sellerName).trim(),
        };
    };

    // ================= ETSY =================
    // ============================================================
    // ETSY — kiểm chứng 2026-09-24 (cổng 35007; 35006 bị DataDome chặn IP)
    // ============================================================
    // Trang listing render sẵn phía server:
    //   · JSON-LD Product: name, description (chữ thường đủ), image[].contentURL (il_fullxfull),
    //     brand.name = TÊN SHOP, offers.price = giá "từ" thấp nhất, priceSpecification có
    //     StrikethroughPrice (giá gạch), offers.availability
    //   · select#variation-selector-N (label trong #label-variation-selector-N): tên trục do
    //     người bán TỰ ĐẶT ("Primary color", "SIZE/STYLE", "Colour"...) -> nhận trục màu bằng
    //     chữ color/colour, trục size bằng chữ size, còn lại là trục giữa.
    //     Chữ option có kèm "($12.71)" (giá của lựa chọn đó) và "[Sold out...]".
    //   · ul[data-carousel-pane-list] li[data-image-id] img[data-src-zoom-image] = ảnh lớn
    //   · Etsy.Context.data.image_ids_by_listing_variation_ids {id lựa chọn: [id ảnh]} —
    //     chỉ có khi người bán gắn ảnh theo màu (rỗng thì mọi ảnh dùng chung)
    // Tồn kho/giá TỪNG MÀU không có sẵn trong trang: gọi đúng API mà trang gọi khi khách chọn
    // màu — GET /api/v3/ajax/bespoke/member/listings/<id>/offerings/find-by-variations?
    // listing_variation_ids[]=<id màu> (BẮT BUỘC header x-etsy-protection: 1, thiếu là 400).
    // Trả {price: HTML giá, variations: HTML các select đã lọc theo màu đó}.
    // BẪY: giá trên trang khi chưa chọn gì là giá "từ" ("$6.65+") — thấp hơn mọi size thật.
    const ET_API = {};           // id lựa chọn màu -> {price, list_price, opts:[{id,name,price,sold}]}
    let _etCtx;
    const etCtx = () => {
        if (_etCtx !== undefined) return _etCtx;
        _etCtx = null;
        try { if (window.Etsy && window.Etsy.Context && window.Etsy.Context.data) _etCtx = window.Etsy.Context.data; } catch (e) { /* isolated world */ }
        return _etCtx;
    };
    const etVarImageMap = () => {
        const c = etCtx();
        let m = c && c.image_ids_by_listing_variation_ids;
        if (!m) {
            // Extension (isolated world) không đọc được window.Etsy -> moi từ chữ script
            const s = [].slice.call(document.scripts).map((x) => x.textContent || '')
                .filter((t) => t.indexOf('"image_ids_by_listing_variation_ids"') >= 0)[0] || '';
            const i = s.indexOf('"image_ids_by_listing_variation_ids":');
            if (i >= 0) {
                const rest = s.slice(i + 38).trim();
                try { m = JSON.parse(rest[0] === '{' ? jsonObjectAt(rest, 0) : rest.slice(0, rest.indexOf(']') + 1)); } catch (e) { m = null; }
            }
        }
        return m && !Array.isArray(m) && typeof m === 'object' ? m : {};
    };
    const etOptName = (t) => S(t).replace(/\s+/g, ' ').replace(/\[[^\]]*\]/g, '')
        .replace(/\(\s*[$€£]\s?[\d.,]+\s*(?:-\s*[$€£]?\s?[\d.,]+\s*)?\)/g, '').trim();
    const etOptPrice = (t) => { const m = S(t).match(/\(\s*([$€£]\s?[\d.,]+)/); return m ? parsePrice(m[1]) : null; };
    // Các trục của 1 khối HTML/DOM select Etsy -> [{index, label, kind, opts:[{id,name,price,sold}]}]
    const etAxesFrom = (root) => [].slice.call(root.querySelectorAll('select[id^="variation-selector-"]')).map((sel) => {
        const idx = S(sel.getAttribute('data-variation-number') || S(sel.id).replace(/\D+/g, ''));
        const lab = root.querySelector('#label-variation-selector-' + idx);
        const label = S(lab ? lab.textContent : '').replace(/\s+/g, ' ').trim();
        const kind = /colou?r/i.test(label) ? 'color' : (/size/i.test(label) ? 'size' : 'variant');
        const opts = [].slice.call(sel.options).filter((o) => S(o.value)).map((o) => ({
            id: S(o.value), name: etOptName(o.textContent),
            price: (etOptPrice(o.textContent) || {}).value || null,
            sold: /sold out|unavailable/i.test(o.textContent) || o.disabled,
            selected: o.hasAttribute('selected') || o.selected,
        }));
        return { index: idx, label: label, kind: kind, opts: opts };
    });
    const etAxes = () => etAxesFrom(document);
    // Trục "hàng" của ma trận (màu, không có thì trục giữa) và trục "size" (trục còn lại)
    const etRoles = () => {
        const ax = etAxes();
        let row = ax.filter((a) => a.kind === 'color')[0] || null;
        let size = ax.filter((a) => a !== row && a.kind === 'size')[0] || null;
        const rest = ax.filter((a) => a !== row && a !== size);
        if (!size && rest.length) size = rest.shift();
        if (!row && rest.length) row = rest.shift();
        if (!row && !size && ax.length) size = ax[0];
        return { all: ax, row: row, size: size };
    };
    const etPriceHtml = (html) => {
        const t = stripHtml(S(html).replace(/<\/span>/g, '</span> '));
        const orig = t.match(/Original Price:\s*([$€£]\s?[\d.,]+)/i);
        const now = t.replace(/Original Price:\s*[$€£]\s?[\d.,]+\+?/i, '').match(/Price:\s*([$€£]\s?[\d.,]+)(\+?)/i);
        const p = now ? parsePrice(now[1]) : null;
        const o = orig ? parsePrice(orig[1]) : null;
        return p ? { value: p.value, currency: p.currency, from: !!now[2],
                     list: o && o.value > p.value ? o.value : null } : null;
    };
    const etListingId = () => (location.pathname.match(/\/listing\/(\d+)/) || [])[1] || '';
    const etFetch = async (ids) => {
        const u = '/api/v3/ajax/bespoke/member/listings/' + etListingId()
            + '/offerings/find-by-variations?channel=1&'
            + ids.map((i) => 'listing_variation_ids%5B%5D=' + encodeURIComponent(i)).join('&')
            + '&selected_quantity=1';
        const r = await fetch(u, { credentials: 'include', headers: {
            'x-etsy-protection': '1', 'X-Requested-With': 'XMLHttpRequest', 'Accept': '*/*' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    };
    // Lựa chọn đang xem theo URL: ?variation0=<id>&variation1=<id> (link Etsy khi đã chọn)
    const etUrlSel = () => {
        const out = {};
        [location.href, opts.url].forEach((u) => {
            let sp; try { sp = new URL(S(u), location.href).searchParams; } catch (e) { return; }
            sp.forEach((v, k) => { const m = k.match(/^variation(\d+)$/); if (m && v && !out[m[1]]) out[m[1]] = S(v); });
        });
        return out;
    };
    const etPrefetch = async () => {
        if (!etListingId()) return;
        const r = etRoles();
        const jobs = [];
        if (r.row && r.size) r.row.opts.forEach((o) => jobs.push([o.id]));
        const sel = etUrlSel();
        const selIds = Object.keys(sel).map((k) => sel[k]);
        if (selIds.length) jobs.push(selIds);          // giá đúng của tổ hợp trên link
        let i = 0;
        const worker = async () => {
            while (i < jobs.length) {
                const ids = jobs[i++];
                try {
                    const j = await etFetch(ids);
                    const tpl = document.createElement('template');
                    tpl.innerHTML = S(j.variations);
                    ET_API[ids.join('+')] = { price: etPriceHtml(j.price), axes: etAxesFrom(tpl.content) };
                } catch (e) { log('etsy api ' + ids.join('+') + ': ' + e.message); }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);   // 4 luồng
        log('etsy: nạp ' + Object.keys(ET_API).length + '/' + jobs.length + ' tổ hợp');
    };
    const etCurrent = () => {
        const r = etRoles();
        const sel = etUrlSel();
        const pick = (ax) => {
            if (!ax) return null;
            const id = sel[ax.index];
            return ax.opts.filter((o) => o.id === id)[0] || null;
        };
        return { row: pick(r.row), size: pick(r.size), roles: r, sel: sel };
    };
    const etPrice = () => {
        const sel = etUrlSel();
        const k = Object.keys(sel).map((x) => sel[x]).join('+');
        const hit = k && ET_API[k] && ET_API[k].price;
        if (hit) return hit;
        // Chưa chọn gì: giá "từ" của trang tính cả màu ĐÃ HẾT (listing 1672052042: "$6.65+" là
        // giá màu Hemp đang sold out, mọi màu còn bán từ $12.71) -> giá thấp nhất của màu CÒN bán
        const rowAx = etRoles().row;
        const soldIds = rowAx ? rowAx.opts.filter((o) => o.sold).map((o) => o.id) : [];
        const perColor = Object.keys(ET_API).filter((x) => x.indexOf('+') < 0 && soldIds.indexOf(x) < 0)
            .map((x) => ET_API[x].price).filter(Boolean).sort((a, b) => a.value - b.value);
        if (perColor.length) return Object.assign({}, perColor[0], { from: true });
        return etPriceHtml((document.querySelector('[data-selector="price-only"]') || {}).innerHTML || '')
            || (() => { const p = ldPrice(); return p ? { value: p.value, currency: p.currency, from: true, list: null } : null; })();
    };
    const etAllImagePanes = () => [].slice.call(document.querySelectorAll('[data-carousel-pane-list] li[data-image-id], li[data-carousel-pane][data-image-id]'))
        .map((li) => {
            const img = li.querySelector('img');
            const u = img && (img.getAttribute('data-src-zoom-image') || img.getAttribute('data-src') || img.currentSrc || img.src);
            return { id: S(li.getAttribute('data-image-id')), url: S(u).replace(/\/il_\d+x[N\d]+\./, '/il_fullxfull.') };
        }).filter((x) => x.url);
    const etImagesAll = () => {
        const panes = etAllImagePanes();
        if (panes.length) return panes.map((x) => x.url);
        const p = ldProduct();
        return ((p && p.image) || []).map((x) => (typeof x === 'string' ? x : (x.contentURL || x.url))).filter(Boolean);
    };
    const etColorImages = (optId) => {
        const ids = (etVarImageMap()[optId] || []).map(S);
        if (!ids.length) return [];
        const byId = {};
        etAllImagePanes().forEach((x) => { byId[x.id] = x.url; });
        return ids.map((id) => byId[id]).filter(Boolean);
    };
    const etImages = () => {
        const cur = etCurrent();
        const own = cur.row ? etColorImages(cur.row.id) : [];
        if (!own.length) return etImagesAll();
        // Ảnh riêng của màu đang xem trước, ảnh dùng chung (không gắn màu nào) sau
        const tagged = {};
        Object.keys(etVarImageMap()).forEach((k) => etColorImages(k).forEach((u) => { tagged[u] = 1; }));
        return own.concat(etImagesAll().filter((u) => !tagged[u] && own.indexOf(u) < 0));
    };
    const etDescSections = () => {
        const out = [];
        const d = document.querySelector('[data-product-details-description-text-content]');
        if (d) out.push({ title: 'Description', kind: 'description', el: d });
        else {
            const p = ldProduct();
            if (p && p.description) out.push({ title: 'Description', kind: 'description', html: textToHtml(decodeHtml(p.description)) });
        }
        const hl = [].slice.call(document.querySelectorAll('[data-selector="product-details-highlights"] li'))
            .map((li) => S(li.textContent).replace(/\s+/g, ' ').trim())
            .filter((t) => t && !/gift wrap|digital download|made to order|ships? from|dispatch/i.test(t));
        if (hl.length) out.push({ title: 'Highlights', kind: 'details',
            html: '<ul>' + hl.map((t) => '<li>' + escHtml(t) + '</li>').join('') + '</ul>' });
        return out;
    };
    // Listing đã gỡ/hết hạn: trang "Sorry, this item is unavailable." vẫn HTTP 200, không có
    // JSON-LD, phần dưới toàn sản phẩm GỢI Ý (giá gạch $395 của hàng khác) -> báo hết hàng.
    const etUnavailable = () => /item is unavailable/i.test(S(document.title))
        || !!document.querySelector('.nla-listing-image');
    const etNlaPrice = () => {
        const box = document.querySelector('.nla-listing-image');
        const grid = box && box.closest('.wt-grid');
        return grid ? parsePrice((S(grid.innerText).match(/[$€£]\s?[\d.,]+/) || [''])[0]) : null;
    };
    const etExtra = () => {
        if (etUnavailable()) {
            warnings.push('Etsy: listing đã ngừng bán ("Sorry, this item is unavailable.")');
            const p = etNlaPrice();
            return { in_stock: false, list_price: p ? p.value : null, colors: [], stock_matrix: [] };
        }
        const cur = etCurrent();
        const r = cur.roles;
        if (!r.all.length) {
            const pr0 = etPrice();
            return { in_stock: ldStock(), fit_guide_images: etSizeChartImages(),
                     list_price: pr0 ? (pr0.list || pr0.value) : null };
        }
        const sizeNames = r.size ? r.size.opts.map((o) => o.name) : [];
        const rows = r.row ? r.row.opts : [{ id: '', name: '', sold: false }];
        const matrix = [];
        const colorPrices = {}, colorCodes = {};
        rows.forEach((o) => {
            const api = o.id ? ET_API[o.id] : null;
            let inS = [];
            if (r.size) {
                if (api) {
                    const ax = api.axes.filter((a) => a.index === r.size.index)[0];
                    inS = ax ? ax.opts.filter((x) => !x.sold).map((x) => x.name) : [];
                } else {
                    // không gọi được API: chỉ biết màu hết hẳn hay không
                    inS = o.sold ? [] : r.size.opts.filter((x) => !x.sold).map((x) => x.name);
                }
                inS = sizeNames.filter((s) => inS.indexOf(s) >= 0);
            }
            if (o.sold) inS = [];
            const row = { color: r.row && r.row.kind === 'color' ? o.name : '',
                          variant: r.row && r.row.kind !== 'color' ? o.name : '',
                          sizes_in_stock: inS, sizes_out_of_stock: sizeNames.filter((s) => inS.indexOf(s) < 0) };
            matrix.push(row);
            if (r.row && r.row.kind === 'color') {
                colorCodes[o.name] = o.id;
                if (api && api.price) colorPrices[o.name] = { price: api.price.value, list_price: api.price.list };
            }
        });
        const curColor = cur.row && r.row.kind === 'color' ? cur.row.name : '';
        const curMid = cur.row && r.row.kind !== 'color' ? cur.row.name : '';
        const here = cur.row ? matrix.filter((m) => (m.color || m.variant) === cur.row.name)[0] : null;
        // Chưa chọn màu: size còn = size còn ở ÍT NHẤT 1 màu (đúng như dropdown size của trang)
        const anyIn = sizeNames.filter((s) => matrix.some((m) => m.sizes_in_stock.indexOf(s) >= 0));
        const inS = here ? here.sizes_in_stock : (r.row ? anyIn : (r.size ? r.size.opts.filter((x) => !x.sold).map((x) => x.name) : []));
        // Ảnh theo màu (nếu người bán gắn ảnh cho từng lựa chọn)
        const imageColors = {};
        const allImgs = [];
        if (r.row && r.row.kind === 'color') {
            r.row.opts.forEach((o) => etColorImages(o.id).forEach((u) => {
                if (allImgs.indexOf(u) < 0) allImgs.push(u);
                imageColors[u] = imageColors[u] && imageColors[u] !== o.name ? null : o.name;
            }));
        }
        Object.keys(imageColors).forEach((u) => { if (!imageColors[u]) delete imageColors[u]; });
        etImagesAll().forEach((u) => { if (allImgs.indexOf(u) < 0) allImgs.push(u); });
        const pr = etPrice();
        if (pr && pr.from) warnings.push('Link chưa chọn variant — giá là giá "từ" thấp nhất của listing ($' + pr.value + '+); giá từng màu xem color_prices.');
        const mids = r.all.filter((a) => a !== r.row && a !== r.size);
        return {
            current_color: curColor,
            color_label: r.row && r.row.kind === 'color' ? r.row.label : '',
            colors: r.row && r.row.kind === 'color' ? r.row.opts.map((o) => o.name) : [],
            size_label: r.size ? r.size.label : '',
            sizes: sizeNames,
            sizes_in_stock: inS,
            sizes_out_of_stock: sizeNames.filter((s) => inS.indexOf(s) < 0),
            variant_label: r.row && r.row.kind !== 'color' ? r.row.label : mids.map((a) => a.label).join(' / '),
            current_variant: curMid,
            stock_matrix: matrix,
            in_stock: r.size ? inS.length > 0 : ldStock(),
            // Không sale thì giá gốc = giá bán (KHÔNG để null: tầng chung sẽ đoán giá gạch từ
            // DOM và vớ phải giá gạch của sản phẩm quảng cáo "Similar items")
            list_price: pr ? (pr.list || pr.value) : null,
            all_images: allImgs,
            image_colors: imageColors,
            fit_guide_images: etSizeChartImages(),
            color_codes: colorCodes,
            color_prices: colorPrices,
        };
    };
    // Ảnh bảng size: alt/description của ảnh trong JSON-LD do Etsy sinh ("May include: Size chart...")
    const etSizeChartImages = () => {
        const p = ldProduct();
        return ((p && p.image) || []).filter((x) => x && typeof x === 'object'
            && /size (chart|guide)|measurement/i.test(S(x.description)))
            .map((x) => S(x.contentURL || x.url)).filter(Boolean);
    };

    // ================= AMAZON =================
    // ============================================================
    // AMAZON — kiểm chứng 2026-09-24 (IP US qua CDP)
    // ============================================================
    // Mỗi variant (màu × size) là 1 ASIN, 1 link riêng (/dp/<ASIN>) -> trang chỉ có đủ dữ
    // liệu của ASIN đang xem; màu khác chỉ có tên + ASIN + giá (theo size đang chọn) + 1 ảnh MAIN.
    //   · tiêu đề   #productTitle (h1 đầu trang là "Product summary ... shift + alt + D"
    //               của menu phím tắt -> tầng chung lấy nhầm)
    //   · brand     #bylineInfo "Visit the Bozspacer Store" / "Brand: Trendy Queen"
    //   · giá       JSON .twister-plus-buying-options-price-data (priceAmount); DOM .priceToPay
    //               (.a-offscreen của priceToPay có lúc RỖNG -> đọc phần aria-hidden)
    //   · giá gạch  .basisPrice ("List Price:" / "Typical price:") [data-a-strike] .a-offscreen
    //   · ảnh       script ImageBlockATF colorImages.initial[].hiRes (_AC_SL1500_) — màu đang xem
    //               script ImageBlockBTF colorImages {tên màu: [MAIN]} — 1 ảnh/màu cho màu khác
    //   · variant   script 'twister-js-init-dpx-data': dimensions / variationValues /
    //               selectedVariationValues / dimensionToAsinMap ("<i size>_<i màu>" -> ASIN)
    //               /variationDisplayLabels; size còn/hết: li[data-asin] của inline twister
    //               (data-csa-c-content-id ...swatchAvailable / swatchUnavailable)
    //   · mô tả     About this item (#feature-bullets ul | #productFactsDesktopExpander ul) +
    //               #productDescription + thông số (#prodDetails table / #detailBullets /
    //               .product-facts-detail) + bảng size (#a-popover-sizeGuide)
    // Phần dưới trang (#productDescription, #prodDetails) về SAU phần đầu 3-7s -> extra trả
    // null tới khi thấy phần đó (hoặc trang load xong).
    // Tường chặn: "Click the button below to continue shopping" (form validateCaptcha, KHÔNG có
    // ảnh captcha) -> tự submit form rồi poll lại; "Enter the characters you see below"
    // (có ảnh captcha) -> báo blocked.
    const amzScriptText = (needle, needle2) => {
        const s = [].slice.call(document.querySelectorAll('script'))
            .find((x) => S(x.textContent).indexOf(needle) >= 0
                && (!needle2 || S(x.textContent).indexOf(needle2) >= 0));
        return s ? S(s.textContent) : '';
    };
    // Giá trị JSON sau "key" : trong chữ script (object/array/chuỗi/số)
    const amzJsonAfter = (txt, key) => {
        const m = new RegExp('"' + key + '"\\s*:\\s*').exec(txt);
        if (!m) return null;
        const i = m.index + m[0].length;
        const ch = txt[i];
        let raw = '';
        if (ch === '{' || ch === '[') {
            // jsonObjectAt chỉ đếm {} -> tự đếm cả [] cho mảng
            let depth = 0, inStr = false, esc = false, j = i;
            for (; j < txt.length; j++) {
                const c = txt[j];
                if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
                if (c === '"') inStr = true;
                else if (c === '{' || c === '[') depth++;
                else if ((c === '}' || c === ']') && --depth === 0) break;
            }
            raw = txt.slice(i, j + 1);
        } else {
            const mm = /^("(?:[^"\\]|\\.)*"|-?[\d.]+|true|false|null)/.exec(txt.slice(i));
            raw = mm ? mm[1] : '';
        }
        try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    };
    let _amzTw;
    const amzTwister = () => {
        if (_amzTw !== undefined) return _amzTw;
        const txt = amzScriptText('twister-js-init-dpx-data', 'dimensionToAsinMap');
        if (!txt) { _amzTw = null; return null; }
        const get = (k) => amzJsonAfter(txt, k);
        _amzTw = {
            dims: get('dimensions') || [],
            values: get('variationValues') || {},
            selected: get('selectedVariationValues') || {},
            labels: get('variationDisplayLabels') || {},
            toAsin: get('dimensionToAsinMap') || {},
            display: get('dimensionValuesDisplayData') || {},
            asin: get('currentAsin') || '',
        };
        return _amzTw;
    };
    // jQuery.parseJSON('...') trong script ảnh: chuỗi JS nháy đơn -> bỏ \' trước khi JSON.parse
    const amzParseJsStr = (txt, start) => {
        const i = txt.indexOf("parseJSON('", start);
        if (i < 0) return null;
        const b = i + "parseJSON('".length;
        let j = b;
        while (j < txt.length && !(txt[j] === "'" && txt[j - 1] !== '\\')) j++;
        try { return JSON.parse(txt.slice(b, j).replace(/\\'/g, "'")); } catch (e) { return null; }
    };
    const amzImgUrl = (x) => S(x && (x.hiRes || x.large || (x.main && Object.keys(x.main).pop())));
    const amzImages = () => {
        const txt = amzScriptText('ImageBlockATF', "'initial'");
        const i = txt.indexOf("'initial'");
        const arr = i >= 0 ? amzParseJsStr(txt, i) : null;
        let list = (arr || []).map(amzImgUrl).filter(Boolean);
        if (!list.length) {
            // Dự phòng: data-a-dynamic-image của ảnh chính -> URL lớn nhất
            const el = document.querySelector('#landingImage[data-a-dynamic-image], #imgBlkFront[data-a-dynamic-image]');
            let dyn = {};
            try { dyn = JSON.parse(S(el && el.getAttribute('data-a-dynamic-image')) || '{}'); } catch (e) { dyn = {}; }
            const best = Object.keys(dyn).sort((a, b) => (dyn[b][0] || 0) - (dyn[a][0] || 0))[0];
            const hi = el && el.getAttribute('data-old-hires');
            list = [hi || best].filter(Boolean);
        }
        return list;
    };
    // {tên màu: [ảnh MAIN hi-res]} của mọi màu (ImageBlockBTF)
    const amzColorImages = () => {
        const txt = amzScriptText("register('ImageBlockBTF'");
        const o = txt ? amzParseJsStr(txt, txt.indexOf("register('ImageBlockBTF'")) : null;
        const ci = (o && o.colorImages) || {};
        const out = {};
        Object.keys(ci).forEach((c) => {
            out[c] = (ci[c] || []).map(amzImgUrl).filter(Boolean);
        });
        return { byColor: out, landing: S(o && o.landingAsinColor) };
    };

    const amzPriceOf = (root, sel) => {
        const el = root && root.querySelector(sel);
        if (!el) return null;
        const off = el.querySelector('.a-offscreen');
        let t = off ? S(off.textContent).trim() : '';
        if (!/\d/.test(t)) t = S(el.textContent).replace(/\s+/g, '');
        return parsePrice(t);
    };
    const AMZ_PRICE_BOX = '#corePriceDisplay_desktop_feature_div, #corePrice_desktop, #corePrice_feature_div, #apex_desktop';
    const amzPrice = () => {
        const el = document.querySelector('.twister-plus-buying-options-price-data');
        if (el) {
            try {
                const j = JSON.parse(S(el.textContent));
                const g = (j.desktop_buybox_group_1 || []).find((x) => x && x.priceAmount != null);
                if (g) return { value: Number(g.priceAmount), currency: S(g.currencySymbol) === '$' ? 'USD' : (parsePrice(g.displayPrice) || {}).currency || 'USD' };
            } catch (e) { /* bỏ */ }
        }
        const boxes = [].slice.call(document.querySelectorAll(AMZ_PRICE_BOX));
        for (let i = 0; i < boxes.length; i++) {
            const p = amzPriceOf(boxes[i], '.priceToPay, .apexPriceToPay, .a-price:not([data-a-strike])');
            if (p) return p;
        }
        const inp = document.querySelector('#twister-plus-price-data-price');
        return inp ? parsePrice(inp.value) : null;
    };
    const amzListPrice = (price) => {
        const boxes = [].slice.call(document.querySelectorAll(AMZ_PRICE_BOX));
        for (let i = 0; i < boxes.length; i++) {
            const p = amzPriceOf(boxes[i], '.basisPrice [data-a-strike="true"], .a-text-price[data-a-strike="true"]');
            if (p && (price == null || p.value > price)) return p.value;
        }
        return null;
    };
    const amzBrand = () => {
        let b = S((document.querySelector('#bylineInfo') || {}).textContent).replace(/\s+/g, ' ').trim();
        b = b.replace(/^Visit the\s+/i, '').replace(/\s+Store$/i, '').replace(/^Brand:\s*/i, '').trim();
        if (b) return b;
        const row = amzDetailRows().find((r) => /^(brand|brand name|manufacturer)$/i.test(r[0]));
        return row ? row[1] : '';
    };
    const amzClean = (s) => S(s).replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();
    // Dòng thông số: bỏ dòng của Amazon (ASIN, xếp hạng, review, ngày lên sàn, bảo hành...)
    const AMZ_SKIP_ROW = /^(asin|best sellers rank|customer reviews|date first available|warranty|feedback|product warranty|is discontinued by manufacturer|global trade identification number|upc|ean)/i;
    const amzDetailRows = () => {
        const rows = [];
        const seen = {};
        const add = (k, v) => {
            k = amzClean(k).replace(/\s*:\s*$/, ''); v = amzClean(v);
            if (!k || !v || AMZ_SKIP_ROW.test(k) || seen[k.toLowerCase()]) return;
            seen[k.toLowerCase()] = 1;
            rows.push([k, v]);
        };
        // "Top highlights" (thời trang)
        document.querySelectorAll('#productFactsDesktopExpander .product-facts-detail').forEach((d) => {
            add(S((d.querySelector('.a-col-left') || {}).textContent), S((d.querySelector('.a-col-right') || {}).textContent));
        });
        // #productOverview_feature_div (bảng tóm tắt thông số hàng gia dụng/điện tử)
        document.querySelectorAll('#productOverview_feature_div tr').forEach((tr) => {
            const td = tr.querySelectorAll('td');
            if (td.length >= 2) add(td[0].textContent, td[1].textContent);
        });
        // "Product information" (bảng th/td, nằm trong expander ẩn -> textContent)
        document.querySelectorAll('#prodDetails table tr, #productDetails_techSpec_section_1 tr, '
            + '#productDetails_detailBullets_sections1 tr').forEach((tr) => {
            const th = tr.querySelector('th'), td = tr.querySelector('td');
            if (th && td) add(th.textContent, td.textContent);
        });
        // "Product details" dạng gạch đầu dòng (thời trang, sách)
        document.querySelectorAll('#detailBullets_feature_div li').forEach((li) => {
            const k = li.querySelector('.a-text-bold');
            if (!k) return;
            const v = S(li.textContent).slice(S(li.textContent).indexOf(S(k.textContent)) + S(k.textContent).length);
            add(k.textContent, v);
        });
        return rows;
    };
    const amzBulletsEl = () => {
        const fb = document.querySelector('#feature-bullets ul');
        if (fb && S(fb.textContent).trim()) return fb;
        const h = [].slice.call(document.querySelectorAll('#productFactsDesktopExpander h3, #productFactsDesktop_feature_div h3'))
            .find((x) => /about this item/i.test(x.textContent));
        let n = h && h.nextElementSibling;
        while (n && n.tagName !== 'UL') n = n.nextElementSibling;
        return n || null;
    };
    const amzDescSections = () => {
        const out = [];
        const bl = amzBulletsEl();
        // el = <ul> thì cleanHtml bỏ vỏ -> <li> mồ côi; đưa cả thẻ <ul> dạng chuỗi
        if (bl) out.push({ title: 'About this item', kind: 'description', html: '<ul>' + bl.innerHTML + '</ul>' });
        const pd = document.querySelector('#productDescription');
        if (pd && S(pd.textContent).trim().length > 20) out.push({ title: 'Product Description', kind: 'description', el: pd });
        const rows = amzDetailRows();
        if (rows.length) out.push({ title: 'Product Details', kind: 'details', html: specTableHtml(rows) });
        const sc = document.querySelector('#a-popover-sizeGuide .fit-sizechartv2-tables-wrapper, #a-popover-sizeGuide table');
        if (sc && sc.querySelector('table')) {
            // BẪY cleanHtml: <tr> chỉ chứa td/th bị coi là "khối lá", chữ cả hàng
            // "XS (0-2) 36.2 23.2 11.9 15.4" khớp mẫu SĐT (>= 8 chữ số) -> mất hết hàng số đo.
            // Bọc nội dung từng ô trong <div> để hàng không còn là khối lá.
            const box = (sc.closest('.fit-sizechartv2-tables-wrapper') || sc).cloneNode(true);
            box.querySelectorAll('td, th').forEach((c) => { c.innerHTML = '<div>' + c.innerHTML + '</div>'; });
            out.push({ title: 'Size Chart', kind: 'size_fit', el: box });
        }
        return out;
    };
    const amzDescText = () => {
        const bl = amzBulletsEl();
        const parts = [];
        if (bl) parts.push([].slice.call(bl.querySelectorAll('li')).map((li) => '• ' + amzClean(li.textContent)).filter((x) => x.length > 2).join('\n'));
        const pd = document.querySelector('#productDescription');
        if (pd) parts.push(nodeText(pd));
        return parts.filter(Boolean).join('\n\n');
    };

    let _amzWall = '';
    const amzPrefetch = async () => {
        const form = document.querySelector('form[action*="validateCaptcha"]');
        if (!form) return;
        const txt = S(document.body && document.body.innerText);
        if (form.querySelector('img[src*="captcha" i], input#captchacharacters') || /characters you see/i.test(txt)) {
            _amzWall = S(txt).replace(/\s+/g, ' ').slice(0, 120);
            return;
        }
        // "Continue shopping": bấm là Amazon ghi cookie rồi chuyển tới amzn-r -> trỏ về đúng trang này
        const r = form.querySelector('input[name="amzn-r"]');
        if (r) r.value = location.pathname + location.search;
        _amzWall = 'continue';
        log('amazon: gặp trang "Continue shopping" -> tự bấm rồi chờ trang sản phẩm');
        setTimeout(() => { try { form.submit(); } catch (e) { /* bỏ */ } }, 50);
    };

    const amzExtra = () => {
        if (_amzWall === 'continue') return null;
        if (_amzWall) {
            warnings.unshift('Amazon hiện captcha (không tự vượt được): ' + _amzWall);
            return { blocked: true, ok: false };
        }
        // Phần dưới trang chưa về -> chờ (trừ khi trang đã load xong mà vẫn không có)
        const btf = document.querySelector('#productDescription_feature_div, #prodDetails, #detailBullets_feature_div, #productDetails_feature_div');
        if (!btf && document.readyState !== 'complete') return null;

        const out = {};
        const tw = amzTwister();
        // #availability chứa cả <script> JSON (isRobot/merchantId...) -> textContent dính rác
        const avEl = document.querySelector('#availability');
        const avail = avEl ? amzClean(S(avEl.innerText).trim() || [].slice.call(avEl.querySelectorAll('span'))
            .map((x) => x.textContent).join(' ')) : '';
        const oos = /currently unavailable|out of stock|temporarily unavailable|not available/i.test(avail)
            || !!document.querySelector('#outOfStock, #outOfStockBuyBox_feature_div #outOfStock');
        out.in_stock = oos ? false : (/in stock|left in stock|available|ships|usually/i.test(avail) || amzPrice() != null ? true : null);
        out.list_price = amzListPrice((amzPrice() || {}).value);
        out.size_guide_button = document.querySelector('#sizeChartV2Data_feature_div a.a-popover-trigger')
            ? '#sizeChartV2Data_feature_div a.a-popover-trigger' : '';

        if (!tw || !tw.dims.length) {
            if (avail) log('amazon: không có variant, availability = ' + avail);
            return out;
        }
        const lab = (d) => S(tw.labels[d] || d.replace(/_name$/, '').replace(/_/g, ' ')).trim();
        const colorD = tw.dims.find((d) => /colou?r/i.test(d + ' ' + lab(d)));
        const sizeD = tw.dims.find((d) => d !== colorD && /size/i.test(d + ' ' + lab(d)));
        const otherD = tw.dims.find((d) => d !== colorD && d !== sizeD);
        const valOf = (d) => {
            const i = tw.selected[d];
            const arr = tw.values[d] || [];
            if (i != null && arr[i] != null) return S(arr[i]);
            const disp = tw.display[tw.asin];
            return disp ? S(disp[tw.dims.indexOf(d)]) : '';
        };
        // Tổ hợp có thật: dimensionToAsinMap "i_j" theo đúng thứ tự tw.dims
        const combos = Object.keys(tw.toAsin).map((k) => {
            const idx = k.split('_').map(Number);
            const o = { asin: tw.toAsin[k] };
            tw.dims.forEach((d, n) => { o[d] = S((tw.values[d] || [])[idx[n]]); });
            return o;
        });
        const curColor = colorD ? valOf(colorD) : '';
        if (colorD) {
            out.color_label = lab(colorD);
            out.colors = (tw.values[colorD] || []).map(S);
            out.current_color = curColor;
        }
        if (otherD) {
            out.variant_label = lab(otherD);
            out.current_variant = valOf(otherD);
            out.variants = (tw.values[otherD] || []).map((v) => lab(otherD) + ':' + v);
        }
        // Swatch của inline twister: trạng thái còn/hết theo tổ hợp đang chọn
        const swatchState = (d) => {
            const st = {};
            document.querySelectorAll('#inline-twister-row-' + d + ' li[data-asin], #variation_' + d + ' li[data-defaultasin], #variation_' + d + ' li[data-asin]').forEach((li) => {
                const asin = S(li.getAttribute('data-asin') || li.getAttribute('data-defaultasin'));
                const cid = S(li.getAttribute('data-csa-c-content-id')) + ' ' + S(li.className);
                const bad = /swatchUnavailable|Unavailable/i.test(cid) || li.getAttribute('data-initiallyunavailable') === 'true';
                if (asin) st[asin] = !bad;
            });
            // dropdown kiểu cũ
            document.querySelectorAll('select[name="dropdown_selected_' + d + '"] option').forEach((o) => {
                const v = S(o.getAttribute('value')).split(',').pop();
                if (v && /^[A-Z0-9]{10}$/.test(v)) st[v] = !/Unavailable/i.test(S(o.className));
            });
            return st;
        };
        if (sizeD) {
            const sizes = (tw.values[sizeD] || []).map(S);
            const st = swatchState(sizeD);
            const mine = combos.filter((c) => (!colorD || c[colorD] === curColor)
                && (!otherD || c[otherD] === out.current_variant));
            const ok = [], bad = [];
            sizes.forEach((s) => {
                const c = mine.find((x) => x[sizeD] === s);
                const good = c && (st[c.asin] !== undefined ? st[c.asin] : true);
                (good ? ok : bad).push(s);
            });
            // Size đang xem mà ASIN này hết hàng -> đưa sang hết
            const curSize = valOf(sizeD);
            if (oos && ok.indexOf(curSize) >= 0) { ok.splice(ok.indexOf(curSize), 1); bad.push(curSize); }
            out.size_label = lab(sizeD);
            out.sizes = sizes;
            out.sizes_in_stock = ok;
            out.sizes_out_of_stock = sizes.filter((s) => ok.indexOf(s) < 0);
            out.stock_matrix = [{ color: curColor, variant: out.current_variant || '',
                                  sizes_in_stock: ok.slice(), sizes_out_of_stock: out.sizes_out_of_stock.slice() }];
            if (out.in_stock !== false && !ok.length) out.in_stock = false;
            // Size CÓ BÁN theo từng màu (chưa biết còn/hết — muốn biết phải mở link màu đó)
            if (colorD) {
                const offered = {};
                (tw.values[colorD] || []).forEach((c) => {
                    offered[c] = sizes.filter((s) => combos.some((x) => x[colorD] === c && x[sizeD] === s));
                });
                out.color_sizes_offered = offered;
            }
        }
        // Theo màu: ASIN (link /dp/<ASIN>), giá + còn hàng hiện trên swatch (theo size đang chọn)
        if (colorD) {
            const codes = {}, prices = {};
            combos.forEach((c) => {
                if (!codes[c[colorD]] || (sizeD && c[sizeD] === valOf(sizeD))) codes[c[colorD]] = c.asin;
            });
            document.querySelectorAll('#inline-twister-row-' + colorD + ' li[data-asin]').forEach((li) => {
                const asin = S(li.getAttribute('data-asin'));
                const name = Object.keys(codes).find((k) => codes[k] === asin)
                    || S((li.querySelector('img[alt]') || {}).alt || (li.querySelector('.swatch-title-text-display') || {}).textContent).trim();
                if (!name) return;
                codes[name] = asin;
                const slot = li.querySelector('.dimension-slot-info, [id^=dimension-slot-info]');
                if (!slot) return;
                const p = amzPriceOf(slot, '.apex-pricetopay-value, .a-price:not([data-a-strike])');
                const lp = amzPriceOf(slot, '[data-a-strike="true"]');
                if (p) prices[name] = { price: p.value, list_price: lp && lp.value > p.value ? lp.value : null };
            });
            out.color_codes = codes;
            if (Object.keys(prices).length) out.color_prices = prices;
            // Ảnh: màu đang xem = gallery đầy đủ; màu khác = 1 ảnh MAIN
            const ci = amzColorImages();
            const cur = amzImages();
            const all = cur.slice(), map = {};
            cur.forEach((u) => { map[u] = curColor; });
            Object.keys(ci.byColor).forEach((c) => {
                if (c === curColor) return;
                ci.byColor[c].forEach((u) => { if (all.indexOf(u) < 0) { all.push(u); map[u] = c; } });
            });
            out.all_images = all;
            out.image_colors = map;
        }
        log('amazon: ' + tw.dims.join('/') + ', màu ' + (curColor || '-') + ', ' + combos.length
            + ' ASIN, availability "' + avail + '"');
        return out;
    };

    // ================= EBAY =================
    // ============================================================
    // EBAY — kiểm chứng 2026-09-24 (IP US qua CDP)
    // ============================================================
    // Trang /itm/<id> chung 1 link cho MỌI variation (?var=<variationId> chỉ chọn sẵn 1 dòng).
    // Dữ liệu nằm trong 1 <script> lớn dạng {"MODULE_NAME":{"_type":...}} (Marko state):
    //   · TITLE / h1.x-item-title__mainTitle — JSON-LD name dính "<wbr/>" -> không dùng
    //   · BUY_BOX.binModel.price.value {value, currency}; giá gạch = span có styles
    //     STRIKETHROUGH trong binModel.additionalInfo ("List price US $64.99" / "Was")
    //   · PICTURE.mediaList[].image.zoomImg.URL (s-l1600.webp -> đổi .jpg, JSON-LD chỉ 5 ảnh)
    //   · MSKU (VariationViewModel): selectMenus[{displayLabel, menuItemValueIds}],
    //     menuItemMap{valueId: {valueName, matchingVariationIds, outOfStock}},
    //     variationsMap{vid: {binModel.price, quantity.outOfStock}},
    //     menuItemPictureIndexMap{valueId: [chỉ số ảnh trong mediaList]}, selectedVariationId
    //   · ABOUT_THIS_ITEM = "Item specifics" (labels/values) -> bảng details + Brand
    //   · Mô tả người bán nằm trong iframe #desc_ifr (itm.ebaydesc.com) KHÁC origin: fetch()
    //     trong trang bị CORS chặn ("Failed to fetch"), contentDocument = null. Python/
    //     extension tải https://itm.ebaydesc.com/itmdesc/<id> (không cần cookie, ~0.6s, không
    //     bị chặn kể cả IP VN) rồi truyền vào opts.descHtml.
    let _ebTxt;
    const ebStateText = () => {
        if (_ebTxt !== undefined) return _ebTxt;
        const s = [].slice.call(document.querySelectorAll('script'))
            .find((x) => S(x.textContent).indexOf('"PICTURE":{"_type"') >= 0
                || S(x.textContent).indexOf('"BUY_BOX":{"_type"') >= 0);
        _ebTxt = s ? S(s.textContent) : '';
        return _ebTxt;
    };
    const _ebMods = {};
    const ebModule = (name) => {
        if (name in _ebMods) return _ebMods[name];
        const txt = ebStateText();
        const key = '"' + name + '":{"_type"';
        const i = txt.indexOf(key);
        let o = null;
        if (i >= 0) {
            try { o = JSON.parse(jsonObjectAt(txt, i + name.length + 3)); } catch (e) { o = null; }
        }
        _ebMods[name] = o;
        return o;
    };
    const ebSpans = (td) => ((td && td.textSpans) || []).map((s) => S(s.text)).join('').replace(/\s+/g, ' ').trim();
    const ebStrike = (bin) => {
        let v = null;
        ((bin && bin.additionalInfo) || []).forEach((ai) => {
            ((ai.additionalText && ai.additionalText.textSpans) || []).forEach((s) => {
                if ((s.styles || []).indexOf('STRIKETHROUGH') >= 0 && v == null) {
                    const p = parsePrice(s.text);
                    if (p) v = p.value;
                }
            });
        });
        return v;
    };
    const ebItemId = () => {
        const m = S(location.pathname).match(/\/itm\/(?:[^/]+\/)?(\d{9,})/);
        return m ? m[1] : '';
    };
    // Ảnh gallery theo đúng thứ tự mediaList (menuItemPictureIndexMap trỏ vào chỉ số này)
    const ebGallery = () => {
        const pic = ebModule('PICTURE');
        const out = [];
        ((pic && pic.mediaList) || []).forEach((m) => {
            const im = m && m.image;
            const u = S(im && ((im.zoomImg && im.zoomImg.URL) || (im.largeImg && im.largeImg.URL)
                || (im.originalImg && im.originalImg.URL)));
            out.push(u ? u.replace(/\/s-l\d+\.(webp|jpe?g|png)(\?.*)?$/i, '/s-l1600.jpg') : '');
        });
        if (!out.filter(Boolean).length) {
            document.querySelectorAll('.ux-image-carousel-item img').forEach((img) => {
                const u = S(img.getAttribute('data-zoom-src') || img.getAttribute('data-src') || img.src);
                if (u) out.push(u.replace(/\/s-l\d+\.(webp|jpe?g|png)$/i, '/s-l1600.jpg'));
            });
        }
        return out;
    };
    // [[nhãn, giá trị]] của Item specifics
    const ebSpecifics = () => {
        const rows = [];
        const mod = ebModule('ABOUT_THIS_ITEM');
        const secs = (mod && mod.sections) || {};
        Object.keys(secs).forEach((sk) => {
            const items = (secs[sk] && secs[sk].dataItems) || {};
            Object.keys(items).forEach((ik) => {
                const it = items[ik];
                const label = ebSpans(it && it.labels && it.labels[0]);
                const vals = [];
                ((it && it.values) || []).forEach((v) => {
                    const tds = v.textualDisplays || [v];
                    tds.forEach((td) => {
                        // bỏ span là link ("See all condition definitions")
                        const t = ((td && td.textSpans) || []).filter((s) => !s.action)
                            .map((s) => S(s.text)).join('').replace(/\s+/g, ' ').trim();
                        if (t) vals.push(t);
                    });
                });
                let val = vals.join(', ');
                // "New with tags: This item is brand new..." -> "New with tags"
                if (/^condition$/i.test(label)) val = val.split(':')[0].trim();
                if (label && val) rows.push([label, val]);
            });
        });
        if (!rows.length) {
            document.querySelectorAll('.ux-layout-section-evo .ux-labels-values, .ux-layout-section__item .ux-labels-values').forEach((lv) => {
                const k = S((lv.querySelector('.ux-labels-values__labels') || {}).textContent).trim();
                const v = S((lv.querySelector('.ux-labels-values__values') || {}).textContent).replace(/\s+/g, ' ').trim();
                if (k && v) rows.push([k, v]);
            });
        }
        return rows;
    };
    const EB_NO_BRAND = /^(unbranded|unbranded\/generic|generic|no brand|none|n\/a|does not apply)$/i;
    const ebBrand = () => {
        const r = ebSpecifics().find((x) => /^brand$/i.test(x[0]));
        const b = r ? r[1].trim() : '';
        return EB_NO_BRAND.test(b) ? '' : b;
    };
    const ebTitle = () => {
        const h = document.querySelector('h1.x-item-title__mainTitle, .x-item-title__mainTitle, h1');
        const t = h ? S(h.innerText || h.textContent).replace(/\s+/g, ' ').trim() : '';
        if (t) return t;
        const tm = ebModule('TITLE');
        return tm ? ebSpans(tm.title) : '';
    };
    let _ebDesc;
    const ebDescDoc = () => {
        if (_ebDesc === undefined) _ebDesc = ebDescDocBuild();
        return _ebDesc;
    };
    const ebDescDocBuild = () => {
        const html = S(opts.descHtml);
        if (!html) return null;
        const d = new DOMParser().parseFromString(html, 'text/html');
        const root = d.querySelector('.x-item-description-child, #ds_div') || d.body;
        // Template cửa hàng eBay: menu "Store Pages / Store Categories / Home / View All
        // Listings..." toàn link -> bỏ khối nào mà chữ gần như toàn là chữ của link
        const linkDense = (el) => {
            const t = S(el.textContent).replace(/\s+/g, '').length;
            if (!t) return false;
            const a = [].slice.call(el.querySelectorAll('a')).reduce((n, x) => n + S(x.textContent).replace(/\s+/g, '').length, 0);
            return a / t > 0.7;
        };
        [].slice.call(root.querySelectorAll('nav, ul, ol, table, div, p')).reverse().forEach((el) => {
            if (el.isConnected && linkDense(el)) el.remove();
        });
        root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
            if (/^(store (pages|categories)|categories|newsletter|sign up|visit (our|my) store|about us|contact us|feedback)$/i
                .test(S(h.textContent).trim())) h.remove();
        });
        return root;
    };

    // Toàn bộ variation: {axes, vars[{vid, values{label: value}, price, list_price, oos}]}
    const ebVariations = () => {
        const ms = ebModule('MSKU');
        if (!ms || !ms.selectMenus || !ms.selectMenus.length) return null;
        const items = ms.menuItemMap || {};
        const axes = ms.selectMenus.map((m) => ({
            label: S(m.displayLabel).trim(),
            values: (m.menuItemValueIds || []).map((id) => items[id]).filter(Boolean)
                .map((it) => S(it.valueName || it.displayName).trim()),
        }));
        const byVid = {};
        ms.selectMenus.forEach((m) => {
            (m.menuItemValueIds || []).forEach((id) => {
                const it = items[id];
                if (!it) return;
                (it.matchingVariationIds || []).forEach((vid) => {
                    const v = byVid[vid] = byVid[vid] || { vid: S(vid), values: {} };
                    v.values[S(m.displayLabel).trim()] = S(it.valueName || it.displayName).trim();
                });
            });
        });
        const vars = Object.keys(byVid).map((vid) => {
            const v = byVid[vid];
            const vm = (ms.variationsMap || {})[vid] || {};
            const pr = vm.binModel && vm.binModel.price && vm.binModel.price.value;
            v.price = pr && pr.value != null ? Number(pr.value) : null;
            v.currency = S(pr && pr.currency) || 'USD';
            v.list_price = ebStrike(vm.binModel);
            v.oos = !!(vm.quantity && vm.quantity.outOfStock);
            return v;
        });
        const pics = {};
        const gal = ebGallery();
        Object.keys(ms.menuItemPictureIndexMap || {}).forEach((id) => {
            const it = items[id];
            if (!it) return;
            pics[S(it.valueName || it.displayName).trim()] = (ms.menuItemPictureIndexMap[id] || [])
                .map((i) => gal[i]).filter(Boolean);
        });
        return { axes: axes, vars: vars, pics: pics, selected: S(ms.selectedVariationId) };
    };
    const ebCurrentVid = (vv) => {
        let v = '';
        [location.href, opts.url].forEach((u) => {
            try { if (!v) v = S(new URL(S(u), location.href).searchParams.get('var')); } catch (e) { /* bỏ */ }
        });
        if (v && vv.vars.some((x) => x.vid === v)) return v;
        return vv.selected && vv.selected !== '-1' ? vv.selected : '';
    };

    const ebExtra = () => {
        if (!ebStateText()) return null;
        const out = {};
        const bb = ebModule('BUY_BOX');
        out.list_price = ebStrike(bb && bb.binModel);
        const alerts = JSON.stringify(ebModule('ALERT_MESSAGES') || {});
        const ended = /listing (was )?ended|no longer available|this item is out of stock|sold on /i.test(alerts)
            || /This listing (was ended|sold on)|no longer available/i.test(S((document.querySelector('.d-statusmessage, [data-testid="d-statusmessage"], .ux-message') || {}).textContent));
        const q = ebModule('QUANTITY');
        const qOut = !!(q && q.outOfStock);
        out.in_stock = !(ended || qOut);
        const iid = ebItemId();
        if (iid) out.description_url = 'https://itm.ebaydesc.com/itmdesc/' + iid;
        const dd = ebDescDoc();
        if (dd) {
            out.description_images = [].slice.call(dd.querySelectorAll('img[src]'))
                .map((i) => S(i.getAttribute('src'))).filter((u) => /^https?:/i.test(u));
        }
        if (ended) warnings.push('Listing eBay đã kết thúc / hết hàng.');

        const vv = ebVariations();
        const gal = ebGallery().filter(Boolean);
        if (!vv) {
            // Listing 1 variant: màu / size lấy từ Item specifics (Color: Black, Size: XL)
            const spec = ebSpecifics();
            const sv = (re) => { const r = spec.find((x) => re.test(x[0])); return r ? r[1] : ''; };
            const c = sv(/^(colou?r|main colou?r)$/i), sz = sv(/^size$/i);
            if (c) { out.color_label = 'Color'; out.colors = [c]; out.current_color = c; }
            if (sz) {
                out.size_label = 'Size'; out.sizes = [sz];
                out.sizes_in_stock = out.in_stock ? [sz] : [];
                out.sizes_out_of_stock = out.in_stock ? [] : [sz];
            }
            return out;
        }

        const colorA = vv.axes.find((a) => /colou?r/i.test(a.label));
        const sizeA = vv.axes.find((a) => a !== colorA && /size/i.test(a.label));
        const otherA = vv.axes.find((a) => a !== colorA && a !== sizeA);
        const inStockVars = vv.vars.filter((v) => !v.oos);
        const curVid = ebCurrentVid(vv);
        const curVar = vv.vars.find((v) => v.vid === curVid) || null;
        // Link không chọn sẵn variation -> lấy màu (trục giữa) đầu tiên còn hàng
        const pickVar = curVar || inStockVars[0] || vv.vars[0];
        if (!curVar) log('ebay: link không có ?var= -> lấy variation còn hàng đầu tiên làm "đang xem"');
        const cur = (a) => (a && pickVar ? S(pickVar.values[a.label]) : '');
        const curColor = cur(colorA), curOther = cur(otherA);

        if (colorA) {
            out.color_label = colorA.label;
            out.colors = colorA.values.slice();
            out.current_color = curColor;
        }
        if (otherA) {
            out.variant_label = otherA.label;
            out.current_variant = curOther;
            out.variants = otherA.values.map((v) => otherA.label + ':' + v);
        }
        // Giá: variation đang chọn -> thấp nhất trong các variation còn hàng của màu đang xem
        const mineVars = vv.vars.filter((v) => (!colorA || v.values[colorA.label] === curColor)
            && (!otherA || v.values[otherA.label] === curOther));
        const priced = (list) => list.filter((v) => v.price != null).sort((a, b) => a.price - b.price)[0];
        const pv = curVar || priced(mineVars.filter((v) => !v.oos)) || priced(mineVars);
        if (pv && pv.price != null) {
            out.price_override = pv.price;
            if (pv.list_price && pv.list_price > pv.price) out.list_price = pv.list_price;
        }

        if (sizeA) {
            const sizes = sizeA.values.slice();
            const okFor = (c, o) => sizes.filter((s) => vv.vars.some((v) => !v.oos && v.values[sizeA.label] === s
                && (!colorA || v.values[colorA.label] === c) && (!otherA || v.values[otherA.label] === o)));
            const ok = okFor(curColor, curOther);
            out.size_label = sizeA.label;
            out.sizes = sizes;
            out.sizes_in_stock = ok;
            out.sizes_out_of_stock = sizes.filter((s) => ok.indexOf(s) < 0);
            const matrix = [];
            (colorA ? colorA.values : ['']).forEach((c) => {
                (otherA ? otherA.values : ['']).forEach((o) => {
                    const k = okFor(c, o);
                    matrix.push({ color: c, variant: o, sizes_in_stock: k, sizes_out_of_stock: sizes.filter((s) => k.indexOf(s) < 0) });
                });
            });
            out.stock_matrix = matrix;
            out.in_stock = out.in_stock && ok.length > 0;
        } else {
            out.in_stock = out.in_stock && mineVars.some((v) => !v.oos);
        }

        if (colorA) {
            const codes = {}, prices = {};
            colorA.values.forEach((c) => {
                const list = vv.vars.filter((v) => v.values[colorA.label] === c);
                const first = list.find((v) => !v.oos) || list[0];
                if (first) codes[c] = first.vid;       // link: /itm/<id>?var=<vid>
                const p = priced(list.filter((v) => !v.oos)) || priced(list);
                if (p) prices[c] = { price: p.price, list_price: p.list_price && p.list_price > p.price ? p.list_price : null };
            });
            out.color_codes = codes;
            out.color_prices = prices;
            // Ảnh: ảnh gắn riêng cho màu (menuItemPictureIndexMap) + ảnh chung không gắn màu nào
            const own = {};
            Object.keys(vv.pics).forEach((c) => { vv.pics[c].forEach((u) => { own[u] = c; }); });
            const shared = gal.filter((u) => !own[u]);
            const mine = (vv.pics[curColor] || []).concat(shared);
            out.images_override = mine;
            out.all_images = gal;
            out.image_colors = own;
        }
        log('ebay: ' + vv.axes.map((a) => a.label + '(' + a.values.length + ')').join(' x ') + ', ' + vv.vars.length
            + ' variation (' + inStockVars.length + ' còn), đang xem ' + (curColor || '-') + '/' + (curOther || '-')
            + (curVar ? ' [var=' + curVid + ']' : ''));
        return out;
    };
    let _ebEx;
    const ebExtraCached = () => {
        if (_ebEx === undefined) _ebEx = ebExtra();
        return _ebEx;
    };
    const ebDescSections = () => {
        const out = [];
        const dd = ebDescDoc();
        if (dd && S(dd.textContent).trim().length > 10) out.push({ title: 'Item description from the seller', kind: 'description', el: dd });
        const rows = ebSpecifics();
        // Mô tả người bán chỉ toàn ảnh / chưa tải được -> Item specifics làm luôn phần mô tả
        // (nếu không tầng chung lấy og:description = câu SEO "Find many great new & used
        // options and get the best deals for ... at eBay!")
        if (rows.length) out.push({ title: 'Item specifics', kind: out.length ? 'details' : 'description', html: specTableHtml(rows) });
        return out;
    };

    const ADAPTERS = {
        // --- Shopify: lấy thẳng /products/<handle>.js, đủ và đúng thứ tự ---
        'bando.com': { shopify: true },
        'oglmove.com': { shopify: true },

        // --- Free People (URBN, app Vue) — xem khối FREE PEOPLE ở trên ---
        // Mỗi màu 1 link riêng (?color=011) nên định danh chỉ cần màu; size dùng chung link.
        'freepeople.com': {
            ready: 'script#urbnInitialPiniaState',
            identity: 'color',
            title: () => {
                const p = fpProduct();
                if (p && p.displayName) return decodeHtml(p.displayName);
                const ld = ldProduct();
                return ld ? decodeHtml(ld.name) : selText('h1');
            },
            // salePriceLow của màu đang xem; state chưa có thì JSON-LD
            price: () => {
                const si = fpSkuInfo();
                const v = si && si.salePriceLow;
                if (v != null && isFinite(Number(v))) return { value: Number(v), currency: 'USD' };
                return ldPrice();
            },
            description: () => fpDescription() || ldDesc(),
            extra: () => fpExtra(),
            images: () => {
                const list = fpImagesOf(fpCurrentColorItem());
                return list.length ? list : ldImages();
            },
        },

        // --- Crate & Barrel — xem khối CRATE & BARREL ở trên ---
        // Mỗi màu/kích thước là 1 SKU 1 link riêng -> định danh theo variant.
        'crateandbarrel.com': {
            ready: 'h1.product-name, .details-description',
            identity: 'variant',
            brand: '',                       // site đa hãng, JSON-LD chỉ trả tên nhà bán lẻ
            title: () => selText('h1.product-name')
                || (() => { const p = ldProduct(); return p ? decodeHtml(p.name) : ''; })()
                || selText('h1'),
            price: () => parsePrice(meta('og:price:amount'))
                || cbMainPrice('.salePrice') || ldPrice(),
            description: () => cbDescription(),
            extra: () => cbExtra(),
            images: () => cbImages(),
        },

        // --- Staples ---
        // BẪY: JSON-LD chỉ trả 1 ảnh (thực tế 9) và description là câu SEO rác
        // "Get ... fast at Staples. Free next-day delivery..." -> KHÔNG dùng.
        // Ảnh đủ nằm ở thumbnails (size 90px), chỉ cần đổi wid/hei.
        'staples.com': {
            ready: '[class*=thumbnails_container] img, [class*=image_element_wrapper] img',
            identity: 'variant',             // mỗi variant 1 link riêng
            title: () => selText('h1'),
            price: () => {
                // finalPrice của sku đang xem trong __NEXT_DATA__ chuẩn hơn JSON-LD
                const st = staplesState();
                const item = st && st.skuData && st.skuData.items && st.skuData.items[0];
                const pi = item && item.price && item.price.item && item.price.item[0];
                if (pi && pi.finalPrice != null && isFinite(Number(pi.finalPrice))) {
                    return { value: Number(pi.finalPrice), currency: 'USD' };
                }
                return ldPrice();
            },
            extra: () => staplesExtra(),
            description: () => selTextBest('[class*=product-details-ux2dot0__detail_container]'),
            descriptionSections: () => staplesDescSections(),
            images: () => {
                let els = [].slice.call(
                    document.querySelectorAll('[class*=thumbnails_container] img'));
                if (!els.length) {
                    els = [].slice.call(
                        document.querySelectorAll('[class*=image_element_wrapper] img'));
                }
                // Thumbnail lazy-load chưa gán src thì bỏ qua — nếu không
                // '?wid=...' trần sẽ bị abs() phân giải thành URL trang sản phẩm.
                return els.map((i) => i.currentSrc || i.src)
                    .filter(Boolean)
                    .map((u) => u.split('?')[0] + '?wid=2000&hei=2000');
            },
        },

        // --- Williams-Sonoma: window.__INITIAL_STATE__ (xem khối WILLIAMS-SONOMA ở trên);
        // JSON-LD Product đã bị site bỏ, chỉ còn giữ làm đường dự phòng ---
        'williams-sonoma.com': {
            ready: 'h1',
            identity: 'color+variant',
            title: () => {
                const d = wsDetails();
                if (d && d.title) return decodeHtml(d.title);
                const p = ldProduct();
                return p ? decodeHtml(p.name) : '';
            },
            price: () => wsPrice() || ldPrice(),
            description: () => wsTab(/summary|overview|^description/i) || ldDesc(),
            descriptionSections: () => wsDescSections(),
            images: () => {
                const list = wsImages();
                return list.length ? list : ldImages().map((u) => u.replace(/-o\.jpg$/i, '-z.jpg'));
            },
            // Chung 1 link cho mọi variant; giao hàng quá 4 ngày kể từ ngày cào = hết hàng.
            extra: () => {
                const ex = wsExtra();
                if (ex) return ex;
                // Không đọc được state -> ít nhất vẫn xét giao hàng chậm như trước
                const ship = slowDeliveryInfo(DELIVERY_SEL);
                const sel = document.querySelector(
                    '[aria-checked="true"][aria-label], [aria-selected="true"][aria-label], '
                    + '.attribute-options .selected, [class*=swatch][class*=selected]');
                const cur = sel ? S(sel.getAttribute('aria-label') || sel.getAttribute('title')
                                    || sel.textContent).trim() : '';
                const out = {};
                if (cur) out.current_variant = cur;
                if (ship.days > 4 || ship.preorder) {
                    out.in_stock = false;
                    if (cur) { out.sizes = [cur]; out.sizes_out_of_stock = [cur]; out.size_label = 'Variant'; }
                    warnings.push('Giao hàng dự kiến ' + (ship.preorder ? 'preorder' : ship.days + ' ngày (>4)')
                        + ' — coi như hết hàng: ' + ship.text);
                }
                return Object.keys(out).length ? out : null;
            },
        },

        // --- Talbots (Salesforce Commerce, markup SiteGenesis) — kiểm chứng 2026-08-30 ---
        // Chung 1 link: màu ở dwvar_<pid>_color, kiểu size ở dwvar_<pid>_sizeType
        // (Misses/Petite/Woman). Trang đôi lúc trả PerimeterX "Please verify you are a
        // human" -> giải tay trong profile rồi cào lại.
        //   · màu đang xem   .attribute-color .selected-value
        //   · dãy màu/size/sizeType  ul.swatches.{color,size,sizetype} li.selectable|unselectable
        //     (a.swatchanchor title="Select color: BISCAYNE BLUE"); unselectable = gạch xám
        //   · giá   .price-container .original-price[data-pricevalue]; giá gạch
        //     .fullpriceprice .strike-through[data-pricevalue] (ẩn khi không sale)
        //   · tồn kho MỌI màu  JSON-LD ProductGroup.hasVariant[] {color, size, offers.availability}
        //   · ảnh   img.primary-image / .productthumbnail[data-lgimg] (JSON có .hires.url)
        //   · mô tả .pdp-description-container; Features & Materials -> details
        // JSON-LD là ProductGroup nên ldPrice/ldImages/ldDesc của tầng chung KHÔNG dùng được
        // (description là mã nội bộ "WP:BUTTON SHOULDER SWEATSHIRT").
        'talbots.com': {
            ready: '.product-variations, h1.product-name',
            identity: 'color+variant',
            // h1 bị CSS uppercase (innerText trả "CABLE KNIT...") -> og:title / textContent
            title: () => S(meta('og:title')).split(' | ')[0].trim()
                || S((document.querySelector('h1.product-name, .product-name h1, h1') || {}).textContent)
                    .replace(/\s+/g, ' ').trim(),
            // Hàng sale: h4.sale-price (giá bán) + h4.strike-through (giá gạch); hàng
            // thường: h4.original-price. KHÔNG lấy phần tử [data-pricevalue] đầu tiên —
            // ở hàng sale đó là h4 gạch.
            price: () => {
                const el = document.querySelector('.price-container .sale-price[data-pricevalue], '
                    + '.price-container .original-price[data-pricevalue], '
                    + '.price-container [data-pricevalue]:not(.strike-through)');
                const p = el ? parsePrice(el.getAttribute('data-pricevalue')) : null;
                return p || parsePrice(selText('.price-container .price-standard, .product-price'));
            },
            description: () => {
                const t = selTextBest('.pdp-description-container .product-description-content, '
                    + '.pdp-description');
                return t || selTextBest('.product-description-content');
            },
            // Mô tả HTML: Details + Features + Fit and Material (mỗi khối có <h6> tiêu đề).
            // Bỏ khối "Ways to Wear It" (gợi ý phối đồ) cùng class product-description-container.
            descriptionSections: () => [].slice.call(document.querySelectorAll(
                '.pdp-description-container, .pdp-features-materials-container')).map((box, i) => {
                const title = S((box.querySelector('h6') || {}).textContent).replace(/\s+/g, ' ').trim();
                return {
                    el: box.querySelector('.product-description-content') || box,
                    title: i === 0 && /^details$/i.test(title) ? 'Description' : title,
                    kind: i === 0 ? 'description' : (/fit|material|care/i.test(title) ? 'fit_care' : 'details'),
                };
            }),
            images: () => {
                const lg = (el) => {
                    try {
                        const j = JSON.parse(S(el.getAttribute('data-lgimg')));
                        return abs((j && j.hires && j.hires.url) || (j && j.url) || '');
                    } catch (e) { return ''; }
                };
                const out = [];
                [].slice.call(document.querySelectorAll('.product-thumbnails .productthumbnail, '
                    + 'img.primary-image, .product-primary-image img')).forEach((img) => {
                    const u = lg(img) || S(img.currentSrc || img.src).replace(/\?sw=\d+.*$/i, '');
                    if (u && out.indexOf(u) < 0) out.push(u);
                });
                return out;
            },
            extra: () => {
                const box = document.querySelector('.product-variations');
                const swatches = (kind) => [].slice.call(document.querySelectorAll(
                    'ul.swatches.' + kind + ' li'));
                const nameOf = (li) => {
                    const a = li.querySelector('a.swatchanchor, a');
                    const t = S(a && (a.getAttribute('title') || a.textContent)).replace(/^select\s+\w+:\s*/i, '');
                    return t.replace(/\s+/g, ' ').trim();
                };
                const dead = (li) => /unselectable|disabled|unavailable/i.test(S(li.className));
                const sel = (li) => /\bselected\b/.test(S(li.className));

                const colors = [], colorsOut = [];
                swatches('color').forEach((li) => {
                    const n = nameOf(li);
                    if (!n || colors.indexOf(n) >= 0) return;
                    colors.push(n);
                    if (dead(li)) colorsOut.push(n);
                });
                const sizes = [], sizesOut = [];
                swatches('size').forEach((li) => {
                    const n = nameOf(li);
                    if (!n || sizes.indexOf(n) >= 0) return;
                    sizes.push(n);
                    if (dead(li)) sizesOut.push(n);
                });
                const types = [];
                let sizeType = '';
                swatches('sizetype').forEach((li) => {
                    const n = nameOf(li);
                    if (!n) return;
                    if (types.indexOf(n) < 0) types.push(n);
                    if (sel(li)) sizeType = n;
                });
                if (box && !colors.length && !sizes.length) {
                    log('talbots: .product-variations chưa dựng swatch');
                    return null;                 // chưa render -> poll tiếp
                }
                const norm = (c) => S(c).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                // Màu đang xem: dwvar_<pid>_color trên LINK (chắc nhất — .selected-value
                // render muộn hơn swatch) -> .selected-value -> li.selected -> màu đầu.
                let cur = '';
                const urlColor = norm(currentColorFromUrl());
                if (urlColor) cur = colors.find((c) => norm(c) === urlColor) || '';
                if (!cur) cur = nodeText(document.querySelector('.attribute-color .selected-value'));
                if (!cur) {
                    const li = swatches('color').find(sel);
                    if (li) cur = nameOf(li);
                }

                // Ma trận tồn kho mọi màu + ảnh chính từng màu từ JSON-LD ProductGroup
                // (màu ghi "DARK-OLIVE", mỗi variant có image của màu đó)
                const group = jsonLdNodes().find((x) => /ProductGroup/i.test(typeOf(x)));
                const byColor = {};
                const imgByColor = {};
                ((group && group.hasVariant) || []).forEach((v) => {
                    const c = norm(v.color);
                    const sz = S(v.size).trim();
                    if (!c) return;
                    const im = abs(typeof v.image === 'string' ? v.image : (v.image && v.image.url) || '');
                    if (im && !imgByColor[c]) imgByColor[c] = im;
                    if (!sz) return;
                    const ok = /instock|limitedavailability|preorder/i.test(S(v.offers && v.offers.availability));
                    const row = byColor[c] = byColor[c] || { ok: [], out: [] };
                    if (ok) { if (row.ok.indexOf(sz) < 0) row.ok.push(sz); }
                    else if (row.out.indexOf(sz) < 0) row.out.push(sz);
                });
                const matrix = [];
                (colors.length ? colors : Object.keys(byColor)).forEach((c) => {
                    const row = byColor[norm(c)];
                    if (!row) return;
                    const ok = row.ok.slice();
                    const out = row.out.filter((s) => ok.indexOf(s) < 0);
                    matrix.push({ color: c, variant: sizeType, sizes_in_stock: ok, sizes_out_of_stock: out });
                });

                const strike = document.querySelector('.fullpriceprice .strike-through[data-pricevalue], '
                    + '.price-container .strike-through[data-pricevalue]');
                const curEl = document.querySelector('.price-container .sale-price[data-pricevalue], '
                    + '.price-container .original-price[data-pricevalue]');
                const lp = strike ? Number(strike.getAttribute('data-pricevalue')) : NaN;
                const cp = curEl ? Number(curEl.getAttribute('data-pricevalue')) : NaN;
                const listPrice = isFinite(lp) && lp > 0 && (!isFinite(cp) || lp > cp) ? lp : null;

                // Ảnh mọi màu: ảnh chính của từng màu trong hasVariant (swatch màu không có
                // data-lgimg). Màu đang xem đứng đầu, kèm gallery của màu đó.
                const allImages = [];
                const imgColors = {};
                const pushImg = (u, c) => {
                    if (u && allImages.indexOf(u) < 0) { allImages.push(u); if (c) imgColors[u] = c; }
                };
                (cur ? [cur] : []).concat(colors.filter((c) => c !== cur)).forEach((c) => {
                    pushImg(imgByColor[norm(c)], c);
                });
                swatches('color').forEach((li) => {
                    const a = li.querySelector('a[data-lgimg]');
                    if (!a) return;
                    try {
                        const j = JSON.parse(S(a.getAttribute('data-lgimg')));
                        pushImg(abs((j.hires && j.hires.url) || j.url || ''), nameOf(li));
                    } catch (e) { /* bỏ */ }
                });
                const details = selTextBest('.pdp-features-materials-container .product-description-content');
                log('talbots: màu ' + (cur || '?') + ' / ' + sizeType + ', ' + sizes.length + ' size ('
                    + sizesOut.length + ' hết), ma trận ' + matrix.length + ' màu, giá gạch ' + (listPrice || 'không'));
                return {
                    current_color: cur || (colors.length ? colors[0] : ''),
                    color_label: colors.length ? 'Color' : '',
                    colors: colors,
                    variant_label: types.length ? 'Size Type' : '',
                    current_variant: sizeType,
                    variants: types.map((v) => 'Size Type:' + v),
                    size_label: sizes.length ? 'Size' : '',
                    sizes: sizes,
                    sizes_in_stock: sizes.filter((s) => sizesOut.indexOf(s) < 0),
                    sizes_out_of_stock: sizesOut,
                    stock_matrix: matrix.length ? matrix : null,
                    list_price: listPrice,
                    all_images: allImages.length ? allImages : null,
                    image_colors: Object.keys(imgColors).length ? imgColors : null,
                    details: details || null,
                    in_stock: sizes.length ? sizes.length > sizesOut.length : null,
                    size_guide_button: document.querySelector('.size-chart-link a') ? '.size-chart-link a' : '',
                };
            },
        },

        // --- Hernest (React; mỗi link 1 variant; giao quá 4 ngày = hết hàng) ---
        'hernest.com': {
            ready: 'h1.detailProName, #detail-price-main',
            identity: 'variant',
            title: () => selText('h1.detailProName') || selText('h1'),
            price: () => parsePrice(nodeText(document.querySelector('#detail-price-main')))
                || parsePrice(selText('.sale-price')),
            description: () => hernestDescription() || selTextBest('.desc-text-box, .descrition'),
            descriptionSections: () => hernestDescSections(),
            images: () => [].slice.call(document.querySelectorAll(
                '#detail-img-list img, .detail-img-wrap img, .carousel-thumb-native__img'))
                .map((i) => S(i.getAttribute('data-src') || i.currentSrc || i.src))
                .filter((u) => u && u.indexOf('data:') !== 0),
            extra: () => hernestExtra(),
        },

        // --- Vionic (Magento + MagicToolbox) ---
        // TOÀN BỘ biến thể (màu/size/width/tồn kho/gallery từng màu/fit guide) nằm
        // sẵn trong jsonConfig của script x-magento-init ngay từ HTML đầu tiên —
        // KHÔNG cần chờ trang render xong swatch (trang này render UI rất chậm).
        // Details / Fit & Care nằm trong tab accordion (#tab_details / #tab_care),
        // tab đóng nên phải đọc textContent (innerText trả rỗng).
        'vionicshoes.com': {
            ready: 'a.mt-thumb-switcher',
            identity: 'color+variant',       // mọi variant chung 1 link: định danh = màu + width
            // h1 bị CSS text-transform: uppercase — innerText trả "MEN'S CARTER...".
            // og:title giữ đúng kiểu chữ gốc "Men's Carter Oxford Lace Up Sneaker"; vài
            // sp có đuôi SEO " | Women’s Casual Loafers | Vionic Shoes" -> chỉ lấy phần đầu.
            title: () => S(meta('og:title')).split(' | ')[0].trim() || selText('h1'),
            price: () => parsePrice(meta('product:price:amount')),
            description: () => selTextBest(
                '.product.attribute.overview .value, .product.attribute.description .value,'
                + ' .product.attribute.description, #description .value, [class*=product-description]')
                || stripHtml(meta('og:description')),
            // Gallery tách sẵn theo từng màu -> gán được ảnh nào của màu nào
            imageColors: () => {
                const cfg = vionicCfg();
                if (!cfg || !cfg.color_variants) return {};
                const labels = vionicColorLabels(cfg);
                const map = {};
                vionicColorOrder(cfg).forEach((cid) => {
                    const name = labels[cid] || S(cid);
                    const v = cfg.color_variants[cid];
                    ((v && v.gallery) || []).forEach((g) => {
                        const u = abs(g.full || g.img || g.thumb || '');
                        if (u) map[u] = name;
                    });
                });
                return map;
            },
            // Gallery của MÀU ĐANG XEM (cột "Ảnh của variant đang lấy"). Không xác định
            // được màu thì lấy mọi màu — thà thừa còn hơn rỗng.
            images: () => {
                const cfg = vionicCfg();
                if (cfg && cfg.color_variants) {
                    const labels = vionicColorLabels(cfg);
                    const ids = vionicColorOrder(cfg);
                    const cur = magentoCurrentColor(cfg, null);
                    const curId = ids.find((cid) => (labels[cid] || S(cid)) === cur);
                    const out = [];
                    (curId ? [curId] : ids).forEach((cid) => {
                        const v = cfg.color_variants[cid];
                        ((v && v.gallery) || []).forEach((g) => {
                            out.push(g.full || g.img || g.thumb || '');
                        });
                    });
                    if (out.length) return out;
                }
                return [].slice.call(document.querySelectorAll('a.mt-thumb-switcher'))
                    .map((a) => a.getAttribute('href') || a.getAttribute('data-image') || '');
            },
            // Gallery của TẤT CẢ các màu, theo thứ tự swatch trên site (cột "Ảnh của
            // toàn bộ variant" — site 1 hãng, listing eBay dùng cả loạt).
            allImages: () => {
                const cfg = vionicCfg();
                if (!cfg || !cfg.color_variants) return [];
                const out = [];
                vionicColorOrder(cfg).forEach((cid) => {
                    const v = cfg.color_variants[cid];
                    ((v && v.gallery) || []).forEach((g) => {
                        out.push(g.full || g.img || g.thumb || '');
                    });
                });
                return out;
            },
            extra: () => {
                const cfg = vionicCfg();
                const mv = magentoVariants(cfg);
                if (!mv) return null;
                const cur = magentoCurrentColor(cfg, mv);
                // Trục giữa (Men's Width) đang xem: width đầu tiên còn hàng với màu đó.
                const hit = currentMatrixRow(mv.stock_matrix, cur);

                const tabText = (sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return '';
                    const lis = [].slice.call(el.querySelectorAll('li')).map(nodeText).filter(Boolean);
                    return lis.length ? lis.join('\n') : nodeText(el);
                };

                const fitGuide = [];
                if (cfg.fit_guide_src) fitGuide.push(abs(cfg.fit_guide_src));
                if (cfg.wide_calf_sizechart && cfg.fit_guide_src_calf_size) {
                    fitGuide.push(abs(cfg.fit_guide_src_calf_size));
                }
                const cp = parsePrice(meta('product:price:amount'));
                log('vionic: màu đang xem = ' + (cur || '?') + ', width = '
                    + (hit ? hit.variant || '(không)' : '?'));

                return {
                    current_color: cur,
                    variant_label: mv.variant_label,
                    current_variant: hit ? hit.variant : '',
                    list_price: magentoListPrice(cp ? cp.value : null),
                    color_label: mv.color_label,
                    size_label: mv.size_label,
                    colors: mv.colors,
                    sizes: mv.sizes,
                    // Size còn/hết của ĐÚNG variant đang xem (màu × width), không gộp mọi màu
                    sizes_in_stock: hit ? hit.sizes_in_stock : mv.sizes_in_stock,
                    sizes_out_of_stock: hit ? hit.sizes_out_of_stock : mv.sizes_out_of_stock,
                    variants: mv.variants,
                    stock_matrix: mv.stock_matrix,
                    details: tabText('[id^="tab_details"][data-role="content"]'),
                    fit_care: tabText('[id^="tab_care"][data-role="content"]'),
                    fit_guide_images: fitGuide,
                };
            },
        },

        // --- Danner (Magento + Scene7) ---
        // JSON-LD name bị escape &quot; -> phải decode.
        'danner.com': {
            ready: 'li.gallery-thumb img, h1',
            identity: 'color+variant',       // danner.com và global.danner.com là 1 sản phẩm
            title: () => {
                const p = ldProduct();
                return decodeHtml(p && p.name ? p.name : meta('og:title'));
            },
            price: () => ldPrice() || parsePrice(meta('product:price:amount')),
            description: () => selTextBest(
                '.product.attribute.description .value, .product.attribute.description,'
                + ' #description, [class*=product-description], [class*=product-detail-description]'),
            // Mô tả HTML: cả khối chi tiết — Key Details · Description · Specifications ·
            // Features (mỗi khối tự có tiêu đề <h3> của site).
            descriptionSections: () => [].slice.call(document.querySelectorAll(
                '.product-details-container > .product-detail')).map((el) => ({
                el: el,
                kind: /attributes|spec/i.test(S(el.className)) ? 'details' : 'description',
            })),
            images: () => [].slice.call(document.querySelectorAll('li.gallery-thumb img'))
                .map((i) => i.currentSrc || i.src),
            // Magento configurable: jsonConfig như Vionic (màu/width/size + tồn kho).
            // Sản phẩm đơn không có jsonConfig thì đọc swatch trên DOM: size gạch xám
            // mang class disabled / out-of-stock.
            extra: () => {
                const cfg = magentoCfg();
                const mv = magentoVariants(cfg);
                const cp = ldPrice() || parsePrice(meta('product:price:amount'));
                const listPrice = magentoListPrice(cp ? cp.value : null);
                if (mv) {
                    const cur = magentoCurrentColor(cfg, mv);
                    const hit = currentMatrixRow(mv.stock_matrix, cur);
                    return {
                        current_color: cur,
                        variant_label: mv.variant_label,
                        current_variant: hit ? hit.variant : '',
                        list_price: listPrice,
                        color_label: mv.color_label,
                        size_label: mv.size_label,
                        colors: mv.colors,
                        sizes: mv.sizes,
                        sizes_in_stock: hit ? hit.sizes_in_stock : mv.sizes_in_stock,
                        sizes_out_of_stock: hit ? hit.sizes_out_of_stock : mv.sizes_out_of_stock,
                        variants: mv.variants,
                        stock_matrix: mv.stock_matrix,
                    };
                }
                // Trang thật (2026-08): KHÔNG có jsonConfig. Width/Size là <select
                // name="super_attribute[...]"> liệt kê ĐỦ option; bản Knockout
                // (select[data-bind*=options]) chỉ liệt kê size CÒN HÀNG. Màu nằm ở bảng
                // Specifications ("Color | Brown"); mỗi màu 1 link riêng.
                const statics = [].slice.call(document.querySelectorAll('select[name^="super_attribute"]'));
                const kos = [].slice.call(document.querySelectorAll('select[data-bind*="options"]'));
                // Bỏ caption ("Select Size" / "Choose an Option..."); option ghi
                // "9 (Out of Stock)" -> size 9, hết hàng.
                const OOS = /\s*\((?:out of stock|sold out|unavailable)\)\s*$/i;
                const rawOpts = (sel) => sel ? [].slice.call(sel.options)
                    .map((o) => S(o.textContent).trim())
                    .filter((t) => t && !/^(select|choose)\b/i.test(t) && !/\.\.\.$/.test(t)) : [];
                const optsOf = (sel) => rawOpts(sel).map((t) => t.replace(OOS, '').trim());
                const oosOf = (sel) => rawOpts(sel).filter((t) => OOS.test(t)).map((t) => t.replace(OOS, '').trim());
                const byLabel = (list, re) => list.find((s) => re.test(S(s.getAttribute('aria-label')) + '|'
                    + S(s.options && s.options[0] && s.options[0].textContent)));
                const sizeS = byLabel(statics, /size/i), widthS = byLabel(statics, /width/i);
                const sizeK = byLabel(kos, /size/i), widthK = byLabel(kos, /width/i);
                const sizes = optsOf(sizeS).length ? optsOf(sizeS) : optsOf(sizeK);
                const oos = oosOf(sizeS).concat(oosOf(sizeK));
                const avail = (sizeK ? optsOf(sizeK) : sizes).filter((s) => oos.indexOf(s) < 0);
                const widths = optsOf(widthS).length ? optsOf(widthS) : optsOf(widthK);
                const selectedOf = (sel) => {
                    const t = (sel && sel.selectedIndex > 0)
                        ? S(sel.options[sel.selectedIndex].textContent).trim() : '';
                    return /^(select|choose)\b/i.test(t) ? '' : t.replace(OOS, '');
                };
                const curWidth = selectedOf(widthK) || selectedOf(widthS) || widths[0] || '';

                let curColor = '';
                [].slice.call(document.querySelectorAll(
                    '.product-attributes-container tr, .additional-attributes tr, .product-attributes-container li'))
                    .forEach((row) => {
                        const m = nodeText(row).match(/^\s*Colou?r\s*[:|]?\s*(.+)$/i);
                        if (m && !curColor) curColor = m[1].trim();
                    });
                // Khối chọn option có trên trang mà chưa dựng xong select (global.danner.com
                // dựng muộn) -> trả null để crawler poll tiếp, đừng chốt kết quả thiếu size.
                const optionsBox = document.querySelector('.product-options-wrapper');
                if (optionsBox && !sizes.length && !widths.length) {
                    log('danner: chưa thấy select Width/Size trong .product-options-wrapper');
                    return null;
                }
                if (!sizes.length && !widths.length && !curColor && listPrice == null) return null;
                log('danner: màu ' + (curColor || '?') + ', width ' + (curWidth || '?') + ', '
                    + sizes.length + ' size / ' + avail.length + ' còn');
                return {
                    current_color: curColor,
                    color_label: curColor ? 'Color' : '',
                    colors: curColor ? [curColor] : [],
                    variant_label: widths.length ? 'Width' : '',
                    current_variant: curWidth,
                    variants: widths.map((w) => 'Width:' + w),
                    list_price: listPrice,
                    size_label: sizes.length ? 'Size' : '',
                    sizes: sizes,
                    sizes_in_stock: sizes.filter((s) => avail.indexOf(s) >= 0),
                    sizes_out_of_stock: sizes.filter((s) => avail.indexOf(s) < 0),
                    in_stock: sizes.length ? avail.length > 0 : null,
                };
            },
        },

        // --- Revolve ---
        // BẪY: DOM trả ảnh xoay vòng (V3, V4, V1, V2) và lặp -> PHẢI sort theo số _V.
        // JSON-LD description chỉ là "pant" -> lấy từ DOM.
        'revolve.com': {
            ready: '[class*=slideshow] img, .js-zoom-modal img',
            identity: 'color',               // mỗi màu 1 link riêng, size chung link
            // og:title kèm đuôi " in <màu>" — bỏ đi để lấy đúng tên sản phẩm
            title: () => {
                let t = S(meta('og:title'))
                    .replace(/\s*(\|\s*REVOLVE|from\s+Revolve\.com)\s*$/i, '').trim();
                const color = revolveCurrentColor(t);
                if (color) {
                    t = t.replace(new RegExp('\\s+in\\s+' + color.replace(
                        /[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i'), '').trim();
                }
                return t;
            },
            price: () => ldPrice(),
            prefetch: () => revolvePrefetch(),
            description: () => revolveDescription(),
            descriptionSections: () => revolveDescSections(),
            extra: (images) => revolveExtra(images),
            images: () => {
                const m = location.pathname.match(/\/dp\/([A-Za-z0-9._-]+)\/?/);
                const code = m ? m[1] : '';
                const srcs = [].slice.call(document.querySelectorAll(
                    '[class*=slideshow] img, .js-zoom-modal img, [class*=zoom] img'))
                    .map((i) => i.currentSrc || i.src);
                const nums = new Set();
                srcs.forEach((s) => {
                    if (code && s.indexOf(code) < 0) return;
                    const mm = s.match(/_V(\d+)\.jpe?g/i);
                    if (mm) nums.add(parseInt(mm[1], 10));
                });
                const sorted = Array.from(nums).sort((a, b) => a - b);
                if (code && sorted.length) {
                    return sorted.map((n) => 'https://is4.revolveassets.com/images/p4/n/uv/'
                        + code + '_V' + n + '.jpg');
                }
                return srcs;
            },
        },

        // --- Duluth Trading (React/Mobify — dữ liệu trong <script id=mobify-data>) ---
        'duluthtrading.com': {
            ready: 'script#mobify-data',
            identity: 'color+variant',
            // Hỏi server xem ảnh chụp phụ bản riêng theo màu nào có thật (xem duluthPrefetch)
            prefetch: () => duluthPrefetch(),
            title: () => {
                const p = duluthProduct();
                if (p && p.name) return decodeHtml(p.name);
                const ld = ldProduct();
                return ld ? decodeHtml(ld.name) : selText('h1');
            },
            price: () => duluthPrice() || ldPrice(),
            description: () => duluthDescription() || ldDesc(),
            extra: () => duluthExtra(),
            imageColors: () => duluthImageColors(),
            images: () => {
                const list = duluthImages();
                return list.length ? list : ldImages();
            },
        },

        // --- Victoria's Secret ---
        // BẪY: class DOM là hash styled-components (sc-mhhg36-0) -> đổi mỗi lần build,
        // TUYỆT ĐỐI không bám. Chỉ dùng JSON-LD. Ảnh thiếu scheme -> abs() thêm https://.
        // Ảnh KHÔNG upsize được (760x1013 -> 2000x2666 trả lỗi) -> giữ nguyên size gốc.
        'victoriassecret.com': {
            ready: 'h1',
            identity: 'color',               // mỗi màu 1 link (?choice=), size chung link
            title: () => { const p = ldProduct(); return p ? decodeHtml(p.name) : ''; },
            price: () => ldPrice(),
            // JSON-LD description là HTML (<p>/<ul>) -> giữ xuống dòng / gạch đầu dòng
            description: () => { const p = ldProduct(); return p ? htmlToText(p.description) : ''; },
            descriptionSections: () => {
                const p = ldProduct();
                const html = S(p && p.description);
                return /<[a-z]/i.test(html) ? [{ html: html, kind: 'description' }] : [];
            },
            images: () => ldImages(),
            // Màu đang xem nằm trong document.title: "Buy Shine Bow Push-Up Bra, Black - Order
            // Bras online". Swatch: div[role=radio][data-testid^=choice-] với aria-label
            // "<Màu> <Tên sp>" (chỉ lấy swatch cùng data-generic-id với ?genericId= trên link).
            // Size: nhóm [data-testid=Band|Cup|Size] chứa radio aria-label "Band 30" / "Cup A",
            // aria-disabled=true = gạch xám. Bra là Band × Cup — tồn kho từng tổ hợp cần bấm
            // chọn band nên chỉ ghi trục, không đoán.
            extra: () => {
                const p = ldProduct();
                const name = p ? decodeHtml(p.name) : '';
                let cur = '';
                const mt = S(document.title).match(/^\s*(?:Buy\s+)?(.+?),\s*([^,]+?)\s+-\s+/);
                if (mt && (!name || mt[1].trim().toLowerCase() === name.toLowerCase())) cur = mt[2].trim();
                let gid = '';
                [location.href, opts.url].forEach((u) => {
                    try { if (!gid) gid = S(new URL(S(u), location.href).searchParams.get('genericId')); } catch (e) { /* bỏ */ }
                });
                const radios = [].slice.call(document.querySelectorAll('[role="radio"][data-testid^="choice-"]'))
                    .filter((r) => !gid || S(r.getAttribute('data-generic-id')) === gid);
                // aria-label = "<Màu> <tên sp>" nhưng tên trong swatch có thể khác JSON-LD
                // ("Shine Strap" vs "Shine Bow") -> bỏ ĐUÔI CHUNG (theo từ) của cả dãy swatch.
                const labels = radios.map((r) => S(r.getAttribute('aria-label')).trim()).filter(Boolean);
                let suffixWords = [];
                if (labels.length > 1) {
                    const words = labels.map((l) => l.split(/\s+/));
                    const minLen = Math.min.apply(null, words.map((w) => w.length));
                    for (let i = 1; i < minLen; i++) {
                        const w = words[0][words[0].length - i];
                        if (words.every((ws) => ws[ws.length - i] === w)) suffixWords.unshift(w);
                        else break;
                    }
                }
                // Tên sp trong JSON-LD của nước hoa kèm dung tích ("... Eau de Parfum 1.7 oz")
                // -> so bằng phần tên KHÔNG có dung tích; aria-label có thể đặt tên ở giữa
                // ("1.7 oz Tease ... Parfum - 3.4 oz") nên xoá tên ở bất kỳ vị trí nào.
                const nameCore = name.replace(/\s*[-–]?\s*\d+(\.\d+)?\s*(fl\.?\s*oz|oz|ml)\s*$/i, '').trim();
                const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const tidy = (x) => S(x).replace(/^[\s\-–,]+|[\s\-–,]+$/g, '').replace(/\s+/g, ' ').trim();
                const SIZE_TOKEN = /\d+(\.\d+)?\s*(fl\.?\s*oz|oz|ml)\b/gi;
                const stripName = (lbl) => {
                    let out = lbl;
                    if (nameCore) out = out.replace(new RegExp(esc(nameCore), 'i'), ' ');
                    out = tidy(out);
                    // Nước hoa: aria-label = "<choice đang chọn> <tên sp của radio đó - 3.4 oz>"
                    // -> sau khi bỏ tên còn 2 dung tích, dung tích CUỐI mới là của radio này.
                    const sizes = out.match(SIZE_TOKEN) || [];
                    if (sizes.length >= 2) return sizes[sizes.length - 1].replace(/\s+/g, ' ');
                    if (out && out.toLowerCase() !== lbl.toLowerCase()) return out;
                    if (suffixWords.length) {
                        const ws = lbl.split(/\s+/);
                        if (ws.length > suffixWords.length) return ws.slice(0, ws.length - suffixWords.length).join(' ');
                    }
                    return lbl;
                };
                const colors = [];
                const hasCI = (list, v) => list.some((x) => x.toLowerCase() === S(v).toLowerCase());
                radios.forEach((r) => {
                    const lbl = stripName(S(r.getAttribute('aria-label')).trim());
                    if (!lbl) return;
                    if (!hasCI(colors, lbl)) colors.push(lbl);
                    if (!cur && r.getAttribute('aria-checked') === 'true') cur = lbl;
                });
                // Màu lấy từ title có thể khác hoa/thường với swatch ("1.7 Oz" / "1.7 oz")
                const same = colors.find((c) => c.toLowerCase() === S(cur).toLowerCase());
                if (same) cur = same;
                else if (cur) colors.unshift(cur);

                const axes = {};
                const AXIS_RE = /^(band|cup|size|length|inseam)$/i;
                [].slice.call(document.querySelectorAll('[role="radio"][aria-label]')).forEach((r) => {
                    // Radio nằm trong div[role=radiogroup][aria-label="Band"] (data-testid
                    // "BoxSelector-size1"); div[data-testid="Band"] bên cạnh chỉ là nhãn ->
                    // đi ngược lên tìm nhóm theo aria-label rồi mới tới data-testid.
                    let gname = '';
                    for (let el = r.parentElement; el && !gname; el = el.parentElement) {
                        if (!el.getAttribute) break;
                        const al = S(el.getAttribute('aria-label')).trim();
                        const t = S(el.getAttribute('data-testid')).trim();
                        if (AXIS_RE.test(al)) gname = al;
                        else if (AXIS_RE.test(t)) gname = t;
                        if (/^(main|body)$/i.test(el.tagName)) break;
                    }
                    const lbl = S(r.getAttribute('aria-label')).trim();
                    if (!gname) return;
                    const val = lbl.replace(new RegExp('^' + gname + '\\s*', 'i'), '').trim();
                    if (!val) return;
                    const ax = axes[gname] = axes[gname] || { all: [], out: [] };
                    if (ax.all.indexOf(val) < 0) ax.all.push(val);
                    if (r.getAttribute('aria-disabled') === 'true' && ax.out.indexOf(val) < 0) ax.out.push(val);
                });
                const sizeAxis = Object.keys(axes).find((k) => /size/i.test(k));
                const variants = [];
                Object.keys(axes).forEach((k) => {
                    if (k === sizeAxis) return;
                    axes[k].all.forEach((v) => variants.push(k + ':' + v));
                });
                if (!cur && !colors.length && !Object.keys(axes).length) return null;
                // Nước hoa: "choice" là dung tích ("1.7 Oz") chứ không phải màu -> trục Size
                const sizeLike = (v) => /^\d+(\.\d+)?\s*(oz|ml|fl|g|lb|kg|inch|in|cm|")/i.test(S(v));
                const isSize = cur && sizeLike(cur) && colors.every(sizeLike);
                log('vs: ' + (isSize ? 'dung tích' : 'màu') + ' đang xem = ' + (cur || '?') + ', '
                    + colors.length + ' lựa chọn, trục ' + Object.keys(axes).join('/'));
                const out = isSize ? {
                    variant_label: 'Size',
                    current_variant: cur,
                    size_label: 'Size',
                    sizes: colors,
                    sizes_in_stock: colors,
                    variants: variants,
                } : {
                    current_color: cur,
                    color_label: colors.length ? 'Color' : '',
                    colors: colors,
                    variants: variants,
                };
                if (isSize) return out;
                if (sizeAxis) {
                    out.size_label = sizeAxis;
                    out.sizes = axes[sizeAxis].all;
                    out.sizes_out_of_stock = axes[sizeAxis].out;
                    out.sizes_in_stock = axes[sizeAxis].all.filter((v) => axes[sizeAxis].out.indexOf(v) < 0);
                }
                return out;
            },
        },

        // --- BestBuy: chỉ chạy được khi IP không bị Akamai chặn PDP ---
        'bestbuy.com': {
            ready: '[class*=gallery] img, [data-testid*=gallery] img',
            title: () => { const p = ldProduct(); return p ? decodeHtml(p.name) : selText('h1'); },
            price: () => ldPrice(),
            description: () => ldDesc(),
            images: () => [].slice.call(document.querySelectorAll(
                '[class*=media-gallery] img, [class*=gallery] img, [data-testid*=gallery] img'))
                .map((i) => i.currentSrc || i.src),
        },

        'landsend.com': {
            ready: 'script#app-root-state',
            identity: 'color+variant',
            prefetch: () => lePrefetch(),
            get brand() {
                const p = leProduct();
                return decodeHtml(S(p && p.brandName)) || "Lands' End";
            },
            title: () => leTitle(),
            price: () => {
                const pr = leCurPrice();
                return pr && pr.price ? { value: pr.price, currency: 'USD' } : null;
            },
            description: () => leDescription(),
            descriptionSections: () => leDescSections(),
            images: () => leImages(),
            extra: () => leExtra(),
        },

        // --- Tommy Bahama — xem khối TOMMY BAHAMA ở trên. Chung 1 link mọi màu. ---
        'tommybahama.com': {
            ready: '[tbr-pdp--details-contents]',
            identity: 'color+variant',
            brand: 'Tommy Bahama',
            prefetch: () => tbPrefetch(),
            title: () => tbTitle(),
            price: () => {
                const p = tbPriceOf(tbCurrentCode());
                return p ? { value: p.price, currency: 'USD' } : null;
            },
            description: () => {
                const el = document.querySelector('[tbr-pdp--description-main]');
                const t = el ? S(el.textContent).trim() : '';
                if (/^<[a-z]/i.test(t)) return htmlToText(t);      // lượt dựng đầu: HTML bị escape
                return t ? nodeText(el) || t : ldDesc();
            },
            descriptionSections: () => tbDescSections(),
            images: () => {
                const c = tbFeedColor(tbCurrentCode());
                const list = tbColorImages(c);
                return list.length ? list : ldImages().map(tbBig);
            },
            extra: () => tbExtra(),
        },

        // --- Eileen Fisher (SFRA) — xem khối EILEEN FISHER ở trên. Chung 1 trang mọi màu. ---
        'eileenfisher.com': {
            ready: 'button.color-attribute[data-attr-value], .product-detail .prices',
            identity: 'color+variant',
            brand: 'Eileen Fisher',
            prefetch: () => efPrefetch(),
            title: () => {
                const p = efVar(efCurrentCode());
                if (p && p.productName) return decodeHtml(p.productName);
                const ld = ldProduct();
                return ld ? decodeHtml(ld.name) : selText('h1');
            },
            price: () => {
                const pr = efPriceOf(efVar(efCurrentCode())) || efDomPrice();
                return pr ? { value: pr.price, currency: 'USD' } : ldPrice();
            },
            description: () => selTextBest('.r-copy') || ldDesc(),
            descriptionSections: () => efDescSections(),
            images: () => {
                const list = efImages(efVar(efCurrentCode()));
                return list.length ? list : ldImages().map((u) => u.replace(/\?sw=525&sh=700&sfrm=png&q=90$/, '?sw=1680&sh=2240&sfrm=png'));
            },
            extra: () => efExtra(),
        },

        // --- MacKenzie-Childs (SFRA) — xem khối MACKENZIE-CHILDS ở trên. Chung 1 trang mọi hoa văn. ---
        'mackenzie-childs.com': {
            ready: '.product-detail[data-pid]',
            identity: 'color+variant',
            prefetch: () => mcPrefetch(),
            title: () => {
                const p = mcCur();
                if (p && p.productName) return decodeHtml(p.productName);
                const ld = ldProduct();
                return ld ? decodeHtml(ld.name) : selText('h1');
            },
            price: () => {
                const pr = mcPriceOf(mcCur());
                return pr ? { value: pr.price, currency: 'USD' } : ldPrice();
            },
            description: () => {
                const p = mcCur();
                return p && p.shortDescription ? htmlToText(p.shortDescription) : ldDesc();
            },
            descriptionSections: () => mcDescSections(),
            images: () => {
                const list = mcImages(mcCur());
                return list.length ? list : ldImages().map((u) => S(u).split('?')[0] + '?format=jpg&width=2000');
            },
            extra: () => mcExtra(),
        },

        'personalcreations.com': {
            ready: '#price-container, .product-thumbnails',
            identity: 'color',                 // ?attr9=<design> trên URL chọn design
            title: () => {
                const p = ldProduct();
                return p ? decodeHtml(p.name) : selText('h1, .product-name');
            },
            // Giá của tổ hợp đang chọn trên trang (#price-container .sale-price); giá gạch là
            // "Comp. Value" (.original-price) — tầng chung domListPrice đọc được, extra cũng trả.
            price: () => parsePrice(selText('#price-container .sale-price')) || ldPrice(),
            description: () => selTextBest('.component-bullets-description .product-description') || ldDesc(),
            descriptionSections: () => pcDescSections(),
            images: () => {
                const gal = pcGallery();
                const po = pcOptions();
                const cur = pcSelected(pcAxes().color);
                // Đã chọn design -> ảnh chính của design đó đứng đầu, rồi gallery chung
                if (cur && po && po.product_designs) {
                    const d = Object.keys(po.product_designs).map((k) => po.product_designs[k])
                        .find((x) => pcDesignOf(x, pcAxes().color) === cur);
                    if (d && d.front_sample) return [pcBig(d.front_sample)].concat(gal);
                }
                return gal.length ? gal : ldImages().map(pcBig);
            },
            extra: () => {
                const ex = pcExtra();
                if (!ex) return null;
                const lp = parsePrice(selText('#price-container .original-price'));
                const p = parsePrice(selText('#price-container .sale-price'));
                if (lp && (!p || lp.value > p.value)) ex.list_price = lp.value;
                return ex;
            },
        },

        'academy.com': {
            ready: 'h1',
            identity: 'color+variant',
            title: () => {
                const p = acItem();
                if (p && p.name) return acText(p.name);
                const ld = ldProduct();
                return ld ? acText(ld.name) : selText('h1');
            },
            price: () => {
                const pr = acPriceOf(acCurrentSku());
                return pr ? { value: pr.price, currency: 'USD' } : ldPrice();
            },
            description: () => {
                const p = acItem();
                return p ? acText(S(p.longDescription)) : ldDesc();
            },
            descriptionSections: () => acDescSections(),
            images: () => {
                const c = acCurrentColor();
                const list = c ? acColorImages(c) : [];
                return list.length ? list : ldImages().map(acImg);
            },
            extra: () => acExtra(),
        },

        'walmart.com': {
            ready: 'script#__NEXT_DATA__',
            // Mỗi tổ hợp màu×size 1 item id riêng, nhưng dữ liệu mọi màu có đủ trong 1 trang
            // -> định danh theo màu (+ trục giữa), mã màu = color_codes
            identity: 'color+variant',
            // brand là getter: tầng chung chỉ nhận chuỗi (typeof AD.brand === 'string')
            get brand() { const p = wmProduct(); return p && p.brand ? decodeHtml(p.brand) : ''; },
            title: () => {
                const p = wmProduct();
                if (p && p.name) return decodeHtml(p.name);
                return S(document.title).replace(/\s*[-|]\s*Walmart\.com\s*$/i, '').trim();
            },
            price: () => {
                const cur = wmCurrent();
                if (cur && cur.price != null) return { value: cur.price, currency: 'USD' };
                const p = wmProduct();
                const pr = p ? wmPriceOf(p.priceInfo) : null;
                return pr && pr.price != null ? { value: pr.price, currency: 'USD' } : null;
            },
            description: () => {
                const d = wmData();
                return d ? htmlToText(d.idml.shortDescription || d.product.shortDescription || '') : '';
            },
            descriptionSections: () => wmDescSections(),
            images: () => wmImages(),
            extra: () => wmExtra(),
        },

        'etsy.com': {
            ready: 'select[id^="variation-selector-"], [data-product-details-description-text-content], script[type="application/ld+json"]',
            // 1 link chung mọi màu/size (chọn màu chỉ thêm ?variation0=<id>) -> màu + trục giữa
            identity: 'color+variant',
            prefetch: () => etPrefetch(),
            title: () => { const p = ldProduct(); return p && p.name ? decodeHtml(p.name) : selText('h1'); },
            price: () => {
                if (etUnavailable()) return etNlaPrice();
                const p = etPrice();
                return p ? { value: p.value, currency: p.currency } : null;
            },
            description: () => { const p = ldProduct(); return p ? decodeHtml(p.description) : ''; },
            descriptionSections: () => etDescSections(),
            images: () => (etUnavailable()
                ? [].slice.call(document.querySelectorAll('.nla-listing-image img')).map((i) => S(i.src).replace(/\/il_\d+x[N\d]+\./, '/il_fullxfull.'))
                : etImages()),
            extra: () => etExtra(),
        },

        'amazon.com': {
            ready: '#productTitle',
            // Mỗi màu (× size) là 1 ASIN, 1 link riêng; trang chỉ có đủ dữ liệu của ASIN
            // đang xem (màu khác chỉ 1 ảnh, không tồn kho) -> KHÔNG tách màu lúc xuất.
            identity: 'color',
            prefetch: () => amzPrefetch(),
            title: () => amzClean((document.querySelector('#productTitle') || {}).textContent),
            price: () => amzPrice(),
            description: () => amzDescText(),
            descriptionSections: () => amzDescSections(),
            images: () => amzImages(),
            // getter: tầng chung chỉ nhận AD.brand dạng chuỗi (không thì lấy JSON-LD/tên site
            // = "Amazon") -> đọc hãng thật từ #bylineInfo đúng lúc gom kết quả
            get brand() { return amzBrand(); },
            extra: () => {
                const ex = amzExtra();
                if (ex && !ex.blocked) {
                    log('amazon extra mới: ' + JSON.stringify({ color_codes: ex.color_codes,
                        color_prices: ex.color_prices, color_sizes_offered: ex.color_sizes_offered }));
                }
                return ex;
            },
        },

        'ebay.com': {
            ready: 'h1.x-item-title__mainTitle, .x-price-primary',
            identity: 'color+variant',
            title: () => ebTitle(),
            price: () => {
                const ex = ebExtraCached();
                if (ex && ex.price_override != null) return { value: ex.price_override, currency: 'USD' };
                const bb = ebModule('BUY_BOX');
                const pr = bb && bb.binModel && bb.binModel.price && bb.binModel.price.value;
                if (pr && pr.value != null) return { value: Number(pr.value), currency: S(pr.currency) || 'USD' };
                return parsePrice(selText('.x-price-primary')) || ldPrice();
            },
            // Chữ mô tả: mô tả người bán (nếu Python đã tải) — không có thì để trống cho
            // tầng chung dựng từ descriptionSections (Item specifics)
            description: () => {
                const dd = ebDescDoc();
                return dd ? htmlToText(dd.innerHTML) : '';
            },
            descriptionSections: () => ebDescSections(),
            images: () => {
                const ex = ebExtraCached();
                if (ex && ex.images_override && ex.images_override.length) return ex.images_override;
                const g = ebGallery().filter(Boolean);
                return g.length ? g : ldImages();
            },
            get brand() { return ebBrand(); },
            extra: () => {
                const ex = ebExtraCached();
                if (ex) {
                    log('ebay extra mới: ' + JSON.stringify({ color_codes: ex.color_codes, color_prices: ex.color_prices,
                        description_url: ex.description_url, description_images: (ex.description_images || []).length }));
                }
                return ex;
            },
        },
    };

    // opts.hostname: chỉ dùng khi TEST offline (nạp HTML đã lưu qua file://) — trang
    // thật không bao giờ truyền.
    const hostname = S(opts.hostname || location.hostname).replace(/^www\./i, '').toLowerCase();
    const domain = Object.keys(ADAPTERS).find(
        (k) => hostname === k || hostname.slice(-(k.length + 1)) === '.' + k) || '';
    const AD = domain ? ADAPTERS[domain] : null;
    log('domain=' + (domain || 'không khớp adapter nào'));

    // ================= phát hiện bị chặn =================
    // Xét cả <title>: vài tường chặn để body gần như trống mà tiêu đề nói rõ
    // ("Williams-Sonoma: 403 - Restricted Access").
    const bodyText = document.body ? S(document.body.innerText).slice(0, 500) : '';
    const wallText = S(document.title).slice(0, 150) + '\n' + bodyText;
    // Mẫu tường chặn đã gặp trên trang thật (kiểm 2026-09-23, IP VN):
    //   Akamai          "Access Denied" — Crate & Barrel · BestBuy · Duluth
    //   PerimeterX      "Please verify you are a human" / "Access to this page has been
    //                   denied" — Talbots
    //   Cloudflare      "Sorry, you have been blocked" — Vionic
    //   Williams-Sonoma "403 - Restricted Access" / "due to website restrictions"
    // Sót mẫu nào là trang chặn lọt xuống tầng dưới: tiêu đề tường chặn bị lấy làm
    // tiêu đề sản phẩm rồi xuất thẳng vào bảng checklist eBay.
    //   Walmart         PerimeterX "Robot or human?" / "Activate and hold the button"
    //   Amazon          "Enter the characters you see below"
    //   Etsy            DataDome: trang trống (title "etsy.com"), chữ chặn nằm trong
    //                   iframe geo.captcha-delivery.com khác origin -> không đọc được chữ,
    //                   phải nhận ra qua iframe
    const BLOCKED = /Access Denied|Access to this page has been denied|Pardon Our Interruption|px-captcha|Are you a human|verify you are a human|you have been blocked|Restricted Access|due to website restrictions|unusual traffic|site can.t be reached|ERR_HTTP2|Request unsuccessful|Robot or human\?|Activate and hold the button|Enter the characters you see below/i;
    const captchaFrame = !!document.querySelector(
        'iframe[src*="captcha-delivery.com"], iframe[src*="geo.captcha"]');
    if (BLOCKED.test(wallText) || captchaFrame || location.href.indexOf('chrome-error') === 0) {
        return {
            ok: false,
            blocked: true,
            url: location.href,
            title: '', price: null, currency: '', description: '', description_html: '', images: [],
            source: 'blocked',
            warnings: ['Trang bị chặn hoặc không tải được: '
                + S(bodyText || document.title).slice(0, 120)],
            trace: trace,
        };
    }

    // ================= gom kết quả =================
    const rec = {
        ok: true,
        blocked: false,
        url: location.href,
        title: '',
        price: null,
        currency: '',
        description: '',
        // Mô tả dạng HTML của site gốc (đủ mọi phần mô tả, chỉ bỏ liên hệ) — cột "Mô tả HTML"
        description_html: '',
        images: [],
        source: '',
        warnings: warnings,
        trace: trace,
        // Trường biến thể — chỉ site có adapter khai `extra` mới điền (VD Vionic).
        color_label: '',
        size_label: '',
        colors: [],
        sizes: [],
        sizes_in_stock: [],
        sizes_out_of_stock: [],
        // null = không xác định được; true/false = còn/hết hàng (dùng cho trang
        // "Kiểm tra hàng" chạy hằng ngày)
        in_stock: null,
        variants: [],
        stock_matrix: [],
        // {link ảnh: tên màu} — site bán nhiều màu trả gallery của cả loạt màu,
        // ô này cho biết ảnh nào của màu nào. Ảnh dùng chung (ảnh chụp phụ) không
        // có trong bản đồ.
        image_colors: {},
        // Site 1 link chung mọi màu: {màu: mã màu / link riêng của màu} và
        // {màu: {price, list_price}} khi giá khác nhau theo màu — Python dùng để tách
        // mỗi màu thành 1 sản phẩm lúc xuất (exporter.split_by_color).
        color_codes: {},
        color_prices: {},
        color_titles: {},        // {màu: tiêu đề riêng của màu} — site mỗi màu 1 tên (MacKenzie-Childs)
        details: '',
        fit_care: '',
        // Size & Fit (số đo người mẫu + số đo sản phẩm) và link bảng Size Guide
        // để chụp màn hình rồi đưa lên CDN
        size_fit: '',
        size_guide_url: '',
        size_guide_button: '',
        // Ảnh bảng size chụp từ màn hình (base64 PNG) — Python điền sau khi chụp
        size_guide_png: '',
        fit_guide_images: [],
        // ---- bố cục chuẩn checklist eBay ----
        current_color: '',       // màu của variant đang xem (cột "Màu hiện tại")
        variant_label: '',       // tên trục giữa (Men's Width / Size Type), '' nếu không có
        current_variant: '',     // giá trị trục giữa đang xem (MED)
        list_price: null,        // giá gốc / giá gạch — `price` là giá đang bán
        all_images: [],          // gallery MỌI màu; `images` chỉ là gallery màu đang xem
        brand: '',
        title_fixed: '',         // "<Brand> <tiêu đề>, <màu> Color, New" (<= 80 ký tự)
        identity_kind: '',       // 'color+variant' | 'color' | 'variant' — cách định danh variant
        // false = adapter có `extra` nhưng lần này chưa lấy được (trang chưa render xong
        // jsonConfig/DOM) -> crawler phải poll tiếp thay vì dừng sớm vì đã đủ ảnh + tiêu đề
        extra_ready: true,
    };

    const setPrice = (p, from) => {
        if (rec.price != null || !p) return;
        rec.price = p.value;
        rec.currency = p.currency || 'USD';
        log('price <- ' + from + ' = ' + p.value);
    };
    const setText = (field, v, from) => {
        v = S(v).trim();
        if (rec[field] || !v) return;
        rec[field] = v;
        log(field + ' <- ' + from + ' (' + v.length + ' ký tự)');
    };
    const setImages = (list, from) => {
        if (rec.images.length) return;
        const c = cleanImages(list);
        if (!c.length) return;
        rec.images = c;
        if (!rec.source) rec.source = from;
        log('images <- ' + from + ' (' + c.length + ' ảnh)');
    };
    const setAllImages = (list, from) => {
        if (rec.all_images.length) return;
        const c = cleanImages(list);
        if (!c.length) return;
        rec.all_images = c;
        log('all_images <- ' + from + ' (' + c.length + ' ảnh)');
    };

    const safe = (fn, label) => {
        try { return fn(); } catch (e) { log('lỗi ' + label + ': ' + e.message); return null; }
    };

    // Các phần mô tả dạng HTML {title, kind, html | el} — kind: description / details /
    // fit_care / size_fit (thay luôn ô chữ tương ứng) hoặc khác (chỉ vào bản HTML).
    let descSections = [];

    // ---- Tầng 0: Shopify (fetch /products/<handle>.js cùng origin) ----
    if (AD && AD.shopify) {
        try {
            const m = location.pathname.match(/\/products\/[^/?#]+/);
            if (m) {
                const r = await fetch(m[0] + '.js', { credentials: 'omit' });
                if (r.ok) {
                    const j = await r.json();
                    setText('title', j.title, 'shopify.title');
                    if (j.price != null) setPrice({ value: j.price / 100, currency: 'USD' }, 'shopify.price');
                    setText('description', stripHtml(j.description), 'shopify.description');
                    if (/<[a-z]/i.test(S(j.description))) {
                        descSections = [{ html: j.description, kind: 'description' }];
                    }
                    if (typeof j.available === 'boolean') {
                        rec.in_stock = j.available;
                        log('in_stock <- shopify = ' + j.available);
                    }
                    setImages(j.images || [], 'shopify-json');
                    rec.source = 'shopify-json';
                } else {
                    warnings.push('Shopify .js trả HTTP ' + r.status);
                }
            }
        } catch (e) {
            warnings.push('Không gọi được Shopify .js: ' + e.message);
        }
    }

    // ---- Tầng 0.5: adapter nạp trước phần lazy-load (nếu có) ----
    if (AD && AD.prefetch) {
        try {
            await AD.prefetch();
        } catch (e) {
            warnings.push('Không nạp được phần nạp-sau của trang: ' + e.message);
        }
    }

    // ---- Tầng 1: adapter theo domain ----
    if (AD) {
        if (AD.title) setText('title', safe(AD.title, 'adapter.title'), 'adapter');
        if (AD.price) setPrice(safe(AD.price, 'adapter.price'), 'adapter');
        if (AD.description) setText('description', safe(AD.description, 'adapter.description'), 'adapter');
        if (AD.images) setImages(safe(AD.images, 'adapter.images') || [], 'adapter');
        if (AD.allImages) setAllImages(safe(AD.allImages, 'adapter.allImages') || [], 'adapter');
        if (AD.extra) {
            // Truyền luôn danh sách ảnh đã lấy được để adapter gán màu cho từng ảnh
            const ex = safe(() => AD.extra(rec.images.slice()), 'adapter.extra');
            rec.extra_ready = !!ex;
            if (!ex) log('extra: adapter chưa lấy được (trang chưa render xong?) — poll tiếp');
            if (ex) {
                Object.keys(ex).forEach((k) => {
                    if (ex[k] != null && k in rec) rec[k] = ex[k];
                });
                // Ảnh mọi màu do extra trả (Revolve, Duluth) cũng phải qua bộ lọc ảnh rác
                if (Array.isArray(ex.all_images)) {
                    rec.all_images = cleanImages(ex.all_images);
                    log('all_images <- adapter.extra (' + rec.all_images.length + ' ảnh)');
                }
                // Adapter khai riêng imageColors (Vionic, Duluth) thì lấy thêm
                if (AD.imageColors && !Object.keys(rec.image_colors).length) {
                    rec.image_colors = safe(AD.imageColors, 'adapter.imageColors') || {};
                }
                const nColor = Object.keys(rec.image_colors).length;
                if (nColor) log('gán màu cho ' + nColor + '/' + rec.images.length + ' ảnh');
                log('extra <- adapter (' + rec.colors.length + ' màu, '
                    + rec.sizes.length + ' size, ' + rec.variants.length + ' variant, '
                    + rec.fit_guide_images.length + ' fit guide)');
            }
        }
        if (AD.descriptionSections) {
            const secs = safe(AD.descriptionSections, 'adapter.descriptionSections') || [];
            if (secs.length) descSections = secs;
        }
    } else {
        warnings.push('Chưa có adapter riêng cho ' + hostname + ' — dùng luật chung.');
    }

    // Khoá của bản đồ màu phải TRÙNG ĐÚNG link trong rec.images. Ảnh đi qua abs()
    // rồi gộp trùng theo path (bỏ query resize) nên chuỗi có thể lệch chút — tra
    // thêm theo path cho chắc, và bỏ những ảnh không còn trong danh sách.
    if (Object.keys(rec.image_colors).length) {
        const byPath = {};
        Object.keys(rec.image_colors).forEach((u) => {
            byPath[S(u).split('?')[0]] = rec.image_colors[u];
        });
        const fixed = {};
        rec.images.concat(rec.all_images).forEach((u) => {
            const c = rec.image_colors[u] || byPath[S(u).split('?')[0]] || '';
            if (c) fixed[u] = c;
        });
        rec.image_colors = fixed;
    }

    // ---- Tầng 2: structured data (JSON-LD -> OpenGraph) ----
    setText('title', safe(() => { const p = ldProduct(); return p ? decodeHtml(p.name) : ''; }, 'ld.name'), 'json-ld');
    setPrice(safe(ldPrice, 'ld.price'), 'json-ld');
    setText('description', safe(ldDesc, 'ld.desc'), 'json-ld');
    setImages(safe(ldImages, 'ld.images') || [], 'json-ld');

    if (rec.in_stock === null) {
        const st = safe(ldStock, 'ld.stock');
        if (st !== null && st !== undefined) {
            rec.in_stock = st;
            log('in_stock <- json-ld = ' + st);
        }
    }

    setText('title', S(meta('og:title')).split(' | ')[0], 'og');
    setPrice(parsePrice(meta('product:price:amount')), 'og');
    setText('description', stripHtml(meta('og:description')), 'og');
    setImages([meta('og:image')].filter(Boolean), 'og');

    // ---- Tầng 3: DOM heuristic ----
    setText('title', selText('h1'), 'heuristic.h1');

    if (rec.price == null) {
        const el = [].slice.call(document.querySelectorAll('[class*=price], [data-testid*=price], [id*=price]'))
            .find((e) => /\$\s?\d/.test(S(e.innerText)) && S(e.innerText).length < 40);
        if (el) setPrice(parsePrice(el.innerText), 'heuristic.price');
    }

    if (!rec.description) {
        let best = null;
        [].slice.call(document.querySelectorAll(
            '[class*=description], [id*=description], [class*=product-details], [class*=product-detail]'))
            .forEach((e) => {
                const L = S(e.innerText).trim().length;
                if (L > 120 && L < 6000 && (!best || L > S(best.innerText).length)) best = e;
            });
        if (best) setText('description', best.innerText, 'heuristic.description');
    }

    // og:image chỉ có 1 ảnh — nếu đó là tất cả những gì đang có thì vẫn quét
    // gallery DOM: tìm được nhiều ảnh hơn nghĩa là trang có gallery thật mà
    // các tầng trên bỏ lỡ (adapter hỏng do redesign / JSON-LD thiếu).
    if (!rec.images.length || (rec.images.length === 1 && rec.source === 'og')) {
        const els = [].slice.call(document.querySelectorAll(
            '[class*=gallery] img, [class*=carousel] img, [class*=slideshow] img, [class*=media] img'))
            .filter((i) => (i.naturalWidth || i.width) > 250);
        const gal = cleanImages(els.map((i) => i.currentSrc || i.src));
        if (gal.length > rec.images.length) {
            rec.images = gal;
            rec.source = 'heuristic.gallery';
            log('images <- heuristic.gallery (' + gal.length + ' ảnh, thay og:image)');
        }
    }

    // ---- bố cục chuẩn checklist eBay: màu đang xem / giá gốc / ma trận / brand ----
    if (!rec.current_color && rec.colors.length === 1) rec.current_color = rec.colors[0];
    if (rec.list_price == null) {
        const lp = safe(() => domListPrice(rec.price), 'dom.listPrice');
        if (lp != null) { rec.list_price = lp; log('list_price <- heuristic = ' + lp); }
    }
    // Site không có ma trận (Revolve, JSON-LD...) -> 1 dòng cho variant đang xem, để
    // Python/extension dựng cột "Size của tất cả variant" không phải xét riêng site.
    if (!rec.stock_matrix.length && (rec.sizes_in_stock.length || rec.sizes_out_of_stock.length)) {
        rec.stock_matrix = [{ color: rec.current_color, variant: rec.current_variant,
                              sizes_in_stock: rec.sizes_in_stock.slice(),
                              sizes_out_of_stock: rec.sizes_out_of_stock.slice() }];
    }
    rec.identity_kind = (AD && AD.identity) || 'color+variant';
    // Adapter khai `brand` riêng thì theo adapter — Crate & Barrel để trống vì brand
    // trong JSON-LD là tên NHÀ BÁN LẺ chứ không phải hãng sản xuất (Ninja, Le Creuset...).
    // Sàn TMĐT (Walmart, Amazon, eBay, Etsy) khai `brand` là HÀM — hãng thật của từng
    // sản phẩm, không phải tên sàn; hàm trả rỗng thì rơi về luật chung.
    if (AD && typeof AD.brand === 'function') {
        rec.brand = S(safe(AD.brand, 'adapter.brand')).trim() || safe(resolveBrand, 'brand') || '';
    } else {
        rec.brand = (AD && typeof AD.brand === 'string')
            ? AD.brand : (safe(resolveBrand, 'brand') || '');
    }

    // ---- mô tả HTML + thay ô chữ bằng bản đầy đủ lấy từ chính HTML đó ----
    const TEXT_KINDS = [['description', 'Description'], ['details', 'Details'],
                        ['fit_care', 'Fit & Care'], ['size_fit', 'Size & Fit']];
    // Cả phần mang tên bảo hành / ship / đổi trả / về hãng ("Warranty", "Shipping & Returns")
    // -> bỏ cả phần, như cột chữ
    const htmlSecs = descSections.map((s) => ({
        title: S(s.title).trim(),
        kind: s.kind || 'description',
        html: safe(() => cleanHtml(s.el || s.html), 'cleanHtml') || '',
    })).filter((s) => s.html && !(s.title && isListingNoise(s.title)));
    TEXT_KINDS.forEach((k) => {
        const list = htmlSecs.filter((s) => s.kind === k[0]);
        const txt = list.map((s) => {
            const t = htmlToText(s.html);
            return list.length > 1 && s.title && t ? s.title + '\n' + t : t;
        }).filter(Boolean).join('\n\n');
        if (txt) rec[k[0]] = txt;
    });
    // Phần adapter không có bản HTML -> dựng từ chữ (site khác / trang thiếu khối)
    TEXT_KINDS.forEach((k, i) => {
        if (htmlSecs.some((s) => s.kind === k[0]) || !rec[k[0]]) return;
        const sec = { title: k[1], kind: k[0], html: textToHtml(scrubListing(rec[k[0]])) };
        if (i === 0) htmlSecs.unshift(sec); else htmlSecs.push(sec);
    });
    rec.description_html = sectionsHtml(htmlSecs);
    if (htmlSecs.length) log('description_html <- ' + htmlSecs.length + ' phần (' + rec.description_html.length + ' ký tự)');

    // ---- lọc dòng liên hệ / bảo hành / ship / doanh nghiệp trong mọi phần chữ ----
    ['description', 'details', 'fit_care', 'size_fit'].forEach((f) => {
        const cleaned = scrubListing(rec[f]);
        if (cleaned !== rec[f]) log(f + ': đã xoá dòng liên hệ/bảo hành/ship/doanh nghiệp');
        rec[f] = cleaned;
    });
    // Mô tả chuẩn = Description + Details + Fit & Care (+ Size & Fit) gộp lại
    rec.description = mergeDescription(rec);
    rec.title_fixed = fixedTitle(rec.brand, rec.title, rec.current_color);
    log('title_fixed = ' + rec.title_fixed + ' | identity=' + rec.identity_kind
        + ' | màu đang xem=' + (rec.current_color || '?') + ' | giá gốc=' + rec.list_price);

    // ---- hậu kiểm ----
    // Chỉ khi KHÔNG tầng nào lấy được ảnh mới rơi xuống đây. Không gắn nhãn
    // 'adapter' bừa: crawler.py cộng điểm tin cậy lớn cho nguồn adapter, một
    // kết quả rỗng mang nhãn đó sẽ đè lên kết quả thật của lần poll sau.
    if (!rec.source) rec.source = 'generic';
    if (!rec.title) warnings.push('Không lấy được tiêu đề.');
    if (rec.price == null) warnings.push('Không lấy được giá.');
    if (!rec.description) warnings.push('Không lấy được mô tả.');
    if (!rec.images.length) warnings.push('Không lấy được ảnh nào.');
    if (!rec.currency && rec.price != null) rec.currency = 'USD';

    // Vài site đổi giá theo IP: Revolve trả 2.290.728 VND thay vì $228 khi IP không
    // phải Mỹ. Số đó rơi thẳng vào cột "Giá hiện tại" rồi nhân tiếp ra "% giá đặt",
    // nên phải báo rõ chứ không nhận im (crawler.py / background.js hạ trạng thái
    // xuống "Thiếu dữ liệu" khi thấy cờ này).
    if (rec.price != null && rec.currency && rec.currency.toUpperCase() !== 'USD') {
        rec.wrong_currency = rec.currency.toUpperCase();
        warnings.push('Giá đang là ' + rec.wrong_currency + ' chứ không phải USD — site '
            + 'đổi giá theo IP. Đổi sang proxy US rồi cào lại link này.');
    }

    return rec;
}
