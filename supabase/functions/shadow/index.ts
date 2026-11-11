// Dobby Web - Supabase Edge Function "shadow" (SPEC 10.6): the shadow AI forward test.
//
// While a bot trade is open, the Dobby app on the member's PC posts a snapshot of it here every few minutes. Claude
// answers what it would do with the trade right now (hold / close / tighten the stop / reverse) and the answer is
// stored in shadow_decisions. NOTHING is sent to the EA: this is a log for a forward test of "would an AI that watches
// every open trade beat the fixed rules?" (scored offline against the real trades).
//
// Deploy once: Supabase Dashboard -> Edge Functions -> Deploy a new function -> Via Editor, name it  shadow , paste
// this WHOLE file, deploy, then turn "Verify JWT" OFF (the function checks the user's token itself, like `chat`).
// Uses the same secret as `chat`: ANTHROPIC_API_KEY. Provided by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEYS). The service key reaches only the RPCs shadow_start and
// shadow_record; the bot is read with the user's own token (RLS).
//
// Request:  POST {bot_id, snapshot}   (snapshot.position.ticket identifies the trade)
// Response: 200 {ok, id, decision: {action, new_sl, confidence, reason, details}, valid, next_after_s, memory_rev}
//           or {error, message} with 400 / 401 / 403 / 404 / 429 / 500 / 503.
// SPEC 10.7 memory: the decision reads the bot's lessons and may call data tools (indicators, price history, trade
// history, its own record) for up to 5 rounds. POST {mode: "review", bot_id, ticket, close, bars_m15} after the trade
// closed: the AI reviews its decisions against the real result and updates its lessons (shadow_review_record).
//
// Tests: supabase/functions/shadow/test (node --test, fake fetch and a fake Anthropic client).

import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

// deno-lint-ignore no-explicit-any
type Json = any;
type EnvSource = ((key: string) => string | undefined) | Record<string, string | undefined>;
export interface ShadowDeps {
  env: EnvSource;
  fetch?: typeof fetch;
  anthropic?: (apiKey: string) => Anthropic;
  now?: () => number;
}

export const MAX_BODY_CHARS = 64_000;
export const MAX_TOKENS = 1600;
const CALL_TIMEOUT_MS = 60_000;
export const ACTIONS = ["hold", "close", "tighten", "reverse"] as const;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// USD per million tokens: input, output, cache read, cache write (same table as `chat`)
export const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.20, 5],
  "claude-sonnet-5-5": [2, 10, 0.20, 2.50],
  "claude-haiku-5-5": [0.10, 0.50, 0.01, 0.125],
};
const PRICE_UNKNOWN: [number, number, number, number] = [5, 25, 0.50, 6.25];

export const ERRORS: Record<string, [number, string]> = {
  bad_request: [400, "คำขอไม่ถูกต้อง"],
  not_authenticated: [401, "กรุณาเข้าสู่ระบบอีกครั้ง"],
  not_approved: [403, "บัญชียังไม่ได้รับอนุมัติ หรือถูกปิดการใช้งาน"],
  shadow_disabled: [403, "ผู้ดูแลยังไม่ได้เปิด AI เงา"],
  shadow_admin_only: [403, "AI เงาใช้ได้เฉพาะผู้ดูแล"],
  ai_trader_disabled: [403, "ผู้ดูแลยังไม่ได้เปิดให้ AI เทรดเอง"],
  ai_trade_open: [409, "AI มีไม้ของตัวเองเปิดอยู่แล้ว"],
  ai_trade_not_found: [404, "ไม่พบไม้ของ AI"],
  bot_not_found: [404, "ไม่พบบอทนี้ในบัญชีของคุณ"],
  method_not_allowed: [405, "ใช้ได้เฉพาะ POST"],
  shadow_too_soon: [429, "ถามเรื่องไม้นี้ไปแล้วเมื่อสักครู่"],
  shadow_budget: [429, "งบ AI เงาของเดือนนี้หมดแล้ว"],
  review_done: [409, "ทบทวนไม้นี้ไปแล้ว"],
  review_nothing: [404, "AI เงาไม่ได้ดูไม้นี้"],
  internal: [500, "เกิดข้อผิดพลาด"],
  ai_not_configured: [503, "ยังไม่ได้ตั้งค่า AI ใน Supabase"],
};
const RPC_CODES = ["not_approved", "bot_not_found", "shadow_disabled", "shadow_budget", "shadow_too_soon", "review_done", "review_nothing",
  "ai_trader_disabled", "ai_trade_open", "ai_trade_not_found", "shadow_admin_only"];

// ------------------------------------------------------------------ prompt
export const SYSTEM_PROMPT = `You are the shadow AI of Dobby, a MetaTrader 5 robot that trades gold (XAUUSD) on M15 with fixed rules. A Dobby trade is open right now. Decide what YOU would do with it at this moment. Your answer is only logged for a forward test that compares your decisions with the fixed rules; it is never executed, so be honest and calibrated, not cautious for show.

How the open trade is managed by the fixed rules (all prices in USD per ounce):
- d = the stop distance in $ ("d" in the order comment, e.g. "D3 C5 d5.70 t8.55"); tpd = the target distance ("t"). TP0 = entry + tpd for a BUY, entry - tpd for a SELL. That is the REAL target. The broker TP shown in the snapshot is only a disconnect safety (TP0 + 4 d) because the runner is on.
- Stage-1 lock: when the gain reaches 85 % of tpd, the stop moves to entry + 83 % of tpd. Stage-2 lock: at 95 % the stop moves to 93 %.
- Runner: when price touches TP0 the trade is not closed; the stop goes to entry + 85 % of tpd and ratchets 0.5 d further each time price gains another 0.5 d.
- Time stop 48 M15 bars for A_new and C5G; NY trades are closed at 23:00 server time. Daily loss cap 10 % of the day's start balance.
- Strategies: A_new = RSI divergence with the H4 EMA50 trend; NY = breakout of the first M15 bar after the New York open; C5G = VWAP touch with an RSI hook.
- Historical tests on 2026 data found that closing early on pullbacks, trailing stops and stop-and-reverse rules all LOST money against these fixed rules, because most pullbacks are noise and the trade still reaches TP0. Only deviate from "hold" when the snapshot gives you a concrete reason (for example a scheduled high-impact USD release in the next minutes, a structural break against the trade, or momentum that has clearly failed).

Your options, and the exact prices you MUST give with each (2 decimals, real prices, not distances):
- hold: leave the trade to the fixed rules. Give hold_target = the price you expect this trade to reach (usually TP0, or further when you expect the runner to carry it) and hold_exit = the price at which you would stop holding and close it (between the current stop and the current price). Both on the correct sides of the current price.
- close: close the whole trade now at market (bid for a BUY, ask for a SELL). No extra prices.
- tighten: move the stop to new_sl, strictly between the current stop and the current price; never widen the stop.
- reverse: close now and open the opposite trade with the same lots. Give reverse_sl and reverse_tp for the new trade: for a new SELL (entered at the bid) the stop above and the target below; for a new BUY (entered at the ask) the stop below and the target above. Size them from the chart (recent swing, ATR); a stop tighter than 0.5 x ATR is noise.
Set every field that does not belong to your action to null. The system turns your prices into money at this trade's lots (1.00 $ of price = lots x 100 USD).

Data: the snapshot has the trade, the market, 32 M15 bars with the EA's RSI / ATR / H4 EMA / VWAP, the news and the journal. When you need more (another timeframe, EMA / MACD / Bollinger / swings / levels, the bot's recent results, your own past reviews), call get_indicators, get_price_history, get_trade_history or get_my_record first (a few calls at most), then decide.

Finish by calling the tool decide. confidence = how sure you are that your action beats "hold" for this trade (0-100; use 50 or less when it is a coin flip). reason: 2 to 4 short sentences in Thai that name the facts from the snapshot behind the decision AND the plan with its prices (for hold: where you expect it to go and where you would get out; for close: why now; for tighten: why that stop level; for reverse: why the other way and why that stop and target).`;

