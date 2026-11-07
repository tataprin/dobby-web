// The trade page chart (SPEC 9.1): the price line with VWAP from `bars` for [open - 3 h, close + 1 h], the entry mark,
// the initial SL and TP as dashed levels, each lock stage as a step of the SL line (with its time), and the exit ring.
// Same drawing language as the dashboard hero chart (pricechart.js): inline SVG at the container width, Thai time.
import { h, fmtNum, fmtSigned, fmtThai } from './util.js';
import { REASON_LABELS } from './journal.js';

const HOUR = 3600000;

function niceStep(span, count) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * mag >= raw) return k * mag;
  return 10 * mag;
}

// bars: {tf, t: [ms], c: [], vwap: []} | null; trade: from pairTrades (+ lockSteps); now: ms
export function tradeChart() {
  const plot = h('div', { class: 'pc-plot' });
  const tip = h('div', { class: 'pc-tip', role: 'status', hidden: true });
  const el = h('figure', { class: 'pchart tchart' }, plot, tip);
  let data = null, lastW = 0, geo = null;

  el.update = (d) => { data = d; draw(); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const w = Math.round(el.clientWidth); if (data && w && w !== lastW) draw(); }) : null;
  if (ro) ro.observe(el);
  el.destroy = () => { if (ro) ro.disconnect(); };

  function draw() {
    if (!data) return;
    const { bars, trade } = data;
    if (!bars || bars.t.length < 2) {
      lastW = Math.round(el.clientWidth);
      el.classList.add('is-empty');
      plot.innerHTML = '<svg class="pc-svg" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0 76 C 90 70, 150 52, 230 60 S 380 84, 460 58 S 560 40, 600 46" fill="none" class="pc-ghost"/></svg>';
      plot.append(h('p', { class: 'pc-empty-text' }, data.emptyText || 'ยังไม่มีข้อมูลราคาช่วงนี้'));
      return;
    }
    el.classList.remove('is-empty');
    const W = Math.max(280, Math.round(el.clientWidth || 640));
    lastW = W;
    const H = W < 560 ? 220 : 280;
    const xs = bars.t.map((t) => t + bars.tf);
    const pts = xs.map((x, i) => [x, bars.c[i]]);
    const openT = trade.openUtc, closeT = trade.open ? (data.now || Date.now()) : trade.closeUtc;
    const xa = Math.min(xs[0], Number.isFinite(openT) ? openT : xs[0]);
    const xb = Math.max(xs[xs.length - 1], Number.isFinite(closeT) ? closeT : xs[xs.length - 1]);
    let lo = Infinity, hi = -Infinity;
    const see = (p) => { if (Number.isFinite(p) && p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); } };
    pts.forEach((p) => see(p[1])); bars.vwap.forEach(see);
    [trade.openPrice, trade.sl, trade.tp, trade.closePrice].forEach(see);
    (trade.lockSteps || []).forEach((s) => see(s.sl));
    const span0 = Math.max(hi - lo, 2);
    const ya = lo - span0 * 0.1, yb = hi + span0 * 0.1;
    const narrow = W < 560;
    const L = 2, R = narrow ? 64 : 76, T = 18, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const sx = (t) => L + ((t - xa) / (xb - xa || 1)) * pw;
    const sy = (p) => T + (1 - (p - ya) / (yb - ya || 1)) * ph;
    const f1 = (x) => x.toFixed(1);
    let s = '';
    // grid + price labels
    const step = niceStep(yb - ya, narrow ? 4 : 5);
    for (let v = Math.ceil(ya / step) * step; v <= yb + 1e-9; v += step) {
      const y = sy(v);
      s += `<path class="pc-grid" d="M${L} ${f1(y)}H${L + pw}"/>`;
    }
    // time labels (Thai time): every 1, 2, 3 or 6 h depending on the span
    const spanH = (xb - xa) / HOUR;
    const every = (spanH <= 6 ? 1 : spanH <= 12 ? 2 : spanH <= 24 ? 3 : 6) * HOUR * (narrow && spanH > 4 ? 2 : 1);
    const tz = 7 * HOUR;
    for (let t = Math.ceil((xa + tz) / every) * every - tz; t <= xb; t += every) {
      const x = sx(t);
      if (x < L + 18 || x > L + pw - 18) continue;
      s += `<path class="pc-vtick" d="M${f1(x)} ${T + ph}v4"/><text class="pc-xlab" x="${f1(x)}" y="${H - 6}" text-anchor="middle">${fmtThai(t, 'time')}</text>`;
    }
    // the holding period, shaded
    if (Number.isFinite(openT)) s += `<rect class="tc-hold" x="${f1(sx(openT))}" y="${T}" width="${f1(Math.max(1, sx(closeT) - sx(openT)))}" height="${ph}"/>`;
    // VWAP + price
    let vw = '', pen = false;
    bars.vwap.forEach((v, i) => { if (v === null) { pen = false; return; } vw += `${pen ? 'L' : 'M'}${f1(sx(xs[i]))} ${f1(sy(v))}`; pen = true; });
    if (vw) s += `<path class="pc-vwap" d="${vw}"/>`;
    s += `<path class="pc-line" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${f1(sx(p[0]))} ${f1(sy(p[1]))}`).join('')}"/>`;
    // levels: TP (whole holding period), the SL line stepping up at each lock stage
    const labels = [];
    const x0 = Number.isFinite(openT) ? sx(openT) : L, x1 = sx(closeT);
    if (trade.tp > 0) { s += `<path class="tc-tp" d="M${f1(x0)} ${f1(sy(trade.tp))}H${f1(x1)}"/>`; labels.push({ y: sy(trade.tp), text: fmtNum(trade.tp), cls: 'tp' }); }
    if (trade.sl > 0) {
      const steps = (trade.lockSteps || []).filter((st) => st.utc >= openT && st.utc <= closeT).sort((a, b) => a.utc - b.utc);
      // the original SL (cinnabar, dashed) until the first lock stage, then the locked SL (gold) stepping up
      const firstX = steps.length ? sx(steps[0].utc) : x1;
      s += `<path class="tc-sl" d="M${f1(x0)} ${f1(sy(trade.sl))}H${f1(firstX)}"/>`;
      if (steps.length) {
        let d = `M${f1(firstX)} ${f1(sy(trade.sl))}`;
        steps.forEach((st, i) => { d += `V${f1(sy(st.sl))}H${f1(i + 1 < steps.length ? sx(steps[i + 1].utc) : x1)}`; });
        s += `<path class="tc-lock" d="${d}"/>`;
      }
      labels.push({ y: sy(trade.sl), text: fmtNum(trade.sl), cls: 'sl' });
      for (const st of steps) {
        s += `<circle class="tc-step" cx="${f1(sx(st.utc))}" cy="${f1(sy(st.sl))}" r="3.4"/>`;
        labels.push({ y: sy(st.sl), text: fmtNum(st.sl), cls: 'lock' });
      }
    }
    // entry + exit
    const marks = [];
    if (Number.isFinite(openT) && trade.openPrice > 0) {
      const ox = sx(openT), oy = sy(trade.openPrice), buy = trade.side === 'BUY';
      s += `<path class="tc-entry" d="M${f1(ox)} ${T}V${T + ph}"/>`;
      s += `<path class="pc-mark ${buy ? 'buy' : 'sell'}" d="${buy ? `M${f1(ox)} ${f1(oy - 7)}l6.2 11h-12.4z` : `M${f1(ox)} ${f1(oy + 7)}l6.2 -11h-12.4z`}"/>`;
      marks.push({ x: ox, y: oy, kind: 'open' });
      labels.push({ y: oy, text: fmtNum(trade.openPrice), cls: 'entry' });
    }
    if (!trade.open && Number.isFinite(trade.closeUtc) && trade.closePrice > 0) {
      const cx = sx(trade.closeUtc), cy = sy(trade.closePrice);
      s += `<circle class="pc-ring ${(trade.pnl ?? 0) >= 0 ? 'win' : 'loss'}" cx="${f1(cx)}" cy="${f1(cy)}" r="5"/>`;
      marks.push({ x: cx, y: cy, kind: 'close' });
    }
    // right-edge labels, pushed apart so they never overlap (16 px apart)
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 16) labels[i].y = labels[i - 1].y + 16;
    const over = labels.length ? labels[labels.length - 1].y - (T + ph) : 0;
    if (over > 0) labels.forEach((l) => { l.y -= over; });
    for (const l of labels) s += `<text class="tc-lab ${l.cls}" x="${W - 2}" y="${f1(l.y + 4)}" text-anchor="end">${l.text}</text>`;
    s += `<g class="pc-cross" visibility="hidden"><path class="pc-crossl" d="M0 ${T}V${T + ph}"/><circle class="pc-crossd" r="3.4" cx="0" cy="0"/></g>`;
    const aria = `ราคาทองช่วงที่ถือไม้ ${fmtThai(xa, 'short')} ถึง ${fmtThai(xb, 'short')} ราคาเข้า ${fmtNum(trade.openPrice)}${trade.open ? ' ยังเปิดอยู่' : ` ราคาออก ${fmtNum(trade.closePrice)} ${fmtSigned(trade.pnl)}`}`;
    plot.innerHTML = `<svg class="pc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}">${s}<rect class="pc-hit" x="${L}" y="0" width="${pw}" height="${H}"/></svg>`;
    geo = { pts, sx, sy, T, ph, W, marks };
    const hit = plot.querySelector('.pc-hit');
    hit.addEventListener('pointermove', point);
    hit.addEventListener('pointerdown', point);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; const c = plot.querySelector('.pc-cross'); if (c) c.setAttribute('visibility', 'hidden'); });
  }

  function point(e) {
    if (!geo) return;
    const r = plot.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const cross = plot.querySelector('.pc-cross');
    const t = data.trade;
    let best = null, bd = 16;
    for (const m of geo.marks) { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } }
    if (best) {
      cross.setAttribute('visibility', 'hidden');
      const kids = best.kind === 'open'
        ? [h('p', { class: 'pc-tip-sub' }, `เปิด ${fmtThai(t.openUtc, 'short')} น.`), h('p', { class: 'pc-tip-price num' }, fmtNum(t.openPrice))]
        : [h('p', { class: 'pc-tip-sub' }, `ปิด ${fmtThai(t.closeUtc, 'short')} น. ${REASON_LABELS[t.reason] || t.reason || ''}`), h('p', { class: 'pc-tip-price num' }, fmtNum(t.closePrice)),
          h('p', null, h('span', { class: `num pnl ${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : 'zero'}` }, fmtSigned(t.pnl)))];
      show(kids, best.x, best.y);
      return;
    }
    let bi = 0, bx = Infinity;
    geo.pts.forEach((p, i) => { const dd = Math.abs(geo.sx(p[0]) - x); if (dd < bx) { bx = dd; bi = i; } });
    const p = geo.pts[bi];
    const px = geo.sx(p[0]), py = geo.sy(p[1]);
    cross.setAttribute('visibility', 'visible');
    cross.querySelector('.pc-crossl').setAttribute('d', `M${px.toFixed(1)} ${geo.T}V${geo.T + geo.ph}`);
    const dot = cross.querySelector('.pc-crossd'); dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1));
    show([h('p', { class: 'pc-tip-sub' }, `${fmtThai(p[0], 'short')} น.`), h('p', { class: 'pc-tip-price num' }, fmtNum(p[1]))], px, py);
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
  return el;
}

// `bars` table rows -> chart bars
export function barsFromRows(rows) {
  const ok = (rows || []).map((r) => ({ t: Date.parse(r.t), c: Number(r.close), v: r.vwap === null || r.vwap === undefined ? NaN : Number(r.vwap) }))
    .filter((r) => Number.isFinite(r.t) && r.c > 0).sort((a, b) => a.t - b.t);
  return ok.length >= 2 ? { tf: 15 * 60000, t: ok.map((r) => r.t), c: ok.map((r) => r.c), vwap: ok.map((r) => (r.v > 0 ? r.v : null)) } : null;
}
