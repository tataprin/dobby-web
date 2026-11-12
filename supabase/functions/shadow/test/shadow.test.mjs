// Edge Function `shadow` (SPEC 10.6): auth, validation, RPC errors, the Claude call (forced `decide` tool), the
// tighten check, cost, and that every answer (also a failed call) is recorded through shadow_record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, checkDecision, readPosition, costOf, SYSTEM_PROMPT, aggregate, ema, rsi, indicator, evaluate, checkOpen, lastStop } from '../index.ts';

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

const BARS = Array.from({ length: 200 }, (_, i) => ({ t: new Date(Date.UTC(2026, 10, 9, 0, 0) + i * 900e3).toISOString(), close: 4000 + i * 0.3 + (i % 7) - 3, vwap: 4020 }))
  .reverse();   // the table answers newest first
function fakeFetch({ user = { id: USER }, start = { model: 'claude-sonnet-5-5', interval_s: 300 }, startError = null, recordError = null, tables = {} } = {}) {
  const calls = [];
  const data = { bars: BARS, shadow_lessons: [], shadow_reviews: [], journal: [], shadow_decisions: [], ...tables };
  const f = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, headers: init.headers || {}, body, method: init.method || 'GET' });
    if (u.endsWith('/auth/v1/user')) return user ? new Response(JSON.stringify(user), { status: 200 }) : new Response('{}', { status: 401 });
    if (u.endsWith('/rpc/shadow_start')) return startError ? new Response(JSON.stringify({ message: startError }), { status: 400 }) : new Response(JSON.stringify(start), { status: 200 });
    if (u.endsWith('/rpc/shadow_record')) return recordError ? new Response(JSON.stringify({ message: recordError }), { status: 400 }) : new Response('42', { status: 200 });
    if (u.endsWith('/rpc/shadow_review_start')) return startError ? new Response(JSON.stringify({ message: startError }), { status: 400 }) : new Response(JSON.stringify({ model: 'claude-opus-5-5' }), { status: 200 });
    if (u.endsWith('/rpc/shadow_review_record')) return new Response(JSON.stringify({ review_id: 7, applied: body.p_ops.map((o, i) => ({ ...o, id: o.id ?? 100 + i })) }), { status: 200 });
    if (u.endsWith('/rpc/ai_scan_start')) return startError ? new Response(JSON.stringify({ message: startError }), { status: 400 }) : new Response(JSON.stringify({ model: 'claude-opus-5-5', interval_s: 1800, lots: 0.2, memory_rev: 2 }), { status: 200 });
    if (u.endsWith('/rpc/ai_scan_record')) return new Response(JSON.stringify({ scan_id: 11, trade: body.p_row.action === 'open' && body.p_row.valid ? { id: 5, ticket: 900000000005, side: body.p_row.side, entry: body.p_row.entry, sl: body.p_row.sl, tp: body.p_row.tp, lots: 0.2, status: 'open' } : null }), { status: 200 });
    if (u.endsWith('/rpc/ai_trade_apply')) return new Response(JSON.stringify({ trade: { id: body.p_trade, status: body.p_op.op === 'sl' ? 'open' : 'closed', ...body.p_op }, new_trade: body.p_op.op === 'reverse' ? { id: 6, ticket: 900000000006 } : null }), { status: 200 });
    const m = /\/rest\/v1\/(\w+)\?/.exec(u);
    if (m && data[m[1]]) return new Response(JSON.stringify(data[m[1]]), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}
