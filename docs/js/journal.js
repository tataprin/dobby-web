// Journal analysis: rows -> paired trades, per-module stats, daily P&L, CSV.
import { parseWall, serverToUtc, wallString } from './util.js';

export const MODULES = ['A_new', 'NY', 'C5G', 'ASIA16'];
export const JOURNAL_HEADER = ['time_server', 'event', 'tag', 'side', 'lots', 'price', 'sl', 'tp', 'pnl', 'v_balance', 'step', 'detail'];
export const LOCK_EVENTS = new Set(['NEARTP', 'LOCK', 'NEAR1', 'LOCK1', 'SHADOWLOCK', 'SHADOWLOCK1']);

const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

// Normalised row: adds ms (server wall clock as epoch), utc (true UTC epoch).
export function prepareRows(rows, offsetMin) {
  return rows
    .map((r) => {
      const wall = parseWall(r.ts_server);
      return {
        ...r, wall, utc: serverToUtc(r.ts_server, offsetMin),
        lots: num(r.lots), price: num(r.price), sl: num(r.sl), tp: num(r.tp), pnl: num(r.pnl), v_balance: num(r.v_balance), step: num(r.step),
        day: Number.isFinite(wall) ? wallString(wall, '-').slice(0, 10) : '',
      };
    })
    .sort((a, b) => a.wall - b.wall || (a.id ?? 0) - (b.id ?? 0));
}

export function closeReason(detail) {
  const m = /reason=(\w+)/.exec(detail || '');
  return m ? m[1] : '';
}

