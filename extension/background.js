/**
 * background.js — điều phối cào: mở tab nền, chờ render, chạy extract.js, đóng tab.
 *
 * Logic mirror từ app/services/site_crawler/crawler.py (poll nhiều lần, chấm điểm
 * chất lượng, retry giữ kết quả tốt nhất). Luật per-site nằm TRỌN trong extract.js.
 */

import extract from './extract.js';

// ==== port từ crawler.py ====================================================

const KEEP_PARAMS = new Set(['color', 'size', 'sizeval', 'choice', 'skuid', 'sku',
    'genericid', 'productid', 'variant', 'colorcode',
    // Lands' End: ?attributes=<số màu>,<số Regular/Petite>... — bỏ đi là rơi về màu mặc định
    'attributes']);
// Tham số lựa chọn đánh số: Etsy ?variation0=&variation1=, Personal Creations ?attr17=
const KEEP_PARAM_RE = /^(dwvar_|variation\d+$|attr\d+$)/i;

const TRUSTED_SOURCES = ['adapter', 'shopify-json', 'json-ld'];

const SETTLE_MS = 3500;       // chờ trang render trước lần extract đầu
const POLL_MS = 1500;         // giãn cách giữa các lần poll
const MAX_POLLS = 6;
const NAV_TIMEOUT_MS = 40000;
const EXTRACT_TIMEOUT_MS = 30000;   // 1 lần chạy extract (kể cả fetch dữ liệu màu khác)
const RETRIES = 1;            // số lần cào lại 1 link khi PARTIAL/ERROR

export function baseDomain(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host.startsWith('www.') ? host.slice(4) : host;
    } catch (e) { return ''; }
}

// Domain đăng ký, bỏ mọi subdomain (mirror crawler.site_domain)
function siteDomain(url) {
    const parts = baseDomain(url).split('.').filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
}