/** reply: one answer for every call, or an array = one answer per call in order. */
function fakeAnthropic(reply) {
  const seen = [];
  let i = 0;
  const make = () => ({ messages: { create: async (p) => {
    seen.push(JSON.parse(JSON.stringify(p)));
    const r = Array.isArray(reply) ? reply[Math.min(i++, reply.length - 1)] : reply;
    if (r instanceof Error) throw r;
    return r;
  } } });
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
    details: { price_now: 4051.03, pnl_now: 28, new_sl: 4047.5, locked_pnl: -42.6, old_sl: 4043.93, sl_from: 4043.93, sl_to: 4047.5, sl_move: 'closer' } });
  assert.equal(out.valid, true);
  assert.equal(out.next_after_s, 300);
  const p = an.seen[0];
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.equal('tool_choice' in p, false);                           // Opus 5.5 / Sonnet 5.5 refuse a forced tool choice (400)
  assert.equal(p.max_tokens, 8000);                                  // room for the always-on thinking
  assert.ok(p.system.startsWith(SYSTEM_PROMPT));
  assert.ok(p.system.includes('memory is empty'));
  assert.deepEqual(p.tools.map((t) => t.name), ['get_indicators', 'get_price_history', 'get_trade_history', 'get_my_record', 'decide']);
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
  const wider = checkDecision({ action: 'tighten', new_sl: 4040, confidence: 50, reason: 'ถอย SL' }, buy);   // the owner allows a wider stop
  assert.deepEqual([wider.valid, wider.details.sl_move, wider.details.sl_from, wider.details.sl_to], [true, 'further', 4043.93, 4040]);
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4052, confidence: 50, reason: 'x' }, buy).valid, false);   // above bid
  assert.equal(checkDecision({ action: 'tighten', new_sl: null, confidence: 50, reason: 'x' }, buy).valid, false);
  const sell = readPosition({ ...SNAP, position: { ...SNAP.position, side: 'SELL', sl: 4056 } });
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4053, confidence: 50, reason: 'x' }, sell).valid, true);
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4050, confidence: 50, reason: 'x' }, sell).valid, false);   // under the ask: not a stop
  assert.equal(checkDecision({ action: 'tighten', new_sl: 4060, confidence: 50, reason: 'x' }, sell).details.sl_move, 'further');
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
  assert.deepEqual(h.details, { price_now: 4051.03, pnl_now: 28, hold_target: 4058.18, target_pnl: 171, hold_exit: 4046, exit_pnl: -72.6,
    sl_from: 4043.93, sl_to: 4046, sl_move: 'closer' });
  const h2 = checkDecision({ action: 'hold', hold_target: 4058.18, hold_exit: 4044, confidence: 40, reason: 'x' }, buy, 4046);   // vs the AI's last stop
  assert.equal(h2.details.sl_move, 'further');
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

test('data tools: the AI asks for indicators, gets them, then decides; usage of both rounds is counted; lessons are in the prompt', async () => {
  const lessons = [{ id: 3, text: 'อย่าปิดก่อนถึงจุดล็อกถ้ายังอยู่เหนือ VWAP', weight: 2 }];
  const reviews = [{ ticket: 1, module: 'C5G', side: 'BUY', summary: 's', mistakes: 'ปิดเร็วเกินไป', outcome: { close: { pnl: 120 }, checks: [{ action: 'close', delta: -80, verdict: 'worse' }] } }];
  const f = fakeFetch({ tables: { shadow_lessons: lessons, shadow_reviews: reviews }, start: { model: 'claude-opus-5-5', interval_s: 300, memory_rev: 1 } });
  const an = fakeAnthropic([
    { content: [{ type: 'tool_use', id: 'a', name: 'get_indicators', input: { timeframe: 'H1', specs: ['ema:20', 'rsi:14', 'macd', 'swings', 'levels'] } }], usage: { input_tokens: 1000, output_tokens: 50 }, stop_reason: 'tool_use' },
    toolReply({ action: 'hold', hold_target: 4058.18, hold_exit: 4046, confidence: 40, reason: 'ถือ' }, { input_tokens: 2000, output_tokens: 100 }),
  ]);
  const out = await (await createHandler({ env: ENV, fetch: f, anthropic: an })(post({ bot_id: BOT, snapshot: SNAP }))).json();
  assert.equal(out.decision.action, 'hold');
  assert.equal(out.memory_rev, 1);
  assert.deepEqual(out.decision.details.data_used, ['get_indicators:H1']);
  assert.equal(an.seen.length, 2);
  assert.ok(an.seen[0].system.includes('lesson #3, weight 2'));
  assert.ok(an.seen[0].system.includes('close: 1 decision(s), better 0, worse 1'));
  const result = JSON.parse(an.seen[1].messages[2].content[0].content);
  assert.equal(result.timeframe, 'H1');
  assert.ok(Number.isFinite(result['ema:20'].last) && Number.isFinite(result['rsi:14'].last) && 'hist' in result.macd);
  assert.ok(Array.isArray(result.swings.highs) && result.levels.prev_day);
  const rec = f.calls.find((c) => c.url.endsWith('/rpc/shadow_record'));
  assert.equal(rec.body.p_row.input_tokens, 3000);
  assert.equal(rec.body.p_row.memory_rev, 1);
  assert.equal(rec.body.p_row.cost_usd, 0.015);                      // opus: 3000 x 4 + 150 x 20 per million
});