export const DECIDE_TOOL = {
  name: "decide",
  description: "Record your decision for the open Dobby trade, with the exact prices of the plan.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      new_sl: { type: ["number", "null"], description: "tighten only: the new stop price. Otherwise null." },
      reverse_sl: { type: ["number", "null"], description: "reverse only: the stop price of the new opposite trade. Otherwise null." },
      reverse_tp: { type: ["number", "null"], description: "reverse only: the target price of the new opposite trade. Otherwise null." },
      hold_target: { type: ["number", "null"], description: "hold only: the price you expect the trade to reach. Otherwise null." },
      hold_exit: { type: ["number", "null"], description: "hold only: the price at which you would close instead of holding. Otherwise null." },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string", description: "2 to 4 short sentences in Thai: the facts and the plan with its prices." },
    },
    required: ["action", "new_sl", "reverse_sl", "reverse_tp", "hold_target", "hold_exit", "confidence", "reason"],
    additionalProperties: false,
  },
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clip = (s: unknown, n: number) => Array.from(String(s ?? "")).slice(0, n).join("");

/** The position fields we need; null when the snapshot is unusable. */
export function readPosition(snapshot: Json): Json | null {
  const p = snapshot && typeof snapshot === "object" ? snapshot.position : null;
  if (!p || typeof p !== "object") return null;
  const ticket = num(p.ticket);
  const side = p.side === "BUY" || p.side === "SELL" ? p.side : null;
  const module = typeof p.module === "string" && /^[A-Za-z0-9_]{1,24}$/.test(p.module) ? p.module : null;
  if (!ticket || ticket <= 0 || !Number.isInteger(ticket) || !side || !module) return null;
  const m = snapshot.market && typeof snapshot.market === "object" ? snapshot.market : {};
  return {
    ticket, side, module, lots: num(p.lots), open_price: num(p.open_price), sl: num(p.sl), tp: num(p.tp),
    profit: num(p.profit), bid: num(m.bid), ask: num(m.ask),
    server_time: typeof snapshot.server_time === "string" ? clip(snapshot.server_time, 24) : null,
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const px2 = (v: unknown) => { const n = num(v); return n === null ? null : r2(n); };

export interface Decision {
  action: string; new_sl: number | null; confidence: number | null; reason: string; valid: boolean; details: Json;
}

/** Normalises the tool input and turns the AI's prices into money at this trade's lots (`details`, SPEC 10.6).
 *  `valid` is false when the action cannot be applied as given (a stop or target on the wrong side, a missing price). */
export function checkDecision(input: Json, pos: Json): Decision {
  const action = ACTIONS.includes(input?.action) ? input.action : "hold";
  let valid = ACTIONS.includes(input?.action);
  const buy = pos.side === "BUY";
  const px = buy ? pos.bid : pos.ask;                       // where this trade closes now
  const mult = (pos.lots || 0) * 100;                       // USD per 1.00 $ of price
  const pnlAt = (p: number) => r2((buy ? p - pos.open_price : pos.open_price - p) * mult);
  const ok = px !== null && pos.open_price !== null && mult > 0;
  const details: Json = {};
  if (ok) { details.price_now = px; details.pnl_now = pnlAt(px); }
  let newSl: number | null = null;
  if (action === "tighten") {
    newSl = px2(input?.new_sl);
    if (newSl === null || px === null) valid = false;
    else if (buy) valid = valid && newSl < px && (pos.sl === null || pos.sl <= 0 || newSl > pos.sl);
    else valid = valid && newSl > px && (pos.sl === null || pos.sl <= 0 || newSl < pos.sl);
    if (ok && newSl !== null) { details.new_sl = newSl; details.locked_pnl = pnlAt(newSl); details.old_sl = pos.sl; }
  } else if (action === "close") {
    if (ok) { details.close_price = px; details.close_pnl = pnlAt(px); }
    else valid = false;
  } else if (action === "reverse") {
    const sl = px2(input?.reverse_sl), tp = px2(input?.reverse_tp);
    const side = buy ? "SELL" : "BUY";
    const entry = side === "SELL" ? pos.bid : pos.ask;        // the new trade's own fill
    if (!ok || entry === null || sl === null || tp === null) valid = false;
    else {
      const sides = side === "SELL" ? sl > entry && tp < entry : sl < entry && tp > entry;
      valid = valid && sides;
      const risk = r2(Math.abs(entry - sl) * mult), reward = r2(Math.abs(tp - entry) * mult);
      details.close_price = px;
      details.close_pnl = pnlAt(px);
      details.reverse = { side, lots: pos.lots, entry, sl, tp, risk: -risk, reward, sl_dist: r2(Math.abs(entry - sl)), tp_dist: r2(Math.abs(tp - entry)) };
      details.total_if_tp = r2(details.close_pnl + reward);
      details.total_if_sl = r2(details.close_pnl - risk);
    }
  } else if (ok) {                                           // hold: where it should go, where the AI would get out
    const target = px2(input?.hold_target), exit = px2(input?.hold_exit);
    if (target !== null && (buy ? target > px : target < px)) { details.hold_target = target; details.target_pnl = pnlAt(target); }
    if (exit !== null && (buy ? exit < px : exit > px)) { details.hold_exit = exit; details.exit_pnl = pnlAt(exit); }
  }
  const c = num(input?.confidence);
  return { action, new_sl: newSl, confidence: c === null ? null : Math.max(0, Math.min(100, Math.round(c))), reason: clip(input?.reason, 1200).trim(), valid, details };
}

export function costOf(model: string, u: Json): number {
  const [pi, po, pr, pw] = PRICES[model] || PRICE_UNKNOWN;
  const c = ((u?.input_tokens || 0) * pi + (u?.output_tokens || 0) * po + (u?.cache_read_input_tokens || 0) * pr +
    (u?.cache_creation_input_tokens || 0) * pw) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

export function userMessage(snapshot: Json): string {
  return `Snapshot of the open trade and the market (JSON; times: *_utc = UTC, server_time = broker server time):\n${JSON.stringify(snapshot)}`;
}

// ------------------------------------------------------------------ memory (SPEC 10.7)
export const MAX_LESSONS = 20;
export const MAX_ROUNDS = 5;              // data-tool rounds before the decision is forced
const RECENT_REVIEWS = 6;

/** Verdict counts per action from the reviews' outcome.checks (the AI's own track record). */
export function recordStats(reviews: Json[]): Json {
  const out: Json = {};
  for (const r of reviews || []) {
    for (const c of (r?.outcome?.checks || [])) {
      const a = String(c.action || "");
      if (!a) continue;
      const s = out[a] || (out[a] = { decisions: 0, better: 0, worse: 0, same: 0, sum_delta: 0 });
      s.decisions += 1;
      if (c.verdict === "better") s.better += 1; else if (c.verdict === "worse") s.worse += 1; else s.same += 1;
      s.sum_delta = r2(s.sum_delta + (Number(c.delta) || 0));
    }
  }
  return out;
}

/** The memory block of the system prompt: lessons, track record, the last reviews. */
export function memoryPrompt(lessons: Json[], reviews: Json[], totalReviews: number): string {
  if (!lessons.length && !reviews.length) {
    return "\n\nYour memory is empty: this bot has no reviewed trade yet. After every closed trade you will review your own decisions against what really happened and write lessons that you will read here next time.";
  }
  const lines = ["", "", `YOUR MEMORY (from ${totalReviews} reviewed trade(s) of this bot; you wrote it yourself after comparing your decisions with what really happened):`];
  if (lessons.length) {
    lines.push("Lessons (weight = how many reviews supported it; higher = more reliable; a lesson with weight 1 rests on one trade only, treat it as a hint):");
    for (const l of lessons) lines.push(`- [lesson #${l.id}, weight ${l.weight}] ${l.text}`);
  }
  const st = recordStats(reviews);
  if (Object.keys(st).length) {
    lines.push("Your track record in the reviewed trades (delta = USD your action would have made versus the bot's real result; positive = you were better):");
    for (const [a, s] of Object.entries(st) as [string, Json][]) lines.push(`- ${a}: ${s.decisions} decision(s), better ${s.better}, worse ${s.worse}, same ${s.same}, total delta ${s.sum_delta >= 0 ? "+" : ""}${s.sum_delta}`);
  }
  const recent = (reviews || []).slice(0, 3);
  if (recent.length) {
    lines.push("Your latest reviews:");
    for (const r of recent) lines.push(`- trade ${r.ticket} (${r.module} ${r.side}, bot ${r.outcome?.close?.pnl ?? "?"} USD): ${clip(r.mistakes || r.summary, 300)}`);
  }
  lines.push("Use the lessons, but judge THIS trade on its own facts: a lesson that does not fit the situation does not apply. Call get_my_record for more of your history.");
  return lines.join("\n");
}

// ------------------------------------------------------------------ indicators on the bot's M15 closes (bars table)
export interface Bar { t: number; o: number; h: number; l: number; c: number; vwap: number | null }
const TF_MS: Record<string, number> = { M15: 15 * 60_000, H1: 3600_000, H4: 4 * 3600_000, D1: 86_400_000 };

/** M15 closes -> bars of the timeframe (open/high/low/close OF THE CLOSES: the table keeps closes only). */
export function aggregate(rows: { t: number; close: number; vwap: number | null }[], tf: string): Bar[] {
  const ms = TF_MS[tf] || TF_MS.M15;
  const out: Bar[] = [];
  for (const r of rows) {
    const k = Math.floor(r.t / ms) * ms;
    const b = out[out.length - 1];
    if (b && b.t === k) { b.h = Math.max(b.h, r.close); b.l = Math.min(b.l, r.close); b.c = r.close; b.vwap = r.vwap; }
    else out.push({ t: k, o: r.close, h: r.close, l: r.close, c: r.close, vwap: r.vwap });
  }
  return out;
}
export function ema(xs: number[], n: number): number[] {
  const k = 2 / (n + 1), out: number[] = [];
  xs.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
}
export function sma(xs: number[], n: number): (number | null)[] {
  return xs.map((_, i) => (i + 1 < n ? null : xs.slice(i + 1 - n, i + 1).reduce((s, v) => s + v, 0) / n));
}
export function rsi(xs: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let ag = 0, al = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) { ag += g / n; al += l / n; out.push(i === n ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null); }
    else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al)); }
  }
  return out;
}
function stdev(xs: number[]): number {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
}
const tail = (xs: (number | null)[], n = 8) => xs.slice(-n).map((v) => (v === null || !Number.isFinite(v) ? null : r2(v)));
const isoMin = (t: number) => new Date(t).toISOString().slice(0, 16) + "Z";

