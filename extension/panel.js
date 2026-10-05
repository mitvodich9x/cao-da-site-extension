/** panel.js — UI của side panel.
 *
 * Trạng thái CÀO nằm ở background.js; phần biên tập (tiêu đề/giá/variant/ảnh CDN)
 * nằm ở đây và được lưu vào chrome.storage.local theo link, nên đóng/mở lại panel
 * vẫn còn nguyên chỉnh sửa.
 *
 * Convert ảnh: tải ảnh (thử fetch thẳng, hỏng thì mở tab sản phẩm rồi fetch trong
 * tab đó để thừa hưởng cookie/proxy) → vẽ ra canvas → JPG → upload CDN Lumi
 * (POST /api/scanner/images). Cùng đường với tool desktop.
 */

const $ = (id) => document.getElementById(id);

// Chữ trạng thái dùng chung với tool desktop (exporter.STATUS_TEXT)
const STATUS_TEXT = {
    OK: 'Thành công', PARTIAL: 'Thiếu dữ liệu', BLOCKED: 'Bị chặn', ERROR: 'Lỗi',
};

// Còn/hết hàng — mirror stock_check.py của tool desktop
const STOCK_TEXT = {
    in: '✅ Còn hàng', out: '❌ Hết hàng', partial: '⚠️ Còn một phần',
    unknown: '❔ Không rõ', error: '🚫 Lỗi kiểm tra',
};

const EMPTY = '';
const QUOTE = String.fromCharCode(34);          // dau nhay kep
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const RE_EOL = new RegExp(String.fromCharCode(13) + String.fromCharCode(63) + String.fromCharCode(10), 'g');   // /\r?\n/g
const RE_SPECIAL = new RegExp('[' + TAB + LF + QUOTE + ']');
const RE_QUOTE = new RegExp(QUOTE, 'g');

// Nơi công bố bản extension mới (repo riêng của extension, release.ps1 tự ghi file này)
const UPDATE_INFO_URL =
    'https://raw.githubusercontent.com/mitvodich9x/cao-da-site-extension/main/extension.json';

// % giá đặt theo checklist eBay: Giá ứng = giá hiện tại × %/100 (180 × 70% = 126)
const DEFAULT_LIST_PERCENT = 70;
const VARIANT_SEP = ' | ';
const VARIANT_EQ = ':=';

let records = [];      // bản chiếu từ background, theo thứ tự nhập (null = chưa xong)
// Danh sách HIỂN THỊ: records đã tách màu (site 1 link chung mọi màu -> mỗi màu 1 dòng).
// Bảng, editor, Bảng eBay, convert, xuất file đều theo `rows`; rec._src = vị trí trong records.
let rows = [];
let currentKey = '';   // url (khoá bản nháp) của dòng đang mở — giữ đúng dòng khi bảng dựng lại
let drafts = {};       // url -> bản nháp đang biên tập
// CDN Lumi điền sẵn để không phải nhập lại trên từng máy. Token này chỉ dùng cho
// việc đưa ảnh lên CDN của Lumi; ai muốn dùng token riêng thì nhập ở mục ⚙️,
// bản nhập tay luôn được ưu tiên (để trống ô token = quay về bản điền sẵn).
// Token nằm ở lumi-default.js (không đưa lên git vì repo công khai; release.ps1 đóng vào zip).
const DEFAULT_LUMI = {
    url: 'https://lumi.vgplay.vn',
    token: window.LUMI_DEFAULT_TOKEN || '',
};

let lumi = Object.assign({}, DEFAULT_LUMI);
let current = -1;      // dòng đang mở trong editor
let cdnMap = {};       // link ảnh gốc -> link CDN đã convert (nhớ giữa các lần cào)
// Mã định danh variant đã cấp: {counters: {"Vionicshoes_300826": 3}, ids: {khoá: mã}}
// (mirror data/variant_ids.json của tool desktop) — xoá bảng KHÔNG xoá bộ nhớ này.
let variantIds = { counters: {}, ids: {} };

const list = (v) => (Array.isArray(v) ? v.filter((x) => String(x).trim()) : []);
const cleanText = (s) => String(s || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

function baseDomain(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.startsWith('www.') ? host.slice(4) : host;
    } catch (e) { return ''; }
}

// ==== bố cục chuẩn checklist eBay (mirror ebay_prep.py / variant_ids.py) =====

// Domain đăng ký, bỏ subdomain: global.danner.com -> danner.com (2 link là 1 sản phẩm)
function siteDomain(url) {
    const parts = baseDomain(url).split('.').filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
}

// vionicshoes.com -> Vionicshoes (dùng cho mã định danh)
function siteName(url) {
    const first = siteDomain(url).split('.')[0] || 'Site';
    return first.charAt(0).toUpperCase() + first.slice(1);
}

// "Tiêu đề đã sửa": <Brand> <tiêu đề>, <màu> Color, New — tối đa 80 ký tự (mirror extract.js)
function fixedTitle(brand, title, color, limit) {
    limit = limit || 80;
    // eBay không cho ký hiệu ®/™ trong tiêu đề — bỏ khỏi bản đã sửa
    title = String(title || '').replace(/[\u00ae\u2122\u00a9]/g, ' ')
        .replace(/\s+/g, ' ').trim();
    brand = String(brand || '').replace(/\s+/g, ' ').trim();
    color = String(color || '').replace(/\s+/g, ' ').trim();
    // Tiêu đề gốc đã kết thúc bằng "New" (eBay: "... edp New") -> bỏ để không thành "New, New"
    title = title.replace(/[\s,\-–—]*\bNew\s*$/i, '').trim() || title;
    if (!title) return '';
    let base = title;
    if (brand && title.toLowerCase().indexOf(brand.toLowerCase()) !== 0) base = brand + ' ' + title;
    // Tiêu đề đã chứa sẵn tên màu ("Element 8\" Brown") thì không lặp ", Brown Color"
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
}

// Giá ứng với % giá đặt = giá hiện tại × %/100, làm tròn 2 số
function offerPrice(price, pct) {
    const p = Number(price);
    const q = Number(pct);
    if (price == null || price === '' || !isFinite(p) || !isFinite(q)) return '';
    return Math.round(p * q) / 100;
}

// % giá đặt trên page (ô #inpPercent), trống thì 70
function pagePercent() {
    const el = $('inpPercent');
    const v = el ? Number(el.value) : NaN;
    return (el && el.value !== '' && isFinite(v)) ? v : DEFAULT_LIST_PERCENT;
}

// % của 1 sản phẩm: bản nháp đã chỉnh riêng > ô trên page
function pctFor(d) {
    if (d && d.list_percent !== '' && d.list_percent != null && isFinite(Number(d.list_percent))) {
        return Number(d.list_percent);
    }
    return pagePercent();
}

function axisText(name, values) {
    return (name || 'Variant') + VARIANT_EQ + list(values).join(';');
}

// 1 dòng ma trận tồn kho -> "Color:=Black Suede | Men's Width:=MED | Size:=7;8;9"
function stockLineOf(rec, m) {
    const parts = [];
    if (m.color) parts.push(axisText(rec.color_label || 'Color', [m.color]));
    if (m.variant) parts.push(axisText(rec.variant_label || 'Variant', [m.variant]));
    parts.push(axisText(rec.size_label || 'Size', m.sizes_in_stock));
    return parts.join(VARIANT_SEP);
}

function matrixRows(rec) {
    return (rec.stock_matrix || []).filter((m) => m && typeof m === 'object');
}

// Cột "Size của tất cả variant": mỗi tổ hợp màu × trục giữa còn size 1 dòng
function buildStockLines(rec) {
    return matrixRows(rec).filter((m) => list(m.sizes_in_stock).length)
        .map((m) => stockLineOf(rec, m));
}

// Cột "Size hiện tại còn": dòng của ĐÚNG variant đang xem (màu + trục giữa hiện tại)
function currentStockLine(rec) {
    const rows = matrixRows(rec);
    const color = rec.current_color || '';
    const variant = rec.current_variant || '';
    if (!rows.length) {
        if (!list(rec.sizes_in_stock).length && !list(rec.sizes_out_of_stock).length) return '';
        return stockLineOf(rec, { color, variant, sizes_in_stock: rec.sizes_in_stock });
    }
    const hit = rows.find((m) => (m.color || '') === color && (m.variant || '') === variant)
        || rows.find((m) => (m.color || '') === color && list(m.sizes_in_stock).length)
        || rows[0];
    return stockLineOf(rec, hit);
}

// ---- định danh variant gốc: <Site>_<DDMMYY>_a001 + bộ khoá (mirror variant_ids.py) ----
// Bộ khoá tuỳ kiểu link của site (identity_kind do adapter extract.js khai):
//   color+variant: domain + tiêu đề + màu + trục giữa · color: + màu · variant: + variant
function identityParts(rec) {
    const kind = String(rec.identity_kind || 'color+variant').toLowerCase();
    const dom = siteDomain(rec.url);
    const parts = [['Link', dom ? 'https://www.' + dom : rec.url], ['Tiêu đề', cleanText(rec.title)]];
    const color = String(rec.current_color || '').trim();
    const variant = String(rec.current_variant || '').trim();
    const colorLabel = String(rec.color_label || '').trim() || 'Color';
    const variantLabel = String(rec.variant_label || '').trim() || 'Variant';
    if (kind === 'variant') {
        if (variant) parts.push([variantLabel, variant]);
        else if (color) parts.push([colorLabel, color]);
    } else {
        if (color) parts.push([colorLabel, color]);
        if (kind !== 'color' && variant) parts.push([variantLabel, variant]);
    }
    // Mã màu của site (Walmart: item id link đầu tiên của màu) — mirror variant_ids.identity_parts
    const codes = rec.color_codes || {};
    if (color) {
        const k = Object.keys(codes).find((x) => sameText(x, color));
        if (k && codes[k]) parts.push(['Mã màu', String(codes[k])]);
    }
    return parts;
}

function identityKey(rec) {
    return identityParts(rec)
        .map((p) => String(p[1]).split(/\s+/).join(' ').trim().toLowerCase()).join('|');
}