test('the last round forces decide (no endless tool use)', async () => {
  const loop = { content: [{ type: 'tool_use', id: 'x', name: 'get_trade_history', input: { n: 5 } }], usage: {}, stop_reason: 'tool_use' };
  const an = fakeAnthropic([loop, loop, loop, loop, toolReply({ action: 'close', confidence: 55, reason: 'x' })]);
  const out = await (await createHandler({ env: ENV, fetch: fakeFetch(), anthropic: an })(post({ bot_id: BOT, snapshot: SNAP }))).json();
  assert.equal(an.seen.length, 5);
  assert.ok(an.seen.every((p) => !('tool_choice' in p)));
  const nudge = an.seen[4].messages.at(-1).content.at(-1);
  assert.equal(nudge.type, 'text');
  assert.ok(nudge.text.includes('call the tool decide now'));
  assert.equal(out.decision.action, 'close');
});

test('a text-only answer (thinking out loud) is nudged once, then the decision is taken', async () => {
  const text = { content: [{ type: 'thinking', thinking: '...', signature: 'sig' }, { type: 'text', text: 'ผมคิดว่าควรถือ' }], usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'end_turn' };
  const an = fakeAnthropic([text, toolReply({ action: 'hold', confidence: 40, reason: 'ถือ' })]);
  const out = await (await createHandler({ env: ENV, fetch: fakeFetch(), anthropic: an })(post({ bot_id: BOT, snapshot: SNAP }))).json();
  assert.equal(out.decision.action, 'hold');
  const second = an.seen[1].messages;
  assert.deepEqual(second[1].content, text.content);                 // the assistant turn goes back unchanged (preserved thinking)
  assert.ok(second[2].content.includes('call the tool decide'));
});

test('time budget: after 70 s of data rounds the next round is the last one', async () => {
  let t = 0;
  const loop = { content: [{ type: 'tool_use', id: 'x', name: 'get_trade_history', input: { n: 5 } }], usage: {}, stop_reason: 'tool_use' };
  const an = fakeAnthropic([loop, toolReply({ action: 'hold', confidence: 40, reason: 'x' })]);
  const fetchSlow = fakeFetch();
  const h = createHandler({ env: ENV, fetch: fetchSlow, anthropic: () => ({ messages: { create: async (p) => { t += 80_000; return an().messages.create(p); } } }), now: () => t });
  const out = await (await h(post({ bot_id: BOT, snapshot: SNAP }))).json();
  assert.equal(out.decision.action, 'hold');
  assert.equal(an.seen.length, 2);
  assert.ok(an.seen[1].messages.at(-1).content.at(-1).text.includes('No more data'));
});

test('indicators: ema / rsi / aggregate on known numbers', () => {
  const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ t: Date.UTC(2026, 0, 1, 0, i * 15), close: 100 + i, vwap: null }));
  const h1 = aggregate(rows, 'H1');
  assert.deepEqual(h1.map((b) => [b.o, b.h, b.l, b.c]), [[100, 103, 100, 103], [104, 107, 104, 107]]);
  assert.equal(ema([1, 2, 3], 1).at(-1), 3);
  assert.equal(rsi([1, 2, 3, 4, 5], 2).at(-1), 100);
  assert.equal(indicator(h1, 'nonsense').error, 'unknown indicator nonsense');
});

