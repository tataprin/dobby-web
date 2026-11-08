// ประวัติ > รายการเทรด: the broker's price over 1, 3 or 5 trading days (`bars` table: M15 closes + VWAP, kept about
// 45 days) with every trade of that window on it: the entry (▲ jade buy / ▼ cinnabar sell), TP (jade, dashed) and SL
// (cinnabar, dashed) over the holding period, the SL stepping up in gold at each lock stage, a dotted link to the exit
// ring coloured by the result. A "day" is the broker's server day (the EA's day: daily cap, VWAP). The x axis runs
// over bars, not clock time, so weekends and the daily break take no space. Same drawing language as the hero
// (pricechart.js) and the trade page (tradechart.js): inline SVG at the container width, Thai time, no motion.
// Hover / tap a mark for the trade, click (second tap on touch) to open its page.
import { h, mount, icon, fmtNum, fmtSigned, fmtThai, thaiDayKey, isoUtc, errText } from './util.js';
import { prefs } from './state.js';
import { panel, segmented } from './views.js';
import { REASON_LABELS } from './journal.js';
import { barsFromRows } from './tradechart.js';
import { readBars } from './pricechart.js';

const DAY = 86400000, HOUR = 3600000, MIN = 60000, TF = 15 * MIN;
const CHUNK = 10 * DAY; // one fetch: about 650 bars, well under the 3000-row limit
const SPANS = [{ value: '1', label: '1 วัน' }, { value: '3', label: '3 วัน' }, { value: '5', label: '5 วัน' }];
const NO_DATA = 'ยังไม่มีข้อมูลราคาย้อนหลัง (ต้องใช้แอป Dobby 1.2.0 ขึ้นไป และเก็บย้อนหลังได้ราว 45 วัน)';

function niceStep(span, count) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * mag >= raw) return k * mag;
  return 10 * mag;
}
const when = (ms) => (thaiDayKey(ms) === thaiDayKey(Date.now()) ? `วันนี้ ${fmtThai(ms, 'time')} น.` : `${fmtThai(ms, 'short')} น.`);