// Cấp (hoặc lấy lại) mã cho record: cùng khoá -> cùng mã, mã mới đếm theo site + ngày
function assignVariantId(rec) {
    if (!rec || !rec.url || !rec.title) return '';
    const key = identityKey(rec);
    let vid = variantIds.ids[key];
    if (!vid) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const bucket = siteName(rec.url) + '_' + pad(now.getDate()) + pad(now.getMonth() + 1)
            + String(now.getFullYear()).slice(-2);
        const n = (Number(variantIds.counters[bucket]) || 0) + 1;
        variantIds.counters[bucket] = n;
        vid = bucket + '_a' + String(n).padStart(3, '0');
        variantIds.ids[key] = vid;
        try { chrome.storage.local.set({ sc_variant_ids: variantIds }); } catch (e) { /* bỏ qua */ }
    }
    rec.variant_id = vid;
    return vid;
}

function identityText(rec) {
    const lines = identityParts(rec).filter((p) => p[1]).map((p) => p[0] + ': ' + p[1]);
    return (rec.variant_id ? [rec.variant_id] : []).concat(lines).join('\n');
}

// Cột "Ảnh size chart": link dán tay > ảnh chụp đã lên CDN > ảnh fit guide của site
function sizeChartOf(rec, d) {
    if (d && d.size_chart_url) return d.size_chart_url;
    if (d && d.extra && d.extra.size_guide_image) return d.extra.size_guide_image;
    const fit = list(rec.fit_guide_images);
    if (fit.length) return fit.join('\n');
    return rec.size_guide_url || '';
}

// Tuỳ chọn xuất (ô % giá đặt + 2 ô ẩn cột) nhớ giữa các lần mở panel
function saveExportOpts() {
    try {
        chrome.storage.local.set({ sc_opts: {
            percent: pagePercent(),
            hide_all_images: !!($('chkHideAllImages') && $('chkHideAllImages').checked),
            hide_all_sizes: !!($('chkHideAllSizes') && $('chkHideAllSizes').checked),
            split_colors: splitColors(),
            page_wait: pageWait(),
            amazon_all: !!($('chkAmazonAll') && $('chkAmazonAll').checked),
        } });
    } catch (e) { /* bỏ qua */ }
}

function restoreExportOpts(opts) {
    if (!opts) return;
    if (opts.percent != null && $('inpPercent')) $('inpPercent').value = opts.percent;
    if ($('chkHideAllImages')) $('chkHideAllImages').checked = !!opts.hide_all_images;
    if ($('chkHideAllSizes')) $('chkHideAllSizes').checked = !!opts.hide_all_sizes;
    if ($('chkSplitColors') && opts.split_colors != null) $('chkSplitColors').checked = !!opts.split_colors;
    if ($('inpPageWait') && opts.page_wait != null) $('inpPageWait').value = opts.page_wait;
    if ($('chkAmazonAll')) $('chkAmazonAll').checked = !!opts.amazon_all;
}

// Ô "Chờ mỗi trang" (giây): background đọc sc_opts.page_wait mỗi lần mở 1 trang để cào
function pageWait() {
    const n = Number($('inpPageWait') ? $('inpPageWait').value : 40);
    return isFinite(n) && n >= 5 ? Math.min(n, 300) : 40;
}

// ==== còn/hết hàng ==========================================================

function evaluateStock(rec) {
    if (rec.status === 'ERROR' || rec.status === 'BLOCKED') {
        return { status: 'error',
                 note: rec.note || (rec.status === 'BLOCKED' ? 'Bị chặn khi mở trang'
                                                             : 'Không cào được trang') };
    }
    const ok = list(rec.sizes_in_stock);
    const out = list(rec.sizes_out_of_stock);
    if (ok.length && out.length) {
        return { status: 'partial', note: 'Còn: ' + ok.join(', ') + ' · Hết: ' + out.join(', ') };
    }
    if (ok.length) return { status: 'in', note: 'Còn đủ size: ' + ok.join(', ') };
    if (out.length) return { status: 'out', note: 'Hết tất cả size: ' + out.join(', ') };
    if (rec.in_stock === true) return { status: 'in', note: 'Trang báo còn hàng' };
    if (rec.in_stock === false) return { status: 'out', note: 'Trang báo hết hàng' };
    if (rec.status === 'OK' || rec.title) {
        return { status: 'unknown', note: 'Trang không nói rõ còn hay hết' };
    }
    return { status: 'error', note: rec.note || 'Không đọc được trang' };
}

function labelJoin(label, items) {
    const arr = list(items).map(String);
    if (!arr.length) return '';
    return label ? label + ': ' + arr.join(', ') : arr.join(', ');
}

function stockMatrixText(matrix) {
    return (matrix || []).filter((m) => m && typeof m === 'object').map((m) => {
        const parts = [m.color, m.variant].filter(Boolean);
        parts.push('Còn: ' + (list(m.sizes_in_stock).join(', ') || '(không)'));
        parts.push('Hết: ' + (list(m.sizes_out_of_stock).join(', ') || '(không)'));
        return parts.join(' | ');
    }).join('\n');
}

// ==== bản nháp biên tập =====================================================

// Mọi size CÒN hàng của sản phẩm — gộp từ MỌI màu trong ma trận tồn kho.
// mirror ebay_prep.all_sizes_in_stock. `sizes_in_stock` chỉ là size còn của ĐÚNG
// màu trong link; lấy nó làm trục Size cả bảng thì size chỉ có ở màu khác sẽ mất.
function allSizesInStock(rec) {
    const pool = [];
    list(rec && rec.stock_matrix).forEach((row) => {
        if (!row || typeof row !== 'object') return;
        list(row.sizes_in_stock).forEach((s) => { if (pool.indexOf(s) < 0) pool.push(s); });
    });
    if (!pool.length) {
        return list(rec.sizes_in_stock).length ? list(rec.sizes_in_stock) : list(rec.sizes);
    }
    const order = list(rec.sizes);
    return order.filter((s) => pool.indexOf(s) >= 0)
        .concat(pool.filter((s) => order.indexOf(s) < 0));
}

// Gom biến thể của record thành [{name, values[]}] — mirror ebay_prep.parse_variant_groups
function parseVariantGroups(rec) {
    const groups = [];
    if (list(rec.colors).length) {
        groups.push({ name: rec.color_label || 'Color', values: list(rec.colors) });
    }
    const sizes = allSizesInStock(rec);
    if (sizes.length) groups.push({ name: rec.size_label || 'Size', values: sizes });
    const byName = {};
    list(rec.variants).forEach((v) => {
        const raw = String(v);
        const i = raw.indexOf(':');
        const name = (i >= 0 ? raw.slice(0, i) : 'Variant').trim() || 'Variant';
        const value = (i >= 0 ? raw.slice(i + 1) : '').trim();
        if (!value) return;
        if (!byName[name]) { byName[name] = { name, values: [] }; groups.push(byName[name]); }
        if (byName[name].values.indexOf(value) < 0) byName[name].values.push(value);
    });
    return groups;
}

// Size CÒN hàng của đúng 1 tổ hợp (màu × trục giữa) — mirror ebay_prep.combo_sizes.
// null = ma trận không có dòng nào khớp -> dùng trục Size đầy đủ như cũ.
function comboSizes(matrix, color, midValues) {
    const rows = list(matrix).filter((m) => m && typeof m === 'object');
    if (!rows.length) return null;
    const want = String(color || '').trim();
    const mids = list(midValues).map((v) => String(v).trim()).filter(Boolean);
    const hits = rows.filter((row) => {
        if (String(row.color || '').trim() !== want) return false;
        const variant = String(row.variant || '').trim();
        return !(variant && mids.length && mids.indexOf(variant) < 0);
    });
    if (!hits.length) return null;
    const out = [];
    hits.forEach((row) => list(row.sizes_in_stock).forEach(
        (s) => { if (out.indexOf(s) < 0) out.push(s); }));
    return out;
}

// Màu ở đầu, Size ở cuối, các nhóm giữa nhân với màu — mirror build_variant_lines.
// Có `matrix` (stock_matrix) thì MỖI MÀU chỉ trải size còn hàng của chính màu đó;
// màu hết sạch size thì bỏ hẳn dòng. Trước đây nhân Descartes màu × trục Size nên
// mọi màu đều bị gán size của MÀU GỐC trong link.
function buildVariantLines(groups, matrix) {
    const clean = (groups || []).filter((g) => g && list(g.values).length);
    const colorG = clean.find((g) => /color|màu/i.test(g.name || ''));
    const sizeG = clean.find((g) => /size|cỡ/i.test(g.name || ''));
    const mids = clean.filter((g) => g !== colorG && g !== sizeG);
    const ordered = [].concat(colorG || [], mids, sizeG || []);
    if (!ordered.length) return [];

    const axis = (name, values) => (name || 'Variant') + VARIANT_EQ + values.join(';');
    const lines = [ordered.map((g) => axis(g.name, list(g.values))).join(VARIANT_SEP)];

    let heads = [[]];
    [].concat(colorG || [], mids).forEach((g) => {
        const next = [];
        heads.forEach((combo) => list(g.values).forEach((v) => next.push(combo.concat([[g.name, v]]))));
        heads = next;
    });
    const sizes = sizeG ? list(sizeG.values) : [];
    const colorName = colorG ? colorG.name : '';
    heads.forEach((combo) => {
        const parts = combo.map(([n, v]) => axis(n, [v]));
        let comboList = sizes;
        if (sizes.length && matrix && colorG) {
            const cv = (combo.find(([n]) => n === colorName) || ['', ''])[1];
            const found = comboSizes(matrix, cv,
                combo.filter(([n]) => n !== colorName).map(([, v]) => v));
            if (found !== null) {
                comboList = sizes.filter((s) => found.indexOf(s) >= 0);
                if (!comboList.length) return;      // hết sạch size -> không đăng
            }
        }
        if (comboList.length) {
            comboList.forEach((s) => lines.push(parts.concat([axis(sizeG.name, [s])]).join(VARIANT_SEP)));
        } else if (parts.length) lines.push(parts.join(VARIANT_SEP));
    });
    if (lines.length === 2 && lines[0] === lines[1]) lines.pop();
    return lines;
}