/** One indicator spec like "ema:20", "rsi:14", "macd", "bollinger:20", "roc:10", "zscore:20", "atr_close:14",
 *  "swings", "levels", "vwap" on the bars of a timeframe. Returns {last, recent} or an error text. */
export function indicator(bars: Bar[], spec: string): Json {
  const [name, p1] = String(spec).toLowerCase().split(":");
  const n = Math.max(2, Math.min(200, Number(p1) || 0));
  const c = bars.map((b) => b.c);
  if (!c.length) return { error: "no bars" };
  switch (name) {
    case "ema": { const e = ema(c, n || 20); return { period: n || 20, last: r2(e[e.length - 1]), recent: tail(e), price_vs: r2(c[c.length - 1] - e[e.length - 1]) }; }
    case "sma": { const s = sma(c, n || 20); return { period: n || 20, last: tail(s, 1)[0], recent: tail(s) }; }
    case "rsi": { const s = rsi(c, n || 14); return { period: n || 14, last: tail(s, 1)[0], recent: tail(s) }; }
    case "macd": {
      const f = ema(c, 12), s = ema(c, 26), m = f.map((v, i) => v - s[i]), sig = ema(m, 9), hist = m.map((v, i) => v - sig[i]);
      return { macd: r2(m[m.length - 1]), signal: r2(sig[sig.length - 1]), hist: r2(hist[hist.length - 1]), hist_recent: tail(hist) };
    }
    case "bollinger": {
      const p = n || 20; if (c.length < p) return { error: `needs ${p} bars` };
      const w = c.slice(-p), m = w.reduce((s, v) => s + v, 0) / p, sd = stdev(w);
      return { period: p, mid: r2(m), upper: r2(m + 2 * sd), lower: r2(m - 2 * sd), width: r2(4 * sd), pct_b: r2((c[c.length - 1] - (m - 2 * sd)) / (4 * sd || 1)) };
    }
    case "roc": { const p = n || 10; if (c.length <= p) return { error: `needs ${p + 1} bars` }; return { period: p, last: r2(c[c.length - 1] - c[c.length - 1 - p]) }; }
    case "zscore": { const p = n || 20; if (c.length < p) return { error: `needs ${p} bars` }; const w = c.slice(-p); const sd = stdev(w); return { period: p, last: r2((c[c.length - 1] - w.reduce((s, v) => s + v, 0) / p) / (sd || 1)) }; }
    case "atr_close": {
      const p = n || 14; const tr = bars.map((b, i) => Math.max(b.h - b.l, i ? Math.abs(b.c - bars[i - 1].c) : 0));
      const a = sma(tr, p); return { period: p, last: tail(a, 1)[0], note: "range of the M15 closes per bar (the table has no tick highs / lows)" };
    }
    case "swings": {
      const k = 3, highs: Json[] = [], lows: Json[] = [];
      for (let i = k; i < bars.length - k; i++) {
        const w = bars.slice(i - k, i + k + 1);
        if (bars[i].h === Math.max(...w.map((b) => b.h))) highs.push({ t: isoMin(bars[i].t), price: r2(bars[i].h) });
        if (bars[i].l === Math.min(...w.map((b) => b.l))) lows.push({ t: isoMin(bars[i].t), price: r2(bars[i].l) });
      }
      return { highs: highs.slice(-5), lows: lows.slice(-5) };
    }
    case "levels": {
      const d = aggregate(bars.map((b) => ({ t: b.t, close: b.c, vwap: b.vwap })), "D1");
      const prev = d.length > 1 ? d[d.length - 2] : null, cur = d[d.length - 1], px = c[c.length - 1];
      return { prev_day: prev ? { high: r2(prev.h), low: r2(prev.l), close: r2(prev.c) } : null, today: { open: r2(cur.o), high: r2(cur.h), low: r2(cur.l) },
        round_numbers: [Math.floor(px / 10) * 10, Math.ceil(px / 10) * 10, Math.round(px / 50) * 50].filter((v, i, a) => a.indexOf(v) === i) };
    }
    case "vwap": { const v = bars[bars.length - 1].vwap; return v ? { vwap: r2(v), price_vs: r2(c[c.length - 1] - v) } : { error: "no vwap on these bars" }; }
    default: return { error: `unknown indicator ${name}` };
  }
}

