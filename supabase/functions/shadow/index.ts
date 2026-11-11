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
export const MAX_TOKENS = 1024;
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

Your options:
- hold: leave the trade to the fixed rules.
- close: close the whole trade now at market.
- tighten: move the stop to new_sl. new_sl must be strictly between the current stop and the current price (bid for a BUY, ask for a SELL); never widen the stop.
- reverse: close now and open the opposite trade with the same lots.

Answer ONLY by calling the tool decide. confidence = how sure you are that your action beats "hold" for this trade (0-100; use 50 or less when it is a coin flip). reason: at most 2 short sentences in Thai, naming the facts from the snapshot that drove the decision.`;

export const DECIDE_TOOL = {
  name: "decide",
  description: "Record your decision for the open Dobby trade.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      new_sl: { type: ["number", "null"], description: "Only for tighten: the new stop price. Otherwise null." },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
      reason: { type: "string", description: "At most 2 short sentences in Thai." },
    },
    required: ["action", "new_sl", "confidence", "reason"],
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

/** Normalises the tool input; `valid` is false when the action cannot be applied as given. */
export function checkDecision(input: Json, pos: Json): { action: string; new_sl: number | null; confidence: number | null; reason: string; valid: boolean } {
  const action = ACTIONS.includes(input?.action) ? input.action : "hold";
  let valid = ACTIONS.includes(input?.action);
  let newSl = action === "tighten" ? num(input?.new_sl) : null;
  if (action === "tighten") {
    const px = pos.side === "BUY" ? pos.bid : pos.ask;
    if (newSl === null || px === null) valid = false;
    else if (pos.side === "BUY") valid = valid && newSl < px && (pos.sl === null || pos.sl <= 0 || newSl > pos.sl);
    else valid = valid && newSl > px && (pos.sl === null || pos.sl <= 0 || newSl < pos.sl);
    if (newSl !== null) newSl = Math.round(newSl * 100) / 100;
  }
  const c = num(input?.confidence);
  return { action, new_sl: newSl, confidence: c === null ? null : Math.max(0, Math.min(100, Math.round(c))), reason: clip(input?.reason, 600).trim(), valid };
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
    const model = String(start?.model || "claude-sonnet-5-5");
    const interval = Number(start?.interval_s) || 300;

    let decision = { action: "error", new_sl: null as number | null, confidence: null as number | null, reason: "", valid: false };
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
          valid: decision.valid, snapshot, model, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
          cost_usd: cost,
        },
      });
    } catch (e) {
      return jsonError(rpcErrorCode(e));
    }
    if (decision.action === "error") return new Response(JSON.stringify({ ok: false, id, error: "ai_failed", message: decision.reason, next_after_s: interval }), { status: 200, headers: JSON_HEADERS });
    return new Response(JSON.stringify({
      ok: true, id,
      decision: { action: decision.action, new_sl: decision.new_sl, confidence: decision.confidence, reason: decision.reason },
      valid: decision.valid, next_after_s: interval, model, cost_usd: cost,
    }), { status: 200, headers: JSON_HEADERS });
  }
}

// ------------------------------------------------------------------ Deno entry point (Supabase Edge Runtime)
const DenoNs = (globalThis as Json).Deno;
if (DenoNs && typeof DenoNs.serve === "function") {
  DenoNs.serve(createHandler({ env: (k: string) => DenoNs.env.get(k) }));
}
