// The dashboard hero chart: the last 24 h of XAUUSD (bots.agent_state.bars, SPEC 8) as one quiet line, a faint VWAP,
// the current price, and Dobby's own trades stamped on it (OPEN: ▲ jade buy / ▼ cinnabar sell at entry time and
// price; CLOSE: a small ring coloured by the trade's P&L). Hover or tap shows the trade (or the price at that time).
// Drawn as inline SVG at the container's pixel width, redrawn on resize. One orchestrated motion on first draw: the
// line draws in and the marks stamp in where the line reaches them (off with prefers-reduced-motion).
import { h, fmtNum, fmtSigned, fmtThai, thaiDayKey } from './util.js';
import { REASON_LABELS } from './journal.js';

const DAY = 86400000, HOUR = 3600000;
const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// bots.agent_state.bars -> {tf (ms), t: [bar open, ms UTC], c: [close], vwap: [number|null]} or null
export function readBars(bot) {
  const b = bot && bot.agent_state && bot.agent_state.bars;
  if (!b || !Array.isArray(b.t) || !Array.isArray(b.c)) return null;
  const m = /^M(\d+)$/i.exec(String(b.tf || 'M15'));
  const tf = (m ? Number(m[1]) : 15) * 60000;
  const idx = [];
  for (let i = 0; i < b.t.length; i++) {
    const t = Number(b.t[i]) * 1000, c = Number(b.c[i]);
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) idx.push(i);
  }
  idx.sort((i, j) => Number(b.t[i]) - Number(b.t[j]));
  const out = { tf, t: [], c: [], vwap: [] };
  for (const i of idx) {
    out.t.push(Number(b.t[i]) * 1000);
    out.c.push(Number(b.c[i]));
    const v = Array.isArray(b.vwap) ? Number(b.vwap[i]) : NaN;
    out.vwap.push(Number.isFinite(v) && v > 0 ? v : null);
  }
  return out.t.length >= 2 ? out : null;
}

function niceStep(span, count) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * mag >= raw) return k * mag;
  return 10 * mag;
}

const when = (ms) => (thaiDayKey(ms) === thaiDayKey(Date.now()) ? `${fmtThai(ms, 'time')} น.` : `${fmtThai(ms, 'short')} น.`);

