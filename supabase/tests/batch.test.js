// Feature batch 2026-11-07 (SPEC 9): bars, cash_flows (+ audit), trade_notes, push_subscriptions,
// bots.offline_notified_at. Same pattern as rls.test.js: the approved owner writes, another member sees nothing, the
// admin reads (except push_subscriptions) but never writes, unapproved / disabled users see nothing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

let ctx, admin, bob, erin, carol, dave;
let botB, botE;

const SUB = (n, extra = {}) => ({ endpoint: `https://push.example.test/send/${n}`, p256dh: `BPk-${n}-key`, auth: `au-${n}`, ...extra });

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
  await ctx.as(bob, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)`, Object.values(SUB('bob')));
  await ctx.as(erin, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)`, Object.values(SUB('erin')));
  const daveBot = await ctx.registerBot(dave, 'Dave PC');
  await ctx.as(dave, `insert into public.bars (bot_id, t, close) values ($1, '2026-11-06T13:30:00Z', 4100)`, [daveBot]);
  await ctx.as(dave, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)`, Object.values(SUB('dave')));
  await ctx.as(admin, `select public.admin_set_user($1, null, null, true)`, [dave]);
});

const count = async (who, table, where = 'true', params = []) =>
  (await ctx.as(who, `select count(*)::int as n from ${table} where ${where}`, params))[0].n;
const touched = async (who, sql, params = []) => (await ctx.as(who, sql + ' returning 1', params)).length;
const NEW_TABLES = ['public.bars', 'public.cash_flows', 'public.trade_notes', 'public.push_subscriptions'];

// ------------------------------------------------------------------------------------------------------ visibility
test('owner sees own rows; another member sees none of them', async () => {
  for (const t of ['public.bars', 'public.cash_flows', 'public.trade_notes']) {
    assert.equal(await count(bob, t), 1, `bob sees his ${t}`);
    assert.equal(await count(bob, t, 'bot_id = $1', [botE]), 0, `bob cannot read erin's ${t}`);
  }
  assert.equal(await count(bob, 'public.push_subscriptions'), 1);
  assert.deepEqual((await ctx.as(bob, `select endpoint from public.push_subscriptions`)).map(r => r.endpoint), [SUB('bob').endpoint]);
});