// Chưa mở khung Chi tiết thì vẫn dựng được dòng variant từ dữ liệu cào
function parseVariantLines(rec) {
    return buildVariantLines(parseVariantGroups(rec), list(rec && rec.stock_matrix));
}

function draftFor(idx) {
    const rec = rows[idx];
    if (!rec) return null;
    if (!drafts[rec.url]) {
        drafts[rec.url] = {
            url: rec.url,
            title: rec.title || '',
            description: rec.description || '',
            price: rec.price == null ? '' : rec.price,
            list_percent: pagePercent(),
            size_fit: rec.size_fit || '',
            // Link ảnh bảng size: Vionic có sẵn; site khác dán tay hoặc lấy ảnh chụp sau convert
            size_chart_url: list(rec.fit_guide_images)[0] || '',
            images: list(rec.images).concat(list(rec.fit_guide_images)),
            cdn_images: [],
            variants: parseVariantGroups(rec),
            stock_matrix: list(rec.stock_matrix),
        };
    }
    // Bản nháp lưu từ trước chưa có ma trận tồn kho -> bù lại từ record đang có
    if (!list(drafts[rec.url].stock_matrix).length && list(rec.stock_matrix).length) {
        drafts[rec.url].stock_matrix = list(rec.stock_matrix);
    }
    return drafts[rec.url];
}

function saveDrafts() {
    try { chrome.storage.local.set({ sc_drafts: drafts }); } catch (e) { /* bỏ qua */ }
}

// Nhớ ảnh đã convert: link gốc -> link CDN. Cào lại đúng sản phẩm đó (hoặc sản
// phẩm khác dùng chung ảnh) thì lấy lại link cũ, KHÔNG upload lên CDN lần nữa.
function rememberCdn(srcUrl, cdnUrl) {
    if (!srcUrl || !cdnUrl) return;
    cdnMap[srcUrl] = cdnUrl;
    try { chrome.storage.local.set({ sc_cdn_map: cdnMap }); } catch (e) { /* bỏ qua */ }
}

// ==== render bảng ===========================================================

function renderRow(idx, rec) {
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    const price = rec.price == null ? '' : String(rec.price);
    const stock = evaluateStock(rec);
    const draft = drafts[rec.url];
    const sizes = list(rec.sizes_in_stock).length ? list(rec.sizes_in_stock) : list(rec.sizes);
    tr.innerHTML =
        '<td>' + (idx + 1) + '</td>' +
        '<td>' + baseDomain(rec.url) + '</td>' +
        '<td class="title"></td>' +
        '<td>' + price + '</td>' +
        '<td class="sizes"></td>' +
        '<td class="stock stock-' + stock.status + '"></td>' +
        '<td>' + rec.image_count + '</td>' +
        '<td class="cdn-count"></td>' +
        '<td class="st-' + rec.status + '"></td>' +
        '<td>' +
        '<button class="mini copy" title="Copy toàn bộ link ảnh của sản phẩm này">📋 Ảnh</button>' +
        '<button class="mini conv" title="Convert ảnh của riêng sản phẩm này sang CDN '
        + '(ảnh đã convert lần trước thì dùng lại link cũ)">⚡</button>' +
        '<button class="mini addimg" title="Thêm ảnh cho sản phẩm này: dán ảnh chụp màn hình '
        + 'hoặc chọn file — tự đưa lên CDN">➕</button>' +
        '<button class="mini guide" title="Chụp bảng Size Guide của sản phẩm này: mở trang, '
        + 'bấm nút Size Guide, chờ bảng hiện rồi chụp và đưa lên CDN">📐</button>' +
        '<button class="mini edit" title="Mở phần biên tập của sản phẩm này">✏️</button>' +
        '<button class="mini open" title="Mở link gốc">🔗</button>' +
        '<button class="mini retry" title="Cào lại riêng link này">↻</button>' +
        '</td>';
    const tdTitle = tr.children[2];
    tdTitle.textContent = (rec.title || '(không lấy được tiêu đề)')
        + (rec._split && rec.current_color ? ' — ' + rec.current_color
           + (rec.current_variant ? ' / ' + rec.current_variant : '') : '');
    tdTitle.title = rec.url + (rec.description ? '\n\n' + rec.description.slice(0, 800) : '');

    const tdSizes = tr.children[4];
    tdSizes.textContent = sizes.length ? sizes.join(', ') : '';
    tdSizes.title = [labelJoin(rec.color_label || 'Màu', rec.colors),
                     labelJoin(rec.size_label || 'Size', rec.sizes),
                     list(rec.variants).join('\n'),
                     stockMatrixText(rec.stock_matrix)].filter(Boolean).join('\n')
                    || 'Site này không cho biết size';

    const tdStock = tr.children[5];
    tdStock.textContent = STOCK_TEXT[stock.status] || stock.status;
    tdStock.title = stock.note;

    const nCdn = (draft && draft.cdn_images.length) || 0;
    const nSrc = (draft && draft.images.length) || rec.image_count;
    const tdCdn = tr.children[7];
    // Ảnh dán tay làm số convert có thể NHIỀU hơn số ảnh gốc -> đừng hiện "4/3"
    tdCdn.textContent = !nCdn ? '—' : (nCdn >= nSrc ? '✔ ' + nCdn : nCdn + '/' + nSrc);
    tdCdn.className = 'cdn-count' + (nCdn && nCdn >= nSrc ? ' is-done' : '');
    tdCdn.title = nCdn ? draft.cdn_images.join('\n') : 'Chưa convert ảnh sang CDN';

    const tdStatus = tr.children[8];
    tdStatus.textContent = STATUS_TEXT[rec.status] || rec.status;
    if (rec.note) tdStatus.title = rec.note;

    if (idx === current) tr.classList.add('is-active');

    tr.querySelector('.copy').addEventListener('click', () => copyRowImages(idx));
    tr.querySelector('.conv').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (current !== idx) openEditor(idx);
        await convertDraft(idx);
    });
    tr.querySelector('.guide').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (current !== idx) openEditor(idx);
        await captureSizeGuide(idx);
    });
    tr.querySelector('.addimg').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (current !== idx) openEditor(idx);
        $('filePick').click();          // dán được thì Ctrl+V, còn lại chọn file
    });
    tr.querySelector('.edit').addEventListener('click', () => openEditor(idx));
    tr.querySelector('.open').addEventListener('click', () => chrome.tabs.create({ url: rec.link_url || rec.url }));
    tr.querySelector('.retry').addEventListener('click', () => {
        chrome.runtime.sendMessage({ cmd: 'retry', idx: rec._src != null ? rec._src : idx }, (res) => {
            if (res && res.error) alert(res.error);
        });
    });
    tr.addEventListener('click', (ev) => {
        if (ev.target.tagName !== 'BUTTON') openEditor(idx);
    });
    return tr;
}

function rebuildRows() {
    const src = [];
    records.forEach((r, i) => { if (r) src.push(Object.assign({}, r, { _src: i })); });
    rows = splitColors() ? splitByColor(src) : src;
}

// Vẽ lại 1 dòng của bảng hiển thị (idx = vị trí trong rows)
function upsertRow(idx, rec) {
    if (!rec) return;
    rows[idx] = rec;
    const body = $('tblBody');
    const existing = body.querySelector('tr[data-idx="' + idx + '"]');
    const tr = renderRow(idx, rec);
    if (existing) existing.replaceWith(tr); else body.appendChild(tr);
}

// Background báo xong 1 LINK (idx = vị trí trong records) -> tách màu rồi vẽ lại cả bảng
function setSourceRow(idx, rec) {
    records[idx] = rec;
    renderAll();
}

function renderAll() {
    rebuildRows();
    current = currentKey ? rows.findIndex((r) => r.url === currentKey) : -1;
    if (current < 0 && !$('editor').hidden) { $('editor').hidden = true; currentKey = ''; }
    $('tblBody').innerHTML = '';
    rows.forEach((rec, idx) => $('tblBody').appendChild(renderRow(idx, rec)));
}

function doneRecords() {
    return rows;
}

// ==== editor ================================================================

function openEditor(idx) {
    const rec = rows[idx];
    if (!rec) return;
    current = idx;
    currentKey = rec.url;
    const d = draftFor(idx);
    $('editor').hidden = false;
    $('edTitleHead').textContent = 'Chi tiết: ' + (rec.title || rec.url).slice(0, 60);
    $('edLink').href = rec.url;
    $('edTitle').value = d.title;
    $('edPrice').value = d.price;
    $('edPercent').value = d.list_percent;
    $('edSizeChart').value = d.size_chart_url || '';
    $('edDesc').value = d.description;
    $('edSizeFit').value = d.size_fit;
    $('edImages').value = d.images.join('\n');

    const stock = evaluateStock(rec);
    $('edStock').textContent = (STOCK_TEXT[stock.status] || '') + ' — ' + stock.note;
    $('edStock').className = 'stock-line stock-' + stock.status;

    renderVariantTable(d);
    renderCdnTable(d);
    updateListPrice();
    renderAll();
    $('editor').scrollIntoView({ block: 'nearest' });
}

function renderVariantTable(d) {
    const body = $('tblVarBody');
    body.innerHTML = '';
    (d.variants || []).forEach((g) => addVariantRow(g.name, list(g.values).join(';')));
    renderVariantLines(d);
}

function addVariantRow(name, values) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input class="var-name" type="text"></td>'
        + '<td><input class="var-values" type="text"></td>';
    tr.querySelector('.var-name').value = name || '';
    tr.querySelector('.var-values').value = values || '';
    tr.addEventListener('input', collectVariants);
    tr.addEventListener('click', () => {
        [].slice.call($('tblVarBody').children).forEach((r) => r.classList.remove('is-active'));
        tr.classList.add('is-active');
    });
    $('tblVarBody').appendChild(tr);
}

function collectVariants() {
    const d = currentDraft();
    if (!d) return;
    const groups = [];
    [].slice.call($('tblVarBody').children).forEach((tr) => {
        const name = tr.querySelector('.var-name').value.trim();
        const values = tr.querySelector('.var-values').value.split(';')
            .map((v) => v.trim()).filter(Boolean);
        if (name || values.length) groups.push({ name: name || 'Variant', values });
    });
    d.variants = groups;
    renderVariantLines(d);
    saveDrafts();
}