export const DATA_TOOLS = [
  {
    name: "get_indicators",
    description: "Indicators computed on this bot's gold price (M15 closes of the last ~30 days, aggregated to the timeframe). Use it when the snapshot is not enough. specs: ema:N, sma:N, rsi:N, macd, bollinger:N, roc:N (change over N bars), zscore:N, atr_close:N, swings (recent swing highs / lows), levels (previous day high / low / close, today's range, round numbers), vwap (M15 only).",
    input_schema: { type: "object", properties: {
      timeframe: { type: "string", enum: ["M15", "H1", "H4", "D1"] },
      specs: { type: "array", items: { type: "string" }, maxItems: 10 },
    }, required: ["timeframe", "specs"], additionalProperties: false },
  },
  {
    name: "get_price_history",
    description: "Recent bars of the timeframe as [time UTC, open, high, low, close] built from M15 closes (newest last).",
    input_schema: { type: "object", properties: {
      timeframe: { type: "string", enum: ["M15", "H1", "H4", "D1"] }, bars: { type: "integer", minimum: 5, maximum: 120 },
    }, required: ["timeframe", "bars"], additionalProperties: false },
  },
  {
    name: "get_trade_history",
    description: "The bot's last closed trades (strategy, side, lots, close price, P&L, reason) and a summary per strategy.",
    input_schema: { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 40 } }, required: ["n"], additionalProperties: false },
  },
  {
    name: "get_my_record",
    description: "Your own past reviews of this bot's trades: what you decided, what really happened, what you got wrong.",
    input_schema: { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 15 } }, required: ["n"], additionalProperties: false },
  },
];

// ------------------------------------------------------------------ review after the trade closed (SPEC 10.7)
/** Objective checks of every decision against the real result. path = [t ms, price at which this trade would close]
 *  sorted by time (the bot's M15 closes and the decisions' own prices; no ticks, so a stop hit inside a bar can be
 *  missed: "approx"). delta = USD the action would have made minus the bot's real P&L. */
export function evaluate(decisions: Json[], close: Json, path: [number, number][], side: string, entry: number, lots: number): Json {
  const buy = side === "BUY", mult = lots * 100, finalPnl = Number(close?.pnl);
  const tEnd = Date.parse(close?.ts_utc || "") || Infinity;
  const pnlAt = (p: number) => r2((buy ? p - entry : entry - p) * mult);
  const after = (t: number) => path.filter(([tt]) => tt > t && tt <= tEnd);
  const verdict = (d: number) => (d > 0.5 ? "better" : d < -0.5 ? "worse" : "same");
  const checks: Json[] = [];
  for (const d of decisions || []) {
    if (!d || d.action === "error" || d.valid === false) continue;
    const t = Date.parse(d.ts), det = d.details || {};
    const pnlNow = Number(det.pnl_now ?? d.profit);
    let result = finalPnl, note = "";
    if (d.action === "hold") {
      result = finalPnl;
      const pts = after(t).map(([, p]) => pnlAt(p));
      const best = pts.length ? Math.max(...pts) : null, worst = pts.length ? Math.min(...pts) : null;
      const delta = r2(finalPnl - pnlNow);   // holding versus closing at that moment
      checks.push({ ts: d.ts, action: "hold", confidence: d.confidence, pnl_then: pnlNow, final: finalPnl, delta, verdict: verdict(delta),
        target_reached: det.hold_target !== undefined && best !== null ? best >= Number(det.target_pnl) - 1e-9 : null,
        exit_touched: det.hold_exit !== undefined && worst !== null ? worst <= Number(det.exit_pnl) + 1e-9 : null, best_after: best, worst_after: worst });
      continue;
    }
    if (d.action === "close") { result = Number(det.close_pnl ?? pnlNow); note = "closed at that moment"; }
    if (d.action === "tighten") {
      const sl = Number(det.new_sl ?? d.new_sl);
      const hit = after(t).find(([, p]) => (buy ? p <= sl : p >= sl));
      result = hit ? Number(det.locked_pnl ?? pnlAt(sl)) : finalPnl;
      note = hit ? `the new stop ${sl} was hit (approx, M15 closes)` : "the new stop was not hit before the bot's exit";
    }
    if (d.action === "reverse" && det.reverse) {
      const v = det.reverse, sellRev = v.side === "SELL";
      let leg: number | null = null;
      for (const [, p] of after(t)) {       // p = the original trade's exit price; the reverse leg is close enough on it
        if (sellRev ? p >= v.sl : p <= v.sl) { leg = Number(v.risk); note = "reverse trade hit its stop (approx)"; break; }
        if (sellRev ? p <= v.tp : p >= v.tp) { leg = Number(v.reward); note = "reverse trade hit its target (approx)"; break; }
      }
      if (leg === null) {
        const last = after(t).pop();
        leg = last ? r2((sellRev ? v.entry - last[1] : last[1] - v.entry) * mult) : 0;
        note = "reverse trade still open at the bot's exit: valued there (approx)";
      }
      result = r2(Number(det.close_pnl ?? pnlNow) + leg);
    }
    const delta = r2(result - finalPnl);
    checks.push({ ts: d.ts, action: d.action, confidence: d.confidence, pnl_then: pnlNow, result, final: finalPnl, delta, verdict: verdict(delta), note });
  }
  const all = path.filter(([tt]) => tt <= tEnd).map(([, p]) => pnlAt(p));
  return { close, checks, mfe: all.length ? Math.max(...all) : null, mae: all.length ? Math.min(...all) : null,
    better: checks.filter((c) => c.verdict === "better").length, worse: checks.filter((c) => c.verdict === "worse").length };
}

export const REVIEW_PROMPT = `You are the shadow AI of Dobby (a gold M15 robot). A trade you watched has just closed. Review your own decisions honestly against what really happened, find what you got wrong and WHY, and update your memory so that you decide better on the next trades.

You get: the trade, the real result, every decision you made (with your reasons and prices), objective checks of each decision (delta = USD your action would have made minus the bot's real result; positive = you were better; "approx" = checked on M15 closes, not ticks), the price path, and your current lessons.

Rules for good learning:
- Separate a bad decision from bad luck. One trade is noise: a decision can be right and still lose. Say which it was and why.
- Look at the decisions that were "worse": which fact did you misread or ignore? Which data would have helped (indicators you can request with get_indicators next time)?
- Lessons must be general and testable: a condition you can see in a snapshot + what to do (e.g. "when the trade is past 70 % of the target and price is above VWAP, hold to the lock instead of closing"). No lessons about a single price level or date.
- Prefer reinforce (this trade supports a lesson) or weaken (this trade contradicts it) on existing lessons over adding near-duplicates. Add at most 2 new lessons per review, only when this trade shows something your lessons do not cover. Retire a lesson that has proved wrong.
- Write summary and mistakes in Thai (short sentences, with the prices and money).

Answer ONLY by calling the tool review.`;