test('unapproved and disabled users see nothing in the new tables', async () => {
  for (const t of NEW_TABLES) {
    assert.equal(await count(carol, t), 0, `carol sees nothing in ${t}`);
    assert.equal(await count(dave, t), 0, `disabled dave sees nothing in ${t} (not even his own rows)`);
  }
  await assert.rejects(ctx.as(carol, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://x.test/c', 'k', 'a')`), /row-level security/);
  await assert.rejects(ctx.as(carol, `insert into public.bars (bot_id, t, close) values ($1, now(), 1)`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(dave, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://x.test/d2', 'k', 'a')`), /row-level security/);
  assert.equal(await touched(dave, `delete from public.push_subscriptions`), 0);
});

test('admin reads every bar, cash flow and trade note, but no push subscription of anyone else', async () => {
  for (const t of ['public.bars', 'public.cash_flows', 'public.trade_notes'])
    assert.ok(await count(admin, t) >= 2, `admin reads all ${t}`);
  assert.equal(await count(admin, 'public.bars', 'bot_id = any($1::uuid[])', [[botB, botE]]), 2);
  assert.equal(await count(admin, 'public.push_subscriptions'), 0, 'no admin read on push_subscriptions');
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
  assert.equal(await touched(admin, `update public.push_subscriptions set events = '{}' where user_id = $1`, [bob]), 0);
  assert.equal(await touched(admin, `delete from public.push_subscriptions where user_id = $1`, [bob]), 0);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.push_subscriptions where user_id = $1`, [bob]))[0].n, 1);
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
  await assert.rejects(ctx.as(erin, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://x.test/e2', 'k', 'a')`, [bob]), /row-level security/);
  await assert.rejects(ctx.as(erin, `update public.push_subscriptions set user_id = $1`, [bob]), /row-level security/);
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

// ---------------------------------------------------------------------------------------------- push_subscriptions
test('push_subscriptions: own rows, user_id defaults to the caller, events are checked, endpoint is unique', async () => {
  const s = SUB('bob-phone');
  const [r] = await ctx.as(bob, `insert into public.push_subscriptions (endpoint, p256dh, auth, ua) values ($1, $2, $3, 'iPhone') returning user_id, events`, [s.endpoint, s.p256dh, s.auth]);
  assert.deepEqual(r, { user_id: bob, events: ['open', 'close', 'daycap', 'offline'] });
  assert.equal(await touched(bob, `update public.push_subscriptions set events = '{close,offline}' where endpoint = $1`, [s.endpoint]), 1);
  await assert.rejects(ctx.as(bob, `update public.push_subscriptions set events = '{close,spam}' where endpoint = $1`, [s.endpoint]), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('http://insecure.test/x', 'k', 'a')`), /check constraint/);
  await assert.rejects(ctx.as(erin, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, 'k', 'a')`, [s.endpoint]), /duplicate key/);
  assert.equal(await touched(bob, `delete from public.push_subscriptions where endpoint = $1`, [s.endpoint]), 1);
});

test("push_subscriptions: the website upsert (on_conflict=endpoint) updates its own row, never another account's", async () => {
  const s = SUB('upsert');
  const upsert = (who, events) => ctx.as(who, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, ua, events)
      values (auth.uid(), $1, $2, $3, 'Firefox', $4::text[])
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, events = excluded.events
      returning user_id, events`, [s.endpoint, s.p256dh, s.auth, events]);
  assert.deepEqual(await upsert(bob, ['open']), [{ user_id: bob, events: ['open'] }]);
  assert.deepEqual(await upsert(bob, ['open', 'offline']), [{ user_id: bob, events: ['open', 'offline'] }]);
  await assert.rejects(upsert(erin, ['close']), /row-level security/);
  assert.deepEqual((await ctx.sql(`select user_id, events from public.push_subscriptions where endpoint = $1`, [s.endpoint]))[0],
    { user_id: bob, events: ['open', 'offline'] });
  await ctx.as(bob, `delete from public.push_subscriptions where endpoint = $1`, [s.endpoint]);
});

test('register_push_subscription: saves for the caller, keeps chosen events, takes over a browser from another account', async () => {
  const s = SUB('shared-pc');
  const call = (who, events = null) => ctx.as(who, `select public.register_push_subscription($1, $2, $3, 'Chrome', $4::text[]) as id`,
    [s.endpoint, s.p256dh, s.auth, events]);
  const [{ id }] = await call(bob, ['close']);
  assert.ok(Number(id) > 0);
  await call(bob);                                                    // re-register without events: keeps {close}
  assert.deepEqual((await ctx.as(bob, `select events from public.push_subscriptions where endpoint = $1`, [s.endpoint]))[0].events, ['close']);
  await call(erin);                                                   // the same browser, now signed in as erin
  assert.equal(await count(bob, 'public.push_subscriptions', 'endpoint = $1', [s.endpoint]), 0);
  const [e] = await ctx.as(erin, `select user_id, events from public.push_subscriptions where endpoint = $1`, [s.endpoint]);
  assert.deepEqual(e, { user_id: erin, events: ['open', 'close', 'daycap', 'offline'] }, 'a new owner starts with all events');
  await assert.rejects(call(carol), /not_approved/);
  await assert.rejects(call(dave), /not_approved/);
  await assert.rejects(ctx.as(bob, `select public.register_push_subscription('http://x.test', 'k', 'a')`), /subscription_invalid/);
  await assert.rejects(ctx.as(bob, `select public.register_push_subscription($1, 'k', 'a', null, '{spam}')`, [SUB('z').endpoint]), /events_invalid/);
});

test('deleting a user removes their push subscriptions (cascade)', async () => {
  const frank = await ctx.approvedUser('frank@example.test');
  await ctx.as(frank, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)`, Object.values(SUB('frank')));
  await ctx.sql(`delete from auth.users where id = $1`, [frank]);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.push_subscriptions where endpoint = $1`, [SUB('frank').endpoint]))[0].n, 0);
});

// ------------------------------------------------------------------------------------------ bots.offline_notified_at
test('bots.offline_notified_at: only the push job (postgres) sets it; it is cleared when last_seen moves', async () => {
  await ctx.as(bob, `update public.bots set last_seen = now() where id = $1`, [botB]);
  await ctx.sql(`update public.bots set offline_notified_at = now() where id = $1`, [botB]);
  const flag = async () => (await ctx.sql(`select offline_notified_at from public.bots where id = $1`, [botB]))[0].offline_notified_at;
  assert.ok(await flag(), 'set by postgres');
  await ctx.as(bob, `update public.bots set name = 'Bob PC', offline_notified_at = null where id = $1`, [botB]);
  assert.ok(await flag(), 'a client cannot clear it without last_seen moving');
  await ctx.as(bob, `update public.bots set agent_version = '1.2.0', last_seen = '2020-01-01T00:00:00Z' where id = $1`, [botB]);
  assert.equal(await flag(), null, 'cleared when the agent reports last_seen');
  await ctx.as(bob, `update public.bots set offline_notified_at = now() where id = $1`, [botB]);
  assert.equal(await flag(), null, 'a client cannot set it');
  const [n] = await ctx.as(bob, `insert into public.bots (name, offline_notified_at) values ('Tmp', now()) returning id, offline_notified_at`);
  assert.equal(n.offline_notified_at, null);
  await ctx.as(bob, `delete from public.bots where id = $1`, [n.id]);
});

test('schema.sql runs again with data in the new tables and keeps it', async () => {
  const before = {};
  for (const t of NEW_TABLES) before[t] = (await ctx.sql(`select count(*)::int as n from ${t}`))[0].n;
  await ctx.runSchemaAgain();
  for (const t of NEW_TABLES) assert.equal((await ctx.sql(`select count(*)::int as n from ${t}`))[0].n, before[t], t);
  assert.equal(await count(bob, 'public.bars', 'bot_id = $1', [botB]), 3);
  const [c] = await ctx.sql(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'bots' and column_name = 'offline_notified_at'`);
  assert.ok(c);
});
