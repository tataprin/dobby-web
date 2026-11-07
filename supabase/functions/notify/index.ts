// @ts-nocheck - one paste-able file; the pure part below is plain JavaScript (see the note above BEGIN messages)
// Dobby Web - Supabase Edge Function "notify" (SPEC 9.7): Web Push to the bot owner's phones / computers.
//
// Deploy once (steps in supabase/README.md): Dashboard -> Edge Functions -> Deploy a new function -> Via Editor,
// name it  notify , paste this WHOLE file, and turn "Verify JWT" OFF (this function checks the shared secret or the
// user's token itself). Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, NOTIFY_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Two kinds of calls (POST, JSON body):
//   (a) the database (supabase/push.sql): header  x-notify-secret: <NOTIFY_SECRET>,
//       body {"bot_id": "<uuid>", "event": "open" | "close" | "daycap" | "offline", "row": {...journal row...}}
//       -> every push subscription of the bot's owner whose events include the event.
//   (b) the website: header  Authorization: Bearer <the user's access token>,  body {"event": "test", "endpoint"?}
//       -> only the caller's own subscriptions (only that one browser when "endpoint" is given).
// Subscriptions that answer 404 / 410 (expired or unsubscribed) are deleted.
// Push payload (JSON, read by docs/sw.js): {title, body, tag, url, event, bot_id, ts}.
//
// The block between BEGIN messages / END messages is plain JavaScript on purpose: supabase/tests/notify.test.js runs
// exactly that block in node, so the Thai texts and the CORS rule are unit-tested without Deno.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// ==== BEGIN messages ====
export const EVENTS = ["open", "close", "daycap", "offline"];
export const SITE_URL = "https://tataprin.github.io/dobby-web/";
export const OPEN_URL = SITE_URL + "#/dashboard";        // the page a click on the notification opens
export const ALLOWED_ORIGINS = ["https://tataprin.github.io"];

const SIDE_TH = { BUY: "ซื้อ", SELL: "ขาย" };
const REASON_TH = {
  TP: "ถึงเป้ากำไร", SL: "ตัดขาดทุน", LOCK: "ล็อกกำไร", MANUAL: "ปิดเอง", STOPOUT: "โบรกตัดไม้ (stop out)",
  EA: "บอทปิดเอง",
};

function num(x) {
  const v = typeof x === "number" ? x : parseFloat(String(x ?? ""));
  return Number.isFinite(v) ? v : null;
}

/** 4121.78 -> "4,121.78" (fixed decimals, comma thousands). */
export function fmtNum(x, digits = 2) {
  const v = num(x);
  if (v === null) return "-";
  const [i, f] = Math.abs(v).toFixed(digits).split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (v < 0 ? "-" : "") + int + (f !== undefined ? "." + f : "");
}

/** 83.2 -> "+83.20", -12.5 -> "-12.50". */
export function fmtSigned(x, digits = 2) {
  const v = num(x);
  if (v === null) return "-";
  return (v > 0 ? "+" : v < 0 ? "-" : "") + fmtNum(Math.abs(v), digits);
}

/** "reason=LOCK pos=4123 ..." -> "ล็อกกำไร"; an unknown EA reason is shown as it is; none / OTHER -> "". */
export function closeReason(detail) {
  const m = /reason=([A-Za-z0-9_]+)/.exec(String(detail ?? ""));
  if (!m) return "";
  const code = m[1].toUpperCase();
  if (code === "OTHER") return "";
  return REASON_TH[code] ?? m[1];
}

function clean(s, max = 60) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The notification for one event. bot = {id, name}; row = the journal row (open / close / daycap) or
 * {name, last_seen} (offline); opts.currency for CLOSE (default USD). Returns {title, body, tag, url, event,
 * bot_id, ts} or null for an unknown event.
 */
export function buildMessage(event, row, bot, opts = {}) {
  const r = row && typeof row === "object" ? row : {};
  const b = bot && typeof bot === "object" ? bot : {};
  const title = clean(b.name || r.name, 60) || "Dobby";
  const tag = clean(r.tag, 20) || "-";
  let body;
  if (event === "open") {
    const side = SIDE_TH[String(r.side ?? "").toUpperCase()] ?? clean(r.side, 10);
    body = `เปิดไม้ ${tag} ${side} ${fmtNum(r.lots, 2)} ล็อต ที่ ${fmtNum(r.price, 2)}`.replace(/\s+/g, " ");
  } else if (event === "close") {
    const why = closeReason(r.detail);
    body = `ปิดไม้ ${tag} ${fmtSigned(r.pnl ?? 0)} ${clean(opts.currency, 6) || "USD"}` + (why ? ` (${why})` : "");
  } else if (event === "daycap") {
    body = "ชนจุดหยุดรายวัน วันนี้ไม่เปิดไม้ใหม่";
  } else if (event === "offline") {
    body = `บอท ${title} ขาดการติดต่อ`;
  } else if (event === "test") {
    return { title: "Dobby", body: "ทดสอบการแจ้งเตือนจาก Dobby", tag: "dobby-test", url: OPEN_URL, event,
             bot_id: null, ts: opts.now ?? null };
  } else {
    return null;
  }
  const botId = b.id ?? null;
  const tagKey = event === "offline" || event === "daycap" ? `${event}:${botId}` : `${event}:${botId}:${r.id ?? ""}`;
  return { title, body, tag: tagKey, url: OPEN_URL, event, bot_id: botId, ts: opts.now ?? null };
}