// trade_key (SPEC 9.6): "<tag>|<open ts_server as YYYY-MM-DD HH:MM:SS>" of the trade's OPEN journal row.
export function tradeKeyOf(tag, tsServer) {
  const s = String(tsServer || '').replace('T', ' ').replace(/\./g, '-').slice(0, 19);
  return tag && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${tag}|${s}` : '';
}
export function parseTradeKey(key) {
  const i = String(key || '').indexOf('|');
  if (i < 1) return null;
  const tag = key.slice(0, i), ts = key.slice(i + 1);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? { tag, ts } : null;
}
export const tradeHref = (key) => `#/trade/${encodeURIComponent(key)}`;

// OPEN -> CLOSE per module, in time order. Rows must be sorted ascending. Each trade carries its trade_key and the SL
// steps of the lock stages (LOCK1 / LOCK rows: time and the new SL).
// NY never writes an OPEN row (2026-11-11): it places a pending stop order (ORDER) and the fill is not logged, so the
// trade starts at its last ORDER (key = that row: "NY|<ORDER time>", side / lots / SL / TP from it) once a lock row or
// the CLOSE shows the order filled; a CANCEL drops the order. Such a trade has viaOrder = true and openApprox = true:
// openUtc is the time the order was placed (the fill came later, before fillBy). The entry price is the position's
// own open price from its LOCK rows, else the one the CLOSE's P&L implies, else the order's level.
// openNow (optional): { <module>: { utc, price } } from the status' open positions: an order that filled and has no
// lock row yet becomes an open trade with the exact fill time and price.
const ORDER_MAX_MS = 12 * 3600e3; // a pending order older than this when the next row comes is not that trade's
// EA v3.05 runner (SPEC 11): the order's TP is only a safety TP, SafetyTP x d beyond the real first target TP0
// ("... d=8.00 ... (runner on: ..., safety TP +4.0 d)"). tp becomes TP0, safetyTp keeps the broker's.
export function withRunnerTp(t) {
  const s = String(t.openDetail || '');
  const m = /runner on:[^)]*safety TP \+([\d.]+)\s*d/i.exec(s), d = /\bd=([\d.]+)/.exec(s);
  if (!m || !d || !(t.tp > 0)) return t;
  const side = t.side === 'BUY' ? 1 : -1;
  return { ...t, safetyTp: t.tp, tp: Math.round((t.tp - side * Number(m[1]) * Number(d[1])) * 100) / 100 };
}
export function pairTrades(rows, { openNow = null } = {}) {
  const open = {};
  const pending = {};
  const trades = [];
  const fromOrder = (mod, o, r) => withRunnerTp({
    module: mod, side: o.side, lots: o.lots, openUtc: o.utc, openWall: o.wall, openPrice: o.price, sl: o.sl, tp: o.tp,
    step: o.step, openDetail: o.detail, events: [], lockSteps: [], openTs: o.ts_server, key: tradeKeyOf(mod, o.ts_server),
    viaOrder: true, openApprox: true, orderPrice: o.price, fillBy: r ? r.utc : null,
  });
  const takeOrder = (mod, r) => {
    const o = pending[mod];
    pending[mod] = null;
    return o && (!r || r.utc - o.utc <= ORDER_MAX_MS) ? fromOrder(mod, o, r) : null;
  };
  for (const r of rows) {
    const mod = r.tag;
    if (r.event === 'ORDER') {
      if (!open[mod]) pending[mod] = r;
    } else if (r.event === 'CANCEL') {
      pending[mod] = null;
    } else if (r.event === 'OPEN') {
      pending[mod] = null;
      if (open[mod]) trades.push({ ...open[mod], open: true, orphan: true });
      open[mod] = withRunnerTp({
        module: mod, side: r.side, lots: r.lots, openUtc: r.utc, openWall: r.wall, openPrice: r.price, sl: r.sl, tp: r.tp,
        step: r.step, openDetail: r.detail, events: [], lockSteps: [], openTs: r.ts_server, key: tradeKeyOf(mod, r.ts_server),
      });
    } else if (r.event === 'CLOSE') {
      const t = open[mod] || takeOrder(mod, r);
      const base = t || { module: mod, side: r.side, lots: r.lots, openUtc: null, openWall: null, openPrice: null, sl: null, tp: null, step: r.step, events: [], lockSteps: [], key: '' };
      const done = {
        ...base, open: false, closeUtc: r.utc, closeWall: r.wall, closePrice: r.price, pnl: r.pnl ?? 0, vBalance: r.v_balance,
        reason: closeReason(r.detail), closeDetail: r.detail, day: r.day,
      };
      // a filled stop order without a lock row: the entry the P&L implies (XAUUSD: 100 oz a lot), close to the real fill
      if (done.viaOrder && !done.entryKnown && done.lots > 0 && r.price > 0 && Number.isFinite(r.pnl)) {
        const dist = r.pnl / (100 * done.lots);
        done.openPrice = Math.round((done.side === 'BUY' ? r.price - dist : r.price + dist) * 100) / 100;
      }
      trades.push(done);
      open[mod] = null;
      pending[mod] = null;
    } else if (LOCK_EVENTS.has(r.event)) {
      if (!open[mod] && pending[mod]) open[mod] = takeOrder(mod, r);
      if (!open[mod]) continue;
      open[mod].events.push(r.event);
      if ((r.event === 'LOCK' || r.event === 'LOCK1') && r.sl > 0) open[mod].lockSteps.push({ event: r.event, utc: r.utc, sl: r.sl, detail: r.detail });
      // a LOCK row's price is the position's open price: the real entry of a filled stop order
      if (open[mod].viaOrder && (r.event === 'LOCK' || r.event === 'LOCK1') && r.price > 0) { open[mod].openPrice = r.price; open[mod].entryKnown = true; }
    }
  }
  for (const [mod, o] of Object.entries(pending)) {
    if (o && !open[mod] && openNow && openNow[mod]) open[mod] = fromOrder(mod, o, null);
  }
  for (const [mod, t] of Object.entries(open)) {
    if (!t) continue;
    const now = openNow && openNow[mod];
    if (t.viaOrder && now) {
      if (Number.isFinite(now.utc) && now.utc >= t.openUtc) { t.openUtc = now.utc; t.openApprox = false; }
      if (now.price > 0) { t.openPrice = now.price; t.entryKnown = true; }
    }
    trades.push({ ...t, open: true });
  }
  return trades.sort((a, b) => (a.openWall ?? a.closeWall) - (b.openWall ?? b.closeWall));
}

