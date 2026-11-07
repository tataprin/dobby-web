// Numbers behind ประวัติ: strategy health against the tester baseline (SPEC 9.4), the risk panel and the week / month
// summary (SPEC 9.5), and cash flows (SPEC 9.2). Pure functions of journal trades, status and cash_flows rows.
import { statsOf } from './journal.js';
import { THAI_OFFSET_MIN } from './util.js';

const DAY = 86400000;

// ------------------------------------------------------------------ strategy health (SPEC 9.4)
// EA tester run 2026-07-15 .. 2026-10-22 (v3.04, 209 closed trades), per 0.01 lot.
export const BASELINE = {
  A_new: { trades: 37, winRate: 51.4, avgWin: 8.78, avgLoss: -6.00, pf: 1.54, perWeek: 2.64, expectancy: 1.59 },
  NY: { trades: 76, winRate: 60.5, avgWin: 7.88, avgLoss: -8.00, pf: 1.51, perWeek: 5.43, expectancy: 1.61 },
  C5G: { trades: 96, winRate: 47.9, avgWin: 10.68, avgLoss: -7.23, pf: 1.36, perWeek: 6.86, expectancy: 1.35 },
};
export const HEALTH_WINDOW = 20, HEALTH_MIN = 8;

// P(X <= k) for X ~ Binomial(n, p)
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let pr = (1 - p) ** n, sum = pr;
  for (let i = 1; i <= k; i++) { pr *= ((n - i + 1) / i) * (p / (1 - p)); sum += pr; }
  return Math.min(1, sum);
}

const per001 = (t) => (t.lots > 0 ? (t.pnl / t.lots) * 0.01 : t.pnl);

// status: 'ok' (ปกติ) | 'watch' (จับตา) | 'bad' (ผิดปกติ) | 'few' (ยังน้อยเกินไป) | 'none' (ไม่มีค่าทดสอบ)
export function strategyHealth(trades) {
  const closed = trades.filter((t) => !t.open && Number.isFinite(t.closeUtc)).sort((a, b) => a.closeUtc - b.closeUtc);
  const mods = [...new Set([...Object.keys(BASELINE), ...closed.map((t) => t.module)])];
  return mods.map((module) => {
    const base = BASELINE[module] || null;
    const all = closed.filter((t) => t.module === module);
    const last = all.slice(-HEALTH_WINDOW).map((t) => ({ ...t, pnl: per001(t) }));
    const s = statsOf(last);
    const n = s.trades;
    const out = { module, base, n, total: all.length, wins: s.wins, winRate: s.winRate, avgWin: s.avgWin, avgLoss: s.avgLoss, pf: s.profitFactor,
      expectancy: n ? s.net / n : null, net: s.net, p: null, status: 'few' };
    if (!base) { out.status = n ? 'none' : 'few'; return out; }
    if (n < HEALTH_MIN) return out;
    out.p = binomCdf(s.wins, n, base.winRate / 100);
    const pf = s.profitFactor === null ? 0 : s.profitFactor;
    if (out.p < 0.02 || pf < 0.7) out.status = 'bad';
    else if (out.p < 0.10 || pf < 1.0) out.status = 'watch';
    else out.status = 'ok';
    return out;
  });
}

export const HEALTH_LABEL = { ok: 'ปกติ', watch: 'จับตา', bad: 'ผิดปกติ', few: 'ยังน้อยเกินไป', none: 'ไม่มีค่าทดสอบ' };

// ------------------------------------------------------------------ risk (SPEC 9.5)
// trades: paired trades (ascending); st: status JSON. Drawdown from the peak of v_balance inside the trades given.
export function riskStats(trades, st) {
  const closed = trades.filter((t) => !t.open && Number.isFinite(t.closeUtc)).sort((a, b) => a.closeUtc - b.closeUtc);
  const v = (st && st.virtual) || {};
  const series = closed.filter((t) => Number.isFinite(t.vBalance)).map((t) => ({ utc: t.closeUtc, v: t.vBalance }));
  if (Number.isFinite(v.balance) && series.length) series.push({ utc: Date.now(), v: v.balance });
  let peak = -Infinity, peakAt = null, maxDd = 0, maxDdPct = 0, maxDdAt = null;
  for (const p of series) {
    if (p.v > peak) { peak = p.v; peakAt = p.utc; }
    const dd = peak - p.v;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; maxDdAt = p.utc; }
  }
  const last = series.length ? series[series.length - 1].v : null;
  const curDd = series.length ? Math.max(0, peak - last) : null;
  let cur = 0, longest = 0, run = 0;
  for (const t of closed) { if (t.pnl < 0) { run++; longest = Math.max(longest, run); } else run = 0; }
  for (let i = closed.length - 1; i >= 0 && closed[i].pnl < 0; i--) cur++;
  const capPct = (st && st.params && Number(st.params.daily_cap_pct)) || 10;
  const dayStart = Number(v.day_start) || 0, dayPnl = Number(v.day_pnl) || 0;
  const capAmt = (capPct / 100) * dayStart;
  const used = capAmt > 0 ? Math.max(0, Math.min(1, -dayPnl / capAmt)) : null;
  return {
    hasSeries: series.length > 0, peak: series.length ? peak : null, peakAt, current: last, curDd, curDdPct: curDd !== null && peak > 0 ? (curDd / peak) * 100 : null,
    maxDd, maxDdPct, maxDdAt, streak: cur, longestStreak: longest, trades: closed.length,
    budget: { capPct, capAmt, dayPnl, used, hit: !!v.day_cap_hit, known: !!st },
  };
}