const EBAY_ITEM_RE = /\/itm\/(?:[^/?#]+\/)?(\d{9,})/;

export function canonicalUrl(url) {
    url = (url || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
    try {
        const u = new URL(url);
        const kept = new URLSearchParams();
        for (const [k, v] of u.searchParams) {
            // dwvar_45507_color=BRN: kiểu tham số biến thể của Salesforce Commerce (Duluth)
            if (v && (KEEP_PARAMS.has(k.toLowerCase()) || KEEP_PARAM_RE.test(k))) kept.append(k, v);
        }
        u.search = kept.toString().replace(/%2C/gi, ',');
        u.hash = '';
        return u.toString();
    } catch (e) { return url; }
}

export function parseUrls(text) {
    const out = [], seen = new Set();
    for (const line of (text || '').split(/\r?\n/)) {
        const m = line.trim().match(/(https?:\/\/\S+)/);
        if (!m) continue;
        const u = canonicalUrl(m[1]);
        if (u && !seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
}

// Trường biến thể do adapter `extra` của extract.js điền (màu/size/tồn kho).
// Bản extension trước đây bỏ hết các trường này khi chuẩn hoá -> panel không có
// gì để hiện. Giữ nguyên đúng như tool desktop (crawler.EXTRA_LIST_FIELDS).
// GIỮ ĐÚNG 4 nhóm như crawler.py (EXTRA_LIST/TEXT/MAP/NUM_FIELDS). Trước đây thiếu
// nhóm MAP nên image_colors không bao giờ tới panel -> cột "Tên màu" luôn trống.
const EXTRA_LIST_FIELDS = ['colors', 'sizes', 'sizes_in_stock', 'sizes_out_of_stock',
                           'variants', 'stock_matrix', 'fit_guide_images', 'all_images'];
const EXTRA_TEXT_FIELDS = ['color_label', 'size_label', 'details', 'fit_care',
                          'size_fit', 'size_guide_url', 'size_guide_button',
                          'current_color', 'variant_label', 'current_variant',
                          'brand', 'title_fixed', 'identity_kind', 'description_html'];
const EXTRA_MAP_FIELDS = ['image_colors', 'color_codes'];
const EXTRA_NUM_FIELDS = ['list_price'];

function emptyExtra() {
    const out = { in_stock: null, color_prices: {} };
    EXTRA_LIST_FIELDS.forEach((f) => { out[f] = []; });
    EXTRA_TEXT_FIELDS.forEach((f) => { out[f] = ''; });
    EXTRA_MAP_FIELDS.forEach((f) => { out[f] = {}; });
    EXTRA_NUM_FIELDS.forEach((f) => { out[f] = null; });
    return out;
}

function pickExtra(raw) {
    const out = emptyExtra();
    EXTRA_LIST_FIELDS.forEach((f) => {
        if (Array.isArray(raw[f])) out[f] = raw[f].filter((x) => x != null && x !== '');
    });
    EXTRA_TEXT_FIELDS.forEach((f) => {
        if (raw[f]) out[f] = String(raw[f]);
    });
    EXTRA_MAP_FIELDS.forEach((f) => {
        if (raw[f] && typeof raw[f] === 'object' && !Array.isArray(raw[f])) {
            const m = {};
            Object.keys(raw[f]).forEach((k) => { if (k) m[String(k)] = String(raw[f][k] || ''); });
            out[f] = m;
        }
    });
    EXTRA_NUM_FIELDS.forEach((f) => {
        const n = Number(raw[f]);
        if (raw[f] != null && raw[f] !== '' && isFinite(n)) out[f] = n;
    });
    // {màu: {price, list_price}} — giá riêng từng màu (site 1 link chung mọi màu)
    if (raw.color_prices && typeof raw.color_prices === 'object') {
        Object.keys(raw.color_prices).forEach((k) => {
            const x = raw.color_prices[k] || {};
            const p = Number(x.price);
            if (!k || x.price == null || x.price === '' || !isFinite(p)) return;
            const lp = Number(x.list_price);
            out.color_prices[k] = { price: p,
                                    list_price: x.list_price != null && x.list_price !== '' && isFinite(lp) ? lp : null };
        });
    }
    if (raw.in_stock === true || raw.in_stock === false) out.in_stock = raw.in_stock;
    return out;
}

function emptyRecord(url, status, note) {
    return Object.assign(
        { url, title: '', price: null, currency: '', description: '',
          images: [], image_count: 0, source: '', status, note: note || '', trace: [] },
        emptyExtra());
}

function normalizeRecord(url, raw) {
    raw = raw || {};
    const images = (raw.images || []).filter(Boolean);
    const warnings = raw.warnings || [];
    let status;
    if (raw.blocked) status = 'BLOCKED';
    else if (raw.title && images.length) status = 'OK';
    else if (raw.title || images.length) status = 'PARTIAL';
    else status = 'ERROR';
    // Giá lạc đơn vị tiền (site đổi giá theo IP) không dùng được cho bảng eBay —
    // đừng để trạng thái xanh khiến người dùng tưởng dòng này đã chuẩn.
    if (status === 'OK' && raw.wrong_currency) status = 'PARTIAL';
    return Object.assign({
        url,
        title: (raw.title || '').trim(),
        price: raw.price != null ? raw.price : null,
        currency: raw.currency || '',
        description: (raw.description || '').trim(),
        images,
        image_count: images.length,
        source: raw.source || '',
        status,
        note: warnings.join('; ').slice(0, 400),
        trace: raw.trace || [],
        extra_ready: raw.extra_ready !== false,
    }, pickExtra(raw));
}

function qualityScore(rec) {
    if (!rec) return -1;
    let score = 0;
    if (TRUSTED_SOURCES.includes(rec.source)) score += 10000;
    // Adapter có `extra` mà lần poll này chưa lấy được thì thua lần đã lấy được
    if (rec.extra_ready !== false) score += 8000;
    score += Math.min((rec.images || []).length, 60) * 100;
    if ((rec.colors || []).length || (rec.sizes || []).length) score += 50;
    if (rec.description) score += 30;
    if (rec.price != null) score += 20;
    if (rec.title) score += 10;
    return score;
}

// ==== trạng thái phiên cào ==================================================

const state = {
    running: false,
    stopFlag: false,
    records: [],       // theo đúng thứ tự nhập (null = chưa xong)
    urls: [],
    done: 0,
    total: 0,
    logs: [],          // giữ ~200 dòng cuối để panel mở lại còn thấy
};

function send(msg) {
    chrome.runtime.sendMessage(Object.assign({ sc: true }, msg)).catch(() => {});
}

function log(text) {
    state.logs.push(text);
    if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
    send({ type: 'log', text });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==== cào 1 link =============================================================



// ==== nhớ kết quả cào ========================================================
// Service worker của Chrome bị tắt khi rảnh, và nạp lại extension cũng xoá sạch
// bộ nhớ -> phải ghi kết quả xuống storage, mở lại là có ngay, khỏi cào lại.
let saveTimer = null;

function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            chrome.storage.local.set({
                sc_records: state.records,
                sc_progress: { done: state.done, total: state.total },
                sc_saved_at: new Date().toISOString(),
            });
        } catch (e) { /* hết chỗ lưu thì thôi, không được làm hỏng việc cào */ }
    }, 400);
}

let hydrated = false;

async function hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
        const saved = await chrome.storage.local.get(['sc_records', 'sc_progress']);
        if (!state.running && !state.records.length && Array.isArray(saved.sc_records)) {
            state.records = saved.sc_records;
            const p = saved.sc_progress || {};
            state.total = p.total || state.records.length;
            state.done = p.done || state.records.filter(Boolean).length;
        }
    } catch (e) { /* không đọc được thì coi như chưa có gì */ }
}

