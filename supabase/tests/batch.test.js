// Feature batch 2026-11-07 (SPEC 9): bars, cash_flows (+ audit), trade_notes, and the removal of the push objects
// (2026-11-08). Same pattern as rls.test.js: the approved owner writes, another member sees nothing, the admin reads
// but never writes, unapproved / disabled users see nothing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

let ctx, admin, bob, erin, carol, dave;
let botB, botE;

before(async () => {
  ctx = await freshDb({ runs: 2 });
  admin = await ctx.approvedUser('admin@example.test', 'admin');
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  carol = await ctx.createUser('carol@example.test');            // never approved
  dave = await ctx.approvedUser('dave@example.test');             // disabled below
  botB = await ctx.registerBot(bob, 'Bob PC');
  botE = await ctx.registerBot(erin, 'Erin PC');
  for (const [uid, bot] of [[bob, botB], [erin, botE]]) {
    await ctx.as(uid, `insert into public.bars (bot_id, t, close, vwap) values ($1, '2026-11-06T13:30:00Z', 4121.78, 4118.2)`, [bot]);
    await ctx.as(uid, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, '2026-11-05T03:00:00Z', 100, 'manual')`, [bot]);
    await ctx.as(uid, `insert into public.trade_notes (bot_id, trade_key, note, tags) values ($1, 'C5G|2026-11-06 15:30:00', 'n', '{ช่วงข่าว}')`, [bot]);
  }
  const daveBot = await ctx.registerBot(dave, 'Dave PC');
  await ctx.as(dave, `insert into public.bars (bot_id, t, close) values ($1, '2026-11-06T13:30:00Z', 4100)`, [daveBot]);
  await ctx.as(admin, `select public.admin_set_user($1, null, null, true)`, [dave]);
});

const count = async (who, table, where = 'true', params = []) =>
  (await ctx.as(who, `select count(*)::int as n from ${table} where ${where}`, params))[0].n;
const touched = async (who, sql, params = []) => (await ctx.as(who, sql + ' returning 1', params)).length;
const NEW_TABLES = ['public.bars', 'public.cash_flows', 'public.trade_notes'];

// ------------------------------------------------------------------------------------------------------ visibility
test('owner sees own rows; another member sees none of them', async () => {
  for (const t of ['public.bars', 'public.cash_flows', 'public.trade_notes']) {
    assert.equal(await count(bob, t), 1, `bob sees his ${t}`);
    assert.equal(await count(bob, t, 'bot_id = $1', [botE]), 0, `bob cannot read erin's ${t}`);
  }
});

test('unapproved and disabled users see nothing in the new tables', async () => {
  for (const t of NEW_TABLES) {
    assert.equal(await count(carol, t), 0, `carol sees nothing in ${t}`);
    assert.equal(await count(dave, t), 0, `disabled dave sees nothing in ${t} (not even his own rows)`);
  }
  await assert.rejects(ctx.as(carol, `insert into public.bars (bot_id, t, close) values ($1, now(), 1)`, [botB]), /row-level security/);
  assert.equal(await touched(dave, `delete from public.cash_flows`), 0);
});

test('admin reads every bar, cash flow and trade note', async () => {
  for (const t of ['public.bars', 'public.cash_flows', 'public.trade_notes'])
    assert.ok(await count(admin, t) >= 2, `admin reads all ${t}`);
  assert.equal(await count(admin, 'public.bars', 'bot_id = any($1::uuid[])', [[botB, botE]]), 2);
});