export const REVIEW_TOOL = {
  name: "review",
  description: "Your review of the closed trade and the changes to your memory.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Thai, 2-5 sentences: what happened to the trade and how your decisions did, with prices and money." },
      mistakes: { type: "string", description: "Thai, 1-5 sentences: what you got wrong and why (or that the decisions were right / it was luck)." },
      lessons: {
        type: "array", maxItems: 6,
        items: { type: "object", properties: {
          op: { type: "string", enum: ["add", "reinforce", "weaken", "retire"] },
          id: { type: ["integer", "null"], description: "the lesson number for reinforce / weaken / retire; null for add" },
          text: { type: ["string", "null"], description: "add only: the lesson in Thai, at most 300 characters" },
          why: { type: "string", description: "Thai: why, from this trade" },
        }, required: ["op", "id", "text", "why"], additionalProperties: false },
      },
    },
    required: ["summary", "mistakes", "lessons"],
    additionalProperties: false,
  },
};

// ------------------------------------------------------------------ AI trader: its own paper trades (SPEC 10.8)
export const AI_TICKET_BASE = 900000000000;
export const SCAN_PROMPT = `You are the AI trader of Dobby's owner. Next to the Dobby robot (which trades gold XAUUSD on M15 with fixed rules) you run YOUR OWN paper account: you decide alone when to open a trade, which side, and where its stop and target are. One trade at a time, fixed lots given in the snapshot. Paper only: nothing reaches the broker, but every trade is scored on real prices, reviewed after it closes, and your lessons are kept, so trade as if it were real money.

How your trade works after you open it:
- It fills at the ask for a BUY and at the bid for a SELL (spread about 0.10-0.20 $ is a real cost).
- It closes at its stop or its target on the live price. Every few minutes you are asked again what to do with it (hold / close / tighten the stop / reverse), so you can manage it.
- It is closed on Friday after 22:00 server time and after 24 hours at the latest.

Be selective: waiting is a good answer when there is no clear edge. Historical tests on 2026 data found that most simple rules (RSI / Bollinger / VWAP fades, opening-range breakouts, FVG bounces with small targets, early exits, stop-and-reverse) lose after costs; what worked was trading WITH the H4 trend after a pullback, with a stop of about 1-1.5 ATR and a target of about 1-1.5 times the stop. Avoid opening just before a high-impact USD release. Use the data tools when the snapshot is not enough.

Finish by calling the tool trade with action "open" (side, exact stop and target prices) or "wait". confidence = how sure you are that this trade reaches its target before its stop (0-100). reason: 2 to 4 short sentences in Thai with the facts, the entry idea and why that stop and that target.`;

export const TRADE_TOOL = {
  name: "trade",
  description: "Open your own paper trade now, or wait.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open", "wait"] },
      side: { type: ["string", "null"], enum: ["BUY", "SELL", null] },
      sl: { type: ["number", "null"], description: "open only: the stop price" },
      tp: { type: ["number", "null"], description: "open only: the target price" },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string", description: "Thai, 2-4 sentences" },
    },
    required: ["action", "side", "sl", "tp", "confidence", "reason"],
    additionalProperties: false,
  },
};

/** Validates an "open" against the market: entry at the ask (BUY) / bid (SELL), stop and target on their sides,
 *  stop 1..30 $ and target 1..60 $ away. Returns the row for ai_scan_record. */
export function checkOpen(input: Json, market: Json, lots: number): Json {
  const action = input?.action === "open" ? "open" : "wait";
  const reason = clip(input?.reason, 1200).trim();
  const c = num(input?.confidence);
  const conf = c === null ? null : Math.max(0, Math.min(100, Math.round(c)));
  if (action === "wait") return { action, valid: input?.action === "wait", reason, confidence: conf, details: {} };
  const side = input?.side === "BUY" || input?.side === "SELL" ? input.side : null;
  const entry = side === "BUY" ? num(market?.ask) : side === "SELL" ? num(market?.bid) : null;
  const sl = px2(input?.sl), tp = px2(input?.tp);
  let valid = !!side && entry !== null && sl !== null && tp !== null;
  const details: Json = {};
  if (valid) {
    const buy = side === "BUY";
    const slD = r2(buy ? (entry as number) - (sl as number) : (sl as number) - (entry as number));
    const tpD = r2(buy ? (tp as number) - (entry as number) : (entry as number) - (tp as number));
    valid = slD >= 1 && slD <= 30 && tpD >= 1 && tpD <= 60;
    const mult = lots * 100;
    Object.assign(details, { entry, sl_dist: slD, tp_dist: tpD, risk: r2(-Math.abs(slD) * mult), reward: r2(Math.abs(tpD) * mult), rr: slD > 0 ? r2(tpD / slD) : null });
  }
  return { action, side, entry, sl, tp, lots, valid, reason, confidence: conf, details };
}