// Chạy extract.js trên 1 tab ĐANG mở, poll vài lần cho trang kịp render, giữ kết
// quả tốt nhất. Không đụng vào tab (không mở, không đóng, không tải lại) — phần đó
// tuỳ người gọi: cào tự động thì mở tab nền, cào thủ công thì dùng tab người dùng
// đã tự mở sẵn.
// Mô tả người bán eBay nằm trong iframe khác origin (itm.ebaydesc.com) — script trong
// trang không fetch được (CORS), service worker có host_permissions nên tải ở đây rồi
// đưa vào extract qua opts.descHtml (mirror crawler.fetch_ebay_description).
async function fetchEbayDescription(url) {
    if (siteDomain(url) !== 'ebay.com') return '';
    const m = String(url || '').match(EBAY_ITEM_RE);
    if (!m) return '';
    try {
        const r = await fetch('https://itm.ebaydesc.com/itmdesc/' + m[1], { credentials: 'omit' });
        return r.ok ? await r.text() : '';
    } catch (e) {
        return '';
    }
}

async function extractFromTab(tabId, url, settleMs) {
    let best = null, bestScore = -1;
    const opts = { debug: false, url };
    const descHtml = await fetchEbayDescription(url);
    if (descHtml) opts.descHtml = descHtml;
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await sleep(attempt === 0 ? (settleMs == null ? SETTLE_MS : settleMs) : POLL_MS);
        if (state.stopFlag) break;
        let raw = null;
        try {
            const res = await withTimeout(chrome.scripting.executeScript({
                target: { tabId },
                func: extract,
                // Gửi kèm link gốc: site redirect (đổi slug) có thể làm rơi ?color=
                // khỏi location, adapter vẫn biết người dùng muốn màu nào.
                args: [opts],
            }), EXTRACT_TIMEOUT_MS);
            raw = res && res[0] ? res[0].result : null;
        } catch (e) {
            log('   ⚠️ extract lỗi lần ' + (attempt + 1) + ': ' + String(e).slice(0, 150));
            continue;
        }
        if (!raw) continue;
        const rec = normalizeRecord(url, raw);
        if (rec.status === 'BLOCKED') return rec;
        const score = qualityScore(rec);
        if (score > bestScore) { best = rec; bestScore = score; }
        // Dừng sớm khi đã lấy được bằng đúng luật của site (adapter/JSON-LD/Shopify)
        if (TRUSTED_SOURCES.includes(rec.source) && rec.title && rec.images.length > 1
            && rec.extra_ready !== false) break;
    }
    return best;
}

// Chờ tới khi trang ĐỌC ĐƯỢC (DOM đã có — readyState interactive) chứ không chờ tải xong
// hẳn: trang bán hàng tải quảng cáo/theo dõi rất lâu, tab nền tới "complete" mất 32–60s+
// (Eileen Fisher 42s, Walmart 44s, Academy > 60s — đo 2026-09-25) trong khi dữ liệu sản
// phẩm có từ giây thứ 4–5. Chờ "complete" làm mỗi link mất cả phút, nhìn như treo.
async function waitTabReadable(tabId, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        let tab = null;
        try { tab = await chrome.tabs.get(tabId); } catch (e) { return 'gone'; }
        if (tab && tab.status === 'complete' && tab.url && !/^about:blank/.test(tab.url)) return '';
        try {
            const res = await withTimeout(chrome.scripting.executeScript({
                target: { tabId },
                func: () => (location.href.indexOf('about:') === 0 ? 'blank' : document.readyState),
            }), 5000);
            const st = res && res[0] ? res[0].result : '';
            if (st === 'interactive' || st === 'complete') return '';
        } catch (e) { /* trang đang chuyển hướng / chưa có document -> thử lại */ }
        await sleep(500);
    }
    return 'timeout';
}

// Promise có hạn giờ: executeScript không bao giờ tự bỏ cuộc nếu luật cào chờ 1 fetch treo
function withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('quá ' + Math.round(ms / 1000) + 's')), ms); }),
    ]).finally(() => clearTimeout(timer));
}

async function crawlOnce(url) {
    let tab = null;
    try {
        tab = await chrome.tabs.create({ url, active: false });
        const nav = await waitTabReadable(tab.id, NAV_TIMEOUT_MS);
        if (nav === 'gone') return emptyRecord(url, 'ERROR', 'Tab bị đóng khi đang tải.');
        const best = await extractFromTab(tab.id, url);
        return best || emptyRecord(url, 'ERROR',
            nav === 'timeout' ? 'Trang tải quá lâu (40s).' : 'Không lấy được dữ liệu từ trang.');
    } catch (e) {
        return emptyRecord(url, 'ERROR', String(e).slice(0, 300));
    } finally {
        if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    }
}

