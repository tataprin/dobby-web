// Counting rounds (รอบ, SPEC 9.8). Only the website splits the history: the bot never reads a round. A round runs from
// its start to the next round's start; round 1 (the row with started_at null) from the very beginning. A trade belongs
// to the round in which it CLOSED. Numbers come from the journal (P&L per trade), so they stay right when the EA
// recomputes its virtual balance after an InpVirtualStart change.
import { statsOf } from './journal.js';
import { riskStats, dietz } from './analytics.js';

// rows: the rounds table rows of one bot (any order). [] while no new round was ever started (= one round, no split).
export function roundsOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const starts = list.filter((r) => r.started_at && Number.isFinite(Date.parse(r.started_at)))
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  if (!starts.length) return [];
  const first = list.find((r) => !r.started_at) || null;
  const all = [
    { id: first ? first.id : null, name: first ? first.name || '' : '', from: -Infinity, base: (first && first.base) || {}, startedAt: null },
    ...starts.map((r) => ({ id: r.id, name: r.name || '', from: Date.parse(r.started_at), base: r.base || {}, startedAt: r.started_at })),
  ];
  return all.map((r, i) => ({ ...r, n: i + 1, to: i + 1 < all.length ? all[i + 1].from : Infinity, current: i === all.length - 1 }));
}

export const currentRound = (rounds) => (rounds.length ? rounds[rounds.length - 1] : null);
export const roundTitle = (r) => `รอบที่ ${r.n}`;
export const roundLabel = (r) => `รอบที่ ${r.n}${r.name ? ` ${r.name}` : ''}`;
export const inRound = (r, utc) => Number.isFinite(utc) && utc >= r.from && utc < r.to;

// One round from paired trades (ascending; rebased v_balance for the drawdown) and confirmed cash flows.
// firstUtc: when round 1 began (the EA's start date or the first journal row), for its dates and its %.
export function roundSummary(r, trades, flows, firstUtc) {
  const inR = trades.filter((t) => !t.open && inRound(r, t.closeUtc));
  const s = statsOf(inR);
  const risk = riskStats(inR, null);
  const from = Number.isFinite(r.from) ? r.from : firstUtc;
  const startCap = Number(r.base && r.base.balance) > 0 ? Number(r.base.balance) : null;
  const end = Number.isFinite(r.to) ? r.to : Date.now();
  return {
    round: r, trades: inR, stats: s, net: s.net, maxDd: risk.maxDd, from, to: r.to, startCap,
    pct: startCap && Number.isFinite(from) ? dietz(s.net, startCap, flows, from, end) : null,
  };
}

// The bot's capital against the real account. EA v3.04: virtual = InpVirtualStart + the bot's own P&L since the EA's
// start date. To count exactly the account balance, InpVirtualStart = balance - that P&L (lots do not depend on it).
export function capitalFix(st) {
  const a = (st && st.account) || {}, v = (st && st.virtual) || {};
  const balance = Number(a.balance), virtual = Number(v.balance), start = Number(v.start);
  if (![balance, virtual, start].every(Number.isFinite) || a.balance === null || v.balance === null || v.start === null) return null;
  const botPnl = Math.round((virtual - start) * 100) / 100;
  const next = Math.round((balance - botPnl) * 100) / 100;
  const diff = Math.round((virtual - balance) * 100) / 100;
  return { balance, virtual, start, botPnl, next, diff, startDate: v.start_date || '', needed: Math.abs(diff) >= 1, possible: next >= 10 };
}

// What the bot counts as its capital for a given InpVirtualStart (the settings page), with the live status' P&L.
export function countedCapital(start, st) {
  const v = (st && st.virtual) || {};
  const pnl = Number(v.balance) - Number(v.start);
  return Number.isFinite(pnl) ? Number(start) + pnl : Number(start);
}
export function botPnlOf(st) {
  const v = (st && st.virtual) || {};
  const pnl = Number(v.balance) - Number(v.start);
  return Number.isFinite(pnl) && v.balance !== null && v.start !== null ? Math.round(pnl * 100) / 100 : 0;
}

// The status' snapshot kept on a new round (for the % and for the AI); never read by the bot.
export function roundBase(st) {
  const a = (st && st.account) || {}, v = (st && st.virtual) || {};
  const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
  return {
    balance: num(a.balance), equity: num(a.equity), currency: a.currency || null,
    v_balance: num(v.balance), v_start: num(v.start), ea_start: v.start_date || null, trades: num(v.trades), wins: num(v.wins),
  };
}

// EA start date "YYYY.MM.DD HH:MM[:SS]" (server time) -> UTC ms
export function eaStartUtc(st, offsetMin = 0) {
  const m = /^(\d{4})[.-](\d{2})[.-](\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String((st && st.virtual && st.virtual.start_date) || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - offsetMin * 60000 : NaN;
}