// ------------------------------------------------------------------ Supabase helpers
interface Sb { url: string; apikey: string; token: string; serviceKey: string; fetch: typeof fetch }
class SbError extends Error {
  status: number; text: string;
  constructor(status: number, text: string) { super(text || `HTTP ${status}`); this.status = status; this.text = text; }
}
async function sbRequest(sb: Sb, method: string, path: string, o: { service?: boolean; body?: unknown } = {}): Promise<Json> {
  const headers: Record<string, string> = { apikey: o.service ? sb.serviceKey : sb.apikey, Accept: "application/json" };
  if (!o.service) headers.Authorization = `Bearer ${sb.token}`;
  else if (sb.serviceKey.split(".").length === 3) headers.Authorization = `Bearer ${sb.serviceKey}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await sb.fetch(`${sb.url}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  if (!res.ok) throw new SbError(res.status, text);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
const rpc = (sb: Sb, fn: string, args: Json) => sbRequest(sb, "POST", `/rest/v1/rpc/${fn}`, { service: true, body: args });
export function rpcErrorCode(e: unknown): string {
  if (e instanceof SbError) {
    for (const c of RPC_CODES) if (e.text.includes(c)) return c;
    if (e.status === 404 || e.text.includes("PGRST202") || e.text.includes("42883")) return "ai_not_configured"; // schema.sql not re-run yet
  }
  return "internal";
}
async function getUser(sb: Sb): Promise<Json> {
  const res = await sb.fetch(`${sb.url}/auth/v1/user`, { headers: { apikey: sb.apikey, Authorization: `Bearer ${sb.token}` } });
  if (!res.ok) { await res.text().catch(() => ""); return null; }
  const u = await res.json().catch(() => null);
  return u && typeof u.id === "string" && UUID_RE.test(u.id) ? u : null;
}
function serviceKeyOf(env: (k: string) => string): string {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try {
    const m = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    return String(m.default || Object.values(m)[0] || "");
  } catch {
    return "";
  }
}
const sbGet = async (sb: Sb, table: string, q: string): Promise<Json[]> => {
  const rows = await sbRequest(sb, "GET", `/rest/v1/${table}?${q}`);
  return Array.isArray(rows) ? rows : [];
};

/** The bot's M15 closes (bars table, user's token = RLS), oldest first, cached per request. */
async function loadBars(sb: Sb, botId: string, cache: Json): Promise<{ t: number; close: number; vwap: number | null }[]> {
  if (!cache.bars) {
    const rows = await sbGet(sb, "bars", `bot_id=eq.${botId}&select=t,close,vwap&order=t.desc&limit=3000`);
    cache.bars = rows.map((r) => ({ t: Date.parse(r.t), close: Number(r.close), vwap: r.vwap === null ? null : Number(r.vwap) }))
      .filter((r) => Number.isFinite(r.t) && r.close > 0).reverse();
  }
  return cache.bars;
}

/** Runs one data tool; returns a JSON-able result (errors as {error}). */
export async function runDataTool(sb: Sb, botId: string, name: string, input: Json, cache: Json): Promise<Json> {
  try {
    if (name === "get_indicators" || name === "get_price_history") {
      const tf = TF_MS[input?.timeframe] ? input.timeframe : "M15";
      const bars = aggregate(await loadBars(sb, botId, cache), tf);
      if (!bars.length) return { error: "no price bars stored for this bot yet (Dobby app 1.2.0+ uploads them)" };
      if (name === "get_price_history") {
        const n = Math.max(5, Math.min(120, Number(input?.bars) || 40));
        return { timeframe: tf, format: "[time UTC, open, high, low, close] of the M15 closes", bars: bars.slice(-n).map((b) => [isoMin(b.t), r2(b.o), r2(b.h), r2(b.l), r2(b.c)]) };
      }
      const specs = (Array.isArray(input?.specs) ? input.specs : []).slice(0, 10);
      const out: Json = { timeframe: tf, last_close: r2(bars[bars.length - 1].c), last_bar_utc: isoMin(bars[bars.length - 1].t) };
      for (const s of specs) out[String(s)] = indicator(bars, String(s));
      return out;
    }
    if (name === "get_trade_history") {
      const n = Math.max(1, Math.min(40, Number(input?.n) || 15));
      const rows = await sbGet(sb, "journal", `bot_id=eq.${botId}&event=eq.CLOSE&select=ts_server,tag,side,lots,price,pnl,detail&order=ts_server.desc&limit=${n}`);
      const by: Json = {};
      for (const r of rows) {
        const s = by[r.tag] || (by[r.tag] = { trades: 0, wins: 0, pnl: 0 });
        s.trades += 1; if (Number(r.pnl) > 0) s.wins += 1; s.pnl = r2(s.pnl + Number(r.pnl || 0));
      }
      return { trades: rows.map((r) => ({ ts_server: r.ts_server, strategy: r.tag, side: r.side, lots: Number(r.lots), close: Number(r.price), pnl: Number(r.pnl),
        reason: (/reason=(\w+)/.exec(r.detail || "") || [])[1] || null })), by_strategy: by };
    }
    if (name === "get_my_record") {
      const n = Math.max(1, Math.min(15, Number(input?.n) || 5));
      const rows = await sbGet(sb, "shadow_reviews", `bot_id=eq.${botId}&select=ts,ticket,module,side,outcome,summary,mistakes&order=ts.desc&limit=${n}`);
      return { reviews: rows.map((r) => ({ ts: r.ts, ticket: r.ticket, module: r.module, side: r.side, bot_pnl: r.outcome?.close?.pnl ?? null,
        checks: (r.outcome?.checks || []).map((c: Json) => ({ action: c.action, delta: c.delta, verdict: c.verdict })), summary: r.summary, mistakes: r.mistakes })),
        record: recordStats(rows) };
    }
    return { error: `unknown tool ${name}` };
  } catch (e) {
    return { error: clip(`could not read the data: ${(e as Error)?.message ?? e}`, 200) };
  }
}

/** Active lessons (strongest first) and recent reviews of the bot, with the user's token. Never throws. */
async function loadMemory(sb: Sb, botId: string): Promise<{ lessons: Json[]; reviews: Json[]; total: number }> {
  try {
    const [lessons, reviews] = await Promise.all([
      sbGet(sb, "shadow_lessons", `bot_id=eq.${botId}&status=eq.active&select=id,text,weight&order=weight.desc,updated_at.desc&limit=${MAX_LESSONS}`),
      sbGet(sb, "shadow_reviews", `bot_id=eq.${botId}&select=ticket,module,side,outcome,summary,mistakes&order=ts.desc&limit=30`),
    ]);
    return { lessons, reviews, total: reviews.length };
  } catch {
    return { lessons: [], reviews: [], total: 0 };
  }
}

const addUsage = (acc: Json, u: Json) => {
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) acc[k] = (acc[k] || 0) + (Number(u?.[k]) || 0);
  return acc;
};

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
function jsonError(code: string, message?: string): Response {
  const [status, thai] = ERRORS[code] || ERRORS.internal;
  return new Response(JSON.stringify({ error: ERRORS[code] ? code : "internal", message: message || thai }), { status, headers: JSON_HEADERS });
}