async function crawlWithRetry(url) {
    // Giữ kết quả TỐT NHẤT giữa các lần thử (mirror crawler.py)
    let best = null;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (state.stopFlag) break;
        const cur = await crawlOnce(url);
        if (!best || qualityScore(cur) > qualityScore(best)) best = cur;
        if (cur.status === 'OK' || cur.status === 'BLOCKED') break;
        if (attempt < RETRIES) {
            log('   🔁 Thử lại (' + (cur.note || cur.status).slice(0, 80) + ')');
            await sleep(1500);
        }
    }
    return best || emptyRecord(url, 'ERROR', 'Đã dừng theo yêu cầu.');
}

// ==== cào hàng loạt ==========================================================

async function runBatch(urls, workers) {
    state.running = true;
    state.stopFlag = false;
    state.urls = urls;
    state.records = new Array(urls.length).fill(null);
    state.done = 0;
    state.total = urls.length;
    state.logs = [];
    log('▶ Bắt đầu cào ' + urls.length + ' link (' + workers + ' tab cùng lúc)...');

    let next = 0;
    const finishRow = (i, rec) => {
        state.records[i] = rec;
        saveState();
        state.done += 1;
        send({ type: 'row', idx: i, rec, done: state.done, total: state.total });
        const icon = { OK: '✅', PARTIAL: '⚠️', BLOCKED: '🚫' }[rec.status] || '❌';
        log('   ' + icon + ' [' + (i + 1) + '] ' + rec.status + ' · ' + rec.image_count
            + ' ảnh · ' + (rec.title || '(không tên)').slice(0, 60));
    };

    const workerLoop = async () => {
        while (!state.stopFlag) {
            const i = next++;
            if (i >= urls.length) return;
            log('🔍 [' + (i + 1) + '/' + urls.length + '] ' + urls[i].slice(0, 90));
            finishRow(i, await crawlWithRetry(urls[i]));
            await sleep(800 + Math.random() * 1200);   // giãn cách cho đỡ giống bot
        }
    };

    const n = Math.max(1, Math.min(workers || 2, urls.length, 4));
    await Promise.all(Array.from({ length: n }, workerLoop));

    // Các link chưa kịp chạy khi bấm Dừng
    urls.forEach((u, i) => {
        if (!state.records[i]) finishRow(i, emptyRecord(u, 'ERROR', 'Đã dừng theo yêu cầu.'));
    });

    state.running = false;
    const ok = state.records.filter((r) => r.status === 'OK').length;
    const blocked = state.records.filter((r) => r.status === 'BLOCKED').length;
    saveState();
    const imgs = state.records.reduce((s, r) => s + r.image_count, 0);
    log('✅ Xong: ' + ok + '/' + state.records.length + ' sản phẩm thành công, ' + imgs + ' ảnh'
        + (blocked ? ', ' + blocked + ' link bị chặn' : '') + '.');
    send({ type: 'finished', records: state.records });
}

// ==== cào thủ công: cào chính các tab người dùng đã tự mở =====================
// Tự mở trang bằng tay là cách vượt tường chặn chắc nhất (tự giải captcha, giữ
// đăng nhập, tự bấm chọn màu/size). Ở đây KHÔNG mở tab mới, KHÔNG tải lại và
// KHÔNG đóng tab nào — chỉ chạy extract.js ngay trên tab đang mở, nên luật cào
// (màu · size còn/hết · ma trận tồn kho) y hệt cào tự động.

// Đoán tab nào là trang sản phẩm để tick sẵn. Chỉ là gợi ý — panel vẫn liệt kê
// đủ mọi tab http(s) cho người dùng tự tick thêm/bớt.
const PRODUCT_HINT = new RegExp(
    '/(product|products|shop|item|items|dp|p|site|sku)\\b'      // /products/ · /dp/ · /site/
    + '|\\.html?($|\\?)'                                        // Duluth · Vionic · Talbots
    + '|/s\\d{5,}/?($|\\?)'                                     // Crate & Barrel: /s555845
    + '|[?&](color|colour|size|sku|skuid|productid|choice|variant)='
    + '|[?&]dwvar_[a-z0-9]+_color=', 'i');

async function listOpenTabs() {
    const tabs = await chrome.tabs.query({});
    const out = [], seen = new Set();
    for (const t of tabs) {
        if (!t.id || !t.url || !/^https?:/i.test(t.url)) continue;
        const url = canonicalUrl(t.url);
        if (!url || seen.has(url)) continue;      // 2 tab cùng 1 link -> 1 dòng
        seen.add(url);
        out.push({
            tabId: t.id,
            url,
            title: (t.title || '').slice(0, 120),
            domain: baseDomain(t.url),
            discarded: !!t.discarded,
            // Tab Chrome đã giải phóng thì extract.js không chạy được -> đừng tick sẵn
            product: !t.discarded && PRODUCT_HINT.test(t.url),
        });
    }
    return out;
}

