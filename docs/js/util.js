// DOM, formatting, time and dialog helpers shared by every page.
export const TZ = 'Asia/Bangkok';
export const THAI_OFFSET_MIN = 420; // Thailand has no DST
const LOCALE = 'th-TH-u-ca-gregory';

// ---------- DOM ----------
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // trusted static markup only (icons)
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

// Thai line breaking is dictionary based, and the dictionary does not know some loanwords used all over this site
// ("บอท" can break as "บอ|ท", "สเปรด" as "ส|เปร|ด"). Glue them with word joiners between grapheme clusters and allow a
// break on both sides. Applied to every text node built with h() / append().
const THAI_KEEP = ['โบรกเกอร์', 'เซิร์ฟเวอร์', 'พรีเซ็ต', 'ออนไลน์', 'ออฟไลน์', 'เอเจนต์', 'สเปรด', 'สเต็ป', 'กำไร', 'โบรก', 'บอท'];
const KEEP_RE = new RegExp(THAI_KEEP.join('|'), 'g');
const glue = (w) => '\u200B' + w.replace(/(.)(?=[^\u0E31\u0E34-\u0E3A\u0E47-\u0E4E])/gu, '$1\u2060') + '\u200B';
export const thaiBreaks = (s) => (/[\u0E00-\u0E7F]/.test(s) ? s.replace(KEEP_RE, glue) : s);

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false || k === '') continue;
    el.append(k instanceof Node ? k : document.createTextNode(thaiBreaks(String(k))));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...kids) { clear(el); return append(el, kids); }

let uid = 0;
export const newId = (p = 'f') => `${p}-${++uid}`;

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  warn: '<path d="M12 3l9.5 17h-19L12 3z"/><path d="M12 10v4.5M12 17.5v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5l11 7-11 7V5z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4v-9z"/>',
  history: '<path d="M4 4v6h6"/><path d="M5 15a8 8 0 1 0 1-8.5L4 10"/><path d="M12 8v4l3 2"/>',
  sliders: '<path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="9" r="2" fill="currentColor"/><circle cx="12" cy="15" r="2" fill="currentColor"/><circle cx="19" cy="8" r="2" fill="currentColor"/>',
  doc: '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  news: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h6M7 13h10M7 16h10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.7 3.4-5.5 6.5-5.5s5.7 1.8 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 18h2M12 18h2M16 15v3"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17.2v.3"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wand: '<path d="M4 20L15 9M13 7l4 4"/><path d="M18 3v3M16.5 4.5h3M20 9v2M19 10h2M10 3v2M9 4h2"/>',
  save: '<path d="M5 4h11l3 3v13H5V4z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  zap: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/>',
  power: '<path d="M12 3v8"/><path d="M7.5 6.5a7 7 0 1 0 9 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6"/>',
  bars: '<path d="M5 20V11M12 20V5M19 20v-7"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z"/><path d="M8 9.5h8M8 12.5h5"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
};

export function icon(name, cls = '') {
  return h('span', {
    class: `ico ${cls}`.trim(), 'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}

// ---------- numbers ----------
export function fmtNum(n, d = 2) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtSigned(n, d = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const x = Number(n);
  const s = fmtNum(Math.abs(x), d);
  if (Math.abs(x) < 0.5 * 10 ** -d) return fmtNum(0, d);
  return x > 0 ? '+' + s : '−' + s;
}
export function fmtPct(n, d = 1, signed = false) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return (signed ? fmtSigned(n, d) : fmtNum(n, d)) + '%';
}
export const toneOf = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');
export function pnl(n, d = 2, extra = '') {
  return h('span', { class: `num pnl ${toneOf(Number(n))} ${extra}`.trim() }, fmtSigned(n, d));
}
export const fmtLots = (n) => fmtNum(n, 2);
// Money / price, engraved: the decimals smaller, the unit smaller and lighter (DESIGN.md "Numbers").
// <span class="money"><span class="num pos"><span class="int">+59</span><span class="dec">.61</span></span><span class="unit">USD</span></span>
export function money(n, { d = 2, signed = false, tone = signed, unit = '', cls = '' } = {}) {
  const s = signed ? fmtSigned(n, d) : fmtNum(n, d);
  const i = s.lastIndexOf('.');
  const parts = i > 0 && s !== '—' ? [h('span', { class: 'int' }, s.slice(0, i)), h('span', { class: 'dec' }, s.slice(i))] : [s];
  return h('span', { class: `money ${cls}`.trim() },
    h('span', { class: `num ${tone ? toneOf(Number(n)) : ''}`.trim() }, parts),
    unit ? h('span', { class: 'unit' }, unit) : null);
}
export function fmtBytes(b) {
  if (!Number.isFinite(b)) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- time ----------
const dtfCache = new Map();
function dtf(opts) {
  const k = JSON.stringify(opts);
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour12: false, ...opts }));
  return dtfCache.get(k);
}
const FORMATS = {
  datetime: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  short: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
  seconds: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  dm: { day: 'numeric', month: 'short' },
  day: { weekday: 'short', day: 'numeric', month: 'short' },
  longday: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
  month: { month: 'long', year: 'numeric' },
};
export function fmtThai(ms, kind = 'datetime') {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  return dtf(FORMATS[kind] || FORMATS.datetime).format(new Date(Number(ms)));
}
export const toMs = (x) => (x instanceof Date ? x.getTime() : typeof x === 'number' ? x : x ? Date.parse(x) : NaN);

