// Shadow AI (SPEC 10.6): ai_config shadow columns, shadow_decisions (read: owner + admin; write: service_role RPC only),
// shadow_start (approved, own bot, enabled, budget, interval) and shadow_record.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

let ctx, admin, bob, erin, carol, botB, botE;

const setConfig = async (fields) => {
  const keys = Object.keys(fields);
  await ctx.sql(`update public.ai_config set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} where id = 1`,
    Object.values(fields));
};
const start = async (user, bot, ticket) =>
  (await ctx.asService(`select public.shadow_start($1::uuid, $2::uuid, $3::bigint) as r`, [user, bot, ticket]))[0].r;
const record = async (user, bot, row) =>
  (await ctx.asService(`select public.shadow_record($1::uuid, $2::uuid, $3::jsonb) as id`, [user, bot, JSON.stringify(row)]))[0].id;
const row = (over = {}) => ({
  ticket: 432543137, module: 'C5G', side: 'BUY', lots: 0.2, open_price: 4049.63, sl: 4043.93, tp: 4080.98,
  bid: 4051.03, ask: 4051.19, profit: 28, server_time: '2026.11.11 13:39:47', action: 'hold', new_sl: null,
  confidence: 60, reason: 'ถือต่อ', valid: true, snapshot: { a: 1 }, model: 'claude-sonnet-5-5',
  input_tokens: 3000, output_tokens: 200, cost_usd: 0.008, ...over,
});
const rejects = async (p, code) => {
  await assert.rejects(p, (e) => String(e.message).includes(code), `expected ${code}`);
};

before(async () => {
  ctx = await freshDb({ runs: 2 });
  admin = await ctx.approvedUser('admin@example.test', 'admin');
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  carol = await ctx.createUser('carol@example.test');   // never approved
  botB = (await ctx.as(bob, `insert into public.bots (name) values ('Bob PC') returning id`))[0].id;
  botE = (await ctx.as(erin, `insert into public.bots (name) values ('Erin PC') returning id`))[0].id;
});

test('ai_config: shadow columns exist with the defaults (off, Opus 5.5, 30 USD, 300 s)', async () => {
  const [c] = await ctx.sql(`select shadow_enabled, shadow_model, shadow_budget_usd::float8 as b, shadow_interval_s from public.ai_config`);
  assert.deepEqual(c, { shadow_enabled: false, shadow_model: 'claude-opus-5-5', b: 30, shadow_interval_s: 300 });
  await rejects(ctx.sql(`update public.ai_config set shadow_model = 'gpt-4' where id = 1`), 'check');
  await rejects(ctx.sql(`update public.ai_config set shadow_interval_s = 10 where id = 1`), 'check');
});

test('shadow_start: refuses while off, for unapproved users and for someone else\'s bot', async () => {
  await rejects(start(bob, botB, 1), 'shadow_disabled');
  await setConfig({ shadow_enabled: true });
  await rejects(start(carol, botB, 1), 'not_approved');
  await rejects(start(bob, botE, 1), 'bot_not_found');
  const r = await start(bob, botB, 1);
  assert.deepEqual(r, { model: 'claude-opus-5-5', interval_s: 300 });
});

test('shadow_record + shadow_start: one question per trade per interval; other trades are not blocked', async () => {
  const id = await record(bob, botB, row({ ticket: 77, details: { close_price: 4051.03, close_pnl: 28 } }));
  assert.ok(Number(id) > 0);
  const [stored] = await ctx.sql(`select details from public.shadow_decisions where id = $1`, [id]);
  assert.deepEqual(stored.details, { close_price: 4051.03, close_pnl: 28 });
  const id2 = await record(bob, botB, row({ ticket: 79, details: 'not an object' }));
  assert.deepEqual((await ctx.sql(`select details from public.shadow_decisions where id = $1`, [id2]))[0].details, {});
  await rejects(start(bob, botB, 77), 'shadow_too_soon');
  assert.ok(await start(bob, botB, 78));
  await ctx.sql(`update public.shadow_decisions set ts = now() - interval '5 minutes' where ticket = 77`);
  assert.ok(await start(bob, botB, 77));
});

test('shadow_record: refuses someone else\'s bot and bad actions', async () => {
  await rejects(record(bob, botE, row()), 'bot_not_found');
  await rejects(record(bob, botB, row({ action: 'buy_more' })), 'check');
});

test('shadow_start: the monthly shadow budget stops it', async () => {
  await setConfig({ shadow_budget_usd: 0.01 });
  await record(bob, botB, row({ ticket: 90, cost_usd: 0.02 }));
  await rejects(start(bob, botB, 91), 'shadow_budget');
  await setConfig({ shadow_budget_usd: 30 });
  assert.ok(await start(bob, botB, 91));
});

test('shadow_decisions: owner and admin read, others do not; no client writes; RPCs are service only', async () => {
  await record(erin, botE, row({ ticket: 5 }));
  const n = async (who, bot) => (await ctx.as(who, `select count(*)::int as n from public.shadow_decisions where bot_id = $1`, [bot]))[0].n;
  assert.ok(await n(bob, botB) >= 1);
  assert.equal(await n(bob, botE), 0);
  assert.equal(await n(erin, botE), 1);
  assert.equal(await n(carol, botB), 0);
  assert.ok(await n(admin, botB) >= 1);
  assert.equal(await n(admin, botE), 1);
  await rejects(ctx.as(bob, `insert into public.shadow_decisions (bot_id, user_id, ticket, module, side, action)
                             values ($1, $2, 1, 'A_new', 'BUY', 'hold')`, [botB, bob]), 'permission denied');
  await rejects(ctx.as(bob, `delete from public.shadow_decisions where bot_id = $1`, [botB]), 'permission denied');
  await rejects(ctx.as(bob, `select public.shadow_start($1, $2, 1)`, [bob, botB]), 'permission denied');
  await rejects(ctx.as(bob, `select public.shadow_record($1, $2, '{}'::jsonb)`, [bob, botB]), 'permission denied');
});

test('admin can change the shadow settings; a member cannot', async () => {
  const upd = async (who) => (await ctx.as(who, `update public.ai_config set shadow_interval_s = 600 where id = 1 returning shadow_interval_s`)).length;
  assert.equal(await upd(bob), 0);
  assert.equal(await upd(admin), 1);
});