export function priceChart() {
  const plot = h('div', { class: 'pc-plot' });
  const tip = h('div', { class: 'pc-tip', role: 'status', hidden: true });
  const el = h('figure', { class: 'pchart' }, plot, tip);
  let data = null, animateNext = false, lastW = 0, geo = null, pinned = false, lastPt = null;

  el.update = (d, opts = {}) => {
    data = d;
    if (opts.animate) animateNext = true;
    draw();
  };

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const w = Math.round(el.clientWidth);
    if (data && w && w !== lastW) draw();
  }) : null;
  if (ro) ro.observe(el);
  const outside = (e) => { if (pinned && !el.contains(e.target)) hideTip(); };
  document.addEventListener('pointerdown', outside);
  el.destroy = () => { if (ro) ro.disconnect(); document.removeEventListener('pointerdown', outside); };

  function hideTip() { tip.hidden = true; pinned = false; lastPt = null; const c = plot.querySelector('.pc-cross'); if (c) c.setAttribute('visibility', 'hidden'); }

  function empty(text) {
    lastW = Math.round(el.clientWidth);
    geo = null;
    el.classList.add('is-empty');
    plot.innerHTML = `<svg class="pc-svg" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0 76 C 90 70, 150 52, 230 60 S 380 84, 460 58 S 560 40, 600 46" fill="none" class="pc-ghost"/></svg>`;
    plot.append(h('p', { class: 'pc-empty-text' }, text));
    tip.hidden = true;
  }

  function draw() {
    if (!data) return;
    const bars = data.bars;
    if (!bars) { empty(data.emptyText || 'กราฟราคาจะขึ้นเมื่อแอปเวอร์ชันใหม่ส่งข้อมูล'); return; }
    el.classList.remove('is-empty');
    const W = Math.max(280, Math.round(el.clientWidth || 640));
    lastW = W;
    const H = W < 560 ? 184 : 236;
    const now = data.now || Date.now();
    const xs = bars.t.map((t) => t + bars.tf); // a bar's close is drawn at its close time
    const lastX = xs[xs.length - 1];
    const live = Number.isFinite(data.bid) && now - lastX < 45 * 60000 && now >= lastX - bars.tf;
    const xa = xs[0], xb = live ? Math.max(now, lastX) : lastX;
    const pts = xs.map((x, i) => [x, bars.c[i]]);
    if (live) pts.push([xb, data.bid]);

    // Dobby's trades inside the window
    const inWin = (t) => Number.isFinite(t) && t >= xa - bars.tf && t <= xb + 60000;
    const trades = (data.trades || []).filter((t) => (inWin(t.openUtc) && t.openPrice > 0) || (!t.open && inWin(t.closeUtc) && t.closePrice > 0));

    let lo = Infinity, hi = -Infinity;
    const see = (p) => { if (Number.isFinite(p) && p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); } };
    pts.forEach((p) => see(p[1]));
    bars.vwap.forEach(see);
    trades.forEach((t) => { if (inWin(t.openUtc)) see(t.openPrice); if (!t.open && inWin(t.closeUtc)) see(t.closePrice); });
    const span0 = Math.max(hi - lo, 2);
    const ya = lo - span0 * 0.12, yb = hi + span0 * 0.12;

    const narrow = W < 560;
    const L = 2, R = narrow ? 58 : 70, T = 22, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const sx = (t) => L + ((t - xa) / (xb - xa || 1)) * pw;
    const sy = (p) => T + (1 - (p - ya) / (yb - ya || 1)) * ph;
    const f1 = (n) => n.toFixed(1);

    let s = '';
    // horizontal grid + price labels (right)
    const step = niceStep(yb - ya, narrow ? 3 : 4);
    const dec = step < 1 ? 1 : 0;
    const lastPrice = pts[pts.length - 1][1];
    const ly = sy(lastPrice);
    for (let v = Math.ceil(ya / step) * step; v <= yb + 1e-9; v += step) {
      const y = sy(v);
      if (y < T - 2 || y > T + ph + 2) continue;
      s += `<path class="pc-grid" d="M${L} ${f1(y)}H${L + pw}"/>`;
      if (Math.abs(y - ly) > 15) s += `<text class="pc-ylab" x="${W - 4}" y="${f1(y + 4)}" text-anchor="end">${fmtNum(v, dec)}</text>`;
    }
    // time labels every 6 h (Thai time), bottom
    const tz = 7 * HOUR, every = 6 * HOUR;
    for (let t = Math.ceil((xa + tz) / every) * every - tz; t <= xb; t += every) {
      const x = sx(t);
      if (x < L + 18 || x > L + pw - 18) continue;
      s += `<path class="pc-vtick" d="M${f1(x)} ${T + ph}v4"/><text class="pc-xlab" x="${f1(x)}" y="${H - 6}" text-anchor="middle">${fmtThai(t, 'time')}</text>`;
    }
    // the broker's day starts here (the daily cap and the header's "วันนี้" use this day)
    const off = (data.offsetMin || 0) * 60000;
    const dayStart = Math.floor((now + off) / DAY) * DAY - off;
    if (dayStart > xa + 2 * HOUR && dayStart < xb - HOUR) {
      const x = sx(dayStart);
      s += `<path class="pc-day" d="M${f1(x)} ${T - 4}V${T + ph}"/><text class="pc-daylab" x="${f1(x + 5)}" y="${T - 8}">วันใหม่ของโบรก</text>`;
    }
    // VWAP (faint, dashed), segments over gaps
    let vw = '', pen = false;
    bars.vwap.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      vw += `${pen ? 'L' : 'M'}${f1(sx(xs[i]))} ${f1(sy(v))}`;
      pen = true;
    });
    if (vw) s += `<path class="pc-vwap" d="${vw}"/>`;
    // the price line
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f1(sx(p[0]))} ${f1(sy(p[1]))}`).join('');
    s += `<path class="pc-line" d="${line}" pathLength="1"/>`;

    // trade marks
    const marks = [];
    const delay = (x) => `${(0.18 + 1.0 * ((x - L) / pw)).toFixed(2)}s`;
    let mk = '';
    for (const t of trades) {
      const win = (t.pnl ?? 0) >= 0;
      const hasOpen = inWin(t.openUtc) && t.openPrice > 0;
      const hasClose = !t.open && inWin(t.closeUtc) && t.closePrice > 0;
      const ox = hasOpen ? sx(Math.max(xa, t.openUtc)) : null, oy = hasOpen ? sy(t.openPrice) : null;
      const cx = hasClose ? sx(Math.min(xb, t.closeUtc)) : null, cy = hasClose ? sy(t.closePrice) : null;
      if (hasOpen && hasClose) mk += `<path class="pc-link ${win ? 'win' : 'loss'}" d="M${f1(ox)} ${f1(oy)}L${f1(cx)} ${f1(cy)}"/>`;
      else if (hasOpen && t.open && live) mk += `<path class="pc-link open" d="M${f1(ox)} ${f1(oy)}L${f1(sx(xb))} ${f1(sy(data.bid))}"/>`;
      if (hasOpen) {
        const buy = t.side === 'BUY';
        const d = buy ? `M${f1(ox)} ${f1(oy - 6.5)}l5.8 10.2h-11.6z` : `M${f1(ox)} ${f1(oy + 6.5)}l5.8 -10.2h-11.6z`;
        mk += `<path class="pc-mark ${buy ? 'buy' : 'sell'}" d="${d}" style="--d:${delay(ox)}"/>`;
        marks.push({ x: ox, y: oy, t });
      }
      if (hasClose) {
        mk += `<circle class="pc-ring ${win ? 'win' : 'loss'}" cx="${f1(cx)}" cy="${f1(cy)}" r="4.6" style="--d:${delay(cx)}"/>`;
        marks.push({ x: cx, y: cy, t });
      }
    }
    s += mk;
    // current price: dot, halo and the price tag on the right edge
    const lx = sx(pts[pts.length - 1][0]);
    s += `<g class="pc-nowg" style="--d:${delay(lx)}"><circle class="pc-halo" cx="${f1(lx)}" cy="${f1(ly)}" r="9"/><circle class="pc-now" cx="${f1(lx)}" cy="${f1(ly)}" r="3.6"/>`
      + `<rect class="pc-tag" x="${L + pw + 6}" y="${f1(ly - 11)}" width="${R - 8}" height="22" rx="6"/><text class="pc-tagt" x="${L + pw + 6 + (R - 8) / 2}" y="${f1(ly + 4.5)}" text-anchor="middle">${fmtNum(lastPrice)}</text></g>`;
    // crosshair (hover)
    s += `<g class="pc-cross" visibility="hidden"><path class="pc-crossl" d="M0 ${T}V${T + ph}"/><circle class="pc-crossd" r="3.4" cx="0" cy="0"/></g>`;

    const anim = animateNext && !reduced();
    animateNext = false;
    const aria = `ราคาทอง XAUUSD ช่วง ${Math.round((xb - xa) / HOUR)} ชั่วโมงล่าสุด ต่ำสุด ${fmtNum(lo)} สูงสุด ${fmtNum(hi)} ล่าสุด ${fmtNum(lastPrice)}${trades.length ? ` มีเทรดของ Dobby ${trades.length} ไม้บนกราฟ` : ''}`;
    plot.innerHTML = `<svg class="pc-svg${anim ? ' pc-anim' : ''}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}">${s}<rect class="pc-hit" x="${L}" y="0" width="${pw}" height="${H}"/></svg>`;
    geo = { xs, pts, sx, sy, marks, L, pw, T, ph, W, live, xb };
    const hit = plot.querySelector('.pc-hit');
    hit.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') point(e); });
    hit.addEventListener('pointerdown', (e) => { point(e); pinned = e.pointerType === 'touch'; });
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hideTip(); });
    // a live redraw (new price every few seconds) keeps the tooltip where the pointer is
    if (lastPt) point(lastPt); else tip.hidden = true;
  }

  function point(e) {
    if (!geo) return;
    lastPt = { clientX: e.clientX, clientY: e.clientY };
    const r = plot.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 18;
    for (const m of geo.marks) { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } }
    const cross = plot.querySelector('.pc-cross');
    if (best) {
      cross.setAttribute('visibility', 'hidden');
      showTip(tradeTip(best.t), best.x, best.y);
      return;
    }
    // nearest point on the line
    let bi = 0, bx = Infinity;
    geo.pts.forEach((p, i) => { const d = Math.abs(geo.sx(p[0]) - x); if (d < bx) { bx = d; bi = i; } });
    const p = geo.pts[bi];
    const px = geo.sx(p[0]), py = geo.sy(p[1]);
    cross.setAttribute('visibility', 'visible');
    cross.querySelector('.pc-crossl').setAttribute('d', `M${px.toFixed(1)} ${geo.T}V${geo.T + geo.ph}`);
    const dot = cross.querySelector('.pc-crossd');
    dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1));
    const isNow = geo.live && bi === geo.pts.length - 1;
    showTip([h('p', { class: 'pc-tip-sub' }, isNow ? 'ตอนนี้' : when(p[0])), h('p', { class: 'pc-tip-price num' }, fmtNum(p[1]))], px, py);
  }

  function showTip(kids, x, y) {
    tip.replaceChildren(...kids);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const W = geo ? geo.W : el.clientWidth;
    let left = x + 14;
    if (left + tw > W - 4) left = x - 14 - tw;
    let top = y - th - 12;
    if (top < 0) top = y + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${top}px`;
  }

  function tradeTip(t) {
    const buy = t.side === 'BUY';
    const kids = [h('p', { class: 'pc-tip-title' }, h('span', { class: `side ${buy ? 'buy' : 'sell'}` }, buy ? '▲ ซื้อ' : '▼ ขาย'), ` ${t.module || ''} `, h('span', { class: 'num' }, fmtNum(t.lots)), ' ล็อต')];
    if (t.openPrice > 0 && Number.isFinite(t.openUtc)) kids.push(h('p', null, `เปิด ${when(t.openUtc)} ที่ `, h('span', { class: 'num' }, fmtNum(t.openPrice))));
    if (t.open) kids.push(h('p', { class: 'pc-tip-sub' }, 'ไม้นี้ยังเปิดอยู่'));
    else {
      kids.push(h('p', null, `ปิด ${when(t.closeUtc)} ที่ `, h('span', { class: 'num' }, fmtNum(t.closePrice))));
      kids.push(h('p', { class: 'pc-tip-pnl' }, h('span', { class: `num pnl ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : 'zero'}` }, fmtSigned(t.pnl)),
        h('span', { class: 'pc-tip-sub' }, ` ${REASON_LABELS[t.reason] || t.reason || ''}`)));
    }
    return kids;
  }

  return el;
}