async function crawlOpenTabs(tabIds) {
    state.running = true;
    state.stopFlag = false;
    // Nối vào bảng đang có: mở thêm vài tab rồi cào tiếp không mất kết quả cũ
    const base = state.records.length;
    state.done = state.records.filter(Boolean).length;
    state.total = base + tabIds.length;
    log('▶ Cào thủ công ' + tabIds.length + ' tab đang mở (không mở tab mới, không đóng tab nào)...');

    const finishRow = (i, rec) => {
        state.records[i] = rec;
        saveState();
        state.done += 1;
        send({ type: 'row', idx: i, rec, done: state.done, total: state.total });
        const icon = { OK: '✅', PARTIAL: '⚠️', BLOCKED: '🚫' }[rec.status] || '❌';
        log('   ' + icon + ' [' + (i + 1) + '] ' + rec.status + ' · ' + rec.image_count
            + ' ảnh · ' + (rec.title || '(không tên)').slice(0, 60));
    };

    for (let k = 0; k < tabIds.length; k++) {
        const idx = base + k;
        if (state.stopFlag) {
            finishRow(idx, emptyRecord('', 'ERROR', 'Đã dừng theo yêu cầu.'));
            continue;
        }
        let tab = null;
        try { tab = await chrome.tabs.get(tabIds[k]); } catch (e) { tab = null; }
        if (!tab || !tab.url) {
            finishRow(idx, emptyRecord('', 'ERROR', 'Tab đã đóng trước khi cào.'));
            continue;
        }
        const url = canonicalUrl(tab.url);
        if (tab.discarded) {
            finishRow(idx, emptyRecord(url, 'ERROR',
                'Chrome đã giải phóng tab này để tiết kiệm RAM — bấm vào tab cho trang hiện lại rồi cào lại.'));
            continue;
        }
        log('🔍 [' + (idx + 1) + '/' + state.total + '] ' + url.slice(0, 90));
        let rec = null;
        try {
            // Trang người dùng tự mở thường đã render xong -> chờ ngắn, chưa xong
            // thì extract.js vẫn được poll tiếp như thường.
            rec = await extractFromTab(tab.id, url, 400);
        } catch (e) {
            rec = emptyRecord(url, 'ERROR', String(e).slice(0, 300));
        }
        finishRow(idx, rec || emptyRecord(url, 'ERROR', 'Không lấy được dữ liệu từ tab này.'));
        await sleep(300);
    }

    state.running = false;
    saveState();
    const recs = state.records.slice(base).filter(Boolean);
    const ok = recs.filter((r) => r.status === 'OK').length;
    const imgs = recs.reduce((s, r) => s + r.image_count, 0);
    log('✅ Xong: ' + ok + '/' + recs.length + ' tab cào được, ' + imgs + ' ảnh.');
    send({ type: 'finished', records: state.records });
}

async function retryOne(idx) {
    if (state.running || idx == null || !state.records[idx]) return;
    const url = state.records[idx].url;
    state.running = true;
    state.stopFlag = false;
    log('↻ Cào lại: ' + url.slice(0, 90));
    const rec = await crawlWithRetry(url);
    state.records[idx] = rec;
    saveState();
    state.running = false;
    send({ type: 'row', idx, rec, done: state.done, total: state.total });
    send({ type: 'retry-done', idx, rec });
    log('   → Kết quả mới: ' + rec.status + ' · ' + rec.image_count + ' ảnh');
}

// ==== message từ panel =======================================================

// ==== tải ảnh qua tab sản phẩm ==============================================
// Nhiều site (Vionic, Revolve...) chặn tải ảnh trực tiếp từ ngoài trang. Mở tab
// sản phẩm rồi fetch NGAY TRONG tab đó thì thừa hưởng cookie + proxy nên tải được.
async function fetchImageViaTab(imageUrl, pageUrl) {
    let tab = null;
    try {
        tab = await chrome.tabs.create({ url: pageUrl || imageUrl, active: false });
        await waitTabReadable(tab.id, NAV_TIMEOUT_MS);
        const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [imageUrl],
            func: async (u) => {
                const r = await fetch(u, { credentials: 'include' });
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const blob = await r.blob();
                return await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result);
                    fr.onerror = () => reject(new Error('không đọc được ảnh'));
                    fr.readAsDataURL(blob);
                });
            },
        });
        const dataUrl = res && res[0] ? res[0].result : '';
        if (!dataUrl) throw new Error('tab không trả về ảnh');
        return dataUrl;
    } finally {
        if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* tab đã đóng */ } }
    }
}

