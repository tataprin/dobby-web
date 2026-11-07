// AI assistant (SPEC 10.1 / 10.2): ai_config (admin settings + audit), private chats (ai_conversations /
// ai_messages), ai_usage (written only by the service_role RPCs), ai_quota, ai_start_turn, ai_finish_turn.
// "today" / "month" are Thai time (Asia/Bangkok, UTC+7, no DST); the boundaries below are computed in JS on purpose,
// independently of the SQL under test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './helpers.js';

let ctx, admin, bob, erin, carol, dave, frank;
let convB, convE, convD;

const TH = 7 * 3600e3;
const thaiDayStart = (now = Date.now()) => new Date(Math.floor((now + TH) / 86400e3) * 86400e3 - TH);
const thaiMonthStart = (now = Date.now()) => {
  const t = new Date(now + TH);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) - TH);
};
const iso = (d) => d.toISOString();

const DEFAULTS = { enabled: true, member_daily_limit: 20, admin_daily_limit: 100, monthly_budget_usd: 30,
  model: 'claude-opus-5-5' };

const count = async (who, table, where = 'true', params = []) =>
  (await ctx.as(who, `select count(*)::int as n from ${table} where ${where}`, params))[0].n;
const touched = async (who, sql, params = []) => (await ctx.as(who, sql + ' returning 1', params)).length;

const newConv = async (who, title) => (title === undefined
  ? await ctx.as(who, `insert into public.ai_conversations default values returning id`)
  : await ctx.as(who, `insert into public.ai_conversations (title) values ($1) returning id`, [title]))[0].id;
const msg = async (who, conv, role, content, context = {}) =>
  (await ctx.as(who, `insert into public.ai_messages (conversation_id, role, content, context)
                      values ($1, $2, $3, $4::jsonb) returning id`, [conv, role, content, JSON.stringify(context)]))[0].id;

/** Change ai_config as postgres (test setup; the admin path is tested separately). */
const setConfig = async (fields) => {
  const keys = Object.keys(fields);
  await ctx.sql(`update public.ai_config set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} where id = 1`,
    Object.values(fields));
};
const config = async () => {
  const [c] = await ctx.sql(`select enabled, member_daily_limit, admin_daily_limit,
                                    monthly_budget_usd::float8 as monthly_budget_usd, model from public.ai_config`);
  return c;
};

const start = async (user, conv = null) =>
  (await ctx.asService(`select public.ai_start_turn($1::uuid, $2::uuid) as r`, [user, conv]))[0].r;
const finish = (id, status, input, output, cacheRead, cacheWrite, cost, conv = null) =>
  ctx.asService(`select public.ai_finish_turn($1::bigint, $2::text, $3::int, $4::int, $5::int, $6::int, $7::numeric, $8::uuid)`,
    [id, status, input, output, cacheRead, cacheWrite, cost, conv]);
const quota = async (who) => (await ctx.as(who, `select public.ai_quota() as q`))[0].q;
const usageRow = async (id) => (await ctx.sql(`select * from public.ai_usage where id = $1`, [id]))[0];
const usedToday = async (uid) => (await ctx.sql(
  `select count(*)::int as n from public.ai_usage where user_id = $1 and ts >= $2::timestamptz`,
  [uid, iso(thaiDayStart())]))[0].n;
const monthCost = async () => (await ctx.sql(
  `select coalesce(sum(cost_usd), 0)::text as c from public.ai_usage where ts >= $1::timestamptz`,
  [iso(thaiMonthStart())]))[0].c;

before(async () => {
  ctx = await freshDb({ runs: 2 });
  admin = await ctx.approvedUser('admin@example.test', 'admin');
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  carol = await ctx.createUser('carol@example.test');            // never approved
  dave = await ctx.approvedUser('dave@example.test');             // disabled below
  frank = await ctx.approvedUser('frank@example.test');           // only used by the daily-limit test
  convB = await newConv(bob, 'Bob chat');
  await msg(bob, convB, 'user', 'สวัสดี', { page: 'dashboard', now_th: '2026-11-08 09:00' });
  await msg(bob, convB, 'assistant', 'สวัสดีครับ', { proposals: [], tools: [] });
  convE = await newConv(erin, 'Erin chat');
  await msg(erin, convE, 'user', 'hi');
  convD = await newConv(dave);
  await msg(dave, convD, 'user', 'x');
  // own usage rows of the users who must see nothing (written as postgres: they cannot start a turn)
  await ctx.sql(`insert into public.ai_usage (user_id, model, status) values ($1, 'claude-opus-5-5', 'ok'),
                 ($2, 'claude-opus-5-5', 'ok')`, [carol, dave]);
  await ctx.as(admin, `select public.admin_set_user($1, null, null, true)`, [dave]);
});