test('evaluate: close / hold / tighten / reverse against the real result', () => {
  const t0 = Date.UTC(2026, 10, 11, 12, 0);
  const iso = (m) => new Date(t0 + m * 60e3).toISOString();
  const close = { ts_utc: iso(60), pnl: -111.6, reason: 'SL' };
  const path = [[t0 + 10 * 60e3, 4055], [t0 + 30 * 60e3, 4049], [t0 + 50 * 60e3, 4044]];
  const decs = [
    { ts: iso(5), action: 'hold', profit: 30, details: { pnl_now: 30, hold_target: 4058, target_pnl: 167.4, hold_exit: 4046, exit_pnl: -72.6 } },
    { ts: iso(6), action: 'close', details: { pnl_now: 100, close_pnl: 100 } },
    { ts: iso(12), action: 'tighten', new_sl: 4050, details: { pnl_now: 100, new_sl: 4050, locked_pnl: 7.4 } },
    { ts: iso(20), action: 'reverse', details: { pnl_now: 60, close_pnl: 60, reverse: { side: 'SELL', entry: 4052.6, sl: 4057.6, tp: 4045, risk: -100, reward: 152 } } },
    { ts: iso(21), action: 'close', valid: false, details: {} },
  ];
  const ev = evaluate(decs, close, path, 'BUY', 4049.63, 0.2);
  assert.deepEqual(ev.checks.map((c) => [c.action, c.delta, c.verdict]), [
    ['hold', -141.6, 'worse'], ['close', 211.6, 'better'], ['tighten', 119, 'better'], ['reverse', 323.6, 'better']]);
  assert.equal(ev.checks[0].exit_touched, true);
  assert.equal(ev.checks[0].target_reached, false);
  assert.equal(ev.better, 3);
});

test('review mode: evaluates, asks Claude with the forced review tool, applies the lesson changes', async () => {
  const decisions = [{ ts: '2026-11-11T11:50:00Z', module: 'C5G', side: 'BUY', lots: 0.2, open_price: 4049.63, sl: 4043.93, tp: 4080.98, bid: 4051.03, ask: 4051.19,
    profit: 28, action: 'hold', confidence: 40, valid: true, reason: 'ถือ', details: { pnl_now: 28, hold_target: 4058.18, target_pnl: 171, hold_exit: 4046, exit_pnl: -72.6 } }];
  const f = fakeFetch({ tables: { shadow_decisions: decisions, shadow_lessons: [{ id: 3, text: 'x', weight: 1 }] } });
  const an = fakeAnthropic({ content: [{ type: 'tool_use', name: 'review', id: 'r', input: {
    summary: 'ไม้นี้โดน SL', mistakes: 'ควรปิดตอนหลุด 4,046',
    lessons: [{ op: 'add', id: null, text: 'ถ้าหลุดจุดออกที่ตั้งไว้ ให้ปิดทันที', why: 'w' }, { op: 'weaken', id: 3, text: null, why: 'w' }, { op: 'boom', id: 1, text: null, why: '' }] } }],
    usage: { input_tokens: 5000, output_tokens: 400 }, stop_reason: 'tool_use' });
  const body = { mode: 'review', bot_id: BOT, ticket: 432543137, close: { ts_utc: '2026-11-11T12:03:08Z', ts_server: '2026.11.11 14:03:08', price: 4044.05, pnl: -111.6, reason: 'SL' },
    bars_m15: [{ t_utc: '2026-11-11T11:45:00Z', close: 4052 }, { t_utc: '2026-11-11T12:00:00Z', close: 4045.2 }] };
  const out = await (await createHandler({ env: ENV, fetch: f, anthropic: an })(post(body))).json();
  assert.equal(out.ok, true);
  assert.equal(out.review_id, 7);
  assert.equal(out.applied.length, 2);                                 // the unknown op was dropped
  assert.equal('tool_choice' in an.seen[0], false);
  const sent = JSON.parse(an.seen[0].messages[0].content.split('\n').slice(1).join('\n'));
  assert.equal(sent.checks[0].verdict, 'worse');                        // holding from +28 to -111.60
  assert.equal(sent.your_lessons[0].id, 3);
  const rec = f.calls.find((c) => c.url.endsWith('/rpc/shadow_review_record'));
  assert.equal(rec.body.p_row.outcome.checks[0].exit_touched, true);
  assert.equal(rec.body.p_row.cost_usd, 0.028);
});