function renderVariantLines(d) {
    const lines = buildVariantLines(d.variants, list(d.stock_matrix));
    const body = $('tblVarLinesBody');
    body.innerHTML = '';
    lines.forEach((line, i) => {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.textContent = line;
        if (i === 0) td.className = 'is-main';
        tr.appendChild(td);
        body.appendChild(tr);
    });
    $('lblVarLines').innerHTML = '<b>Variant chi tiết</b>'
        + (lines.length ? ' <span class="tag">1 dòng chính + ' + (lines.length - 1) + ' dòng con</span>' : '');
}

function renderCdnTable(d) {
    const body = $('tblCdnBody');
    body.innerHTML = '';
    (d.cdn_images || []).forEach((link, i) => {
        const tr = document.createElement('tr');
        const num = document.createElement('td');
        num.textContent = String(i + 1);
        const td = document.createElement('td');
        td.textContent = link;
        td.title = 'Bấm để copy link này';
        tr.appendChild(num);
        tr.appendChild(td);
        tr.addEventListener('click', () => {
            navigator.clipboard.writeText(link);
            appendLog('📋 Đã copy link ảnh ' + (i + 1) + '.');
        });
        body.appendChild(tr);
    });
    $('lblCdn').textContent = (d.cdn_images || []).length
        ? 'Link CDN (sau convert) — ' + d.cdn_images.length + ' ảnh'
        : 'Link CDN (sau convert)';
}

function currentDraft() {
    return current >= 0 ? draftFor(current) : null;
}

function saveEditor() {
    const d = currentDraft();
    if (!d) return;
    d.title = $('edTitle').value.trim();
    d.price = $('edPrice').value === '' ? '' : Number($('edPrice').value);
    d.list_percent = $('edPercent').value === '' ? '' : Number($('edPercent').value);
    d.size_chart_url = $('edSizeChart').value.trim();
    d.description = $('edDesc').value.trim();
    d.size_fit = $('edSizeFit').value.trim();
    d.images = $('edImages').value.split('\n').map((x) => x.trim()).filter(Boolean);
    collectVariants();
    updateListPrice();
    saveDrafts();
}

function updateListPrice() {
    const price = Number($('edPrice').value || 0);
    const pct = $('edPercent').value === '' ? pagePercent() : Number($('edPercent').value || 0);
    $('edListPrice').textContent = price > 0
        ? '→ Giá ứng: ' + (price * pct / 100).toFixed(2) : '';
}

// ==== xuất dữ liệu (mirror exporter.py) =====================================

// Bảng xuất theo checklist eBay: 21 cột đúng thứ tự + 4 cột đuôi (Trạng thái · Ghi chú ·
// Ảnh đã convert · Mô tả HTML). Mỗi sản phẩm nhiều hàng: ảnh của variant đang lấy / ảnh của toàn bộ
// variant / dòng size của tất cả variant mỗi thứ 1 hàng; ô chung chỉ điền ở HÀNG ĐẦU.
// Sản phẩm chưa có ảnh vẫn có đúng 1 hàng để không mất dữ liệu.
const COL_CUR_IMAGE = 'Ảnh của variant đang lấy';
const COL_ALL_IMAGES = 'Ảnh của toàn bộ variant';
const COL_IMAGE_COLOR = 'Tên màu';
const COL_ALL_SIZES = 'Size của tất cả variant';
const COL_CDN = 'Ảnh đã convert';
const COL_DESC_HTML = 'Mô tả HTML';
const EXPORT_COLUMNS = ['Link', 'Tiêu đề gốc', 'Tiêu đề đã sửa', 'Mô tả', 'Giá gốc', 'Giá hiện tại',
    'Màu hiện tại', 'Màu tổng', COL_CUR_IMAGE, 'Ảnh size chart', COL_IMAGE_COLOR, COL_ALL_IMAGES,
    'Size hiện tại còn', 'Chi tiết size', COL_ALL_SIZES, 'Cảnh báo hết size', ' ', '% giá đặt',
    'Giá ứng với % giá đặt', 'Định danh variant gốc', 'SKU các acc',
    'Trạng thái', 'Ghi chú', COL_CDN, COL_DESC_HTML];

// 2 ô tích ẩn cột: ẩn cột thì bỏ luôn các hàng chỉ sinh ra để chứa cột đó
function hideAllImages() { const el = $('chkHideAllImages'); return !!(el && el.checked); }
function hideAllSizes() { const el = $('chkHideAllSizes'); return !!(el && el.checked); }
function splitColors() { const el = $('chkSplitColors'); return !el || !!el.checked; }

// Site 1 link chung mọi màu: tách mỗi MÀU (× trục giữa nếu có) thành 1 sản phẩm riêng —
// tiêu đề, ảnh, size còn/hết và mã định danh riêng. Mirror exporter.split_by_color.
function sameText(a, b) {
    const n = (x) => String(x == null ? '' : x).split(/\s+/).filter(Boolean).join(' ').toLowerCase();
    return n(a) === n(b);
}