// A filled stop order (viaOrder, fill not logged): the moment the drawn close series (ts = close times, cs = closes)
// first goes through the order level between the order and fillBy, linear between two closes. A wick filled it when
// the closes never get there: then the close nearest the level in that span. null without a close in the span.
// placeFills: the trades with that estimate as openUtc (fillEstimated = true).
export function fillFromBars(t, ts, cs) {
  if (!t || !t.viaOrder || !t.openApprox || !(t.orderPrice > 0) || !ts || ts.length < 2) return null;
  const a = t.openUtc, b = Number.isFinite(t.fillBy) ? t.fillBy : t.open ? Infinity : t.closeUtc;
  if (!Number.isFinite(a)) return null;
  const L = t.orderPrice, past = (p) => (t.side === 'SELL' ? p <= L : p >= L);
  for (let i = 1; i < ts.length; i++) {
    const t0 = ts[i - 1], t1 = ts[i], p0 = cs[i - 1], p1 = cs[i];
    if (t1 <= a || t0 > b || !Number.isFinite(p0) || !Number.isFinite(p1)) continue;
    if (!past(p0) && past(p1)) return Math.min(b, Math.max(a, t0 + ((t1 - t0) * (L - p0)) / (p1 - p0)));
  }
  let best = null, gap = Infinity;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] <= a || ts[i] > b || !Number.isFinite(cs[i])) continue;
    const g = Math.abs(cs[i] - L);
    if (g < gap) { gap = g; best = ts[i]; }
  }
  return best;
}
export function placeFills(trades, ts, cs) {
  return (trades || []).map((t) => {
    const est = fillFromBars(t, ts, cs);
    return est === null ? t : { ...t, openUtc: est, fillEstimated: true };
  });
}

// openNow for pairTrades from a status: the open positions' fill time (server time -> UTC) and price per module
export function openNowOf(st, offsetMin) {
  const out = {};
  for (const p of (st && st.positions) || []) {
    if (!p || !p.open || !p.module) continue;
    const m = /^(\d{4})[.-](\d{2})[.-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(p.open_time || ''));
    const utc = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - (offsetMin || 0) * 60000 : NaN;
    out[p.module] = { utc, price: Number(p.open_price) };
  }
  return out;
}

export function statsOf(trades) {
  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
  const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
  const gw = sum(wins), gl = -sum(losses);
  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    net: sum(closed),
    avgWin: wins.length ? gw / wins.length : null,
    avgLoss: losses.length ? -gl / losses.length : null,
    profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
    best: closed.length ? Math.max(...closed.map((t) => t.pnl)) : null,
    worst: closed.length ? Math.min(...closed.map((t) => t.pnl)) : null,
  };
}

export function moduleStats(trades) {
  const mods = [...new Set([...MODULES.filter((m) => trades.some((t) => t.module === m)), ...trades.map((t) => t.module)])];
  return {
    rows: mods.map((m) => ({ module: m, ...statsOf(trades.filter((t) => t.module === m)) })),
    total: statsOf(trades),
  };
}

// Server day -> {pnl, trades}. The EA's daily cap uses the server day, so the calendar does too.
export function dailyPnl(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.event !== 'CLOSE') continue;
    const d = map.get(r.day) || { pnl: 0, trades: 0, wins: 0 };
    d.pnl += r.pnl || 0;
    d.trades += 1;
    if ((r.pnl || 0) > 0) d.wins += 1;
    map.set(r.day, d);
  }
  return map;
}