// --------------------------------------------------------------------------------------------------------- ai_config
test('ai_config: one seeded row with the SPEC defaults; approved users read it, unapproved / disabled do not', async () => {
  assert.equal((await ctx.sql(`select count(*)::int as n from public.ai_config`))[0].n, 1);
  assert.deepEqual(await config(), DEFAULTS);
  for (const who of [bob, admin]) assert.equal(await count(who, 'public.ai_config'), 1);
  for (const who of [carol, dave]) assert.equal(await count(who, 'public.ai_config'), 0);
});

test('ai_config: members cannot change it; nobody inserts or deletes through the API', async () => {
  assert.equal(await touched(bob, `update public.ai_config set member_daily_limit = 999`), 0);
  assert.equal(await touched(dave, `update public.ai_config set enabled = false`), 0);
  for (const who of [bob, admin]) {
    await assert.rejects(ctx.as(who, `insert into public.ai_config (id) values (1) on conflict do nothing`), /permission denied/);
    await assert.rejects(ctx.as(who, `delete from public.ai_config`), /permission denied/);
    await assert.rejects(ctx.as(who, `truncate public.ai_config`), /permission denied/);
  }
  assert.deepEqual(await config(), DEFAULTS);
});

test('ai_config: the admin changes limits / budget / model; stamps are the server\'s; checks; audited; kept on re-run', async () => {
  const [u] = await ctx.as(admin, `update public.ai_config
                                   set member_daily_limit = 5, admin_daily_limit = 50, monthly_budget_usd = 12.5,
                                       model = 'claude-sonnet-5-5', updated_by = $1, updated_at = '2000-01-01'
                                   returning updated_by, updated_at`, [bob]);
  assert.equal(u.updated_by, admin, 'updated_by = the admin, whatever the client sends');
  assert.ok(Math.abs(new Date(u.updated_at) - Date.now()) < 60e3, 'updated_at = server now()');
  for (const bad of [`model = 'gpt-4'`, `member_daily_limit = 1001`, `member_daily_limit = -1`,
    `admin_daily_limit = 5001`, `monthly_budget_usd = 100001`, `monthly_budget_usd = -1`, `id = 2`]) {
    await assert.rejects(ctx.as(admin, `update public.ai_config set ${bad}`), /check constraint/, bad);
  }
  await assert.rejects(ctx.as(admin, `update public.ai_config set model = null`), /null value/);
  const a = await ctx.as(admin, `select actor, bot_id, before, after from public.audit
                                 where action = 'ai_config_update' and actor = $1 order by id`, [admin]);
  assert.equal(a.length, 1, 'one audit row (the refused updates rolled back)');
  assert.equal(a[0].bot_id, null);
  assert.equal(a[0].before.model, 'claude-opus-5-5');
  assert.equal(a[0].before.member_daily_limit, 20);
  assert.equal(a[0].after.model, 'claude-sonnet-5-5');
  assert.equal(a[0].after.member_daily_limit, 5);
  assert.equal(Number(a[0].after.monthly_budget_usd), 12.5);
  assert.equal(a[0].after.updated_by, admin);
  assert.equal(await count(bob, 'public.audit', `action = 'ai_config_update'`), 0, 'members do not read it');
  // re-running schema.sql keeps the admin's settings (seed is "on conflict do nothing")
  await ctx.runSchemaAgain();
  assert.deepEqual(await config(), { enabled: true, member_daily_limit: 5, admin_daily_limit: 50,
    monthly_budget_usd: 12.5, model: 'claude-sonnet-5-5' });
  await setConfig(DEFAULTS);
});