function splitByColor(recs) {
    const out = [];
    recs.forEach((r) => {
        const ok = r.status !== 'ERROR' && r.status !== 'BLOCKED';
        const kind = String(r.identity_kind || '').trim().toLowerCase();
        const matrix = list(r.stock_matrix).filter((m) => m && m.color);
        const imgColors = r.image_colors || {};
        let pairs = matrix.map((m) => [m.color, m.variant || '']);
        if (!pairs.length) pairs = list(r.colors).filter(Boolean).map((c) => [c, '']);
        const uniq = [];
        pairs.forEach((p) => { if (!uniq.some((u) => sameText(u[0], p[0]) && sameText(u[1], p[1]))) uniq.push(p); });
        const nColors = uniq.filter((p, i) => uniq.findIndex((u) => sameText(u[0], p[0])) === i).length;
        if (r._split || !ok || kind !== 'color+variant' || nColors < 2) { out.push(r); return; }

        const allImages = list(r.all_images).length ? list(r.all_images) : list(r.images);
        const shared = allImages.filter((u) => !imgColors[u]);
        const codes = r.color_codes || {};
        const prices = r.color_prices || {};
        const pick = (map, color) => { const k = Object.keys(map).find((x) => sameText(x, color)); return k ? map[k] : null; };
        // Link riêng của màu: mã màu của site nằm trong link gốc (Tommy Bahama /p/<style>-<màu>,
        // Eileen Fisher ?dwvar_..._color=<mã>) thì thay mã; Walmart thay item id cuối link.
        const colorLink = (color) => {
            const code = String(pick(codes, color) || '');
            if (!code) return '';
            if (/^https?:/i.test(code)) return code;
            const u = String(r.url || '');
            const cur = String(pick(codes, r.current_color) || '');
            if (cur && cur !== code) {
                const esc = cur.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp('(^|[^A-Za-z0-9])' + esc + '(?=$|[^A-Za-z0-9])');
                if (re.test(u)) return u.replace(re, (m, p) => p + code);
            }
            if (/walmart\.com\/ip\//i.test(u) && /^\d+$/.test(code)) return u.replace(/\/\d+(?=[?#]|$)/, '/' + code);
            return '';
        };
        let curDone = false;
        uniq.forEach(([color, variant]) => {
            const isCur = sameText(color, r.current_color)
                && (!r.current_variant || !variant || sameText(variant, r.current_variant));
            const rec = Object.assign({}, r, { _split: true });
            if (isCur && !curDone) {
                curDone = true;
                rec.current_variant = variant || r.current_variant || '';
            } else {
                // Khoá bản nháp / định danh riêng cho từng màu: link riêng của màu nếu có,
                // không thì link gốc + #màu
                const ownLink = colorLink(color);
                rec.link_url = ownLink || r.url;
                rec.url = ownLink || (r.url + '#' + encodeURIComponent(color + (variant ? ' | ' + variant : '')));
                rec.current_color = color;
                rec.current_variant = variant;
                const own = allImages.filter((u) => sameText(imgColors[u], color));
                rec.images = own.length ? own : shared;
                const cp = pick(prices, color);
                if (cp && cp.price != null) { rec.price = cp.price; rec.list_price = cp.list_price; }
            }
            const mRows = matrix.filter((m) => sameText(m.color, color) && (!variant || sameText(m.variant || '', variant)));
            if (mRows.length) {
                const ins = [], outs = [];
                mRows.forEach((m) => {
                    list(m.sizes_in_stock).forEach((x) => { if (ins.indexOf(x) < 0) ins.push(x); });
                    list(m.sizes_out_of_stock).forEach((x) => { if (outs.indexOf(x) < 0) outs.push(x); });
                });
                rec.sizes_in_stock = ins;
                rec.sizes_out_of_stock = outs;
                rec.sizes = ins.concat(outs.filter((x) => ins.indexOf(x) < 0));
                rec.stock_matrix = mRows;
                rec.in_stock = ins.length > 0;
            }
            // Site mỗi màu 1 tên riêng (MacKenzie-Childs: "Strawberry Canisters, Set of 3")
            const ownTitle = String(pick(r.color_titles || {}, color) || '').trim();
            if (ownTitle) rec.title = ownTitle;
            rec.title_fixed = fixedTitle(r.brand, rec.title, color);
            // Đã tách thì cột "Ảnh của toàn bộ variant" chỉ còn ảnh của chính màu này
            const ownAll = allImages.filter((u) => sameText(imgColors[u], color));
            rec.all_images = ownAll.length ? ownAll : list(rec.images);
            rec.image_count = list(rec.images).length;
            out.push(rec);
        });
    });
    return out;
}

function exportHeader() {
    const hideImgs = hideAllImages();
    const hideSizes = hideAllSizes();
    return EXPORT_COLUMNS.filter((h) => !(hideImgs && h === COL_ALL_IMAGES)
        && !(hideSizes && h === COL_ALL_SIZES));
}

function buildRows(only) {
    const recs = (only ? [only] : doneRecords()).filter(Boolean);
    const header = exportHeader();
    const hideImgs = hideAllImages();
    const hideSizes = hideAllSizes();
    const rows = [header];
    for (const r of recs) {
        const d = drafts[r.url];      // màu tách ra có url (khoá bản nháp) riêng
        const srcImages = list(r.images);
        const cdnImages = (d && d.cdn_images) || [];
        const imgColors = r.image_colors || {};
        // (ảnh gốc, ảnh CDN); ảnh dán tay không có ảnh gốc -> hàng riêng chỉ có CDN
        const pairs = srcImages.map((src, i) => [
            src, (d && d.cdn_src && d.cdn_src[src]) || cdnImages[i] || '']);
        cdnImages.forEach((cdn) => {
            if (!pairs.some((p) => p[1] === cdn)) pairs.push(['', cdn]);
        });
        // Site không trả gallery mọi màu thì cột 12 lặp lại gallery màu đang xem
        const allFallback = !list(r.all_images).length;
        const allImages = hideImgs ? [] : (allFallback ? srcImages : list(r.all_images));
        const stockLines = hideSizes ? [] : buildStockLines(r);
        const pct = pctFor(d);
        const price = r.price == null ? '' : r.price;
        const ok = r.status !== 'ERROR' && r.status !== 'BLOCKED';
        if (ok && r.title) assignVariantId(r);
        // Tiêu đề đã sửa: lấy sẵn từ record; người dùng đổi tiêu đề thì dựng lại
        const dtitle = cleanText(d && d.title);
        let titleFixed = r.title_fixed || '';
        if (dtitle && dtitle !== cleanText(r.title)) titleFixed = fixedTitle(r.brand, dtitle, r.current_color);
        if (!titleFixed) titleFixed = fixedTitle(r.brand, r.title, r.current_color);

        const base = {};
        base['Link'] = r.link_url || r.url;
        base['Tiêu đề gốc'] = cleanText(r.title);
        base['Tiêu đề đã sửa'] = titleFixed;
        base['Mô tả'] = cleanText((d && d.description) || r.description);
        base['Giá gốc'] = r.list_price != null ? r.list_price : price;   // không có giá gạch = giá hiện tại
        base['Giá hiện tại'] = price;
        base['Màu hiện tại'] = r.current_color || '';
        base['Màu tổng'] = list(r.colors).join(';');
        base['Ảnh size chart'] = sizeChartOf(r, d);
        base['Size hiện tại còn'] = currentStockLine(r);
        base['Chi tiết size'] = list(r.sizes_in_stock).join(';');
        base['Cảnh báo hết size'] = list(r.sizes_out_of_stock).join(';');
        base[' '] = '';
        base['% giá đặt'] = pct;
        base['Giá ứng với % giá đặt'] = offerPrice(r.price, pct);
        base['Định danh variant gốc'] = ok ? identityText(r) : '';
        base['SKU các acc'] = '';
        base['Trạng thái'] = STATUS_TEXT[r.status] || r.status;
        base['Ghi chú'] = cleanText(r.note).slice(0, 500);
        // Mô tả gốc dạng HTML (đủ mọi phần, chỉ bỏ liên hệ); Excel giới hạn 32767 ký tự / ô
        base[COL_DESC_HTML] = String(r.description_html || '').trim().slice(0, 32000);

        const nRows = Math.max(pairs.length, allImages.length, stockLines.length, 1);
        for (let i = 0; i < nRows; i++) {
            const cells = i === 0 ? Object.assign({}, base) : {};
            const pair = pairs[i] || ['', ''];
            const alli = allImages[i] || '';
            cells[COL_CUR_IMAGE] = pair[0];
            cells[COL_CDN] = pair[1];
            cells[COL_ALL_IMAGES] = alli;
            // Tên màu = màu của ảnh trên hàng đó (ảnh chụp phụ dùng chung không có màu)
            if (alli) cells[COL_IMAGE_COLOR] = imgColors[alli] || (allFallback ? (r.current_color || '') : '');
            else if (pair[0]) cells[COL_IMAGE_COLOR] = imgColors[pair[0]] || r.current_color || '';
            else cells[COL_IMAGE_COLOR] = '';
            cells[COL_ALL_SIZES] = stockLines[i] || '';
            rows.push(header.map((h) => (cells[h] == null ? '' : cells[h])));
        }
    }
    return rows;
}

// O co xuong dong/tab/nhay thi BOC NHAY KEP nhu chuan CSV - Excel hieu o boc
// nhay nen xuong dong nam gon TRONG O, khong vo bang.
function tsvCell(value) {
    const text = String(value == null ? EMPTY : value).replace(RE_EOL, LF);
    return RE_SPECIAL.test(text) ? QUOTE + text.replace(RE_QUOTE, QUOTE + QUOTE) + QUOTE : text;
}

function tsvOf(rows) {
    return rows.map((row) => row.map(tsvCell).join(TAB)).join(LF);
}

function toTsv() {
    return tsvOf(buildRows());
}

function toCsv() {
    return buildRows().map((row) =>
        row.map((c) => {
            const s = String(c);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',')
    ).join('\r\n');
}

function requireRecords() {
    if (!doneRecords().length) { alert('Chưa có kết quả nào để xuất.'); return false; }
    return true;
}

function copyRowImages(idx) {
    const rec = rows[idx];
    if (!rec || !rec.images.length) { alert('Sản phẩm này không có ảnh nào.'); return; }
    navigator.clipboard.writeText(rec.images.join('\n'));
    appendLog('📋 Đã copy ' + rec.images.length + ' link ảnh của: ' + (rec.title || '').slice(0, 60));
}

// ==== CDN Lumi ==============================================================

function lumiReady() {
    return !!(lumi.url && lumi.token);
}

function setLumiState(text, cls) {
    const el = $('lblLumiState');
    el.textContent = text;
    el.className = 'tag ' + (cls || '');
}

async function lumiUpload(blob, filename) {
    if (!lumiReady()) {
        throw new Error('Chưa cấu hình CDN Lumi (mở mục ⚙️ ở trên để nhập URL + token).');
    }
    const form = new FormData();
    form.append('image', blob, filename || 'image.jpg');
    const res = await fetch(lumi.url.replace(/\/+$/, '') + '/api/scanner/images', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + lumi.token, Accept: 'application/json' },
        body: form,
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { /* trả về không phải JSON */ }
    if (!res.ok) {
        throw new Error('Lumi trả HTTP ' + res.status + ': '
            + (data.message || text.slice(0, 120)));
    }
    const url = data.url || (data.data && data.data.url) || (data.image && data.image.url)
        || data.link || data.path || data.location;
    if (!url) throw new Error('Lumi không trả link ảnh (' + text.slice(0, 120) + ')');
    return url;
}

// Tải ảnh: fetch thẳng trước; site chặn hotlink thì mở tab sản phẩm rồi fetch
// trong tab đó (thừa hưởng cookie + proxy) — cùng cách tool desktop làm.
async function fetchImageBlob(url, pageUrl) {
    try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) {
            const blob = await res.blob();
            if (blob.size > 0 && !/text\/html/i.test(blob.type)) return blob;
        }
    } catch (e) { /* rơi xuống đường qua tab */ }

    const dataUrl = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ cmd: 'fetchImage', url, pageUrl }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!res || res.error) return reject(new Error((res && res.error) || 'không tải được ảnh'));
            resolve(res.dataUrl);
        });
    });
    const res2 = await fetch(dataUrl);
    return await res2.blob();
}

// Vẽ lại ra canvas -> JPG. modify=true thì cắt mép ~1% + lệch sáng nhẹ để ảnh
// khác ảnh gốc (eBay không cho đăng lại ảnh y hệt).
async function toJpegBlob(blob, modify) {
    const bitmap = await createImageBitmap(blob);
    const cut = modify ? Math.round(Math.min(bitmap.width, bitmap.height) * 0.01) : 0;
    const w = bitmap.width - cut * 2;
    const h = bitmap.height - cut * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (modify) ctx.filter = 'brightness(1.01) saturate(1.01)';
    ctx.drawImage(bitmap, cut, cut, w, h, 0, 0, w, h);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

async function convertDraft(idx) {
    const rec = rows[idx];
    const d = draftFor(idx);
    if (!d) return;
    d.cdn_src = d.cdn_src || {};        // link gốc -> link CDN của riêng sản phẩm này
    const urls = (d.images || []).filter((u) => !d.cdn_src[u]);
    if (!urls.length) {
        appendLog((d.images || []).length
            ? '✅ Ảnh của sản phẩm này đã convert hết rồi — không upload lại.'
            : '⚠️ Sản phẩm này chưa có link ảnh nào để convert.');
        return;
    }

    const modify = $('chkModify').checked;
    appendLog('▶ Convert ' + urls.length + ' ảnh: ' + (d.title || rec.url).slice(0, 50));
    let ok = 0;
    let reused = 0;
    for (let i = 0; i < urls.length; i++) {
        const src = urls[i];
        try {
            // Đã convert link này lần trước -> dùng lại, đỡ nặng CDN
            let cdn = cdnMap[src];
            if (cdn) {
                reused++;
            } else {
                const blob = await fetchImageBlob(src, rec.url);
                const jpg = await toJpegBlob(blob, modify);
                cdn = await lumiUpload(jpg, 'image_' + (i + 1) + '.jpg');
                rememberCdn(src, cdn);
            }
            d.cdn_src[src] = cdn;
            if (d.cdn_images.indexOf(cdn) < 0) d.cdn_images.push(cdn);
            ok++;
            setProgress(i + 1, urls.length);
            if (current === idx) renderCdnTable(d);
        } catch (e) {
            appendLog('   ❌ ' + src.slice(-60) + ' → ' + String(e.message || e).slice(0, 120));
        }
    }
    saveDrafts();
    upsertRow(idx, rec);
    appendLog('✅ Xong ' + ok + '/' + urls.length + ' ảnh'
        + (reused ? ' (' + reused + ' ảnh dùng lại link cũ, không upload lại)' : '') + '.');
}

// Cắt phần thừa của ảnh chụp cả tab. Bảng đã được dán sát góc trái-trên nên
// LUÔN cắt từ (0,0) — cắt theo toạ độ như trước hay lệch mép trái khi Chrome
// đang phóng to/thu nhỏ trang. Kích thước lấy theo TỈ LỆ khung nhìn.
async function cropDataUrl(dataUrl, box) {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const w = Math.max(1, Math.round(bitmap.width * (box.ratioW || 1)));
    const h = Math.max(1, Math.round(bitmap.height * (box.ratioH || 1)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h, 0, 0, w, h);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

async function captureSizeGuide(idx) {
    const rec = rows[idx];
    const d = draftFor(idx);
    if (!rec || !d) return;
    appendLog('📐 Đang chụp bảng Size Guide (trang sẽ mở ra vài giây rồi tự đóng)...');
    const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ cmd: 'captureSizeGuide', url: rec.url }, (r) => {
            if (chrome.runtime.lastError) {
                return resolve({ error: chrome.runtime.lastError.message });
            }
            resolve(r || { error: 'không nhận được ảnh' });
        });
    });
    if (!res || res.error) {
        appendLog('   ❌ Chưa chụp được bảng size: ' + (res && res.error));
        alert('Chưa chụp được bảng Size Guide:\n' + (res && res.error)
            + '\n\nCách khác: chụp màn hình rồi bấm nút ➕ để thêm ảnh tay.');
        return;
    }
    try {
        const jpg = await cropDataUrl(res.dataUrl, res.box);
        const cdn = await lumiUpload(jpg, 'size_guide.jpg');
        d.cdn_images.push(cdn);
        (d.extra = d.extra || {}).size_guide_image = cdn;
        saveDrafts();
        if (current === idx) renderCdnTable(d);
        upsertRow(idx, rec);
        appendLog('   📐 Bảng Size Guide đã lên CDN: ' + cdn);
    } catch (e) {
        appendLog('   ❌ Đưa bảng size lên CDN lỗi: ' + String(e.message || e).slice(0, 150));
        alert('Chụp được nhưng không đưa lên CDN được:\n' + (e.message || e));
    }
}