// ==== chụp bảng Size Guide ==================================================
// Extension không chụp được vùng tuỳ ý như bản desktop (không có CDP), nhưng
// chrome.tabs.captureVisibleTab chụp được tab ĐANG HIỆN. Cách làm: mở tab thật,
// bấm nút Size Guide, chờ modal, thu nhỏ trang nếu bảng cao hơn màn hình, chụp
// cả tab rồi panel cắt đúng khung bảng.
async function prepareSizeGuide(tabId) {
    const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            // Duluth dùng class băm (_1fkhros…) nên không bám selector được -> tìm
            // nút theo đúng chữ trên nút. Chỉ nhận chữ NGẮN và đúng mẫu để không bấm
            // nhầm sang link khác làm chuyển trang.
            const BTN_RE = /^(size|sizing)\s*(chart|guide)$|^size\s*&\s*fit$|^view size (chart|guide)$/i;
            const btn = document.querySelector('#js-sizeguide-focus')
                || [].slice.call(document.querySelectorAll('button, a, summary, [role=button]'))
                    .find((el) => {
                        const t = (el.innerText || el.textContent || '')
                            .replace(/\s+/g, ' ').trim();
                        if (!t || t.length > 24 || !BTN_RE.test(t)) return false;
                        const r = el.getBoundingClientRect();
                        return r.width >= 8 && r.height >= 8;
                    });
            if (btn) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
            }

            const WORDS = /(inseam|bust|waist|hip|size chart|size guide|measurement)/i;
            const find = () => {
                const SEL = '[role=dialog], [aria-modal=true], dialog, .modal__inner,'
                    + ' .modal__content, .modal, [class*=modal], [id*=sizeguide],'
                    + ' [class*=sizeguide], [class*=size-guide], [class*=popup],'
                    + ' [class*=drawer i], [aria-label*="refinement" i], [aria-label*="size" i]';
                let best = null;
                [].slice.call(document.querySelectorAll(SEL)).forEach((el) => {
                    const st = window.getComputedStyle(el);
                    if (st.display === 'none' || st.visibility === 'hidden'
                        || Number(st.opacity) === 0) return;
                    const r = el.getBoundingClientRect();
                    if (r.width < 220 || r.height < 140) return;
                    if (!el.querySelector('table')) return;
                    if (!WORDS.test(el.innerText || el.textContent || '')) return;
                    const area = r.width * r.height;
                    if (!best || area < best.area) {
                        best = { el, area, x: r.left, y: r.top, width: r.width, height: r.height };
                    }
                });
                return best;
            };

            let box = null;
            for (let i = 0; i < 8; i++) {
                await sleep(1000);
                box = find();
                if (box) break;
            }
            if (!box) return null;

            // Dựng lại bảng thành TRANG SẠCH: giữ nguyên HTML + CSS của site nhưng bỏ
            // lớp phủ, thanh cuộn, nút đóng và phần trang phía sau. Chụp thẳng màn hình
            // sẽ dính hết mấy thứ đó và bị cắt mép.
            const inner = box.el.querySelector('.modal__inner') || box.el;
            // Nhân bản rồi mới cắt gọt để không đụng vào trang thật. Nút đóng (X) của
            // Duluth là <svg><use href="#close"> — sprite nằm chỗ khác nên sang trang
            // sạch sẽ thành ô trống, bỏ hẳn đi.
            const clone = inner.cloneNode(true);
            [].slice.call(clone.querySelectorAll('svg use')).forEach((u) => {
                const href = u.getAttribute('xlink:href') || u.getAttribute('href') || '';
                if (!/close|times|cross/i.test(href)) return;
                const b = u.closest('button, a, [role=button]');
                if (b) b.remove(); else u.remove();
            });
            const html = clone.innerHTML;
            const css = [].slice.call(document.querySelectorAll('link[rel="stylesheet"], style'))
                .map((n) => n.outerHTML).join('');
            // Nội dung DÁN SÁT góc trái-trên (margin 0, không padding) để lúc cắt ảnh
            // chỉ việc cắt từ (0,0) — cắt theo toạ độ hay lệch khi trang đang phóng to.
            const fix = '<style>'
                + 'html,body{background:#fff!important;margin:0;padding:0;overflow:visible!important;}'
                + '.sg-wrap{width:900px;margin:0;padding:16px;background:#fff;box-sizing:border-box;}'
                + '.sg-wrap *{max-height:none!important;overflow:visible!important;}'
                + '.modal,.modal__content,.modal__inner{position:static!important;'
                + 'transform:none!important;box-shadow:none!important;width:auto!important;'
                + 'height:auto!important;}'
                + '.js-modal-close,.modal__close,[class*="modal__close"]{display:none!important;}'
                + '</style>';
            document.documentElement.innerHTML =
                '<head><base href="' + location.origin + '/">' + css + fix + '</head>'
                + '<body><div class="sg-wrap">' + html + '</div></body>';
            await sleep(1200);          // chờ CSS + ảnh minh hoạ tải lại

            const wrap = document.querySelector('.sg-wrap');
            if (!wrap) return null;

            // Bảng size của Duluth rộng 16 cột — trên web phải CUỘN NGANG mới thấy hết.
            // Khung 900px cố định sẽ cắt mất mấy cột cuối -> đo bề ngang thật rồi nới.
            let need = wrap.scrollWidth;
            [].slice.call(wrap.querySelectorAll('table')).forEach((t) => {
                need = Math.max(need, t.scrollWidth + 32);
            });
            need = Math.min(Math.max(need, 900), 2400);
            if (need > wrap.offsetWidth + 4) {
                wrap.style.width = need + 'px';
                await sleep(500);
            }

            // Extension chỉ chụp được phần đang hiện -> thu nhỏ cho lọt cả bảng
            let zoom = 1;
            const vh = window.innerHeight;
            const vw = window.innerWidth;
            const full = { w: wrap.scrollWidth, h: wrap.scrollHeight };
            if (full.h > vh || full.w > vw) {
                zoom = Math.max(0.2, Math.min(vh / full.h, vw / full.w));
                document.documentElement.style.zoom = String(zoom);
                await sleep(700);
            }
            window.scrollTo(0, 0);
            await sleep(250);
            // Kích thước THẬT của ảnh cần lấy = phần trăm khung nhìn mà bảng chiếm.
            // Trả về theo TỈ LỆ để bên panel nhân với đúng kích thước ảnh chụp được,
            // khỏi phụ thuộc devicePixelRatio hay mức phóng to của Chrome.
            const r2 = wrap.getBoundingClientRect();
            return {
                ratioW: Math.min(1, (r2.width + 2) / vw),
                ratioH: Math.min(1, (r2.height + 2) / vh),
                zoom,
            };
        },
    });
    return res && res[0] ? res[0].result : null;
}