// ------------------------------------------------------------------------------------- ai_conversations / ai_messages
test('conversations: the owner creates (defaults), reads, renames and deletes; only the title can be updated', async () => {
  const [c] = await ctx.as(bob, `insert into public.ai_conversations default values returning *`);
  assert.equal(c.user_id, bob, 'user_id defaults to auth.uid()');
  assert.equal(c.title, 'บทสนทนาใหม่');
  assert.equal(await count(bob, 'public.ai_conversations'), 2);
  assert.equal(await touched(bob, `update public.ai_conversations set title = 'ทำไมไม้นี้ถึงเปิด' where id = $1`, [c.id]), 1);
  await assert.rejects(ctx.as(bob, `update public.ai_conversations set updated_at = now() where id = $1`, [c.id]), /permission denied/);
  await assert.rejects(ctx.as(bob, `update public.ai_conversations set user_id = $1 where id = $2`, [erin, c.id]), /permission denied/);
  await assert.rejects(ctx.as(bob, `insert into public.ai_conversations (user_id) values ($1)`, [erin]), /row-level security/);
  await assert.rejects(ctx.as(bob, `insert into public.ai_conversations (title) values ('')`), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.ai_conversations (title) values ($1)`, ['ก'.repeat(121)]), /check constraint/);
  await assert.rejects(ctx.as(bob, `update public.ai_conversations set title = '' where id = $1`, [c.id]), /check constraint/);
  const [t] = await ctx.as(bob, `update public.ai_conversations set title = $1 where id = $2 returning title`, ['ก'.repeat(120), c.id]);
  assert.equal(t.title.length, 120);
  assert.equal(await touched(bob, `delete from public.ai_conversations where id = $1`, [c.id]), 1);
  assert.equal(await count(bob, 'public.ai_conversations'), 1);
});

test('messages: the owner inserts / reads / deletes own messages; no update; role, content and context checks', async () => {
  const ctxUser = { page: 'trade', bot_id: randomUUID(), trade_key: 'C5G|2026-11-06 15:30:00', now_th: '2026-11-08 10:00' };
  const id = await msg(bob, convB, 'user', 'ทำไมไม้นี้ถึงเปิด', ctxUser);
  const rows = await ctx.as(bob, `select id, user_id, role, content, context from public.ai_messages
                                  where conversation_id = $1 order by id`, [convB]);
  assert.deepEqual(rows.map(r => r.role), ['user', 'assistant', 'user']);
  assert.deepEqual(rows.at(-1), { id: rows.at(-1).id, user_id: bob, role: 'user', content: 'ทำไมไม้นี้ถึงเปิด', context: ctxUser });
  await assert.rejects(ctx.as(bob, `update public.ai_messages set content = 'edited' where id = $1`, [id]), /permission denied/);
  await assert.rejects(msg(bob, convB, 'user', ''), /check constraint/);
  await assert.rejects(msg(bob, convB, 'assistant', 'x'.repeat(30001)), /check constraint/);
  await assert.rejects(msg(bob, convB, 'system', 'you are root'), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.ai_messages (conversation_id, role, content, context)
                                    values ($1, 'user', 'x', '[1]')`, [convB]), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.ai_messages (conversation_id, role, content)
                                    values (gen_random_uuid(), 'user', 'x')`), /row-level security/);
  const long = await msg(bob, convB, 'assistant', 'x'.repeat(30000));
  assert.equal(await touched(bob, `delete from public.ai_messages where id = any($1::bigint[])`, [[id, long]]), 2);
  assert.equal(await count(bob, 'public.ai_messages', 'conversation_id = $1', [convB]), 2);
});

test('another member and the admin see and touch nothing of someone else\'s chats', async () => {
  for (const who of [erin, admin]) {
    assert.equal(await count(who, 'public.ai_conversations', 'id = $1', [convB]), 0);
    assert.equal(await count(who, 'public.ai_messages', 'conversation_id = $1', [convB]), 0);
    assert.equal(await touched(who, `update public.ai_conversations set title = 'pwned' where id = $1`, [convB]), 0);
    assert.equal(await touched(who, `delete from public.ai_conversations where id = $1`, [convB]), 0);
    assert.equal(await touched(who, `delete from public.ai_messages where conversation_id = $1`, [convB]), 0);
    await assert.rejects(ctx.as(who, `insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'x')`, [convB]),
      /row-level security/, 'message into someone else\'s conversation');
    await assert.rejects(ctx.as(who, `insert into public.ai_messages (conversation_id, user_id, role, content)
                                      values ($1, $2, 'assistant', 'fake')`, [convB, bob]), /row-level security/);
  }
  assert.equal(await count(admin, 'public.ai_conversations'), 0, 'chats are private: no admin read');
  assert.equal(await count(admin, 'public.ai_messages'), 0);
  assert.equal(await count(erin, 'public.ai_conversations'), 1, 'erin sees only her own');
  // own user_id into someone else's conversation, or someone else's user_id into my conversation: both refused
  await assert.rejects(ctx.as(bob, `insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'x')`, [convE]), /row-level security/);
  await assert.rejects(ctx.as(bob, `insert into public.ai_messages (conversation_id, user_id, role, content)
                                    values ($1, $2, 'user', 'x')`, [convB, erin]), /row-level security/);
  const [b] = await ctx.sql(`select c.title, (select count(*)::int from public.ai_messages m where m.conversation_id = c.id) as n
                             from public.ai_conversations c where c.id = $1`, [convB]);
  assert.deepEqual(b, { title: 'Bob chat', n: 2 }, 'bob\'s chat untouched');
});

test('unapproved and disabled users see nothing in the AI tables (not even their own rows) and cannot write', async () => {
  for (const t of ['public.ai_config', 'public.ai_conversations', 'public.ai_messages', 'public.ai_usage']) {
    assert.equal(await count(carol, t), 0, `carol sees nothing in ${t}`);
    assert.equal(await count(dave, t), 0, `disabled dave sees nothing in ${t}`);
  }
  for (const who of [carol, dave]) {
    await assert.rejects(ctx.as(who, `insert into public.ai_conversations default values`), /row-level security/);
    await assert.rejects(ctx.as(who, `select public.ai_quota()`), /not_approved/);
  }
  await assert.rejects(ctx.as(dave, `insert into public.ai_messages (conversation_id, role, content) values ($1, 'user', 'x')`, [convD]), /row-level security/);
  assert.equal(await touched(dave, `update public.ai_conversations set title = 'x' where id = $1`, [convD]), 0);
  assert.equal(await touched(dave, `delete from public.ai_conversations where id = $1`, [convD]), 0);
  assert.equal(await touched(dave, `delete from public.ai_messages`), 0);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.ai_messages where conversation_id = $1`, [convD]))[0].n, 1);
});