test('review mode: a failed AI call is not stored (the trade keeps its review for a retry)', async () => {
  const decisions = [{ ts: '2026-11-11T11:50:00Z', module: 'NY', side: 'SELL', lots: 0.2, open_price: 4010, sl: 4018, tp: 3978, bid: 4009.9, ask: 4010.1, profit: -4.6, action: 'hold', valid: true, details: {} }];
  for (const reply of [new Error('400 tool_choice'), { content: [{ type: 'text', text: 'hmm' }], usage: {}, stop_reason: 'end_turn' }]) {
    const f = fakeFetch({ tables: { shadow_decisions: decisions } });
    const r = await createHandler({ env: ENV, fetch: f, anthropic: fakeAnthropic(reply) })(post({ mode: 'review', bot_id: BOT, ticket: 432908888,
      close: { ts_utc: '2026-11-11T15:31:41Z', price: 4002.4, pnl: 148.8, reason: 'LOCK' }, bars_m15: [] }));
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error, 'ai_failed');
    assert.equal(f.calls.filter((c) => c.url.endsWith('/rpc/shadow_review_record')).length, 0);
  }
});

test('review mode: bad input and RPC refusals', async () => {
  const h = createHandler({ env: ENV, fetch: fakeFetch(), anthropic: fakeAnthropic(toolReply({})) });
  assert.equal((await h(post({ mode: 'review', bot_id: BOT, ticket: 'x', close: { pnl: 1 } }))).status, 400);
  const h2 = createHandler({ env: ENV, fetch: fakeFetch({ startError: 'review_done' }), anthropic: fakeAnthropic(toolReply({})) });
  const r = await h2(post({ mode: 'review', bot_id: BOT, ticket: 5, close: { pnl: 1 } }));
  assert.equal(r.status, 409);
});

// ------------------------------------------------------------------ AI trader (SPEC 10.8)
const scanReply = (input) => ({ content: [{ type: 'tool_use', name: 'trade', id: 't1', input }], usage: { input_tokens: 3000, output_tokens: 150 }, stop_reason: 'tool_use' });
const MARKET_SNAP = { server_time: '2026.11.11 15:00:00', market: { bid: 4050.0, ask: 4050.16 }, bars_m15: [] };

test('scan: the AI opens its own paper trade at the ask with its stop and target; the money is computed', async () => {
  const f = fakeFetch();
  const an = fakeAnthropic(scanReply({ action: 'open', side: 'BUY', sl: 4044.16, tp: 4059.16, confidence: 58, reason: 'ซื้อตามเทรนด์' }));
  const out = await (await createHandler({ env: ENV, fetch: f, anthropic: an })(post({ mode: 'scan', bot_id: BOT, snapshot: MARKET_SNAP }))).json();
  assert.equal(out.action, 'open');
  assert.equal(out.trade.ticket, 900000000005);
  assert.deepEqual(out.details, { entry: 4050.16, sl_dist: 6, tp_dist: 9, risk: -120, reward: 180, rr: 1.5 });
  assert.equal(an.seen[0].tools.at(-1).name, 'trade');
  assert.ok(an.seen[0].system.includes('YOUR OWN paper account'));
  const rec = f.calls.find((c) => c.url.endsWith('/rpc/ai_scan_record'));
  assert.equal(rec.body.p_row.entry, 4050.16);
  assert.equal(rec.body.p_row.lots, 0.2);
  assert.equal(rec.body.p_row.memory_rev, 2);
});

test('scan: wait, a stop on the wrong side (recorded as invalid, no trade) and the refusals', async () => {
  const wait = await (await createHandler({ env: ENV, fetch: fakeFetch(), anthropic: fakeAnthropic(scanReply({ action: 'wait', side: null, sl: null, tp: null, confidence: 20, reason: 'รอ' })) })(post({ mode: 'scan', bot_id: BOT, snapshot: MARKET_SNAP }))).json();
  assert.deepEqual([wait.action, wait.trade, wait.next_after_s], ['wait', null, 1800]);
  const bad = await (await createHandler({ env: ENV, fetch: fakeFetch(), anthropic: fakeAnthropic(scanReply({ action: 'open', side: 'SELL', sl: 4040, tp: 4041, confidence: 50, reason: 'x' })) })(post({ mode: 'scan', bot_id: BOT, snapshot: MARKET_SNAP }))).json();
  assert.deepEqual([bad.action, bad.valid, bad.trade], ['open', false, null]);
  for (const [code, status] of [['ai_trader_disabled', 403], ['ai_trade_open', 409], ['shadow_too_soon', 429]]) {
    const r = await createHandler({ env: ENV, fetch: fakeFetch({ startError: code }), anthropic: fakeAnthropic(toolReply({})) })(post({ mode: 'scan', bot_id: BOT, snapshot: MARKET_SNAP }));
    assert.equal(r.status, status, code);
  }
  assert.equal((await createHandler({ env: ENV, fetch: fakeFetch(), anthropic: fakeAnthropic(toolReply({})) })(post({ mode: 'scan', bot_id: BOT, snapshot: { market: {} } }))).status, 400);
  assert.equal(checkOpen({ action: 'open', side: 'BUY', sl: 4049.5, tp: 4060, confidence: 1, reason: '' }, MARKET_SNAP.market, 0.2).valid, false);   // stop under 1 $
});