async function pasteImageToCdn(blob) {
    const d = currentDraft();
    if (!d) { alert('Hãy chọn 1 sản phẩm ở bảng trước đã.'); return; }
    if (!blob) { alert('Clipboard chưa có ảnh nào. Hãy chụp màn hình (Windows + Shift + S) rồi thử lại.'); return; }
    try {
        // Ảnh dán thường là bảng số đo -> KHÔNG chỉnh chống trùng, giữ chữ sắc nét
        const jpg = await toJpegBlob(blob, false);
        const cdn = await lumiUpload(jpg, 'size_guide.jpg');
        d.cdn_images.push(cdn);
        saveDrafts();
        renderCdnTable(d);
        upsertRow(current, rows[current]);
        appendLog('📋 Ảnh dán đã lên CDN: ' + cdn);
    } catch (e) {
        appendLog('❌ Dán ảnh lỗi: ' + String(e.message || e).slice(0, 160));
        alert('Không đưa được ảnh lên CDN:\n' + (e.message || e));
    }
}

// ==== cào thủ công: chọn trong các tab đang mở ===============================
// Người dùng tự mở trang sản phẩm (tự giải captcha, tự bấm màu/size muốn lấy) rồi
// bấm cào — background chạy extract.js ngay trên tab đó, không mở tab mới.

function tabCheckboxes() {
    return Array.prototype.slice.call($('tabList').querySelectorAll('input[type=checkbox]'));
}

function tabsChecked() {
    return tabCheckboxes().filter((el) => el.checked).map((el) => Number(el.value));
}

function setTabsCount() {
    const all = tabCheckboxes();
    $('lblTabsCount').textContent = all.length
        ? 'đã chọn ' + tabsChecked().length + '/' + all.length : '';
}

function setAllTabs(on) {
    tabCheckboxes().forEach((el) => { el.checked = on; });
    setTabsCount();
}

function renderTabList(tabs) {
    const box = $('tabList');
    box.innerHTML = '';
    if (!tabs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Không có tab nào đang mở trang web. Mở trang sản phẩm ở tab khác '
            + 'rồi bấm "↻ Tải lại danh sách".';
        box.appendChild(empty);
        setTabsCount();
        return;
    }
    for (const t of tabs) {
        const label = document.createElement('label');
        label.innerHTML = '<input type="checkbox"><span></span>';
        const inp = label.children[0];
        inp.value = String(t.tabId);
        inp.checked = !!t.product;          // tick sẵn tab trông như trang sản phẩm
        inp.addEventListener('change', setTabsCount);
        const span = label.children[1];
        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = t.title || t.url;
        const url = document.createElement('div');
        url.className = 'tab-url';
        url.textContent = t.url;
        span.appendChild(title);
        span.appendChild(url);
        if (t.discarded) {
            const off = document.createElement('div');
            off.className = 'tab-off';
            off.textContent = '⚠️ Chrome đã giải phóng tab này — bấm vào tab cho trang hiện '
                + 'lại rồi tải lại danh sách.';
            span.appendChild(off);
        }
        label.title = t.url;
        box.appendChild(label);
    }
    setTabsCount();
}

function openTabPicker() {
    chrome.runtime.sendMessage({ cmd: 'listTabs' }, (res) => {
        if (!res || res.error) {
            alert((res && res.error) || 'Không đọc được danh sách tab đang mở.');
            return;
        }
        renderTabList(res.tabs || []);
        $('boxTabs').hidden = false;
    });
}

// ==== log & progress ========================================================

function appendLog(text) {
    const el = $('log');
    el.textContent += (el.textContent ? '\n' : '') + text;
    el.scrollTop = el.scrollHeight;
}

function setProgress(done, total) {
    $('lblProgress').textContent = total ? done + '/' + total : '';
}

function setRunning(running) {
    $('btnStart').disabled = running;
    $('btnTabs').disabled = running;
    $('btnTabsCrawl').disabled = running;
    $('btnStop').disabled = !running;
}

// ==== nút bấm ===============================================================