test('a new message moves its conversation to the top; deleting a conversation deletes its messages, not its cost', async () => {
  const c = await newConv(erin, 'temp');
  await msg(erin, c, 'user', 'q1');
  await ctx.sql(`update public.ai_conversations set updated_at = '2026-01-01T00:00:00Z' where id = $1`, [c]);
  assert.equal((await ctx.as(erin, `select id from public.ai_conversations order by updated_at desc`))[0].id, convE);
  await msg(erin, c, 'assistant', 'a1');
  const [r] = await ctx.as(erin, `select updated_at from public.ai_conversations where id = $1`, [c]);
  assert.ok(Math.abs(new Date(r.updated_at) - Date.now()) < 60e3, 'updated_at = now()');
  assert.equal((await ctx.as(erin, `select id from public.ai_conversations order by updated_at desc`))[0].id, c);
  // a turn's usage row keeps its cost after the conversation is deleted (no FK)
  const s = await start(erin, c);
  await finish(s.usage_id, 'ok', 100, 20, 0, 0, 0.001, c);
  assert.equal(await touched(erin, `delete from public.ai_conversations where id = $1`, [c]), 1);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.ai_messages where conversation_id = $1`, [c]))[0].n, 0);
  const u = await usageRow(s.usage_id);
  assert.equal(u.conversation_id, c);
  assert.equal(Number(u.cost_usd), 0.001);
});

// ---------------------------------------------------------------------------------------------------------- ai_usage
test('ai_usage: no client writes at all; a member reads own rows only, the admin reads every row', async () => {
  const b = await start(bob, convB);
  await start(erin, convE);
  for (const who of [bob, admin]) {
    await assert.rejects(ctx.as(who, `insert into public.ai_usage (user_id, model) values ($1, 'claude-opus-5-5')`, [who]), /permission denied/);
    await assert.rejects(ctx.as(who, `update public.ai_usage set cost_usd = 0, status = 'ok' where id = $1`, [b.usage_id]), /permission denied/);
    await assert.rejects(ctx.as(who, `delete from public.ai_usage where id = $1`, [b.usage_id]), /permission denied/);
    await assert.rejects(ctx.as(who, `truncate public.ai_usage`), /permission denied/);
  }
  await assert.rejects(ctx.asRole('anon', `select * from public.ai_usage`), /permission denied/);
  assert.equal((await usageRow(b.usage_id)).status, 'pending', 'row untouched');
  const all = (await ctx.sql(`select count(*)::int as n from public.ai_usage`))[0].n;
  assert.equal(await count(bob, 'public.ai_usage', 'user_id <> $1', [bob]), 0, 'bob reads only his rows');
  assert.equal(await count(bob, 'public.ai_usage'), (await ctx.sql(`select count(*)::int as n from public.ai_usage where user_id = $1`, [bob]))[0].n);
  assert.equal(await count(erin, 'public.ai_usage', 'user_id = $1', [bob]), 0);
  assert.equal(await count(admin, 'public.ai_usage'), all, 'the admin reads every row');
});

// ------------------------------------------------------------------------------------- ai_start_turn / ai_finish_turn
test('ai_start_turn / ai_finish_turn: clients (member, admin, anon) cannot call them', async () => {
  for (const who of [bob, admin]) {
    await assert.rejects(ctx.as(who, `select public.ai_start_turn($1::uuid, null)`, [who]), /permission denied/);
    await assert.rejects(ctx.as(who, `select public.ai_finish_turn(1, 'ok', 0, 0, 0, 0, 0, null)`), /permission denied/);
  }
  await assert.rejects(ctx.asRole('anon', `select public.ai_start_turn($1::uuid, null)`, [bob]), /permission denied/);
  await assert.rejects(ctx.asRole('anon', `select public.ai_finish_turn(1, 'ok', 0, 0, 0, 0, 0, null)`), /permission denied/);
  await assert.rejects(ctx.asRole('anon', `select public.ai_quota()`), /permission denied/);
});

test('ai_start_turn: not_approved for an unapproved, disabled, unknown or null user (checked before ai_disabled)', async () => {
  const n0 = (await ctx.sql(`select count(*)::int as n from public.ai_usage`))[0].n;
  for (const u of [carol, dave, randomUUID(), null]) await assert.rejects(start(u), /not_approved/, String(u));
  await setConfig({ enabled: false });
  await assert.rejects(start(carol), /not_approved/);
  await assert.rejects(start(bob), /ai_disabled/);
  await assert.rejects(start(admin), /ai_disabled/);
  assert.equal((await quota(bob)).enabled, false);
  await setConfig({ enabled: true });
  assert.equal((await ctx.sql(`select count(*)::int as n from public.ai_usage`))[0].n, n0, 'refused turns insert nothing');
});

test('ai_start_turn: returns usage_id / model / used_today / limit_today / role and inserts a pending row', async () => {
  await setConfig({ model: 'claude-haiku-5-5' });
  const before = await usedToday(bob);
  const r = await start(bob, convB);
  assert.deepEqual(Object.keys(r).sort(), ['limit_today', 'model', 'role', 'usage_id', 'used_today']);
  assert.equal(typeof r.usage_id, 'number');
  assert.deepEqual({ ...r, usage_id: 0 }, { usage_id: 0, model: 'claude-haiku-5-5', used_today: before + 1,
    limit_today: 20, role: 'member' });
  const u = await usageRow(r.usage_id);
  assert.equal(u.user_id, bob);
  assert.equal(u.conversation_id, convB);
  assert.equal(u.model, 'claude-haiku-5-5');
  assert.equal(u.status, 'pending');
  assert.deepEqual([u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, Number(u.cost_usd)], [0, 0, 0, 0, 0]);
  await setConfig({ model: 'claude-opus-5-5' });
  const a = await start(admin, null);
  assert.equal(a.role, 'admin');
  assert.equal(a.limit_today, 100);
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal((await usageRow(a.usage_id)).conversation_id, null);
});

test('ai_start_turn: the daily limit counts only this Thai day\'s rows of that user, in any status; member vs admin limit', async () => {
  const day = thaiDayStart();
  // frank: one row 1 s before Thai midnight (yesterday: not counted), one 1 s after (today, an error: counted).
  // Other users' rows of today (bob, erin, admin) must not count for frank.
  await ctx.sql(`insert into public.ai_usage (user_id, ts, model, status) values
                   ($1, $2::timestamptz, 'claude-opus-5-5', 'ok'), ($1, $3::timestamptz, 'claude-opus-5-5', 'error')`,
    [frank, iso(new Date(day - 1000)), iso(new Date(+day + 1000))]);
  await setConfig({ member_daily_limit: 3, admin_daily_limit: 4 });
  assert.deepEqual([(await quota(frank)).used_today, (await quota(frank)).limit_today], [1, 3]);
  let r = await start(frank);
  assert.deepEqual([r.used_today, r.limit_today], [2, 3]);
  r = await start(frank);                                             // the first one is still pending: it counts
  assert.deepEqual([r.used_today, r.limit_today], [3, 3]);
  await assert.rejects(start(frank), /ai_daily_limit/);
  await finish(r.usage_id, 'error', 0, 0, 0, 0, 0);                   // a finished row still counts
  await assert.rejects(start(frank), /ai_daily_limit/);
  assert.equal(await usedToday(frank), 3);
  // the admin's own limit
  const used = await usedToday(admin);
  assert.ok(used < 4);
  for (let i = used; i < 4; i++) assert.equal((await start(admin)).used_today, i + 1);
  await assert.rejects(start(admin), /ai_daily_limit/);
  assert.ok(await usedToday(bob) < 3);
  assert.equal((await start(bob)).limit_today, 3, 'frank\'s full day does not block bob');
  // limit 0 = no questions today
  await setConfig({ member_daily_limit: 0 });
  await assert.rejects(start(erin), /ai_daily_limit/);
  await setConfig(DEFAULTS);
});

test('ai_start_turn: ai_monthly_budget when this Thai month\'s cost of every user reaches the budget', async () => {
  const month = thaiMonthStart();
  // erin: 1 s before the Thai month started (not counted, huge cost) and 1 s after (counted)
  await ctx.sql(`insert into public.ai_usage (user_id, ts, model, status, cost_usd) values
                   ($1, $2::timestamptz, 'claude-opus-5-5', 'ok', 5000), ($1, $3::timestamptz, 'claude-opus-5-5', 'ok', 0.25)`,
    [erin, iso(new Date(month - 1000)), iso(new Date(+month + 1000))]);
  const cost = Number(await monthCost());
  assert.ok(cost < 30, 'last month\'s row is not counted');
  const budget = (cost + 0.5).toFixed(6);
  await setConfig({ monthly_budget_usd: budget });
  const s = await start(bob);                                         // under the budget
  assert.equal((await quota(bob)).budget_reached, false);
  await finish(s.usage_id, 'ok', 1000, 200, 0, 0, 0.5);              // now this month's total = the budget
  await assert.rejects(start(erin), /ai_monthly_budget/, 'every user\'s cost counts');
  await assert.rejects(start(admin), /ai_monthly_budget/, 'the admin too');
  assert.equal((await quota(bob)).budget_reached, true);
  const qa = await quota(admin);
  assert.equal(qa.budget_reached, true);
  assert.equal(qa.month_cost_usd, Number(budget));
  assert.equal(qa.monthly_budget_usd, Number(budget));
  // the daily limit is checked before the budget
  await setConfig({ member_daily_limit: 0 });
  await assert.rejects(start(bob), /ai_daily_limit/);
  await setConfig({ member_daily_limit: 20, monthly_budget_usd: (cost + 0.51).toFixed(6) });
  assert.equal((await start(erin)).role, 'member', 'a higher budget lets turns through again');
  await setConfig({ monthly_budget_usd: 0 });
  await assert.rejects(start(bob), /ai_monthly_budget/, 'budget 0 = no AI');
  await setConfig(DEFAULTS);
});

test('budget 0 blocks every turn even when nothing was spent; a fresh database lets a member start a turn', async () => {
  const db2 = await freshDb({ runs: 1 });
  const u = await db2.approvedUser('x@example.test');
  const st = async () => (await db2.asService(`select public.ai_start_turn($1::uuid, null) as r`, [u]))[0].r;
  const r = await st();
  assert.deepEqual({ ...r, usage_id: 0 }, { usage_id: 0, model: 'claude-opus-5-5', used_today: 1, limit_today: 20, role: 'member' });
  await db2.sql(`update public.ai_config set monthly_budget_usd = 0`);
  assert.equal((await db2.sql(`select sum(cost_usd)::float8 as c from public.ai_usage`))[0].c, 0);
  await assert.rejects(st(), /ai_monthly_budget/);
  assert.equal((await db2.as(u, `select public.ai_quota() as q`))[0].q.budget_reached, true);
});

test('ai_finish_turn: finishes a pending row once (later calls rejected); bad status / negative numbers rejected', async () => {
  const s = await start(bob, null);
  const bad = [
    [['pending', 1, 1, 1, 1, 0.01], /status_invalid/], [['great', 1, 1, 1, 1, 0.01], /status_invalid/],
    [[null, 1, 1, 1, 1, 0.01], /status_invalid/],
    [['ok', -1, 1, 1, 1, 0.01], /tokens_invalid/], [['ok', 1, -1, 1, 1, 0.01], /tokens_invalid/],
    [['ok', 1, 1, -1, 1, 0.01], /tokens_invalid/], [['ok', 1, 1, 1, -1, 0.01], /tokens_invalid/],
    [['ok', 1, 1, 1, 1, -0.01], /cost_invalid/],
  ];
  for (const [args, re] of bad) await assert.rejects(finish(s.usage_id, ...args), re, JSON.stringify(args));
  await assert.rejects(finish(987654321, 'ok', 1, 1, 1, 1, 0), /usage_not_found/);
  assert.equal((await usageRow(s.usage_id)).status, 'pending', 'rejected calls leave the row pending');
  await finish(s.usage_id, 'ok', 1200, 345, 6000, 1500, 0.0123456789, convB);
  const u = await usageRow(s.usage_id);
  assert.deepEqual([u.status, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.cost_usd, u.conversation_id],
    ['ok', 1200, 345, 6000, 1500, '0.012346', convB]);
  // a finished row never changes again
  await assert.rejects(finish(s.usage_id, 'error', 0, 0, 0, 0, 0, null), /usage_finished/);
  assert.deepEqual(await usageRow(s.usage_id), u);
  // refused, null numbers count as 0, a null conversation keeps the one from ai_start_turn
  const s2 = await start(erin, convE);
  await finish(s2.usage_id, 'refused', null, null, null, null, null, null);
  const u2 = await usageRow(s2.usage_id);
  assert.deepEqual([u2.status, u2.input_tokens, u2.output_tokens, Number(u2.cost_usd), u2.conversation_id],
    ['refused', 0, 0, 0, convE]);
});

test('ai_start_turn locks the ai_config row (for update) before it counts', async () => {
  // PGlite has one connection, so the race itself cannot be run here; check the code path instead.
  const [p] = await ctx.sql(`select prosrc from pg_proc where oid = 'public.ai_start_turn(uuid,uuid)'::regprocedure`);
  const lock = p.prosrc.search(/from public\.ai_config where id = 1 for update/);
  assert.ok(lock > 0, 'config row locked');
  assert.ok(lock < p.prosrc.indexOf('ai_used_today') && lock < p.prosrc.indexOf('ai_month_cost'), 'lock before counting');
});

// ---------------------------------------------------------------------------------------------------------- ai_quota
test('ai_quota: a member gets enabled / model / used_today / limit_today / budget_reached; the admin also gets cost and budget', async () => {
  const q = await quota(bob);
  assert.deepEqual(Object.keys(q).sort(), ['budget_reached', 'enabled', 'limit_today', 'model', 'used_today']);
  assert.deepEqual(q, { enabled: true, model: 'claude-opus-5-5', used_today: await usedToday(bob), limit_today: 20,
    budget_reached: false });
  const a = await quota(admin);
  assert.deepEqual(Object.keys(a).sort(), ['budget_reached', 'enabled', 'limit_today', 'model', 'month_cost_usd',
    'monthly_budget_usd', 'used_today']);
  assert.deepEqual(a, { enabled: true, model: 'claude-opus-5-5', used_today: await usedToday(admin), limit_today: 100,
    budget_reached: false, month_cost_usd: Number(await monthCost()), monthly_budget_usd: 30 });
  await assert.rejects(ctx.asService(`select public.ai_quota()`), /not_approved/, 'no user, no quota');
});

test('schema.sql runs again with AI data and keeps all of it', async () => {
  const T = ['ai_config', 'ai_conversations', 'ai_messages', 'ai_usage'];
  const n = async () => {
    const out = {};
    for (const t of T) out[t] = (await ctx.sql(`select count(*)::int as n from public.${t}`))[0].n;
    return out;
  };
  const before = await n();
  await ctx.runSchemaAgain();
  assert.deepEqual(await n(), before);
  assert.equal(await count(bob, 'public.ai_messages', 'conversation_id = $1', [convB]), 2);
  assert.deepEqual(await config(), DEFAULTS);
});