// v_balance on one footing. The EA recomputes its virtual balance whenever InpVirtualStart changes (a deposit
// adjustment, a new round's capital), so rows logged before the change sit on another footing and a chart or a
// drawdown across them would jump. Walk back from the newest close, subtracting each later trade's P&L. The anchor is
// the status' virtual balance when the status is not older than that close, else that close's own v_balance.
// Prepared rows (ascending) in, a new array out; the journal table keeps showing the raw values.
export function rebaseBalances(rows, st) {
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].event === 'CLOSE') { last = i; break; }
  if (last < 0) return rows;
  const v = st && st.virtual;
  const hb = st && Number.isFinite(st.heartbeat_gmt_unix) ? st.heartbeat_gmt_unix * 1000 : -Infinity;
  const sv = v && v.balance !== null && v.balance !== undefined ? Number(v.balance) : NaN;
  let bal = Number.isFinite(sv) && hb >= rows[last].utc ? sv : rows[last].v_balance;
  if (!Number.isFinite(bal)) return rows;
  const out = rows.slice();
  for (let i = last; i >= 0; i--) {
    const r = out[i];
    if (r.event !== 'CLOSE') continue;
    const at = Math.round(bal * 100) / 100;
    if (r.v_balance !== at) out[i] = { ...r, v_balance: at };
    bal -= r.pnl || 0;
  }
  return out;
}

export function equitySeries(rows) {
  return rows.filter((r) => r.event === 'CLOSE' && r.v_balance !== null).map((r) => ({ utc: r.utc, wall: r.wall, v: r.v_balance, pnl: r.pnl, tag: r.tag }));
}

export function journalCsvRows(rows) {
  return rows.map((r) => [
    typeof r.ts_server === 'string' ? r.ts_server.replace('T', ' ').replace(/-/g, '.') : r.ts_server,
    r.event, r.tag, r.side, r.lots, r.price, r.sl, r.tp, r.pnl, r.v_balance, r.step, r.detail,
  ]);
}

export const EVENT_LABELS = {
  OPEN: 'เปิดไม้', CLOSE: 'ปิดไม้', LOCK: 'ล็อกกำไร', LOCK1: 'ล็อกขั้น 1', NEARTP: 'ใกล้ TP', NEAR1: 'ใกล้ขั้น 1',
  SHADOWLOCK: 'ล็อกเงา', SHADOWLOCK1: 'ล็อกเงาขั้น 1', START: 'เริ่มทำงาน', STOP: 'หยุดทำงาน', CONTROL: 'รับคำสั่ง',
  SIGNAL: 'สัญญาณ', ORDER: 'ตั้งคำสั่ง', ARM: 'ตั้งกรอบ NY', CANCEL: 'ยกเลิกคำสั่ง', SKIP: 'ข้าม', ERROR: 'ข้อผิดพลาด',
  DAYCAP: 'ถึงจุดหยุดรายวัน', LOCKED: 'ล็อกการเทรดจริง', UNLOCKED: 'ปลดล็อกเทรดจริง',
  // EA v3.05 (SPEC 11): runner stage and the daily-cap reset
  RUN_ON: 'runner เริ่มวิ่ง', RUN_UP: 'runner ขยับขึ้น', DAYCAP_RESET: 'รีเซ็ตจุดหยุดรายวัน', WARN: 'คำเตือน',
};
// trade_notes tags offered on the trade page (SPEC 9.6); any other tag can be typed
export const SUGGESTED_TAGS = ['ช่วงข่าว', 'ปิดเอง', 'เลื่อน SL เอง', 'ตลาดผันผวน'];
export const REASON_LABELS = { TP: 'ถึง TP', SL: 'โดน SL', LOCK: 'ล็อกกำไร', TIME: 'หมดเวลา', FLAT: 'ปิดสิ้นวัน', MANUAL: 'ปิดเอง', RUN: 'runner ปิดที่ SL กันกำไร' };
