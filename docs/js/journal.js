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
export function pairTrades(rows) {
  const open = {};
  const trades = [];
  for (const r of rows) {
    const mod = r.tag;
    if (r.event === 'OPEN') {
      if (open[mod]) trades.push({ ...open[mod], open: true, orphan: true });
      open[mod] = {
        module: mod, side: r.side, lots: r.lots, openUtc: r.utc, openWall: r.wall, openPrice: r.price, sl: r.sl, tp: r.tp,
        step: r.step, openDetail: r.detail, events: [], lockSteps: [], openTs: r.ts_server, key: tradeKeyOf(mod, r.ts_server),
      };
    } else if (r.event === 'CLOSE') {
      const t = open[mod];
      const base = t || { module: mod, side: r.side, lots: r.lots, openUtc: null, openWall: null, openPrice: null, sl: null, tp: null, step: r.step, events: [], lockSteps: [], key: '' };
      trades.push({
        ...base, open: false, closeUtc: r.utc, closeWall: r.wall, closePrice: r.price, pnl: r.pnl ?? 0, vBalance: r.v_balance,
        reason: closeReason(r.detail), closeDetail: r.detail, day: r.day,
      });
      open[mod] = null;
    } else if (open[mod] && LOCK_EVENTS.has(r.event)) {
      open[mod].events.push(r.event);
      if ((r.event === 'LOCK' || r.event === 'LOCK1') && r.sl > 0) open[mod].lockSteps.push({ event: r.event, utc: r.utc, sl: r.sl, detail: r.detail });
    }
  }
  for (const t of Object.values(open)) if (t) trades.push({ ...t, open: true });
  return trades.sort((a, b) => (a.openWall ?? a.closeWall) - (b.openWall ?? b.closeWall));
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
};
// trade_notes tags offered on the trade page (SPEC 9.6); any other tag can be typed
export const SUGGESTED_TAGS = ['ช่วงข่าว', 'ปิดเอง', 'เลื่อน SL เอง', 'ตลาดผันผวน'];
export const REASON_LABELS = { TP: 'ถึง TP', SL: 'โดน SL', LOCK: 'ล็อกกำไร', TIME: 'หมดเวลา', FLAT: 'ปิดสิ้นวัน', MANUAL: 'ปิดเอง' };