async function captureSizeGuide(url) {
    let tab = null;
    try {
        tab = await chrome.tabs.create({ url, active: true });   // phải hiện mới chụp được
        await waitTabReadable(tab.id, NAV_TIMEOUT_MS);
        await sleep(SETTLE_MS);
        const box = await prepareSizeGuide(tab.id);
        if (!box) throw new Error('bấm Size Guide rồi nhưng không thấy bảng size');
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        if (!dataUrl) throw new Error('không chụp được màn hình tab');
        return { dataUrl, box };
    } finally {
        if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* đã đóng */ } }
    }
}

// ==== tab "Cào link": ô chọn sản phẩm trên trang danh mục ======================
// Bật ở panel (lp_enabled) thì mọi tab http(s) — đang mở và mở sau — được gắn
// picker.js: ô vuông trên từng sản phẩm + thanh "Lấy link". Link lấy được nối vào
// lp_links (bỏ trùng theo link), panel nghe storage.onChanged để vẽ lại bảng.

const LP_KEY = 'lp_links';

async function lpEnabled() {
    const saved = await chrome.storage.local.get('lp_enabled');
    return !!saved.lp_enabled;
}

async function lpInject(tabId) {
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
        return true;
    } catch (e) {
        return false;      // trang chrome://, Web Store, tab đã giải phóng... -> bỏ qua
    }
}

async function lpRemove(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => { if (window.__lpPicker) window.__lpPicker.destroy(); },
        });
        return true;
    } catch (e) {
        return false;      // tab không gắn được thì cũng không có gì để gỡ
    }
}

async function lpHttpTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => t.id && t.url && /^https?:/i.test(t.url) && !t.discarded);
}

async function lpSetEnabled(on) {
    await chrome.storage.local.set({ lp_enabled: !!on });
    const tabs = await lpHttpTabs();
    const results = await Promise.all(tabs.map((t) => (on ? lpInject(t.id) : lpRemove(t.id))));
    return results.filter(Boolean).length;
}

async function lpAdd(items) {
    const saved = await chrome.storage.local.get(LP_KEY);
    const links = Array.isArray(saved[LP_KEY]) ? saved[LP_KEY] : [];
    const seen = new Set(links.map((l) => l.url));
    let added = 0;
    for (const it of items || []) {
        const url = canonicalUrl(it && it.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        links.push({
            url,
            house: String(it.house || '').slice(0, 80),
            title: String(it.title || '').slice(0, 300),
            image: String(it.image || '').slice(0, 1000),
            page: String(it.page || '').slice(0, 1000),
            added_at: new Date().toISOString(),
        });
        added++;
    }
    await chrome.storage.local.set({ [LP_KEY]: links });
    return { added, total: links.length };
}

// Chạy 1 lệnh của picker trên tab đang xem (panel bấm "Chọn tất cả" / "Lấy link")
async function lpOnActiveTab(action) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
        throw new Error('Tab đang xem không phải trang web — mở trang danh mục của site rồi thử lại.');
    }
    await lpInject(tab.id);
    const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [action],
        func: async (act) => {
            const p = window.__lpPicker;
            if (!p) return { error: 'Chưa gắn được ô chọn lên trang này.' };
            if (act === 'all') return { total: p.selectAll(true) };
            if (act === 'none') { p.selectAll(false); return { total: p.count().total }; }
            if (act === 'take') {
                // panel tự copy (trang không có focus nên copy trong trang dễ hỏng)
                const r = await p.take({ noCopy: true });
                return { items: r.items, added: r.added, total: r.total };
            }
            return { error: 'Lệnh không hợp lệ' };
        },
    });
    return Object.assign({ title: tab.title || '' }, (res && res.result) || {});
}