function wire() {
    $('btnStart').addEventListener('click', () => {
        saveExportOpts();       // ô "Chờ mỗi trang" vừa gõ mà chưa rời ô vẫn được áp dụng
        chrome.runtime.sendMessage({
            cmd: 'start',
            text: $('txtLinks').value,
            workers: Number($('selWorkers').value),
        }, (res) => {
            if (res && res.error) { alert(res.error); return; }
            records = new Array(res.total).fill(null);
            rows = [];
            current = -1;
            currentKey = '';
            $('editor').hidden = true;
            $('tblBody').innerHTML = '';
            $('log').textContent = '';
            setProgress(0, res.total);
            setRunning(true);
        });
    });

    $('btnStop').addEventListener('click', () => {
        chrome.runtime.sendMessage({ cmd: 'stop' });
        $('btnStop').disabled = true;
    });

    // Cào thủ công — kết quả NỐI vào bảng đang có nên không xoá bảng như "Bắt đầu cào"
    $('btnTabs').addEventListener('click', openTabPicker);
    $('btnTabsReload').addEventListener('click', openTabPicker);
    $('btnTabsAll').addEventListener('click', () => setAllTabs(true));
    $('btnTabsNone').addEventListener('click', () => setAllTabs(false));
    $('btnTabsClose').addEventListener('click', () => { $('boxTabs').hidden = true; });
    $('btnTabsCrawl').addEventListener('click', () => {
        const ids = tabsChecked();
        if (!ids.length) { alert('Chưa chọn tab nào.'); return; }
        chrome.runtime.sendMessage({ cmd: 'crawlTabs', tabIds: ids }, (res) => {
            if (res && res.error) { alert(res.error); return; }
            $('boxTabs').hidden = true;
            $('editor').hidden = true;
            setRunning(true);
        });
    });

    $('btnCopyImages').addEventListener('click', () => {
        if (!requireRecords()) return;
        const links = doneRecords().flatMap((r) => r.images);
        if (!links.length) { alert('Chưa cào được ảnh nào.'); return; }
        navigator.clipboard.writeText(links.join('\n'));
        appendLog('📋 Đã copy ' + links.length + ' link ảnh của cả danh sách.');
    });

    $('btnCopySizes').addEventListener('click', () => {
        if (!requireRecords()) return;
        const lines = [];
        for (const r of doneRecords()) {
            const ok = list(r.sizes_in_stock).length ? list(r.sizes_in_stock) : list(r.sizes);
            if (!ok.length) continue;
            lines.push([cleanText(r.title), ok.join(', '),
                        list(r.sizes_out_of_stock).join(', ')].join('\t'));
        }
        if (!lines.length) { alert('Chưa cào được size nào — site này không cho biết size.'); return; }
        navigator.clipboard.writeText(['Tiêu đề\tSize còn\tSize hết'].concat(lines).join('\n'));
        appendLog('📐 Đã copy size của ' + lines.length + ' sản phẩm.');
    });

    $('btnCopyTsv').addEventListener('click', () => {
        if (!requireRecords()) return;
        const rows = buildRows();
        navigator.clipboard.writeText(toTsv());
        appendLog('📋 Đã copy bảng đầy đủ (bố cục checklist eBay): ' + (rows.length - 1)
            + ' dòng — mở Excel bấm Ctrl+V.');
    });

    $('btnCopyRow').addEventListener('click', () => {
        const rec = rows[current];
        if (!rec) { alert('Hãy chọn 1 sản phẩm ở bảng trước đã.'); return; }
        saveEditor();
        const rows = buildRows(rec);
        navigator.clipboard.writeText(tsvOf(rows));
        appendLog('📋 Đã copy ' + (rows.length - 1) + ' dòng của sản phẩm đang chọn.');
    });

    $('btnCsv').addEventListener('click', () => {
        if (!requireRecords()) return;
        const blob = new Blob(['\ufeff' + toCsv()], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        a.download = 'cao_da_site_' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
            + '_' + pad(now.getHours()) + pad(now.getMinutes()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
        appendLog('⬇️ Đã tải file CSV.');
    });

    $('btnRestore').addEventListener('click', () => {
        chrome.runtime.sendMessage({ cmd: 'restore' }, (st) => {
            if (!st || !(st.records || []).length) {
                alert('Chưa có kết quả cào nào được lưu.');
                return;
            }
            records = st.records;
            current = -1;
            currentKey = '';
            $('editor').hidden = true;
            renderAll();
            setProgress(st.done, st.total);
            const when = st.saved_at ? new Date(st.saved_at).toLocaleString('vi-VN') : '';
            appendLog('♻️ Đã lấy lại ' + records.filter(Boolean).length + ' sản phẩm đã cào'
                + (when ? ' (lưu lúc ' + when + ')' : '') + '.');
        });
    });

    $('btnUpdate').addEventListener('click', () => checkUpdate(false));
    $('btnHideUpdate').addEventListener('click', () => { $('boxUpdate').hidden = true; });
    $('btnOpenExt').addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions' });
    });
    $('btnDownload').addEventListener('click', () => {
        const url = updateInfo && updateInfo.zip_url;
        if (!url) { alert('Chưa có link bản mới.'); return; }
        chrome.downloads.download({ url, filename: 'cao-da-site-extension.zip' }, () => {
            if (chrome.runtime.lastError) {
                chrome.tabs.create({ url });     // chặn tải thì mở thẳng link
                return;
            }
            appendLog('⬇️ Đã tải bản mới về thư mục Downloads — giải nén đè lên thư mục '
                + 'đang dùng rồi bấm ↻ Reload ở trang extension.');
        });
    });

    $('btnClear').addEventListener('click', () => {
        chrome.runtime.sendMessage({ cmd: 'clear' }, (res) => {
            if (res && !res.ok) { alert('Đang cào, hãy chờ xong đã.'); return; }
            records = [];
            rows = [];
            drafts = {};       // cdnMap giữ nguyên: xoá bảng không được làm mất
            current = -1;      // công convert đã bỏ ra
            currentKey = '';
            saveDrafts();
            $('editor').hidden = true;
            $('tblBody').innerHTML = '';
            $('log').textContent = '';
            setProgress(0, 0);
        });
    });

    // ---- tuỳ chọn xuất (checklist eBay) ----
    ['inpPercent', 'chkHideAllImages', 'chkHideAllSizes', 'chkSplitColors', 'inpPageWait', 'chkAmazonAll'].forEach((id) => {
        if ($(id)) $(id).addEventListener('change', saveExportOpts);
    });
    if ($('chkSplitColors')) $('chkSplitColors').addEventListener('change', renderAll);

    // ---- editor ----
    ['edTitle', 'edPrice', 'edPercent', 'edSizeChart', 'edDesc', 'edSizeFit', 'edImages'].forEach((id) => {
        $(id).addEventListener('input', saveEditor);
    });
    $('btnVarAdd').addEventListener('click', () => { addVariantRow('', ''); collectVariants(); });
    $('btnVarDel').addEventListener('click', () => {
        const active = $('tblVarBody').querySelector('tr.is-active');
        if (active) { active.remove(); collectVariants(); }
    });
    $('btnVarCopy').addEventListener('click', () => {
        const d = currentDraft();
        const lines = d ? buildVariantLines(d.variants, list(d.stock_matrix)) : [];
        if (!lines.length) { alert('Sản phẩm này chưa có variant nào.'); return; }
        navigator.clipboard.writeText(lines.join('\n'));
        appendLog('📋 Đã copy ' + lines.length + ' dòng variant.');
    });

    $('btnConvertOne').addEventListener('click', () => { saveEditor(); convertDraft(current); });
    $('btnConvertAll').addEventListener('click', async () => {
        saveEditor();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i]) await convertDraft(i);
        }
    });
    $('btnCopyCdn').addEventListener('click', () => {
        const d = currentDraft();
        if (!d || !d.cdn_images.length) { alert('Sản phẩm này chưa convert ảnh.'); return; }
        navigator.clipboard.writeText(d.cdn_images.join('\n'));
        appendLog('📋 Đã copy ' + d.cdn_images.length + ' link CDN.');
    });

    $('btnPasteImg').addEventListener('click', async () => {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const type = item.types.find((t) => t.startsWith('image/'));
                if (type) { await pasteImageToCdn(await item.getType(type)); return; }
            }
            alert('Clipboard chưa có ảnh nào. Hãy chụp màn hình (Windows + Shift + S) rồi bấm lại.');
        } catch (e) {
            alert('Không đọc được clipboard: ' + (e.message || e)
                + '\n\nCách khác: bấm "Chọn file ảnh" hoặc bấm Ctrl+V khi đang ở panel này.');
        }
    });
    $('btnPickImg').addEventListener('click', () => $('filePick').click());
    $('filePick').addEventListener('change', async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (file) await pasteImageToCdn(file);
        ev.target.value = '';
    });
    document.addEventListener('paste', async (ev) => {
        const items = (ev.clipboardData && ev.clipboardData.items) || [];
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                ev.preventDefault();
                await pasteImageToCdn(item.getAsFile());
                return;
            }
        }
    });

    // ---- cấu hình Lumi ----
    $('btnLumiSave').addEventListener('click', () => {
        lumi = { url: $('inpLumiUrl').value.trim() || DEFAULT_LUMI.url,
                 token: $('inpLumiToken').value.trim() || DEFAULT_LUMI.token };
        chrome.storage.local.set({ sc_lumi: lumi });
        $('inpLumiUrl').value = lumi.url;
        $('inpLumiToken').value = lumi.token;
        setLumiState('đã lưu', 'ok');
    });
    $('btnLumiTest').addEventListener('click', async () => {
        try {
            const res = await fetch(lumi.url.replace(/\/+$/, '') + '/api/scanner/me', {
                headers: { Authorization: 'Bearer ' + lumi.token, Accept: 'application/json' },
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || ('HTTP ' + res.status));
            const user = data.user || {};
            setLumiState('OK: ' + (user.name || user.email || 'đã đăng nhập'), 'ok');
            appendLog('✅ Lumi: đăng nhập được với tài khoản ' + (user.name || user.email || '?'));
        } catch (e) {
            setLumiState('lỗi đăng nhập', 'err');
            alert('Không đăng nhập được Lumi: ' + (e.message || e));
        }
    });
}

// ==== cập nhật extension ====================================================

// So version kiểu 1.2.10 > 1.2.9 (so từng số, không so chuỗi)
function newerVersion(a, b) {
    const pa = String(a || '0').split('.').map(Number);
    const pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

let updateInfo = null;

async function checkUpdate(silent) {
    const cur = chrome.runtime.getManifest().version;
    try {
        const res = await fetch(UPDATE_INFO_URL + '?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        updateInfo = await res.json();
    } catch (e) {
        if (!silent) alert('Không kiểm tra được bản mới: ' + (e.message || e));
        return;
    }
    if (!newerVersion(updateInfo.version, cur)) {
        appendLog('✅ Extension đang là bản mới nhất (' + cur + ').');
        if (!silent) alert('Đang dùng bản mới nhất rồi (' + cur + ').');
        return;
    }
    $('lblUpdate').textContent = '🔔 Có bản mới ' + updateInfo.version
        + ' (đang dùng ' + cur + ')' + (updateInfo.notes ? ' — ' + updateInfo.notes : '');
    $('boxUpdate').hidden = false;
    appendLog('🔔 Có bản extension mới: ' + updateInfo.version);
}

// ==== tab "Cào link": gom link sản phẩm từ trang danh mục ======================
// Bảng lưu ở chrome.storage.local (lp_links) do background ghi — trang web bấm
// "Lấy link" thì background nối thêm, panel chỉ nghe storage.onChanged để vẽ lại.

const LP_COLUMNS = ['Nhà', 'Link', 'Tiêu đề', 'Ảnh'];
let lpLinks = [];
const lpTicked = new Set();      // url các dòng đang tick trong bảng

function lpSorted() {
    // gom theo nhà (thứ tự nhà xuất hiện lần đầu), trong 1 nhà giữ thứ tự lấy
    const order = new Map();
    lpLinks.forEach((l) => { if (!order.has(l.house)) order.set(l.house, order.size); });
    return lpLinks.map((l, i) => [l, i])
        .sort((a, b) => (order.get(a[0].house) - order.get(b[0].house)) || (a[1] - b[1]))
        .map((x) => x[0]);
}

// Có dòng tick thì chỉ lấy dòng tick, không thì lấy cả bảng
function lpChosen() {
    const all = lpSorted();
    const ticked = all.filter((l) => lpTicked.has(l.url));
    return ticked.length ? ticked : all;
}

function lpRows(links, withHeader) {
    const rows = links.map((l) => [l.house, l.url, l.title, l.image]);
    return withHeader ? [LP_COLUMNS].concat(rows) : rows;
}

function lpRender() {
    const body = $('tblLpBody');
    body.innerHTML = '';
    const sorted = lpSorted();
    let prevHouse = null;
    sorted.forEach((l, i) => {
        const tr = document.createElement('tr');
        if (l.house !== prevHouse && i > 0) tr.classList.add('house-start');
        prevHouse = l.house;
        tr.classList.toggle('is-ticked', lpTicked.has(l.url));

        const tdChk = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = lpTicked.has(l.url);
        chk.addEventListener('change', () => {
            if (chk.checked) lpTicked.add(l.url); else lpTicked.delete(l.url);
            tr.classList.toggle('is-ticked', chk.checked);
            lpSummary();
        });
        tdChk.appendChild(chk);

        const tdImg = document.createElement('td');
        if (l.image) {
            const img = document.createElement('img');
            img.src = l.image;
            img.loading = 'lazy';
            img.referrerPolicy = 'no-referrer';
            tdImg.appendChild(img);
        }

        const cell = (text, cls, tip) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (cls) td.className = cls;
            if (tip) td.title = tip;
            return td;
        };
        const tdOpen = document.createElement('td');
        const open = document.createElement('button');
        open.className = 'mini open';
        open.textContent = '🔗';
        open.title = 'Mở link sản phẩm';
        open.addEventListener('click', () => chrome.tabs.create({ url: l.url, active: false }));
        tdOpen.appendChild(open);

        tr.append(tdChk, cell(String(i + 1)), cell(l.house, 'lp-house'), tdImg,
                  cell(l.title || '—', 'lp-title', l.title), cell(l.url, 'lp-link', l.url), tdOpen);
        body.appendChild(tr);
    });
    $('chkLpRows').checked = sorted.length > 0 && sorted.every((l) => lpTicked.has(l.url));
    lpSummary();
}

function lpSummary() {
    const counts = new Map();
    for (const l of lpLinks) counts.set(l.house, (counts.get(l.house) || 0) + 1);
    const box = $('lblLpHouses');
    box.innerHTML = '';
    for (const [house, n] of counts) {
        const tag = document.createElement('span');
        tag.className = 'tag ok';
        tag.textContent = house + ': ' + n;
        box.appendChild(tag);
    }
    const ticked = lpLinks.filter((l) => lpTicked.has(l.url)).length;
    if (lpLinks.length) {
        const all = document.createElement('span');
        all.className = 'tag';
        all.textContent = 'Tổng ' + lpLinks.length + ' link · ' + counts.size + ' nhà'
            + (ticked ? ' · đang tick ' + ticked : '');
        box.appendChild(all);
    }
    $('lblLpCount').textContent = lpLinks.length ? String(lpLinks.length) : '';
}

function lpLoad(links) {
    lpLinks = Array.isArray(links) ? links : [];
    const exists = new Set(lpLinks.map((l) => l.url));
    for (const u of [...lpTicked]) if (!exists.has(u)) lpTicked.delete(u);
    lpRender();
}

function lpRequire() {
    if (!lpLinks.length) { alert('Bảng link đang trống — tick sản phẩm trên trang rồi bấm Lấy link trước.'); return false; }
    return true;
}

function lpSetState(on, tabs) {
    const el = $('lblLpState');
    el.className = 'tag ' + (on ? 'ok' : '');
    el.textContent = on ? 'đang bật' + (tabs != null ? ' · đã gắn ' + tabs + ' tab' : '') : 'đang tắt';
}

function lpActive(action) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ cmd: 'lpActive', action }, (res) => {
            if (chrome.runtime.lastError) return resolve({ error: chrome.runtime.lastError.message });
            resolve(res || {});
        });
    });
}