/** CORS for the website: only listed origins get Access-Control-Allow-Origin. */
export function corsHeaders(origin, extraOrigins = []) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && [...ALLOWED_ORIGINS, ...extraOrigins].includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/** Constant-time comparison of two strings (the shared secret). */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** Push time-to-live (seconds) per event: trade news gets stale, a test is useless after a few minutes. */
export function ttlFor(event) {
  return event === "test" ? 300 : event === "daycap" ? 12 * 3600 : 6 * 3600;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ==== END messages ====

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

function serviceKey(): string {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try {   // projects that use the new API keys only: SUPABASE_SECRET_KEYS = {"default": "sb_secret_..."}
    const m = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    return m.default || Object.values(m)[0] || "";
  } catch {
    return "";
  }
}

const EXTRA_ORIGINS = env("NOTIFY_ALLOWED_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
const admin = createClient(env("SUPABASE_URL"), serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});
let vapidReady = false;

function reply(status: number, obj: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function approved(uid: string): Promise<boolean> {
  const { data } = await admin.from("profiles").select("approved,disabled").eq("id", uid).maybeSingle();
  return !!data && data.approved === true && data.disabled !== true;
}

type Sub = { id: number; endpoint: string; p256dh: string; auth: string };

async function sendAll(subs: Sub[], msg: Record<string, unknown>, ttl: number) {
  if (!vapidReady) {
    webpush.setVapidDetails(env("VAPID_SUBJECT"), env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
    vapidReady = true;
  }
  const payload = JSON.stringify(msg);
  const gone: number[] = [];
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload,
        { TTL: ttl, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) gone.push(s.id);
      else {
        failed++;
        console.error("push failed", code ?? "", String((e as Error)?.message ?? e).slice(0, 200));
      }
    }
  }));
  if (gone.length) await admin.from("push_subscriptions").delete().in("id", gone);
  return { sent, removed: gone.length, failed };
}

async function fromDatabase(body: Record<string, unknown>, cors: Record<string, string>): Promise<Response> {
  const botId = String(body.bot_id ?? "");
  const event = String(body.event ?? "");
  if (!UUID_RE.test(botId) || !EVENTS.includes(event)) return reply(400, { error: "bad_request" }, cors);
  const { data: bot } = await admin.from("bots").select("id,name,owner").eq("id", botId).maybeSingle();
  if (!bot) return reply(404, { error: "bot_not_found" }, cors);
  if (!(await approved(bot.owner))) return reply(200, { ok: true, sent: 0, skipped: "owner_not_approved" }, cors);
  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth")
    .eq("user_id", bot.owner).contains("events", [event]);
  if (!subs?.length) return reply(200, { ok: true, sent: 0 }, cors);
  let currency = "USD";
  if (event === "close") {
    const { data: st } = await admin.from("bot_status").select("status").eq("bot_id", botId).maybeSingle();
    currency = st?.status?.account?.currency || "USD";
  }
  const row = body.row && typeof body.row === "object" ? body.row : {};
  const msg = buildMessage(event, row, bot, { currency, now: new Date().toISOString() });
  return reply(200, { ok: true, ...(await sendAll(subs as Sub[], msg!, ttlFor(event))) }, cors);
}

async function fromUser(req: Request, body: Record<string, unknown>, cors: Record<string, string>): Promise<Response> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return reply(401, { error: "not_authenticated" }, cors);
  const { data, error } = await admin.auth.getUser(jwt);
  const uid = data?.user?.id;
  if (error || !uid) return reply(401, { error: "not_authenticated" }, cors);
  if (!(await approved(uid))) return reply(403, { error: "not_approved" }, cors);
  if (body.event !== "test") return reply(400, { error: "event_invalid" }, cors);
  let q = admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", uid);
  if (typeof body.endpoint === "string" && body.endpoint) q = q.eq("endpoint", body.endpoint);
  const { data: subs } = await q;
  if (!subs?.length) return reply(200, { ok: true, sent: 0, removed: 0, failed: 0 }, cors);
  const msg = buildMessage("test", {}, null, { now: new Date().toISOString() });
  return reply(200, { ok: true, ...(await sendAll(subs as Sub[], msg!, ttlFor("test"))) }, cors);
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"), EXTRA_ORIGINS);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" }, cors);
  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: "bad_json" }, cors);
    }
    if (!body || typeof body !== "object") return reply(400, { error: "bad_json" }, cors);
    if (!env("VAPID_PUBLIC_KEY") || !env("VAPID_PRIVATE_KEY") || !env("VAPID_SUBJECT")) {
      return reply(500, { error: "vapid_secrets_missing" }, cors);
    }
    const secret = req.headers.get("x-notify-secret");
    if (secret !== null) {          // (a) the database: the shared secret decides, never the JWT
      const want = env("NOTIFY_SECRET");
      if (want.length < 24 || !safeEqual(secret, want)) return reply(401, { error: "bad_secret" }, cors);
      return await fromDatabase(body, cors);
    }
    return await fromUser(req, body, cors);   // (b) the website: the user's own token
  } catch (e) {
    console.error("notify failed", String((e as Error)?.message ?? e).slice(0, 300));
    return reply(500, { error: "internal" }, cors);
  }
});
