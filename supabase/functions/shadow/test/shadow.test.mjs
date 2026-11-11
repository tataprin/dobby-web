// Edge Function `shadow` (SPEC 10.6): auth, validation, RPC errors, the Claude call (forced `decide` tool), the
// tighten check, cost, and that every answer (also a failed call) is recorded through shadow_record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, checkDecision, readPosition, costOf, SYSTEM_PROMPT } from '../index.ts';

const URL_ = 'https://proj.supabase.co';
const USER = '11111111-1111-4111-8111-111111111111';
const BOT = '22222222-2222-4222-8222-222222222222';
const ENV = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'a.b.c', ANTHROPIC_API_KEY: 'sk-test' };

const SNAP = {
  server_time: '2026.11.11 13:39:47',
  position: { ticket: 432543137, module: 'C5G', side: 'BUY', lots: 0.2, open_price: 4049.63, sl: 4043.93, tp: 4080.98, profit: 28, comment: 'D3 C5 d5.70 t8.55' },
  market: { bid: 4051.03, ask: 4051.19 },
  bars_m15: [{ t_utc: '2026-11-11T11:30:00Z', close: 4051 }],
};

function fakeFetch({ user = { id: USER }, start = { model: 'claude-sonnet-5-5', interval_s: 300 }, startError = null, recordError = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, headers: init.headers || {}, body });
    if (u.endsWith('/auth/v1/user')) return user ? new Response(JSON.stringify(user), { status: 200 }) : new Response('{}', { status: 401 });
    if (u.endsWith('/rpc/shadow_start')) return startError ? new Response(JSON.stringify({ message: startError }), { status: 400 }) : new Response(JSON.stringify(start), { status: 200 });
    if (u.endsWith('/rpc/shadow_record')) return recordError ? new Response(JSON.stringify({ message: recordError }), { status: 400 }) : new Response('42', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}
function fakeAnthropic(reply) {
  const seen = [];
  const make = () => ({ messages: { create: async (p) => { seen.push(p); if (reply instanceof Error) throw reply; return reply; } } });
  make.seen = seen;
  return make;
}
const toolReply = (input, usage = { input_tokens: 3000, output_tokens: 150 }) =>
  ({ content: [{ type: 'tool_use', name: 'decide', id: 't1', input }], usage, stop_reason: 'tool_use' });
const post = (body, headers = { authorization: 'Bearer tok' }) =>
  new Request('https://fn/shadow', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('rejects missing token, bad user, bad body and bad snapshot', async () => {
  const h = createHandler({ env: ENV, fetch: fakeFetch(), anthropic: fakeAnthropic(toolReply({})) });
  assert.equal((await h(post({ bot_id: BOT, snapshot: SNAP }, {}))).status, 401);
  const h2 = createHandler({ env: ENV, fetch: fakeFetch({ user: null }), anthropic: fakeAnthropic(toolReply({})) });
  assert.equal((await h2(post({ bot_id: BOT, snapshot: SNAP }))).status, 401);
  assert.equal((await h(post('not json'))).status, 400);
  assert.equal((await h(post({ bot_id: 'x', snapshot: SNAP }))).status, 400);
  assert.equal((await h(post({ bot_id: BOT, snapshot: { position: { ticket: 1 } } }))).status, 400);
  assert.equal((await h(new Request('https://fn/shadow', { method: 'GET' }))).status, 405);
});

test('maps shadow_start errors and does not call Claude', async () => {
  for (const [code, status] of [['shadow_disabled', 403], ['shadow_budget', 429], ['shadow_too_soon', 429], ['bot_not_found', 404], ['not_approved', 403]]) {
    const an = fakeAnthropic(toolReply({}));
    const h = createHandler({ env: ENV, fetch: fakeFetch({ startError: code }), anthropic: an });
    const r = await h(post({ bot_id: BOT, snapshot: SNAP }));
    assert.equal(r.status, status, code);
    assert.equal((await r.json()).error, code);
    assert.equal(an.seen.length, 0);
  }
});

test('503 when the API key or the service key is missing', async () => {
  const h = createHandler({ env: { ...ENV, ANTHROPIC_API_KEY: '' }, fetch: fakeFetch(), anthropic: fakeAnthropic(toolReply({})) });
  assert.equal((await h(post({ bot_id: BOT, snapshot: SNAP }))).status, 503);
});

test('asks Claude with the forced decide tool and records the decision with cost', async () => {
  const f = fakeFetch();
  const an = fakeAnthropic(toolReply({ action: 'tighten', new_sl: 4047.5, confidence: 64, reason: 'ราคาย่อ' }));
  const h = createHandler({ env: ENV, fetch: f, anthropic: an });
  const r = await h(post({ bot_id: BOT, snapshot: SNAP }));
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.decision, { action: 'tighten', new_sl: 4047.5, confidence: 64, reason: 'ราคาย่อ',
    details: { price_now: 4051.03, pnl_now: 28, new_sl: 4047.5, locked_pnl: -42.6, old_sl: 4043.93 } });
  assert.equal(out.valid, true);
  assert.equal(out.next_after_s, 300);
  const p = an.seen[0];
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.deepEqual(p.tool_choice, { type: 'tool', name: 'decide' });
  assert.equal(p.system, SYSTEM_PROMPT);
  assert.ok(p.messages[0].content.includes('432543137'));
  const rec = f.calls.find((c) => c.url.endsWith('/rpc/shadow_record'));
  assert.equal(rec.body.p_user, USER);
  assert.equal(rec.body.p_bot, BOT);
  assert.equal(rec.body.p_row.action, 'tighten');
  assert.equal(rec.body.p_row.ticket, 432543137);
  assert.equal(rec.body.p_row.cost_usd, 0.0075);   // 3000 x 2 + 150 x 10 per million
  assert.equal(rec.body.p_row.details.locked_pnl, -42.6);
  assert.equal(rec.headers.apikey, 'a.b.c');          // service key only on the RPCs
  const auth = f.calls.find((c) => c.url.endsWith('/auth/v1/user'));
  assert.equal(auth.headers.Authorization, 'Bearer tok');
});