function lpEnable() {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ cmd: 'lpSetEnabled', on: true }, (res) => {
            lpSetState(true, res && res.tabs);
            resolve(res || {});
        });
    });
}

function showView(id) {
    for (const btn of document.querySelectorAll('.tabs .tab')) {
        btn.classList.toggle('is-active', btn.dataset.view === id);
    }
    $('viewSite').hidden = id !== 'viewSite';
    $('viewLinks').hidden = id !== 'viewLinks';
    chrome.storage.local.set({ sc_view: id });
}

// Dán link vào ô nhập link của tab Cào site, link đã có trong ô thì bỏ qua
function pushLinksToSite(urls) {
    const box = $('txtLinks');
    const current = box.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const have = new Set(current);
    const fresh = urls.filter((u) => !have.has(u));
    box.value = current.concat(fresh).join('\n');
    showView('viewSite');
    box.focus();
    box.scrollTop = box.scrollHeight;
    return fresh.length;
}

function wireLinks() {
    for (const btn of document.querySelectorAll('.tabs .tab')) {
        btn.addEventListener('click', () => showView(btn.dataset.view));
    }

    $('chkLpEnabled').addEventListener('change', (e) => {
        const on = e.target.checked;
        lpSetState(on);
        chrome.runtime.sendMessage({ cmd: 'lpSetEnabled', on }, (res) => {
            if (res && res.error) { alert(res.error); return; }
            lpSetState(on, res && res.tabs);
            appendLog(on ? '☑️ Đã bật ô chọn sản phẩm trên ' + ((res && res.tabs) || 0) + ' tab đang mở — trang mở sau cũng tự có.'
                         : '⬜ Đã tắt ô chọn sản phẩm trên các trang.');
        });
    });

    // Bấm nút trên panel khi chưa bật ô chọn -> tự bật luôn cho đỡ một bước
    const ensureOn = async () => {
        if ($('chkLpEnabled').checked) return;
        $('chkLpEnabled').checked = true;
        await lpEnable();
    };

    $('btnLpAll').addEventListener('click', async () => {
        await ensureOn();
        const res = await lpActive('all');
        if (res.error) { alert(res.error); return; }
        appendLog('☑️ Đã tick ' + (res.total || 0) + ' sản phẩm trên trang "' + (res.title || '') + '".');
    });
    $('btnLpNone').addEventListener('click', async () => {
        const res = await lpActive('none');
        if (res.error) alert(res.error);
    });
    $('btnLpTake').addEventListener('click', async () => {
        await ensureOn();
        const res = await lpActive('take');
        if (res.error) { alert(res.error); return; }
        const items = res.items || [];
        if (!items.length) { alert('Chưa tick sản phẩm nào trên trang đang xem.'); return; }
        let copied = true;
        try { await navigator.clipboard.writeText(items.map((x) => x.url).join('\n')); } catch (e) { copied = false; }
        appendLog('🔗 Lấy ' + items.length + ' link (' + (res.added || 0) + ' mới)'
            + (copied ? ' — đã copy vào bộ nhớ tạm.' : '. Không copy được, bấm 📋 Copy link.'));
    });

    $('btnLpCopy').addEventListener('click', () => {
        if (!lpRequire()) return;
        const chosen = lpChosen();
        navigator.clipboard.writeText(tsvOf(lpRows(chosen, $('chkLpHeader').checked)));
        appendLog('📄 Đã copy bảng ' + chosen.length + ' link (Nhà · Link · Tiêu đề · Ảnh) — dán vào Excel/Sheets.');
    });

    $('btnLpCsv').addEventListener('click', () => {
        if (!lpRequire()) return;
        const chosen = lpChosen();
        const csv = lpRows(chosen, true).map((row) => row.map((c) => {
            const s = String(c == null ? '' : c);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        a.download = 'link_theo_nha_' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
            + '_' + pad(now.getHours()) + pad(now.getMinutes()) + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
        appendLog('⬇️ Đã tải CSV ' + chosen.length + ' link.');
    });

    $('btnLpCopyLinks').addEventListener('click', () => {
        if (!lpRequire()) return;
        const chosen = lpChosen();
        navigator.clipboard.writeText(chosen.map((l) => l.url).join('\n'));
        appendLog('📋 Đã copy ' + chosen.length + ' link.');
    });

    $('btnLpPush').addEventListener('click', () => {
        if (!lpRequire()) return;
        const chosen = lpChosen();
        const n = pushLinksToSite(chosen.map((l) => l.url));
        appendLog('➡️ Đã dán ' + n + ' link vào ô nhập link của tab Cào site'
            + (n < chosen.length ? ' (' + (chosen.length - n) + ' link đã có sẵn trong ô)' : '')
            + ' — bấm 🕷️ Bắt đầu cào.');
    });

    $('btnLpDelTicked').addEventListener('click', () => {
        const keep = lpLinks.filter((l) => !lpTicked.has(l.url));
        if (keep.length === lpLinks.length) { alert('Chưa tick dòng nào để xoá.'); return; }
        const n = lpLinks.length - keep.length;
        lpTicked.clear();
        chrome.storage.local.set({ lp_links: keep });
        appendLog('➖ Đã xoá ' + n + ' dòng link.');
    });

    $('btnLpClear').addEventListener('click', () => {
        if (!lpLinks.length) return;
        if (!confirm('Xoá toàn bộ ' + lpLinks.length + ' link trong bảng?')) return;
        lpTicked.clear();
        chrome.storage.local.set({ lp_links: [] });
        appendLog('🗑 Đã xoá bảng link.');
    });

    $('chkLpRows').addEventListener('change', (e) => {
        lpTicked.clear();
        if (e.target.checked) for (const l of lpLinks) lpTicked.add(l.url);
        lpRender();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.lp_links) lpLoad(changes.lp_links.newValue);
    });

    chrome.storage.local.get(['lp_links', 'lp_enabled', 'sc_view'], (saved) => {
        lpLoad(saved && saved.lp_links);
        $('chkLpEnabled').checked = !!(saved && saved.lp_enabled);
        lpSetState(!!(saved && saved.lp_enabled));
        if (saved && saved.sc_view === 'viewLinks') showView('viewLinks');
    });
}

// ==== nhận tin từ background ================================================

chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.sc) return;
    if (msg.type === 'row') {
        setSourceRow(msg.idx, msg.rec);
        setProgress(msg.done, msg.total);
    } else if (msg.type === 'finished') {
        setRunning(false);
    } else if (msg.type === 'retry-done') {
        setRunning(false);
    } else if (msg.type === 'log') {
        appendLog(msg.text);
    }
});

wire();
wireLinks();

// Mở lại panel giữa chừng vẫn thấy tiến độ + kết quả + bản nháp đang biên tập
chrome.storage.local.get(['sc_drafts', 'sc_lumi', 'sc_cdn_map', 'sc_variant_ids', 'sc_opts'], (saved) => {
    drafts = (saved && saved.sc_drafts) || {};
    cdnMap = (saved && saved.sc_cdn_map) || {};
    const ids = saved && saved.sc_variant_ids;
    if (ids && typeof ids === 'object') {
        variantIds = { counters: ids.counters || {}, ids: ids.ids || {} };
    }
    restoreExportOpts(saved && saved.sc_opts);
    const savedLumi = (saved && saved.sc_lumi) || {};
    lumi = { url: savedLumi.url || DEFAULT_LUMI.url,
             token: savedLumi.token || DEFAULT_LUMI.token };
    $('inpLumiUrl').value = lumi.url;
    $('inpLumiToken').value = lumi.token;
    setLumiState(savedLumi.token ? 'đã lưu' : 'điền sẵn', 'ok');
    renderAll();
});

// Mở panel là tự kiểm tra bản mới, im lặng nếu đang là bản mới nhất
checkUpdate(true);

chrome.runtime.sendMessage({ cmd: 'getState' }, (st) => {
    if (!st) return;
    records = st.records || [];
    renderAll();
    setProgress(st.done, st.total);
    setRunning(!!st.running);
    if (st.logs && st.logs.length) $('log').textContent = st.logs.join('\n');
});
