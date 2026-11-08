// A local stand-in for everything the chat function talks to: GoTrue (/auth/v1/user), PostgREST (/rest/v1/<table>,
// /rest/v1/rpc/<fn>) with a small RLS model, and the Anthropic Messages API (/v1/messages) answering with scripted
// SSE streams. Every request is recorded so tests can check which key was sent where.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

// a legacy service_role key is a JWT; projects on the new API keys have an sb_secret_ key instead
export const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.ZmFrZS1zaWduYXR1cmU';
export const SECRET_KEY = 'sb_secret_test_not_real';
export const ANON_KEY = 'sb_publishable_test';

const BOT_TABLES = new Set(['bot_status', 'bot_control', 'journal', 'trade_notes', 'bars', 'cash_flows', 'rounds']);

export async function startFake() {
  const state = {
    users: {},          // token -> {id, email, role}
    tables: {
      profiles: [], bots: [], bot_status: [], bot_control: [], journal: [], trade_notes: [], bars: [], cash_flows: [], rounds: [],
      presets: [], news_events: [], ai_conversations: [], ai_messages: [],
    },
    rpc: {
      ai_start_turn: () => ({ usage_id: 501, model: 'claude-opus-5-5', used_today: 3, limit_today: 20, role: 'member' }),
      ai_finish_turn: () => null,
    },
    anthropic: [],       // queue: each item = {sse: [events]} | {status, error: {type, message}} | (body) => item
    requests: [],        // every request: {method, path, query, headers, body}
    claudeBodies: [],    // parsed /v1/messages bodies
    nextMessageId: 1000,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const rec = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body };
    state.requests.push(rec);
    try {
      if (url.pathname === '/v1/messages') return anthropic(state, rec, res);
      if (url.pathname === '/auth/v1/user') return gotrue(state, rec, res);
      if (url.pathname.startsWith('/rest/v1/rpc/')) return rpc(state, rec, res);
      if (url.pathname.startsWith('/rest/v1/')) return rest(state, rec, res);
      send(res, 404, { message: 'not found' });
    } catch (e) {
      send(res, 500, { message: String(e && e.stack || e) });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`, state,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    reqs: (pred) => state.requests.filter(pred),
  };
}

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

function who(state, rec) {
  const auth = String(rec.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (rec.headers.apikey === SERVICE_KEY && auth === SERVICE_KEY) return { service: true };
  if (rec.headers.apikey === SECRET_KEY && (!rec.headers.authorization || auth === SECRET_KEY)) return { service: true };
  if ([SERVICE_KEY, SECRET_KEY].includes(rec.headers.apikey)) return null;
  const u = state.users[auth];
  return u ? { uid: u.id, admin: u.role === 'admin' } : null;
}

function gotrue(state, rec, res) {
  const auth = String(rec.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const u = state.users[auth];
  if (!rec.headers.apikey) return send(res, 401, { msg: 'No API key found in request' });
  if (!u) return send(res, 401, { msg: 'invalid JWT' });
  send(res, 200, { id: u.id, email: u.email, aud: 'authenticated' });
}

function rpc(state, rec, res) {
  const fn = rec.path.slice('/rest/v1/rpc/'.length);
  const w = who(state, rec);
  if (!w || !w.service) return send(res, 401, { code: '42501', message: `permission denied for function ${fn}` });
  const h = state.rpc[fn];
  if (!h) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
  const out = h(rec.body);
  if (out && out.raise) return send(res, 400, { code: 'P0001', message: out.raise, details: null, hint: null });
  if (out === null || out === undefined) { res.writeHead(204); return res.end(); }
  send(res, 200, out);
}

// ---------------------------------------------------------------- PostgREST
function visible(state, table, row, w) {
  if (w.service) return true;
  const t = state.tables;
  const botOk = (id) => { const b = t.bots.find((x) => x.id === id); return !!b && (b.owner === w.uid || w.admin); };
  if (table === 'bots') return row.owner === w.uid || w.admin;
  if (BOT_TABLES.has(table)) return botOk(row.bot_id);
  if (table === 'presets') return row.owner === w.uid || w.admin;
  if (table === 'profiles') return row.id === w.uid || w.admin;
  if (table === 'news_events') return true;
  if (table === 'ai_conversations' || table === 'ai_messages') return row.user_id === w.uid; // chats are private
  return false;
}
const asTime = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return NaN;
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v.replace(' ', 'T')}Z`;
  return Date.parse(s);
};
function cmp(a, b) {
  const ta = asTime(a), tb = asTime(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  const na = Number(a), nb = Number(b);
  if (a !== null && a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function matches(row, col, expr) {
  const i = expr.indexOf('.');
  const op = expr.slice(0, i), arg = expr.slice(i + 1);
  const v = row[col];
  switch (op) {
    case 'eq': return v !== null && v !== undefined && (String(v) === arg || (typeof v === 'number' && Number(arg) === v));
    case 'neq': return String(v) !== arg;
    case 'gt': return v !== null && cmp(v, arg) > 0;
    case 'gte': return v !== null && cmp(v, arg) >= 0;
    case 'lt': return v !== null && cmp(v, arg) < 0;
    case 'lte': return v !== null && cmp(v, arg) <= 0;
    case 'in': return arg.replace(/^\(|\)$/g, '').split(',').includes(String(v));
    case 'ilike': {
      const re = new RegExp(`^${arg.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return re.test(String(v ?? ''));
    }
    case 'is': return arg === 'null' ? v === null || v === undefined : String(v) === arg;
    default: throw new Error(`unsupported operator ${op}`);
  }
}
function rest(state, rec, res) {
  const table = rec.path.slice('/rest/v1/'.length);
  const rows = state.tables[table];
  if (!rows) return send(res, 404, { code: '42P01', message: `relation "public.${table}" does not exist` });
  const w = who(state, rec);
  if (!w) return send(res, 401, { code: 'PGRST301', message: 'JWT invalid' });
  if (rec.method === 'GET') {
    let out = rows.filter((r) => visible(state, table, r, w));
    for (const [k, v] of rec.query.entries()) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      out = out.filter((r) => matches(r, k, v));
    }
    const order = rec.query.get('order');
    if (order) {
      const keys = order.split(',').map((s) => { const [c, d] = s.split('.'); return [c, d === 'desc' ? -1 : 1]; });
      out = [...out].sort((a, b) => { for (const [c, d] of keys) { const x = cmp(a[c], b[c]); if (x) return x * d; } return 0; });
    }
    const off = Number(rec.query.get('offset') || 0), lim = rec.query.get('limit');
    out = out.slice(off, lim === null ? undefined : off + Number(lim));
    return send(res, 200, out.map((r) => JSON.parse(JSON.stringify(r))));
  }
  if (rec.method === 'POST') {
    const list = Array.isArray(rec.body) ? rec.body : [rec.body];
    const made = [];
    for (const r0 of list) {
      const r = { ...r0 };
      if (table === 'ai_conversations') Object.assign(r, { id: r.id || randomUUID(), user_id: r.user_id || w.uid, title: r.title || 'บทสนทนาใหม่', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      if (table === 'ai_messages') {
        Object.assign(r, { id: state.nextMessageId++, user_id: r.user_id || w.uid, created_at: new Date().toISOString() });
        const conv = state.tables.ai_conversations.find((c) => c.id === r.conversation_id);
        if (!conv || conv.user_id !== w.uid) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
        if (!(r.content && r.content.length >= 1 && r.content.length <= 30000)) return send(res, 400, { code: '23514', message: 'content check' });
      }
      if (!w.service && !visible(state, table, r, w)) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
      made.push(r);
    }
    rows.push(...made);
    if (String(rec.headers.prefer || '').includes('return=representation')) return send(res, 201, made);
    res.writeHead(201); return res.end();
  }
  send(res, 405, { message: 'method not supported by the fake' });
}

// ---------------------------------------------------------------- Anthropic
function anthropic(state, rec, res) {
  state.claudeBodies.push(rec.body);
  let item = state.anthropic.shift();
  if (typeof item === 'function') item = item(rec.body, state.claudeBodies.length);
  if (!item) return send(res, 500, { type: 'error', error: { type: 'api_error', message: 'fake: no scripted response left' } });
  if (item.status) return send(res, item.status, { type: 'error', error: item.error });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_${state.claudeBodies.length}` });
  for (const ev of item.sse) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}