// api, bot, offsetMin (server UTC offset), onTrade(trade)
export function historyChart({ api, bot, offsetMin = 0, onTrade }) {
  const off = offsetMin * MIN;
  const dayKey = (t) => new Date(t + off).toISOString().slice(0, 10); // server day of a bar / time (UTC ms)
  const dayMid = (key) => Date.parse(`${key}T12:00:00Z`) - off; // noon server time, for the Thai date label
  let span = SPANS.some((o) => o.value === prefs.get('hist-chart-days')) ? Number(prefs.get('hist-chart-days')) : 1;
  let endKey = null; // last server day shown (null: the latest)
  let trades = [], note = '';
  const cache = new Map(); // bar open (ms) -> {c, v}
  let loadedFrom = Infinity, exhausted = false, loading = false, failed = '', fallback = false, lastFetch = 0, seq = 0;

  // ---------------- view
  const plot = h('div', { class: 'pc-plot' });
  const tip = h('div', { class: 'pc-tip', role: 'status', hidden: true });
  const fig = h('figure', { class: 'pchart hchart' }, plot, tip);
  const seg = segmented({
    label: 'จำนวนวันบนกราฟ', options: SPANS, get: () => String(span),
    set: (v) => { span = Number(v); prefs.set('hist-chart-days', v); seg.update(); refresh(); },
  });
  const prevBtn = h('button', { class: 'icon-btn hc-prev', type: 'button', 'aria-label': 'ช่วงก่อนหน้า', title: 'ช่วงก่อนหน้า', onclick: () => step(-1) }, icon('chevron'));
  const nextBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'ช่วงถัดไป', title: 'ช่วงถัดไป', onclick: () => step(1) }, icon('chevron'));
  const lastBtn = h('button', { class: 'btn small ghost', type: 'button', hidden: true, onclick: () => { endKey = null; refresh(); } }, 'ล่าสุด');
  const rangeLab = h('p', { class: 'hc-range', 'aria-live': 'polite' });
  const sub = h('p', { class: 'muted small' });
  const legend = h('ul', { class: 'tc-legend' },
    [['entry-buy', 'เข้าซื้อ'], ['entry-sell', 'เข้าขาย'], ['exit-win', 'ออกกำไร'], ['exit-loss', 'ออกขาดทุน'], ['tp', 'TP'], ['sl', 'SL'],
      ['lock', 'SL ที่เลื่อนมาล็อกกำไร'], ['vwap', 'VWAP']].map(([cls, text]) => h('li', null, h('span', { class: `lg-key ${cls}`, 'aria-hidden': 'true' }), text)));
  const el = panel(null, { cls: 'hc-panel' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'panel-title' }, h('div', null, h('h2', null, 'กราฟราคากับไม้ของบอท'), sub)), seg),
    h('div', { class: 'hc-nav' }, prevBtn, rangeLab, nextBtn, lastBtn),
    fig, legend);
  el.setAttribute('aria-label', 'กราฟราคากับไม้ของบอท');
  const drawSub = () => mount(sub, `ราคาจากโบรกของบอท แท่ง 15 นาที จุดเข้า TP SL และจุดออกของทุกไม้${note ? ` ${note}` : ''}`);
  drawSub();

  // ---------------- data
  async function fetchRange(from, to) {
    const rows = await api.bars(bot.id, isoUtc(from), isoUtc(to));
    const b = barsFromRows(rows);
    if (b) b.t.forEach((t, i) => cache.set(t, { c: b.c[i], v: b.vwap[i] }));
    return b ? b.t.length : (rows || []).length;
  }
  async function loadLatest() {
    const now = Date.now();
    const from = Number.isFinite(loadedFrom) ? Math.max(now - CHUNK, latestBar() - HOUR) : now - CHUNK;
    await fetchRange(from, now);
    loadedFrom = Math.min(loadedFrom, from);
    lastFetch = now;
  }
  async function loadOlder() {
    const to = loadedFrom - 1, from = loadedFrom - CHUNK;
    const n = await fetchRange(from, to);
    loadedFrom = from;
    if (!n) exhausted = true; // ten days without a bar: past what the database keeps
  }
  const latestBar = () => { let m = -Infinity; for (const t of cache.keys()) if (t > m) m = t; return m; };
  const dayList = () => [...new Set([...cache.keys()].map(dayKey))].sort();
  // index of the last day shown: the latest day with bars on or before endKey (-1: endKey is older than all loaded)
  const endIndex = (days) => {
    if (!endKey) return days.length - 1;
    let i = days.length - 1;
    while (i >= 0 && days[i] > endKey) i--;
    return i;
  };
  const dayBefore = (key) => new Date(Date.parse(`${key}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

  // the days to show: `span` days ending at endKey (fetching older bars while there are too few)
  async function ensure() {
    for (let guard = 0; guard < 8; guard++) {
      if (endIndex(dayList()) + 1 >= span || exhausted || fallback) return;
      await loadOlder();
    }
  }

  async function refresh() {
    const my = ++seq;
    loading = true; draw();
    try {
      if (!lastFetch || (!endKey && Date.now() - lastFetch > 5 * MIN)) await loadLatest();
      await ensure();
      failed = '';
    } catch (e) {
      if (e && e.code === 'not_deployed' || !cache.size) {
        // no `bars` table yet: the last 24 h the app keeps in agent_state
        const b = readBars(bot);
        if (b) { fallback = true; exhausted = true; b.t.forEach((t, i) => cache.set(t, { c: b.c[i], v: b.vwap[i] })); }
        if (!b) failed = e && e.code === 'not_deployed' ? NO_DATA : errText(e);
      } else failed = errText(e);
    }
    if (my !== seq) return;
    loading = false; draw();
  }

  function step(dir) {
    const days = dayList();
    if (!days.length) return;
    const endI = Math.max(0, endIndex(days));
    if (dir < 0) {
      const firstI = Math.max(0, endI - span + 1);
      if (firstI > 0) endKey = days[firstI - 1];
      else if (!exhausted) endKey = dayBefore(days[0]); // older than anything loaded: ensure() fetches
      else return;
    } else {
      const i = Math.min(days.length - 1, endI + span);
      endKey = i >= days.length - 1 ? null : days[i];
    }
    refresh();
  }

  // ---------------- chart
  let geo = null, lastW = 0, pinned = false, tapped = null;
  function placeholder(text) {
    geo = null;
    fig.classList.add('is-empty');
    plot.innerHTML = '<svg class="pc-svg" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0 76 C 90 70, 150 52, 230 60 S 380 84, 460 58 S 560 40, 600 46" fill="none" class="pc-ghost"/></svg>';
    plot.append(h('p', { class: 'pc-empty-text' }, text));
    tip.hidden = true;
  }

  function draw() {
    lastW = Math.round(fig.clientWidth);
    const days = dayList();
    let endI = endIndex(days);
    if (endI < 0) endI = Math.min(days.length - 1, span - 1); // older than anything kept: the oldest days
    const shown = days.slice(Math.max(0, endI - span + 1), endI + 1);
    const isLatest = !endKey || endI >= days.length - 1;
    prevBtn.disabled = loading || !days.length || (exhausted && endI - span + 1 <= 0);
    nextBtn.disabled = loading || isLatest;
    lastBtn.hidden = isLatest;
    if (shown.length) {
      const a = dayMid(shown[0]), b = dayMid(shown[shown.length - 1]);
      rangeLab.textContent = shown.length === 1 ? fmtThai(a, 'day') : `${fmtThai(a, 'dm')} ถึง ${fmtThai(b, 'dm')}`;
    } else rangeLab.textContent = loading ? 'กำลังโหลด…' : '';
    if (!shown.length) { placeholder(loading ? 'กำลังโหลดราคา…' : failed || NO_DATA); return; }

    const keep = new Set(shown);
    const bt = [...cache.keys()].filter((t) => keep.has(dayKey(t))).sort((x, y) => x - y);
    const n = bt.length;
    if (n < 2) { placeholder(loading ? 'กำลังโหลดราคา…' : NO_DATA); return; }
    fig.classList.remove('is-empty');
    const bc = bt.map((t) => cache.get(t).c), bv = bt.map((t) => cache.get(t).v);
    const ws = bt[0], we = bt[n - 1] + TF, now = Date.now();

    // time -> position in bars (a bar spans [i, i + 1]; a time in a gap goes to the next bar's start)
    const pos = (T) => {
      if (!(T >= ws)) return 0;
      let lo = 0, hi = n - 1, i = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (bt[m] <= T) { i = m; lo = m + 1; } else hi = m - 1; }
      return T < bt[i] + TF ? i + (T - bt[i]) / TF : Math.min(n, i + 1);
    };
    const endOf = (t) => (t.open ? now : t.closeUtc);
    const inWin = (T) => Number.isFinite(T) && T >= ws && T <= we;
    const list = trades.filter((t) => {
      const a = Number.isFinite(t.openUtc) ? t.openUtc : t.closeUtc, b = endOf(t);
      return Number.isFinite(a) && Number.isFinite(b) && a <= we && b >= ws;
    });

    let lo = Infinity, hi = -Infinity;
    const see = (p) => { if (Number.isFinite(p) && p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); } };
    bc.forEach(see); bv.forEach(see);
    for (const t of list) { [t.openPrice, t.closePrice, t.tp, t.sl].forEach(see); (t.lockSteps || []).forEach((s) => see(s.sl)); }
    const span0 = Math.max(hi - lo, 2);
    const ya = lo - span0 * 0.06, yb = hi + span0 * 0.06;

    const W = Math.max(280, lastW || 640);
    const narrow = W < 560;
    const H = narrow ? 260 : 340;
    const L = 2, R = narrow ? 58 : 70, T = 14, B = 28;
    const pw = W - L - R, ph = H - T - B;
    const sx = (p) => L + (p / n) * pw;
    const sy = (p) => T + (1 - (p - ya) / (yb - ya || 1)) * ph;
    const tx = (time) => sx(pos(time));
    const f1 = (x) => x.toFixed(1);
    let s = '';

    // grid + price labels (right)
    const stepP = niceStep(yb - ya, narrow ? 4 : 5);
    const dec = stepP < 1 ? 1 : 0;
    for (let v = Math.ceil(ya / stepP) * stepP; v <= yb + 1e-9; v += stepP) {
      const y = sy(v);
      if (y < T - 2 || y > T + ph + 2) continue;
      s += `<path class="pc-grid" d="M${L} ${f1(y)}H${L + pw}"/><text class="pc-ylab" x="${W - 4}" y="${f1(y + 4)}" text-anchor="end">${fmtNum(v, dec)}</text>`;
    }
    // days: a dashed line where a server day starts, the date under each day (one day: Thai times instead)
    const firstOf = [];
    bt.forEach((t, i) => { if (!i || dayKey(t) !== dayKey(bt[i - 1])) firstOf.push(i); });
    firstOf.forEach((i, k) => {
      if (k) s += `<path class="pc-day" d="M${f1(sx(i))} ${T}V${T + ph}"/>`;
      if (shown.length > 1) {
        const j = k + 1 < firstOf.length ? firstOf[k + 1] : n;
        const key = dayKey(bt[i]);
        const lab = narrow && shown.length > 3 ? fmtThai(dayMid(key), 'dm') : fmtThai(dayMid(key), 'day');
        s += `<text class="pc-xlab" x="${f1(sx((i + j) / 2))}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
      }
    });
    if (shown.length === 1) {
      const every = (narrow ? 6 : 3) * HOUR, tz = 7 * HOUR;
      for (let t = Math.ceil((ws + tz) / every) * every - tz; t <= we; t += every) {
        const p = pos(t);
        if (t > ws && Math.abs(bt[Math.min(n - 1, Math.floor(p))] - t) > TF) continue; // inside a gap
        const x = sx(p);
        if (x < L + 18 || x > L + pw - 18) continue;
        s += `<path class="pc-vtick" d="M${f1(x)} ${T + ph}v4"/><text class="pc-xlab" x="${f1(x)}" y="${H - 8}" text-anchor="middle">${fmtThai(t, 'time')}</text>`;
      }
    }
    // holding periods (faint), VWAP (resets each server day), the price line
    for (const t of list) {
      const a = tx(Number.isFinite(t.openUtc) ? Math.max(ws, t.openUtc) : ws), b = tx(Math.min(we, endOf(t)));
      s += `<rect class="tc-hold" x="${f1(a)}" y="${T}" width="${f1(Math.max(1, b - a))}" height="${ph}"/>`;
    }
    let vw = '', pen = false;
    bv.forEach((v, i) => {
      if (v === null || (i && dayKey(bt[i]) !== dayKey(bt[i - 1]))) pen = false;
      if (v === null) return;
      vw += `${pen ? 'L' : 'M'}${f1(sx(i + 1))} ${f1(sy(v))}`; pen = true;
    });
    if (vw) s += `<path class="pc-vwap" d="${vw}"/>`;
    s += `<path class="pc-line hc-line" d="${bc.map((c, i) => `${i ? 'L' : 'M'}${f1(sx(i + 1))} ${f1(sy(c))}`).join('')}"/>`;

    // trades: TP and SL over the holding period (SL stepping up in gold at each lock), link, entry, exit
    const marks = [];
    let mk = '';
    for (const t of list) {
      const t0 = Number.isFinite(t.openUtc) ? Math.max(ws, t.openUtc) : ws, t1 = Math.min(we, endOf(t));
      const x0 = tx(t0), x1 = tx(t1);
      if (t.tp > 0) mk += `<path class="tc-tp" d="M${f1(x0)} ${f1(sy(t.tp))}H${f1(x1)}"/>`;
      if (t.sl > 0) {
        const steps = (t.lockSteps || []).filter((st) => st.utc >= (t.openUtc ?? -Infinity) && st.utc <= endOf(t)).sort((a, b) => a.utc - b.utc);
        const firstX = steps.length ? tx(Math.max(ws, Math.min(we, steps[0].utc))) : x1;
        if (firstX > x0) mk += `<path class="tc-sl" d="M${f1(x0)} ${f1(sy(t.sl))}H${f1(firstX)}"/>`;
        if (steps.length) {
          let d = `M${f1(firstX)} ${f1(sy(t.sl))}`;
          steps.forEach((st, i) => { d += `V${f1(sy(st.sl))}H${f1(i + 1 < steps.length ? tx(Math.min(we, steps[i + 1].utc)) : x1)}`; });
          mk += `<path class="tc-lock" d="${d}"/>`;
        }
      }
      const hasOpen = inWin(t.openUtc) && t.openPrice > 0;
      const hasClose = !t.open && inWin(t.closeUtc) && t.closePrice > 0;
      const win = (t.pnl ?? 0) >= 0;
      const ox = hasOpen ? tx(t.openUtc) : null, oy = hasOpen ? sy(t.openPrice) : null;
      const cx = hasClose ? tx(t.closeUtc) : null, cy = hasClose ? sy(t.closePrice) : null;
      if (hasOpen && hasClose) mk += `<path class="pc-link ${win ? 'win' : 'loss'}" d="M${f1(ox)} ${f1(oy)}L${f1(cx)} ${f1(cy)}"/>`;
      if (hasOpen) {
        const buy = t.side === 'BUY';
        mk += `<path class="pc-mark ${buy ? 'buy' : 'sell'}" d="${buy ? `M${f1(ox)} ${f1(oy - 6.5)}l5.8 10.2h-11.6z` : `M${f1(ox)} ${f1(oy + 6.5)}l5.8 -10.2h-11.6z`}"/>`;
        marks.push({ x: ox, y: oy, t });
      }
      if (hasClose) {
        mk += `<circle class="pc-ring ${win ? 'win' : 'loss'}" cx="${f1(cx)}" cy="${f1(cy)}" r="4.6"/>`;
        marks.push({ x: cx, y: cy, t });
      }
    }
    s += mk;
    s += `<g class="pc-cross" visibility="hidden"><path class="pc-crossl" d="M0 ${T}V${T + ph}"/><circle class="pc-crossd" r="3.4" cx="0" cy="0"/></g>`;
    const closed = list.filter((t) => !t.open && inWin(t.closeUtc));
    const net = closed.reduce((a, t) => a + (t.pnl || 0), 0);
    const aria = `ราคาทอง ${rangeLab.textContent} ต่ำสุด ${fmtNum(Math.min(...bc))} สูงสุด ${fmtNum(Math.max(...bc))}`
      + `${list.length ? ` มี ${list.length} ไม้บนกราฟ ปิดแล้ว ${closed.length} ไม้ รวม ${fmtSigned(net)}` : ' ไม่มีไม้ในช่วงนี้'}`;
    plot.innerHTML = `<svg class="pc-svg${loading ? ' hc-busy' : ''}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}">${s}<rect class="pc-hit" x="${L}" y="0" width="${pw}" height="${H}"/></svg>`;
    if (!list.length) plot.append(h('p', { class: 'hc-none' }, 'ไม่มีไม้ในช่วงนี้'));
    geo = { n, bt, bc, sx, sy, marks, T, ph, W };
    const hitR = plot.querySelector('.pc-hit');
    hitR.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') point(e); });
    hitR.addEventListener('pointerdown', (e) => {
      const m = point(e);
      const can = m && onTrade && m.t.key;
      if (e.pointerType === 'touch') { if (can && tapped === m.t) { tapped = null; onTrade(m.t); return; } tapped = m ? m.t : null; pinned = true; }
      else if (can) onTrade(m.t);
    });
    hitR.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hideTip(); });
  }

  function hideTip() { tip.hidden = true; pinned = false; const c = plot.querySelector('.pc-cross'); if (c) c.setAttribute('visibility', 'hidden'); }

  function point(e) {
    if (!geo) return null;
    const r = plot.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const cross = plot.querySelector('.pc-cross');
    let best = null, bd = 18;
    for (const m of geo.marks) { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } }
    const hitR = plot.querySelector('.pc-hit');
    if (best) {
      cross.setAttribute('visibility', 'hidden');
      show(tradeTip(best.t, e.pointerType === 'touch'), best.x, best.y);
      hitR.classList.toggle('on-mark', !!(onTrade && best.t.key));
      return best;
    }
    hitR.classList.remove('on-mark');
    const i = Math.max(0, Math.min(geo.n - 1, Math.round((x - geo.sx(0)) / (geo.sx(1) - geo.sx(0))) - 1));
    const px = geo.sx(i + 1), py = geo.sy(geo.bc[i]);
    cross.setAttribute('visibility', 'visible');
    cross.querySelector('.pc-crossl').setAttribute('d', `M${px.toFixed(1)} ${geo.T}V${geo.T + geo.ph}`);
    const dot = cross.querySelector('.pc-crossd'); dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1));
    show([h('p', { class: 'pc-tip-sub' }, when(geo.bt[i] + TF)), h('p', { class: 'pc-tip-price num' }, fmtNum(geo.bc[i]))], px, py);
    return null;
  }

  function show(kids, x, y) {
    tip.replaceChildren(...kids);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > geo.W - 4) left = x - 14 - tw;
    let top = y - th - 12;
    if (top < 0) top = y + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${top}px`;
  }

  function tradeTip(t, touch) {
    const buy = t.side === 'BUY';
    const kids = [h('p', { class: 'pc-tip-title' }, h('span', { class: `side ${buy ? 'buy' : 'sell'}` }, buy ? '▲ ซื้อ' : '▼ ขาย'), ` ${t.module || ''} `, h('span', { class: 'num' }, fmtNum(t.lots)), ' ล็อต')];
    if (t.openPrice > 0 && Number.isFinite(t.openUtc)) kids.push(h('p', null, `เข้า ${when(t.openUtc)} ที่ `, h('span', { class: 'num' }, fmtNum(t.openPrice))));
    if (t.tp > 0 || t.sl > 0) kids.push(h('p', null, 'TP ', h('span', { class: 'num' }, t.tp > 0 ? fmtNum(t.tp) : '—'), ' SL ', h('span', { class: 'num' }, t.sl > 0 ? fmtNum(t.sl) : '—')));
    if ((t.lockSteps || []).length) kids.push(h('p', { class: 'pc-tip-sub' }, `เลื่อน SL ล็อกกำไร ${t.lockSteps.length} ครั้ง`));
    if (t.open) kids.push(h('p', { class: 'pc-tip-sub' }, 'ไม้นี้ยังเปิดอยู่'));
    else {
      kids.push(h('p', null, `ออก ${when(t.closeUtc)} ที่ `, h('span', { class: 'num' }, fmtNum(t.closePrice))));
      kids.push(h('p', { class: 'pc-tip-pnl' }, h('span', { class: `num pnl ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : 'zero'}` }, fmtSigned(t.pnl)),
        h('span', { class: 'pc-tip-sub' }, ` ${REASON_LABELS[t.reason] || t.reason || ''}`)));
    }
    if (onTrade && t.key) kids.push(h('p', { class: 'pc-tip-sub' }, touch ? 'แตะอีกครั้งเพื่อดูไม้นี้' : 'กดเพื่อดูไม้นี้'));
    return kids;
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const w = Math.round(fig.clientWidth); if (w && w !== lastW) draw(); }) : null;
  if (ro) ro.observe(fig);
  const outside = (e) => { if (pinned && !fig.contains(e.target)) hideTip(); };
  document.addEventListener('pointerdown', outside);

  // trades: from pairTrades, already narrowed by the page's strategy and tag filters; label: e.g. "เฉพาะสูตร C5G"
  el.setTrades = (list, label = '') => {
    trades = list || []; note = label; drawSub();
    if (!lastFetch && !loading) refresh();
    else if (!endKey && Date.now() - lastFetch > 5 * MIN && !loading) refresh(); // new bars every 15 min
    else draw();
  };
  // jump to one server day ('YYYY-MM-DD'), e.g. a day picked on the calendar
  el.showDay = (key) => { if (key && key !== endKey) { endKey = key; refresh(); } };
  el.destroy = () => { if (ro) ro.disconnect(); document.removeEventListener('pointerdown', outside); seq++; };
  return el;
}
