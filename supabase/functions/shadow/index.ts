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
// Response: 200 {ok, id, decision: {action, new_sl, confidence, reason}, valid, next_after_s}
//           or {error, message} with 400 / 401 / 403 / 404 / 429 / 500 / 503.
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
  bot_not_found: [404, "ไม่พบบอทนี้ในบัญชีของคุณ"],
  method_not_allowed: [405, "ใช้ได้เฉพาะ POST"],
  shadow_too_soon: [429, "ถามเรื่องไม้นี้ไปแล้วเมื่อสักครู่"],
  shadow_budget: [429, "งบ AI เงาของเดือนนี้หมดแล้ว"],
  internal: [500, "เกิดข้อผิดพลาด"],
  ai_not_configured: [503, "ยังไม่ได้ตั้งค่า AI ใน Supabase"],
};
const RPC_CODES = ["not_approved", "bot_not_found", "shadow_disabled", "shadow_budget", "shadow_too_soon"];

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

Answer ONLY by calling the tool decide. confidence = how sure you are that your action beats "hold" for this trade (0-100; use 50 or less when it is a coin flip). reason: 2 to 4 short sentences in Thai that name the facts from the snapshot behind the decision AND the plan with its prices (for hold: where you expect it to go and where you would get out; for close: why now; for tighten: why that stop level; for reverse: why the other way and why that stop and target).`;

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

    let decision: Decision = { action: "error", new_sl: null, confidence: null, reason: "", valid: false, details: {} };
    let usage: Json = {};
    try {
      const msg: Json = await makeClient(anthropicKey).messages.create({
        model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT,
        tools: [DECIDE_TOOL] as Json, tool_choice: { type: "tool", name: "decide" },
        messages: [{ role: "user", content: userMessage(snapshot) }],
      } as Json);
      usage = msg?.usage || {};
      const block = Array.isArray(msg?.content) ? msg.content.find((b: Json) => b && b.type === "tool_use" && b.name === "decide") : null;
      if (block) decision = checkDecision(block.input, pos);
      else decision = { ...decision, reason: clip(`no decision (stop_reason ${msg?.stop_reason ?? "?"})`, 200) };
    } catch (e) {
      decision = { ...decision, reason: clip(`AI call failed: ${(e as Error)?.message ?? e}`, 300) };
    }

    const cost = costOf(model, usage);
    let id: Json = null;
    try {
      id = await rpc(sb, "shadow_record", {
        p_user: user.id, p_bot: botId,
        p_row: {
          ...pos, action: decision.action, new_sl: decision.new_sl, confidence: decision.confidence, reason: decision.reason,
          valid: decision.valid, snapshot, details: decision.details, model, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
          cost_usd: cost,
        },
      });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    if (decision.action === "error") return new Response(JSON.stringify({ ok: false, id, error: "ai_failed", message: decision.reason, next_after_s: interval }), { status: 200, headers: JSON_HEADERS });
    return new Response(JSON.stringify({
      ok: true, id,
      decision: { action: decision.action, new_sl: decision.new_sl, confidence: decision.confidence, reason: decision.reason, details: decision.details },
      valid: decision.valid, next_after_s: interval, model, cost_usd: cost,
    }), { status: 200, headers: JSON_HEADERS });
  }
}

// ------------------------------------------------------------------ Deno entry point (Supabase Edge Runtime)
const DenoNs = (globalThis as Json).Deno;
if (DenoNs && typeof DenoNs.serve === "function") {
  DenoNs.serve(createHandler({ env: (k: string) => DenoNs.env.get(k) }));
}