// ---------------------------------------------------------------------------------------------------------- writes
test('admin cannot write friends\' bars, cash flows or trade notes', async () => {
  await assert.rejects(ctx.as(admin, `insert into public.bars (bot_id, t, close) values ($1, now(), 1)`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(admin, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, now(), 5, 'manual')`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(admin, `insert into public.trade_notes (bot_id, trade_key) values ($1, 'x')`, [botB]), /row-level security/);
  assert.equal(await touched(admin, `update public.bars set close = 1 where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(admin, `update public.cash_flows set status = 'dismissed' where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(admin, `delete from public.cash_flows where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(admin, `update public.trade_notes set note = 'x' where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(admin, `delete from public.trade_notes where bot_id = $1`, [botB]), 0);
});

test('another member cannot write a bot that is not theirs', async () => {
  await assert.rejects(ctx.as(erin, `insert into public.bars (bot_id, t, close) values ($1, now(), 1)`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(erin, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, now(), 5, 'manual')`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(erin, `insert into public.trade_notes (bot_id, trade_key) values ($1, 'x')`, [botB]), /row-level security/);
  assert.equal(await touched(erin, `update public.cash_flows set amount = 1 where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(erin, `delete from public.trade_notes where bot_id = $1`, [botB]), 0);
  // moving own rows onto someone else's bot is refused by WITH CHECK
  await assert.rejects(ctx.as(erin, `update public.cash_flows set bot_id = $1 where bot_id = $2`, [botB, botE]), /row-level security/);
  await assert.rejects(ctx.as(erin, `update public.bars set bot_id = $1 where bot_id = $2`, [botB, botE]), /row-level security/);
});

// ------------------------------------------------------------------------------------------------------------ bars
test('bars: the agent upload (insert ... on conflict do nothing) works under RLS and ignores duplicates', async () => {
  const rows = [['2026-11-06T13:30:00Z', 9999], ['2026-11-06T13:45:00Z', 4123.4], ['2026-11-06T14:00:00Z', 4124.1]];
  const values = rows.map((_, i) => `($1, $${2 * i + 2}::timestamptz, $${2 * i + 3}::numeric, null)`).join(', ');
  await ctx.as(bob, `insert into public.bars (bot_id, t, close, vwap) values ${values} on conflict (bot_id, t) do nothing`,
    [botB, ...rows.flat()]);
  const got = await ctx.as(bob, `select t, close::float8 as close from public.bars where bot_id = $1 order by t`, [botB]);
  assert.deepEqual(got.map(r => r.close), [4121.78, 4123.4, 4124.1], 'the first row of a bar wins; new bars are added');
  // upsert (merge) is also allowed for the owner
  await ctx.as(bob, `insert into public.bars (bot_id, t, close) values ($1, '2026-11-06T14:00:00Z', 4125) on conflict (bot_id, t) do update set close = excluded.close`, [botB]);
  assert.equal((await ctx.as(bob, `select close::float8 as c from public.bars where bot_id = $1 and t = '2026-11-06T14:00:00Z'`, [botB]))[0].c, 4125);
  await assert.rejects(ctx.as(bob, `insert into public.bars (bot_id, t, close) values ($1, '2026-11-06T13:30:00Z', 1)`, [botB]), /duplicate key/);
});

test('bars: clients cannot delete (cascade only); deleting the bot removes its bars', async () => {
  await assert.rejects(ctx.as(bob, `delete from public.bars where bot_id = $1`, [botB]), /permission denied/);
  await assert.rejects(ctx.as(bob, `truncate public.bars`), /permission denied/);
  const [tmp] = await ctx.as(bob, `insert into public.bots (name) values ('Tmp bars') returning id`);
  await ctx.as(bob, `insert into public.bars (bot_id, t, close) values ($1, now(), 4000)`, [tmp.id]);
  await ctx.as(bob, `delete from public.bots where id = $1`, [tmp.id]);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.bars where bot_id = $1`, [tmp.id]))[0].n, 0);
});

// ------------------------------------------------------------------------------------------------------ cash_flows
test('cash_flows: owner CRUD with audit rows cash_flow_insert / update / delete (bot_id set), stamps by the server', async () => {
  const [cf] = await ctx.as(bob, `insert into public.cash_flows (bot_id, ts, amount, source, status, balance_after, note, created_at)
                                  values ($1, now(), 250.5, 'auto', 'suggested', 780.5, 'balance change not explained by Dobby trades', '2000-01-01')
                                  returning id, created_at, updated_at, status`, [botB]);
  assert.equal(cf.status, 'suggested');
  assert.ok(new Date(cf.created_at).getFullYear() >= 2026, 'created_at is the server time');
  await ctx.as(bob, `update public.cash_flows set status = 'confirmed', created_at = '2000-01-01' where id = $1`, [cf.id]);
  const [u] = await ctx.as(bob, `select status, created_at, updated_at from public.cash_flows where id = $1`, [cf.id]);
  assert.equal(u.status, 'confirmed');
  assert.equal(new Date(u.created_at).getTime(), new Date(cf.created_at).getTime(), 'created_at cannot be changed');
  assert.ok(new Date(u.updated_at) >= new Date(cf.updated_at));
  await ctx.as(bob, `delete from public.cash_flows where id = $1`, [cf.id]);
  const rows = await ctx.as(bob, `select action, bot_id, actor, before, after from public.audit
                                  where action like 'cash_flow_%' and coalesce(after->>'id', before->>'id') = $1 order by id`, [String(cf.id)]);
  assert.deepEqual(rows.map(r => r.action), ['cash_flow_insert', 'cash_flow_update', 'cash_flow_delete']);
  for (const r of rows) { assert.equal(r.bot_id, botB); assert.equal(r.actor, bob); }
  assert.equal(rows[1].before.status, 'suggested');
  assert.equal(rows[1].after.status, 'confirmed');
  assert.equal(rows[2].after, null);
  assert.equal(Number(rows[0].after.amount), 250.5);
  // the admin reads them (audit rows of bob's bot), erin does not
  assert.equal(await count(admin, 'public.audit', `action like 'cash_flow_%' and bot_id = $1`, [botB]), 4);
  assert.equal(await count(erin, 'public.audit', `action like 'cash_flow_%' and bot_id = $1`, [botB]), 0);
});

test('cash_flows: checks on amount, source and status', async () => {
  await assert.rejects(ctx.as(bob, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, now(), 0, 'manual')`, [botB]), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, now(), 5, 'bank')`, [botB]), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.cash_flows (bot_id, ts, amount, source, status) values ($1, now(), 5, 'manual', 'maybe')`, [botB]), /check constraint/);
  const [r] = await ctx.as(bob, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, now(), -40, 'manual') returning status`, [botB]);
  assert.equal(r.status, 'confirmed', 'status defaults to confirmed');
});

// ----------------------------------------------------------------------------------------------------- trade_notes
test('trade_notes: owner upserts a note; updated_by / updated_at come from the server', async () => {
  const key = 'NY|2026-11-06 16:00:00';
  await ctx.as(bob, `insert into public.trade_notes (bot_id, trade_key, note, updated_by) values ($1, $2, 'first', $3)`, [botB, key, erin]);
  let [n] = await ctx.as(bob, `select note, tags, updated_by from public.trade_notes where bot_id = $1 and trade_key = $2`, [botB, key]);
  assert.deepEqual(n, { note: 'first', tags: [], updated_by: bob });
  await ctx.as(bob, `insert into public.trade_notes (bot_id, trade_key, note, tags) values ($1, $2, 'second', '{ปิดเอง,ตลาดผันผวน}')
                     on conflict (bot_id, trade_key) do update set note = excluded.note, tags = excluded.tags`, [botB, key]);
  [n] = await ctx.as(bob, `select note, tags, updated_by from public.trade_notes where bot_id = $1 and trade_key = $2`, [botB, key]);
  assert.deepEqual(n, { note: 'second', tags: ['ปิดเอง', 'ตลาดผันผวน'], updated_by: bob });
  assert.equal(await touched(bob, `delete from public.trade_notes where bot_id = $1 and trade_key = $2`, [botB, key]), 1);
  await assert.rejects(ctx.as(bob, `insert into public.trade_notes (bot_id, trade_key) values ($1, '')`, [botB]), /check constraint/);
});

// ------------------------------------------------------------------------------------- removed push objects
test('schema.sql drops the push objects that the 2026-11-07 version created, and keeps the bots', async () => {
  await ctx.sql(`alter table public.bots add column if not exists offline_notified_at timestamptz`);
  await ctx.sql(`create table if not exists public.push_subscriptions (id bigserial primary key, endpoint text)`);
  await ctx.sql(`create or replace function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text,
                   p_ua text default null, p_events text[] default null) returns bigint language sql as 'select 1::bigint'`);
  await ctx.runSchemaAgain();
  const has = async (q) => (await ctx.sql(q)).length > 0;
  assert.equal(await has(`select 1 from pg_class where relname = 'push_subscriptions'`), false);
  assert.equal(await has(`select 1 from pg_proc where proname = 'register_push_subscription'`), false);
  assert.equal(await has(`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bots'
                          and column_name = 'offline_notified_at'`), false);
  assert.equal(await count(bob, 'public.bots', 'id = $1', [botB]), 1);
});

test('schema.sql runs again with data in the new tables and keeps it', async () => {
  const before = {};
  for (const t of NEW_TABLES) before[t] = (await ctx.sql(`select count(*)::int as n from ${t}`))[0].n;
  await ctx.runSchemaAgain();
  for (const t of NEW_TABLES) assert.equal((await ctx.sql(`select count(*)::int as n from ${t}`))[0].n, before[t], t);
  assert.equal(await count(bob, 'public.bars', 'bot_id = $1', [botB]), 3);
});