// Server wall-clock strings ('2026.11.06 23:54:59' from the EA, '2026-11-06T23:54:59' from Postgres `timestamp`).
const TS_RE = /^(\d{4})[.-](\d{2})[.-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;
export function parseWall(s) {
  const m = TS_RE.exec(String(s || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
export function serverToUtc(s, offsetMin = 0) {
  const w = parseWall(s);
  return Number.isFinite(w) ? w - (offsetMin || 0) * 60000 : NaN;
}
const p2 = (n) => String(n).padStart(2, '0');
export function wallString(ms, sep = '.', seconds = false) {
  const d = new Date(ms);
  const s = `${d.getUTCFullYear()}${sep}${p2(d.getUTCMonth() + 1)}${sep}${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${s}:${p2(d.getUTCSeconds())}` : s;
}
export function utcToServer(ms, offsetMin = 0, seconds = false) {
  return wallString(ms + (offsetMin || 0) * 60000, '.', seconds);
}
export function serverClock(ms, offsetMin = 0) {
  const d = new Date(ms + (offsetMin || 0) * 60000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
// <input type="datetime-local"> values are entered in Thai time.
export function thaiInputToUtc(v) {
  const w = parseWall(v);
  return Number.isFinite(w) ? w - THAI_OFFSET_MIN * 60000 : NaN;
}
export function utcToThaiInput(ms) {
  const d = new Date(ms + THAI_OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
export function thaiDayKey(ms) {
  const d = new Date(ms + THAI_OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
export function thaiDateInputToUtc(v, endOfDay = false) {
  const w = parseWall(v);
  if (!Number.isFinite(w)) return NaN;
  return w - THAI_OFFSET_MIN * 60000 + (endOfDay ? 86400000 - 1 : 0);
}
export const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function ago(ms) {
  if (!Number.isFinite(ms)) return 'ไม่ทราบ';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return agoSeconds(s);
}
export function agoSeconds(s) {
  if (!Number.isFinite(s)) return 'ไม่ทราบ';
  if (s < 5) return 'เมื่อสักครู่';
  if (s < 60) return `${s} วินาทีก่อน`;
  if (s < 3600) return `${Math.floor(s / 60)} นาทีก่อน`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชั่วโมงก่อน`;
  return `${Math.floor(s / 86400)} วันก่อน`;
}
export function until(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'เริ่มแล้ว';
  if (s < 3600) return `อีก ${Math.max(1, Math.floor(s / 60))} นาที`;
  if (s < 86400) return `อีก ${Math.floor(s / 3600)} ชม. ${Math.floor((s % 3600) / 60)} นาที`;
  return `อีก ${Math.floor(s / 86400)} วัน`;
}
export function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} นาที`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh} ชม. ${mm} นาที` : `${hh} ชม.`;
}

// Thai time with the server time in a tooltip.
export function timeEl(utcMs, offsetMin, kind = 'short') {
  const t = fmtThai(utcMs, kind);
  const attrs = { class: 'time', datetime: Number.isFinite(utcMs) ? new Date(utcMs).toISOString() : null };
  if (offsetMin !== undefined && offsetMin !== null && Number.isFinite(utcMs)) attrs.title = `เวลาเซิร์ฟเวอร์ ${utcToServer(utcMs, offsetMin, true)}`;
  return h('time', attrs, t);
}

// ---------- states ----------
export function loadingState(text = 'กำลังโหลด…') {
  return h('div', { class: 'state', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, text));
}
export function emptyState(title, text, action) {
  return h('div', { class: 'state empty' }, h('p', { class: 'state-title' }, title), text ? h('p', { class: 'muted' }, text) : null, action || null);
}
export function errorState(err, retry) {
  return h('div', { class: 'state error', role: 'alert' },
    icon('warn'),
    h('p', { class: 'state-title' }, 'โหลดข้อมูลไม่สำเร็จ'),
    h('p', { class: 'muted' }, errText(err)),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, icon('refresh'), 'ลองอีกครั้ง') : null);
}
export const errText = (e) => (e && (e.thai || e.message)) || String(e || 'เกิดข้อผิดพลาด');

export function callout(kind, title, ...body) {
  return h('div', { class: `callout ${kind}`, role: kind === 'critical' ? 'alert' : null },
    icon(kind === 'info' ? 'info' : kind === 'good' ? 'check' : 'warn'),
    h('div', null, title ? h('p', { class: 'callout-title' }, title) : null, ...body));
}

// ---------- toast ----------
export function toast(msg, kind = 'info', ms = 3800) {
  let box = document.getElementById('toasts');
  if (!box) box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
  // an open modal sits in the top layer: put the toasts inside it so they are not hidden behind its backdrop
  const dialogs = document.querySelectorAll('dialog[open]');
  const parent = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  if (box.parentNode !== parent) parent.append(box);
  const t = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'warn' : kind === 'good' ? 'check' : 'info'), h('span', null, msg));
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- dialogs (native <dialog>: focus trap, Esc) ----------
export function openModal({ title, body, actions = [], wide = false, dismissable = true, onClose } = {}) {
  const titleId = newId('dlg');
  const bodyBox = h('div', { class: 'modal-body' }, body);
  const foot = h('div', { class: 'modal-foot' });
  const closeBtn = dismissable ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ปิด', onclick: () => close() }, icon('x')) : null;
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title), closeBtn), bodyBox, foot);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    try { dlg.close(); } catch { /* already closed */ }
    dlg.remove();
    onClose && onClose(result);
  }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (dismissable) close(); });
  const setActions = (list) => {
    clear(foot);
    for (const a of list) {
      foot.append(h('button', {
        class: `btn ${a.kind || ''}`.trim(), type: a.submit ? 'submit' : 'button', form: a.form || null, disabled: !!a.disabled,
        onclick: a.submit ? null : () => a.onClick ? a.onClick(close) : close(),
      }, a.icon ? icon(a.icon) : null, a.label));
    }
  };
  setActions(actions);
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body: bodyBox, foot, close, setActions };
}

export function confirmDialog(title, message, { ok = 'ยืนยัน', cancel = 'ยกเลิก', danger = false, extra = null } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title,
      body: [typeof message === 'string' ? h('p', null, message) : message, extra],
      actions: [
        { label: cancel, onClick: (close) => { answered = true; resolve(false); close(); } },
        { label: ok, kind: danger ? 'danger' : 'primary', onClick: (close) => { answered = true; resolve(true); close(); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
    const btn = m.foot.querySelector('.btn.primary, .btn.danger');
    btn && btn.focus();
  });
}

// ---------- misc ----------
export async function copyText(text, label = 'คัดลอกแล้ว') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(label, 'good', 2000);
}

export function copyButton(text, label = 'คัดลอก') {
  return h('button', { class: 'btn small', type: 'button', onclick: () => copyText(typeof text === 'function' ? text() : text) }, icon('copy'), label);
}

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header, rows) {
  return [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}
export function downloadCsv(name, header, rows) {
  // BOM so Excel opens Thai text as UTF-8
  downloadBlob(name, new Blob(['﻿' + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function field(label, input, { hint, error, id, cls = '' } = {}) {
  const fid = id || input.id || newId('in');
  input.id = fid;
  const hintId = hint ? `${fid}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h('div', { class: `field ${cls}`.trim() },
    h('label', { for: fid }, label), input,
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null,
    error ? h('p', { class: 'field-error' }, error) : null);
}

export function busy(btn, on, text) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.classList.add('busy'); if (text) btn.textContent = text; }
  else { btn.disabled = false; btn.classList.remove('busy'); if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// A phone freezes a page left in the background: timers stop, the realtime socket drops without a word, and what
// changed meanwhile is never replayed. onWake(fn) calls fn when the page comes back: shown again after at least
// minHiddenMs hidden, restored from the back-forward cache, the network back, or a timer gap that says the page was
// frozen (some home-screen apps resume without a visibilitychange). Returns the function that removes the listeners.
export function onWake(fn, minHiddenMs = 3000) {
  let hiddenAt = document.hidden ? Date.now() : 0, last = 0, beat = Date.now();
  const fire = () => {
    if (Date.now() - last < 1500) return; // one wake fires several of these at once
    last = Date.now();
    try { fn(); } catch (e) { console.error(e); }
  };
  const vis = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const was = hiddenAt; hiddenAt = 0;
    if (!was || Date.now() - was >= minHiddenMs) fire();
  };
  const show = (e) => { if (e.persisted) fire(); };
  const gap = setInterval(() => { const n = Date.now(); if (n - beat > 20000 && !document.hidden) fire(); beat = n; }, 5000);
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('pageshow', show);
  window.addEventListener('online', fire);
  return () => {
    clearInterval(gap);
    document.removeEventListener('visibilitychange', vis);
    window.removeEventListener('pageshow', show);
    window.removeEventListener('online', fire);
  };
}