// ------------------------------------------------------------------ handler
export function createHandler(deps: ShadowDeps): (req: Request) => Promise<Response> {
  const env = (k: string) => String((typeof deps.env === "function" ? deps.env(k) : deps.env?.[k]) ?? "").trim();
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const makeClient = deps.anthropic ?? ((apiKey: string) => new Anthropic({ apiKey, maxRetries: 1, timeout: CALL_TIMEOUT_MS }));

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return jsonError("method_not_allowed");
    try {
      return await handlePost(req);
    } catch (e) {
      console.error("shadow failed", String((e as Error)?.message ?? e).slice(0, 300));
      return jsonError("internal");
    }
  };

  async function handlePost(req: Request): Promise<Response> {
    const url = env("SUPABASE_URL").replace(/\/+$/, "");
    const apikey = (req.headers.get("apikey") || "").trim() || env("SUPABASE_ANON_KEY");
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !apikey) return jsonError("not_authenticated");
    if (!url) return jsonError("ai_not_configured");
    const sb: Sb = { url, apikey, token, serviceKey: "", fetch: doFetch };
    const user = await getUser(sb);
    if (!user) return jsonError("not_authenticated");

    let body: Json;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_CHARS) return jsonError("bad_request", "snapshot too large");
      body = JSON.parse(raw);
    } catch {
      return jsonError("bad_request");
    }
    const botId = body && typeof body.bot_id === "string" && UUID_RE.test(body.bot_id) ? body.bot_id : null;
    if (body && body.mode === "review") return await handleReview(sb, user, botId, body);
    if (body && body.mode === "scan") return await handleScan(sb, user, botId, body);
    if (body && body.mode === "ai_trade_event") return await handleTradeEvent(sb, user, botId, body);
    const snapshot = body && body.snapshot && typeof body.snapshot === "object" && !Array.isArray(body.snapshot) ? body.snapshot : null;
    const pos = snapshot ? readPosition(snapshot) : null;
    if (!botId || !pos) return jsonError("bad_request");

    const anthropicKey = env("ANTHROPIC_API_KEY");
    sb.serviceKey = serviceKeyOf(env);
    if (!anthropicKey || !sb.serviceKey) return jsonError("ai_not_configured");

    let start: Json;
    try {
      start = await rpc(sb, "shadow_start", { p_user: user.id, p_bot: botId, p_ticket: pos.ticket });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    const model = String(start?.model || "claude-opus-5-5");
    const interval = Number(start?.interval_s) || 300;
    const memory = await loadMemory(sb, botId);

    // the decision: up to MAX_ROUNDS rounds of data tools, then `decide` is forced
    let decision: Decision = { action: "error", new_sl: null, confidence: null, reason: "", valid: false, details: {} };
    const ownTrade = pos.module === "AI" && pos.ticket > AI_TICKET_BASE;     // SPEC 10.8: the AI manages its own paper trade
    const loop = await toolLoop(makeClient(anthropicKey), model, SYSTEM_PROMPT + memoryPrompt(memory.lessons, memory.reviews, memory.total) +
      (ownTrade ? "\n\nThis open trade is YOUR OWN paper trade (module AI): your answer IS applied to it (close, new stop or reverse)." : ""),
      userMessage(snapshot), DECIDE_TOOL, sb, botId);
    const usage = loop.usage, used = loop.used;
    if (loop.block) decision = checkDecision(loop.block.input, pos);
    else decision = { ...decision, reason: loop.error };
    if (used.length) decision.details = { ...decision.details, data_used: used.slice(0, 12) };

    const cost = costOf(model, usage);
    let id: Json = null;
    try {
      id = await rpc(sb, "shadow_record", {
        p_user: user.id, p_bot: botId,
        p_row: {
          ...pos, action: decision.action, new_sl: decision.new_sl, confidence: decision.confidence, reason: decision.reason,
          valid: decision.valid, snapshot, details: decision.details, model, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
          cost_usd: cost, memory_rev: Number(start?.memory_rev) || 0,
        },
      });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    if (decision.action === "error") return new Response(JSON.stringify({ ok: false, id, error: "ai_failed", message: decision.reason, next_after_s: interval }), { status: 200, headers: JSON_HEADERS });
    // SPEC 10.8: on its own paper trade the decision is applied
    let aiTrade: Json = null;
    if (ownTrade && decision.valid && decision.action !== "hold") {
      const d = decision.details || {};
      const op = decision.action === "tighten" ? { op: "sl", sl: decision.new_sl }
        : decision.action === "close" ? { op: "close", price: d.close_price, reason: "ai_close" }
        : d.reverse ? { op: "reverse", price: d.close_price, entry: d.reverse.entry, sl: d.reverse.sl, tp: d.reverse.tp, reason_text: decision.reason } : null;
      if (op) {
        try { aiTrade = await rpc(sb, "ai_trade_apply", { p_user: user.id, p_bot: botId, p_trade: pos.ticket - AI_TICKET_BASE, p_op: op }); }
        catch (e) { aiTrade = { error: rpcErrorCode(e) }; }
      }
    }
    return new Response(JSON.stringify({
      ok: true, id,
      decision: { action: decision.action, new_sl: decision.new_sl, confidence: decision.confidence, reason: decision.reason, details: decision.details },
      valid: decision.valid, next_after_s: interval, model, cost_usd: cost, memory_rev: Number(start?.memory_rev) || 0, ai_trade: aiTrade,
    }), { status: 200, headers: JSON_HEADERS });
  }

  /** Data-tool rounds, then `finalTool` is forced on the last round. Never throws. */
  async function toolLoop(client: Anthropic, model: string, system: string, first: string, finalTool: Json, sb: Sb, botId: string):
    Promise<{ block: Json; usage: Json; used: string[]; error: string }> {
    const usage: Json = {}, used: string[] = [], cache: Json = {};
    try {
      const messages: Json[] = [{ role: "user", content: first }];
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const last = round === MAX_ROUNDS - 1;
        const msg: Json = await client.messages.create({
          model, max_tokens: MAX_TOKENS, system, tools: [...DATA_TOOLS, finalTool] as Json,
          tool_choice: last ? { type: "tool", name: finalTool.name } : { type: "any" }, messages,
        } as Json);
        addUsage(usage, msg?.usage);
        const blocks: Json[] = Array.isArray(msg?.content) ? msg.content : [];
        const fin = blocks.find((b) => b && b.type === "tool_use" && b.name === finalTool.name);
        if (fin) return { block: fin, usage, used, error: "" };
        const calls = blocks.filter((b) => b && b.type === "tool_use");
        if (!calls.length) return { block: null, usage, used, error: clip(`no decision (stop_reason ${msg?.stop_reason ?? "?"})`, 200) };
        messages.push({ role: "assistant", content: blocks });
        const results: Json[] = [];
        for (const c of calls) {
          used.push(`${c.name}${c.input?.timeframe ? `:${c.input.timeframe}` : ""}`);
          results.push({ type: "tool_result", tool_use_id: c.id, content: clip(JSON.stringify(await runDataTool(sb, botId, c.name, c.input, cache)), 12000) });
        }
        messages.push({ role: "user", content: results });
      }
      return { block: null, usage, used, error: "no decision after the last round" };
    } catch (e) {
      return { block: null, usage, used, error: clip(`AI call failed: ${(e as Error)?.message ?? e}`, 300) };
    }
  }

  // SPEC 10.8: POST {mode: "scan", bot_id, snapshot (market, bars, news, the bot's own positions)} -> open or wait
  async function handleScan(sb: Sb, user: Json, botId: string | null, body: Json): Promise<Response> {
    const snapshot = body?.snapshot && typeof body.snapshot === "object" && !Array.isArray(body.snapshot) ? body.snapshot : null;
    const market = snapshot?.market;
    if (!botId || !snapshot || num(market?.bid) === null || num(market?.ask) === null) return jsonError("bad_request");
    const anthropicKey = env("ANTHROPIC_API_KEY");
    sb.serviceKey = serviceKeyOf(env);
    if (!anthropicKey || !sb.serviceKey) return jsonError("ai_not_configured");
    let start: Json;
    try {
      start = await rpc(sb, "ai_scan_start", { p_user: user.id, p_bot: botId });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    const model = String(start?.model || "claude-opus-5-5"), interval = Number(start?.interval_s) || 1800, lots = Number(start?.lots) || 0.2;
    const memory = await loadMemory(sb, botId);
    const loop = await toolLoop(makeClient(anthropicKey), model, SCAN_PROMPT + memoryPrompt(memory.lessons, memory.reviews, memory.total),
      `Your lots: ${lots}. Market snapshot (JSON; *_utc = UTC, server_time = broker server time):\n${JSON.stringify(snapshot)}`, TRADE_TOOL, sb, botId);
    const row: Json = loop.block ? checkOpen(loop.block.input, market, lots) : { action: "error", valid: false, reason: loop.error, details: {} };
    if (loop.used.length) row.details = { ...row.details, data_used: loop.used.slice(0, 12) };
    const cost = costOf(model, loop.usage);
    let res: Json;
    try {
      res = await rpc(sb, "ai_scan_record", { p_user: user.id, p_bot: botId, p_row: { ...row, model, cost_usd: cost, memory_rev: Number(start?.memory_rev) || 0,
        input_tokens: loop.usage.input_tokens || 0, output_tokens: loop.usage.output_tokens || 0 } });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    return new Response(JSON.stringify({ ok: row.action !== "error", action: row.action, valid: row.valid, side: row.side ?? null, sl: row.sl ?? null, tp: row.tp ?? null,
      confidence: row.confidence ?? null, reason: row.reason, details: row.details, trade: res?.trade ?? null, scan_id: res?.scan_id ?? null,
      next_after_s: interval, model, cost_usd: cost }), { status: 200, headers: JSON_HEADERS });
  }

  // SPEC 10.8: POST {mode: "ai_trade_event", bot_id, trade_id, price, reason: sl|tp|time|stale} (the app saw the stop /
  // target / time limit on the live price) -> the paper trade is closed
  async function handleTradeEvent(sb: Sb, user: Json, botId: string | null, body: Json): Promise<Response> {
    const tid = num(body?.trade_id), price = num(body?.price);
    const reason = ["sl", "tp", "time", "stale"].includes(body?.reason) ? body.reason : null;
    if (!botId || !tid || !Number.isInteger(tid) || price === null || price <= 0 || !reason) return jsonError("bad_request");
    sb.serviceKey = serviceKeyOf(env);
    if (!sb.serviceKey) return jsonError("ai_not_configured");
    try {
      const r = await rpc(sb, "ai_trade_apply", { p_user: user.id, p_bot: botId, p_trade: tid, p_op: { op: "close", price, reason } });
      return new Response(JSON.stringify({ ok: true, trade: r?.trade ?? null, already_closed: !!r?.already_closed }), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
  }

  // SPEC 10.7: POST {mode: "review", bot_id, ticket, close: {ts_utc, ts_server, price, pnl, reason}, bars_m15: [{t_utc, close}]}
  async function handleReview(sb: Sb, user: Json, botId: string | null, body: Json): Promise<Response> {
    const ticket = num(body?.ticket);
    const close = body?.close && typeof body.close === "object" ? body.close : null;
    if (!botId || !ticket || ticket <= 0 || !Number.isInteger(ticket) || !close || num(close.pnl) === null) return jsonError("bad_request");
    const anthropicKey = env("ANTHROPIC_API_KEY");
    sb.serviceKey = serviceKeyOf(env);
    if (!anthropicKey || !sb.serviceKey) return jsonError("ai_not_configured");
    let start: Json;
    try {
      start = await rpc(sb, "shadow_review_start", { p_user: user.id, p_bot: botId, p_ticket: ticket });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    const model = String(start?.model || "claude-opus-5-5");
    const decisions = await sbGet(sb, "shadow_decisions",
      `bot_id=eq.${botId}&ticket=eq.${ticket}&select=ts,module,side,lots,open_price,sl,tp,bid,ask,profit,action,new_sl,confidence,reason,valid,details&order=ts.asc&limit=200`);
    // SPEC 10.8: an AI paper trade is reviewed with its opening plan (and even without any management decision)
    let own: Json = null;
    if (ticket > AI_TICKET_BASE) {
      own = (await sbGet(sb, "ai_trades", `bot_id=eq.${botId}&ticket=eq.${ticket}&select=opened_at,side,lots,entry,first_sl,sl,tp,exit,pnl,close_reason,plan&limit=1`))[0] || null;
    }
    if (!decisions.length && !own) return jsonError("review_nothing");
    const d0 = decisions[0] || { ts: own.opened_at, module: "AI", side: own.side, lots: own.lots, open_price: own.entry, sl: own.first_sl, tp: own.tp };
    const buy = d0.side === "BUY";
    const closeOut = { ts_utc: typeof close.ts_utc === "string" ? clip(close.ts_utc, 30) : null, ts_server: clip(close.ts_server, 30),
      price: num(close.price), pnl: num(close.pnl), reason: clip(close.reason, 20) };
    const path: [number, number][] = [];
    for (const b of Array.isArray(body.bars_m15) ? body.bars_m15.slice(-400) : []) {
      const t = Date.parse(b?.t_utc), c = num(b?.close);
      if (Number.isFinite(t) && c !== null) path.push([t + 15 * 60_000, c]);         // a bar's close is known at its end
    }
    for (const d of decisions) { const p = num(buy ? d.bid : d.ask); if (p !== null) path.push([Date.parse(d.ts), p]); }
    const tClose = Date.parse(closeOut.ts_utc || "");
    if (Number.isFinite(tClose) && closeOut.price !== null) path.push([tClose, closeOut.price]);   // the real exit is on the path
    path.sort((a, b) => a[0] - b[0]);
    const outcome = evaluate(decisions, closeOut, path, d0.side, Number(d0.open_price), Number(d0.lots));
    const memory = await loadMemory(sb, botId);
    const input = {
      trade: { ticket, strategy: d0.module, side: d0.side, lots: Number(d0.lots), entry: Number(d0.open_price), first_sl: Number(d0.sl), broker_tp: Number(d0.tp) },
      your_own_trade: own ? { note: "YOU opened this paper trade yourself: review the entry idea too (was it a good place to open, were the stop and target well placed?)",
        opened_at: own.opened_at, open_plan: own.plan, stop: Number(own.first_sl), target: Number(own.tp), exit: Number(own.exit), close_reason: own.close_reason } : undefined,
      real_result: closeOut,
      your_decisions: decisions.map((d) => ({ ts: d.ts, action: d.action, confidence: d.confidence, valid: d.valid, pnl_then: d.profit, details: d.details, reason: d.reason })),
      checks: outcome.checks, best_pnl_during: outcome.mfe, worst_pnl_during: outcome.mae,
      price_path: path.filter(([t]) => t >= Date.parse(d0.ts) - 3600_000).map(([t, p]) => [isoMin(t), p]).slice(-120),
      your_lessons: memory.lessons.map((l) => ({ id: l.id, weight: l.weight, text: l.text })),
      your_record_before: recordStats(memory.reviews),
    };
    let rev: Json = null;
    const usage: Json = {};
    try {
      const msg: Json = await makeClient(anthropicKey).messages.create({
        model, max_tokens: 3000, system: REVIEW_PROMPT, tools: [REVIEW_TOOL] as Json, tool_choice: { type: "tool", name: "review" },
        messages: [{ role: "user", content: `The closed trade and your decisions (JSON):\n${JSON.stringify(input)}` }],
      } as Json);
      addUsage(usage, msg?.usage);
      rev = (Array.isArray(msg?.content) ? msg.content : []).find((b: Json) => b && b.type === "tool_use" && b.name === "review")?.input || null;
    } catch (e) {
      rev = { summary: "", mistakes: clip(`AI review failed: ${(e as Error)?.message ?? e}`, 300), lessons: [] };
    }
    const ops = (Array.isArray(rev?.lessons) ? rev.lessons : []).slice(0, 6).map((l: Json) => ({
      op: l?.op, id: num(l?.id), text: l?.op === "add" ? clip(l?.text, 300) : null, why: clip(l?.why, 300),
    })).filter((l: Json) => ["add", "reinforce", "weaken", "retire"].includes(l.op));
    const cost = costOf(model, usage);
    let res: Json;
    try {
      res = await rpc(sb, "shadow_review_record", {
        p_user: user.id, p_bot: botId, p_ops: ops,
        p_row: { ticket, module: d0.module, side: d0.side, outcome, summary: clip(rev?.summary, 2500), mistakes: clip(rev?.mistakes, 2500),
          model, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cost_usd: cost },
      });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    return new Response(JSON.stringify({ ok: true, review_id: res?.review_id ?? null, summary: clip(rev?.summary, 2500), mistakes: clip(rev?.mistakes, 2500),
      applied: res?.applied ?? [], better: outcome.better, worse: outcome.worse, model, cost_usd: cost }), { status: 200, headers: JSON_HEADERS });
  }
}

// ------------------------------------------------------------------ Deno entry point (Supabase Edge Runtime)
const DenoNs = (globalThis as Json).Deno;
if (DenoNs && typeof DenoNs.serve === "function") {
  DenoNs.serve(createHandler({ env: (k: string) => DenoNs.env.get(k) }));
}