test('own trade: the decision is applied to the paper trade (close / tighten / reverse); the bot\'s trades are never touched', async () => {
  const own = { ...SNAP, position: { ...SNAP.position, module: 'AI', ticket: 900000000005 } };
  for (const [reply, op] of [
    [{ action: 'close', confidence: 60, reason: 'x' }, 'close'],
    [{ action: 'tighten', new_sl: 4047, confidence: 60, reason: 'x' }, 'sl'],
    [{ action: 'reverse', reverse_sl: 4056.5, reverse_tp: 4042.5, confidence: 60, reason: 'x' }, 'reverse'],
  ]) {
    const f = fakeFetch();
    const out = await (await createHandler({ env: ENV, fetch: f, anthropic: fakeAnthropic(toolReply(reply)) })(post({ bot_id: BOT, snapshot: own }))).json();
    const ap = f.calls.find((c) => c.url.endsWith('/rpc/ai_trade_apply'));
    assert.equal(ap.body.p_trade, 5, op);
    assert.equal(ap.body.p_op.op, op);
    assert.ok(out.ai_trade, op);
  }
  const f2 = fakeFetch();
  await createHandler({ env: ENV, fetch: f2, anthropic: fakeAnthropic(toolReply({ action: 'close', confidence: 60, reason: 'x' })) })(post({ bot_id: BOT, snapshot: SNAP }));
  assert.equal(f2.calls.filter((c) => c.url.endsWith('/rpc/ai_trade_apply')).length, 0);       // a Dobby trade: log only
});

test('ai_trade_event: the app reports a stop / target hit', async () => {
  const f = fakeFetch();
  const out = await (await createHandler({ env: ENV, fetch: f, anthropic: fakeAnthropic(toolReply({})) })(post({ mode: 'ai_trade_event', bot_id: BOT, trade_id: 5, price: 4044.1, reason: 'sl' }))).json();
  assert.equal(out.ok, true);
  assert.deepEqual(f.calls.find((c) => c.url.endsWith('/rpc/ai_trade_apply')).body.p_op, { op: 'close', price: 4044.1, reason: 'sl' });
  assert.equal((await createHandler({ env: ENV, fetch: fakeFetch(), anthropic: fakeAnthropic(toolReply({})) })(post({ mode: 'ai_trade_event', bot_id: BOT, trade_id: 5, price: 1, reason: 'boom' }))).status, 400);
});

test('review of an AI paper trade without any management decision uses its opening plan', async () => {
  const trade = { opened_at: '2026-11-11T13:00:00Z', side: 'BUY', lots: 0.2, entry: 4050.16, first_sl: 4044.16, sl: 4044.16, tp: 4059.16, exit: 4044.16, pnl: -120, close_reason: 'sl', plan: { reason: 'ซื้อตามเทรนด์', confidence: 58 } };
  const f = fakeFetch({ tables: { ai_trades: [trade] } });
  const an = fakeAnthropic({ content: [{ type: 'tool_use', name: 'review', id: 'r', input: { summary: 's', mistakes: 'm', lessons: [] } }], usage: {}, stop_reason: 'tool_use' });
  const out = await (await createHandler({ env: ENV, fetch: f, anthropic: an })(post({ mode: 'review', bot_id: BOT, ticket: 900000000005,
    close: { ts_utc: '2026-11-11T13:40:00Z', price: 4044.16, pnl: -120, reason: 'sl' }, bars_m15: [] }))).json();
  assert.equal(out.ok, true);
  const sent = JSON.parse(an.seen[0].messages[0].content.split('\n').slice(1).join('\n'));
  assert.equal(sent.your_own_trade.open_plan.reason, 'ซื้อตามเทรนด์');
  assert.equal(sent.trade.strategy, 'AI');
});