// Trang tải xong (kể cả chuyển trang) -> gắn lại ô chọn nếu đang bật
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete' || !tab.url || !/^https?:/i.test(tab.url)) return;
    lpEnabled().then((on) => { if (on) lpInject(tabId); });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    if (msg.cmd === 'lpAdd') {
        lpAdd(msg.items).then(sendResponse)
            .catch((e) => sendResponse({ error: String(e.message || e).slice(0, 200) }));
        return true;
    } else if (msg.cmd === 'lpSetEnabled') {
        lpSetEnabled(msg.on).then((n) => sendResponse({ ok: true, tabs: n }))
            .catch((e) => sendResponse({ error: String(e.message || e).slice(0, 200) }));
        return true;
    } else if (msg.cmd === 'lpActive') {
        lpOnActiveTab(msg.action).then(sendResponse)
            .catch((e) => sendResponse({ error: String(e.message || e).slice(0, 200) }));
        return true;
    }
    if (msg.cmd === 'start') {
        if (state.running) { sendResponse({ error: 'Đang cào, hãy chờ xong đã.' }); return; }
        const urls = parseUrls(msg.text);
        if (!urls.length) { sendResponse({ error: 'Chưa nhập link nào hợp lệ.' }); return; }
        runBatch(urls, msg.workers);
        sendResponse({ ok: true, total: urls.length });
    } else if (msg.cmd === 'listTabs') {
        listOpenTabs()
            .then((tabs) => sendResponse({ tabs }))
            .catch((e) => sendResponse({ error: String(e.message || e).slice(0, 200) }));
        return true;
    } else if (msg.cmd === 'crawlTabs') {
        if (state.running) { sendResponse({ error: 'Đang cào, hãy chờ xong đã.' }); return; }
        const ids = (msg.tabIds || []).filter((x) => x != null);
        if (!ids.length) { sendResponse({ error: 'Chưa chọn tab nào.' }); return; }
        crawlOpenTabs(ids);
        sendResponse({ ok: true, total: ids.length });
    } else if (msg.cmd === 'stop') {
        state.stopFlag = true;
        log('⏹ Đã yêu cầu dừng — chờ các link đang chạy kết thúc...');
        sendResponse({ ok: true });
    } else if (msg.cmd === 'retry') {
        if (state.running) { sendResponse({ error: 'Đang cào, hãy chờ xong rồi thử lại dòng này.' }); return; }
        retryOne(msg.idx);
        sendResponse({ ok: true });
    } else if (msg.cmd === 'getState') {
        // Nạp lại từ storage trước khi trả lời (mở panel sau khi reload extension)
        hydrate().then(() => sendResponse({
            running: state.running,
            records: state.records,
            done: state.done,
            total: state.total,
            logs: state.logs,
        }));
        return true;
    } else if (msg.cmd === 'restore') {
        chrome.storage.local.get(['sc_records', 'sc_progress', 'sc_saved_at']).then((saved) => {
            const recs = Array.isArray(saved.sc_records) ? saved.sc_records : [];
            if (!state.running && recs.length) {
                state.records = recs;
                const p = saved.sc_progress || {};
                state.total = p.total || recs.length;
                state.done = p.done || recs.filter(Boolean).length;
            }
            sendResponse({ records: state.records, done: state.done, total: state.total,
                           saved_at: saved.sc_saved_at || '' });
        });
        return true;
    } else if (msg.cmd === 'captureSizeGuide') {
        captureSizeGuide(msg.url)
            .then((res) => sendResponse(res))
            .catch((e) => sendResponse({ error: String(e.message || e).slice(0, 200) }));
        return true;
    } else if (msg.cmd === 'fetchImage') {
        fetchImageViaTab(msg.url, msg.pageUrl)
            .then((dataUrl) => sendResponse({ dataUrl }))
            .catch((e) => sendResponse({ error: String(e.message || e).slice(0, 200) }));
        return true;        // giữ kênh trả lời cho tới khi tải xong
    } else if (msg.cmd === 'clear') {
        if (!state.running) {
            state.records = [];
            state.done = 0;
            state.total = 0;
            state.logs = [];
            saveState();
        }
        sendResponse({ ok: !state.running });
    }
    return false;
});

// Bấm icon extension là mở side panel
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