test('a failed Claude call is recorded as action error (so the interval still applies)', async () => {
  const f = fakeFetch();
  const h = createHandler({ env: ENV, fetch: f, anthropic: fakeAnthropic(new Error('overloaded')) });
  const out = await (await h(post({ bot_id: BOT, snapshot: SNAP }))).json();
  assert.equal(out.ok, false);
  assert.equal(out.error, 'ai_failed');
  const rec = f.calls.find((c) => c.url.endsWith('/rpc/shadow_record'));
  assert.equal(rec.body.p_row.action, 'error');
  assert.equal(rec.body.p_row.valid, false);
});

test('checkDecision: tighten must sit between the stop and the price; unknown actions become invalid hold', () => {
  const buy = readPosition(SNAP);
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4045, confidence: 50, reason: 'x' }, buy).valid, true);
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4040, confidence: 50, reason: 'x' }, buy).valid, false);   // wider
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4052, confidence: 50, reason: 'x' }, buy).valid, false);   // above bid
  assert.equal(checkDecision({ action: 'tighten', new_sl: null, confidence: 50, reason: 'x' }, buy).valid, false);
  const sell = readPosition({ ...SNAP, position: { ...SNAP.position, side: 'SELL', sl: 4056 } });
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4053, confidence: 50, reason: 'x' }, sell).valid, true);
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4050, confidence: 50, reason: 'x' }, sell).valid, false);
  const odd = checkDecision({ action: 'buy_more', confidence: 300, reason: 'x' }, buy);
  assert.deepEqual([odd.action, odd.valid, odd.confidence], ['hold', false, 100]);
  assert.equal(checkDecision({ action: 'close', new_sl: 1, confidence: 70, reason: 'x' }, buy).new_sl, null);
});

test('details: close / reverse / hold turn the AI prices into money at the trade lots (0.20 lot = 20 USD per 1 $)', () => {
  const buy = readPosition(SNAP);   // BUY 0.2 from 4049.63, bid 4051.03, ask 4051.19
  const c = checkDecision({ action: 'close', confidence: 60, reason: 'x' }, buy);
  assert.deepEqual(c.details, { price_now: 4051.03, pnl_now: 28, close_price: 4051.03, close_pnl: 28 });
  const r = checkDecision({ action: 'reverse', reverse_sl: 4056.5, reverse_tp: 4042.5, confidence: 55, reason: 'x' }, buy);
  assert.equal(r.valid, true);
  assert.deepEqual(r.details.reverse, { side: 'SELL', lots: 0.2, entry: 4051.03, sl: 4056.5, tp: 4042.5, risk: -109.4, reward: 170.6, sl_dist: 5.47, tp_dist: 8.53 });
  assert.equal(r.details.total_if_tp, 198.6);
  assert.equal(r.details.total_if_sl, -81.4);
  assert.equal(checkDecision({ action: 'reverse', reverse_sl: 4045, reverse_tp: 4042.5, confidence: 55, reason: 'x' }, buy).valid, false); // stop below a SELL entry
  assert.equal(checkDecision({ action: 'reverse', reverse_sl: null, reverse_tp: 4042.5, confidence: 55, reason: 'x' }, buy).valid, false);
  const h = checkDecision({ action: 'hold', hold_target: 4058.18, hold_exit: 4046, confidence: 40, reason: 'x' }, buy);
  assert.deepEqual(h.details, { price_now: 4051.03, pnl_now: 28, hold_target: 4058.18, target_pnl: 171, hold_exit: 4046, exit_pnl: -72.6 });
  const wrong = checkDecision({ action: 'hold', hold_target: 4040, hold_exit: 4060, confidence: 40, reason: 'x' }, buy);
  assert.deepEqual(wrong.details, { price_now: 4051.03, pnl_now: 28 });   // prices on the wrong side are dropped
  const sell = readPosition({ ...SNAP, position: { ...SNAP.position, side: 'SELL', open_price: 4060 } });
  const rs = checkDecision({ action: 'reverse', reverse_sl: 4046, reverse_tp: 4060, confidence: 55, reason: 'x' }, sell);
  assert.equal(rs.details.reverse.side, 'BUY');
  assert.equal(rs.details.reverse.entry, 4051.19);                       // a new BUY fills at the ask
  assert.equal(rs.details.close_pnl, 176.2);                              // a SELL closes at the ask: (4060 - 4051.19) x 20
});

test('the prompt asks for prices with every action and the tool requires all of them', () => {
  for (const k of ['hold_target', 'hold_exit', 'reverse_sl', 'reverse_tp', 'new_sl']) assert.ok(SYSTEM_PROMPT.includes(k), k);
});

test('costOf uses the model prices and never under-counts an unknown model', () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 0 }), 4);
  assert.equal(costOf('mystery', { input_tokens: 1e6 }), 5);
});