// ------------------------------------------------------------------ periods (Thai calendar)
const thaiParts = (ms) => { const d = new Date(ms + THAI_OFFSET_MIN * 60000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: (d.getUTCDay() + 6) % 7 }; };
const thaiMidnight = (y, m, d) => Date.UTC(y, m, d) - THAI_OFFSET_MIN * 60000;

// kind 'week' (Monday..Sunday) | 'month'; offset 0 = this one, -1 = the previous one
export function periodBounds(kind, offset = 0, now = Date.now()) {
  const p = thaiParts(now);
  if (kind === 'month') {
    const from = thaiMidnight(p.y, p.m + offset, 1), to = thaiMidnight(p.y, p.m + offset + 1, 1);
    return { kind, offset, from, to };
  }
  const monday = thaiMidnight(p.y, p.m, p.d - p.dow) + offset * 7 * DAY;
  return { kind, offset, from: monday, to: monday + 7 * DAY };
}

// ------------------------------------------------------------------ cash flows (SPEC 9.2)
export const confirmedFlows = (flows) => (flows || []).filter((f) => f.status === 'confirmed' && Number.isFinite(Number(f.amount)));
export function flowTotals(flows) {
  const c = confirmedFlows(flows);
  const dep = c.filter((f) => Number(f.amount) > 0).reduce((s, f) => s + Number(f.amount), 0);
  const wd = c.filter((f) => Number(f.amount) < 0).reduce((s, f) => s + Number(f.amount), 0);
  return { deposits: dep, withdrawals: wd, net: dep + wd, count: c.length };
}

// Modified Dietz return: pnl / (capital at the start + time-weighted confirmed flows inside [from, to]).
export function dietz(pnl, startCapital, flows, from, to) {
  const end = Math.min(to, Date.now());
  const span = end - from;
  if (!(startCapital > 0) || !(span > 0)) return null;
  let w = 0;
  for (const f of confirmedFlows(flows)) {
    const t = Date.parse(f.ts);
    if (!(t >= from && t < end)) continue;
    w += Number(f.amount) * ((end - t) / span);
  }
  const base = startCapital + w;
  return base > 0 ? (pnl / base) * 100 : null;
}

// ตั้งแต่เริ่ม: the bot's own trading P&L (EA virtual: deposits and withdrawals never enter it, and a change of
// InpVirtualStart recomputes the EA's history), and its % against the capital with confirmed flows weighted by time.
export function sinceStart(st, flows, offsetMin = 0) {
  const v = (st && st.virtual) || {};
  if (!Number.isFinite(Number(v.balance)) || !Number.isFinite(Number(v.start))) return null;
  const pnl = Number(v.balance) - Number(v.start);
  const m = /^(\d{4})[.-](\d{2})[.-](\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v.start_date || ''));
  const from = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - offsetMin * 60000 : NaN;
  const hasFlows = confirmedFlows(flows).some((f) => !Number.isFinite(from) || Date.parse(f.ts) >= from);
  const pct = hasFlows && Number.isFinite(from) ? dietz(pnl, Number(v.start), flows, from, Date.now()) : (Number(v.start) > 0 ? (pnl / Number(v.start)) * 100 : null);
  return { pnl, pct, start: Number(v.start), weighted: hasFlows };
}

// One period of the summary. trades: all paired trades (ascending); rows: prepared journal rows (for the capital at
// the start); flows: cash_flows rows.
export function summarize(trades, rows, flows, from, to, fallbackCapital) {
  const inP = trades.filter((t) => !t.open && t.closeUtc >= from && t.closeUtc < to);
  const s = statsOf(inP);
  const mods = [...new Set(inP.map((t) => t.module))];
  const perModule = mods.map((m) => ({ module: m, ...statsOf(inP.filter((t) => t.module === m)) }));
  let startCapital = null;
  const before = rows.filter((r) => r.event === 'CLOSE' && Number.isFinite(r.v_balance) && r.utc < from);
  if (before.length) startCapital = before[before.length - 1].v_balance;
  else { const first = rows.find((r) => r.event === 'CLOSE' && Number.isFinite(r.v_balance) && r.utc >= from); if (first) startCapital = first.v_balance - (first.pnl || 0); }
  if (!(startCapital > 0)) startCapital = fallbackCapital || null;
  const pf = confirmedFlows(flows).filter((f) => { const t = Date.parse(f.ts); return t >= from && t < to; });
  const best = inP.length ? inP.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worst = inP.length ? inP.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  const risk = riskStats(inP, null);
  return {
    from, to, trades: inP, stats: s, perModule, best, worst, flows: pf, flowTotals: flowTotals(pf), startCapital,
    ret: startCapital ? dietz(s.net, startCapital, flows, from, to) : null, maxDd: risk.maxDd, longestStreak: risk.longestStreak,
  };
}