// ------------------------------------------------------------------ 2026-11-13: earlier answers, binding stop, triggers
const PREV = [   // newest first, as the table answers
  { ts: '2026-11-12T16:52:00Z', action: 'hold', confidence: 50, valid: true, profit: -163.4, reason: 'ถือ ถอย SL', details: { hold_target: 3858.5, hold_exit: 3887.5, sl_move: 'further', trigger: 'price_move' } },
  { ts: '2026-11-12T16:46:00Z', action: 'hold', confidence: 58, valid: true, profit: -9.8, reason: 'ถือ', details: { hold_target: 3858.5, hold_exit: 3884, trigger: 'first' } },
];
const AI_SNAP = { ...SNAP, trigger: 'near_stop', position: { ...SNAP.position, module: 'AI', ticket: 900000000004, side: 'SELL', open_price: 3874.04, sl: 3887.5, tp: 3858.5, lots: 0.2 },
  market: { bid: 3880.3, ask: 3880.47 } };

test('the AI gets its earlier answers on this trade and why it is asked now; the trigger is stored', async () => {
  const f = fakeFetch({ tables: { shadow_decisions: PREV } });
  const an = fakeAnthropic(toolReply({ action: 'hold', hold_target: 3858.5, hold_exit: 3887.5, confidence: 55, reason: 'ถือ SL เดิม' }));
  await createHandler({ env: ENV, fetch: f, anthropic: an })(post({ bot_id: BOT, snapshot: AI_SNAP }));
  const msg = an.seen[0].messages[0].content;
  assert.ok(msg.startsWith('You are asked now because price is close to the stop.'));
  const prev = JSON.parse(msg.split('\n')[2]);
  assert.deepEqual(prev.map((p) => [p.time_utc, p.stop, p.stop_move, p.asked_because]), [['2026-11-12T16:46Z', 3884, null, 'first'], ['2026-11-12T16:52Z', 3887.5, 'further', 'price_move']]);
  const q = f.calls.find((c) => c.url.includes('/rest/v1/shadow_decisions?'));
  assert.ok(q.url.includes('ticket=eq.900000000004') && q.headers.Authorization === 'Bearer tok');   // the user's token (RLS)
  const rec = f.calls.find((c) => c.url.endsWith('/rpc/shadow_record'));
  assert.equal(rec.body.p_row.details.trigger, 'near_stop');
  assert.equal(f.calls.filter((c) => c.url.endsWith('/rpc/ai_trade_apply')).length, 0);       // same stop: nothing to change
});

test('own trade: a hold with a new stop moves the paper trade\'s stop (also further away); the move is labelled', async () => {
  const f = fakeFetch({ tables: { shadow_decisions: PREV } });
  const an = fakeAnthropic(toolReply({ action: 'hold', hold_target: 3858.5, hold_exit: 3889, confidence: 50, reason: 'ถอย SL จาก 3887.50 ไปที่ 3889.00' }));
  const out = await (await createHandler({ env: ENV, fetch: f, anthropic: an })(post({ bot_id: BOT, snapshot: AI_SNAP }))).json();
  assert.equal(out.decision.details.sl_move, 'further');
  assert.equal(out.decision.details.sl_from, 3887.5);
  const ap = f.calls.find((c) => c.url.endsWith('/rpc/ai_trade_apply'));
  assert.deepEqual(ap.body.p_op, { op: 'sl', sl: 3889 });
});

test('lastStop: the newest valid stop of the earlier answers', () => {
  assert.equal(lastStop([...PREV].reverse()), 3887.5);
  assert.equal(lastStop([{ action: 'tighten', valid: true, details: { new_sl: 3881 } }, { action: 'close', valid: true, details: {} }]), 3881);
  assert.equal(lastStop([{ action: 'hold', valid: false, details: { hold_exit: 1 } }]), null);
});

test('costOf uses the model prices and never under-counts an unknown model', () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 0 }), 4);
  assert.equal(costOf('mystery', { input_tokens: 1e6 }), 5);
});
