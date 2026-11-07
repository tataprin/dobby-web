// Row Level Security: unapproved users see nothing, user A cannot read/write user B, admin limits, storage, news.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

let ctx, admin, bob, erin, carol;
let botB, botE, presetB, presetE;

before(async () => {
  ctx = await freshDb({ runs: 2 });
  admin = await ctx.approvedUser('admin@example.test', 'admin');
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  carol = await ctx.createUser('carol@example.test');          // signed up, never redeemed an invite

  botB = await ctx.registerBot(bob, 'Bob PC');
  botE = await ctx.registerBot(erin, 'Erin PC');
  for (const [uid, bot] of [[bob, botB], [erin, botE]]) {
    await ctx.as(uid, `insert into public.bot_status (bot_id, status) values ($1, '{"account":{"balance":280}}')`, [bot]);
    await ctx.as(uid, `insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, '2026-11-06 10:00:00', 'OPEN', 'h1')`, [bot]);
  }
  presetB = (await ctx.as(bob, `insert into public.presets (name, params) values ('bob preset', '{"InpLotsA":0.03}') returning id`))[0].id;
  presetE = (await ctx.as(erin, `insert into public.presets (name, params) values ('erin preset', '{"InpLotsA":0.05}') returning id`))[0].id;
  await ctx.as(admin, `insert into storage.objects (bucket_id, name) values ('downloads', 'Dobby3_v304.ex5')`);
});

const count = async (who, table, where = 'true', params = []) =>
  (await ctx.as(who, `select count(*)::int as n from ${table} where ${where}`, params))[0].n;

test('unapproved user sees nothing but their own profile', async () => {
  for (const t of ['public.bots', 'public.bot_status', 'public.journal', 'public.bot_control', 'public.presets',
    'public.audit', 'public.news_events', 'public.invites', 'storage.objects']) {
    assert.equal(await count(carol, t), 0, `carol sees no rows in ${t}`);
  }
  const prof = await ctx.as(carol, `select id, approved from public.profiles`);
  assert.deepEqual(prof, [{ id: carol, approved: false }]);
  await assert.rejects(ctx.as(carol, `select public.register_bot('x', '{}')`), /not_approved/);
  await assert.rejects(ctx.as(carol, `insert into public.bots (name) values ('x')`), /row-level security/);
  await assert.rejects(ctx.as(carol, `insert into public.presets (name, params) values ('x', '{}')`), /row-level security/);
  await assert.rejects(ctx.as(carol, `insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, now(), 'X', 'zz')`, [botB]), /row-level security/);
  assert.equal(await ctx.as(carol, `select public.owns_bot($1) as o`, [botB]).then(r => r[0].o), false);
});

test('user A cannot read user B: bots, status, journal, control, presets, audit', async () => {
  assert.equal(await count(bob, 'public.bots', 'id = $1', [botE]), 0);
  assert.equal(await count(bob, 'public.bot_status', 'bot_id = $1', [botE]), 0);
  assert.equal(await count(bob, 'public.journal', 'bot_id = $1', [botE]), 0);
  assert.equal(await count(bob, 'public.bot_control', 'bot_id = $1', [botE]), 0);
  assert.equal(await count(bob, 'public.presets', 'id = $1', [presetE]), 0);
  assert.equal(await count(bob, 'public.audit', 'bot_id = $1 or actor = $2', [botE, erin]), 0);
  // ...but sees their own
  assert.equal(await count(bob, 'public.bots'), 1);
  assert.equal(await count(bob, 'public.bot_status'), 1);
  assert.equal(await count(bob, 'public.journal'), 1);
  assert.equal(await count(bob, 'public.bot_control'), 1);
  assert.equal(await count(bob, 'public.presets'), 1);
  assert.ok(await count(bob, 'public.audit') >= 2);
});

test('user A cannot write user B: updates hit 0 rows, inserts are refused, deletes hit 0 rows', async () => {
  const upd = async (sql, params) => (await ctx.as(bob, sql + ' returning 1', params)).length;
  assert.equal(await upd(`update public.bots set name = 'pwned' where id = $1`, [botE]), 0);
  assert.equal(await upd(`update public.bot_status set status = '{}' where bot_id = $1`, [botE]), 0);
  assert.equal(await upd(`update public.journal set event = 'X' where bot_id = $1`, [botE]), 0);
  assert.equal(await upd(`update public.bot_control set desired = '{"live":false,"control":{"mode":"pause"}}' where bot_id = $1`, [botE]), 0);
  assert.equal(await upd(`update public.presets set name = 'pwned' where id = $1`, [presetE]), 0);
  assert.equal(await upd(`delete from public.presets where id = $1`, [presetE]), 0);
  assert.equal(await upd(`delete from public.bots where id = $1`, [botE]), 0);

  await assert.rejects(ctx.as(bob, `insert into public.bot_status (bot_id, status) values ($1, '{}') on conflict (bot_id) do update set status = excluded.status`, [botE]), /row-level security/);
  await assert.rejects(ctx.as(bob, `insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, now(), 'FAKE', 'new-hash')`, [botE]), /row-level security/);
  await assert.rejects(ctx.as(bob, `insert into public.presets (owner, name, params) values ($1, 'x', '{}')`, [erin]), /row-level security/);
  await assert.rejects(ctx.as(bob, `insert into public.bots (owner, name) values ($1, 'x')`, [erin]), /row-level security/);
  // moving my own row onto someone else is refused by WITH CHECK
  await assert.rejects(ctx.as(bob, `update public.bots set owner = $1 where id = $2`, [erin, botB]), /row-level security/);
  await assert.rejects(ctx.as(bob, `update public.presets set owner = $1 where id = $2`, [erin, presetB]), /row-level security/);
  await assert.rejects(ctx.as(bob, `update public.journal set bot_id = $1 where bot_id = $2`, [botE, botB]), /row-level security/);

  // erin's data untouched
  const [e] = await ctx.sql(`select b.name, c.version, c.desired, s.status, (select count(*)::int from public.journal j where j.bot_id = b.id) as j
                             from public.bots b join public.bot_control c on c.bot_id = b.id join public.bot_status s on s.bot_id = b.id where b.id = $1`, [botE]);
  assert.equal(e.name, 'Erin PC');
  assert.equal(e.version, 1);
  assert.equal(e.desired.control.mode, 'run');
  assert.equal(e.status.account.balance, 280);
  assert.equal(e.j, 1);
  assert.equal((await ctx.sql(`select name from public.presets where id = $1`, [presetE]))[0].name, 'erin preset');
});

test('admin sees every bot row but not status, journal, control or presets of other users', async () => {
  assert.equal(await count(admin, 'public.bots'), 2);
  assert.equal(await count(admin, 'public.bot_status'), 0);
  assert.equal(await count(admin, 'public.journal'), 0);
  assert.equal(await count(admin, 'public.bot_control'), 0);
  assert.equal(await count(admin, 'public.presets'), 0);
  // and cannot change them
  assert.equal((await ctx.as(admin, `update public.bots set name = 'x' where id = $1 returning 1`, [botB])).length, 0);
  assert.equal((await ctx.as(admin, `update public.bot_control set desired = '{"live":false}' where bot_id = $1 returning 1`, [botB])).length, 0);
  // audit: the rows exist (bob + erin: 2 control + 2 preset_insert) but the admin cannot read them
  assert.ok((await ctx.sql(`select count(*)::int as n from public.audit where actor = any($1::uuid[])`, [[bob, erin]]))[0].n >= 4);
  assert.equal(await count(admin, 'public.audit', 'actor = $1 or actor = $2', [bob, erin]), 0);
  assert.equal(await count(admin, 'public.audit', `bot_id = $1 or bot_id = $2 or action = 'control' or action like 'preset%'`, [botB, botE]), 0);
});

test('audit privacy: the admin reads admin_* / invite_* rows of others, never their control / preset / bot_delete rows', async () => {
  // a friend joins through an invite -> invite_redeem row with actor = the friend
  const code = (await ctx.as(admin, `select public.create_invite() as c`))[0].c;
  const frank = await ctx.createUser('frank@example.test');
  assert.equal((await ctx.as(frank, `select public.redeem_invite($1) as r`, [code]))[0].r, 'ok');
  const fbot = await ctx.registerBot(frank, 'Frank PC', { live: false, control: { mode: 'run', lots: 0.05 } });
  await ctx.as(frank, `update public.bot_control set desired = '{"live":false,"control":{"mode":"pause","lots":0.05}}' where bot_id = $1`, [fbot]);
  await ctx.as(frank, `insert into public.presets (name, params) values ('frank', '{"InpVirtualStart":5000,"InpKillBalance":2500}')`);
  const [tmp] = await ctx.as(frank, `insert into public.bots (name) values ('Frank tmp') returning id`);
  await ctx.as(frank, `delete from public.bots where id = $1`, [tmp.id]);

  const seen = (await ctx.as(admin, `select action, actor from public.audit order by id`));
  const adminSeesOfFrank = seen.filter(r => r.actor === frank).map(r => r.action);
  assert.deepEqual(adminSeesOfFrank, ['invite_redeem']);
  assert.ok(seen.some(r => r.action === 'admin_bootstrap_invite' && r.actor === null), 'admin sees the bootstrap row');
  assert.ok(seen.some(r => r.action === 'admin_create_invite' && r.actor === admin));
  assert.ok(!seen.some(r => r.action === 'bot_delete' && r.actor !== admin), 'no bot_delete rows of others');
  assert.doesNotMatch(JSON.stringify(seen), /InpVirtualStart/);
  const payloads = await ctx.as(admin, `select before, after from public.audit where actor = $1`, [frank]);
  assert.doesNotMatch(JSON.stringify(payloads), /InpVirtualStart|InpKillBalance|"lots"/);

  // frank sees all of his own rows; members never see admin_* rows of others
  const own = (await ctx.as(frank, `select action from public.audit order by id`)).map(r => r.action);
  for (const a of ['invite_redeem', 'control', 'preset_insert', 'bot_delete']) assert.ok(own.includes(a), `frank sees ${a}`);
  assert.ok(!own.some(a => a.startsWith('admin_')), 'members do not see admin rows');
  assert.equal(await count(bob, 'public.audit', `action like 'admin%' or action like 'invite%'`), 0);
});

test('audit: owners see rows about their bots and presets even when someone else (SQL editor) made them', async () => {
  await ctx.sql(`update public.presets set notes = 'fixed by owner of the project' where id = $1`, [presetB]);
  await ctx.sql(`update public.bot_control set desired = '{"live":false,"control":{"mode":"pause"}}' where bot_id = $1`, [botB]);
  const rows = await ctx.sql(`select id from public.audit where actor is null and (bot_id = $1 or after->>'id' = $2::text)`, [botB, presetB]);
  assert.equal(rows.length, 2);
  const ids = rows.map(r => Number(r.id));
  const visible = async who => (await ctx.as(who, `select id from public.audit where id = any($1::bigint[])`, [ids])).length;
  assert.equal(await visible(bob), 2, 'bob sees both rows about his bot / preset');
  assert.equal(await visible(erin), 0);
  assert.equal(await visible(admin), 0);
});

test('a disabled user loses access to everything, including own bots', async () => {
  await ctx.as(admin, `select public.admin_set_user($1, null, null, true)`, [bob]);
  for (const t of ['public.bots', 'public.bot_status', 'public.journal', 'public.bot_control', 'public.presets', 'public.audit', 'public.news_events', 'storage.objects'])
    assert.equal(await count(bob, t), 0, `disabled bob sees nothing in ${t}`);
  assert.equal((await ctx.as(bob, `update public.bot_control set desired = '{"live":false}' where bot_id = $1 returning 1`, [botB])).length, 0);
  await assert.rejects(ctx.as(bob, `insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, now(), 'X', 'h-dis')`, [botB]), /row-level security/);
  await ctx.as(admin, `select public.admin_set_user($1, null, null, false)`, [bob]);
  assert.equal(await count(bob, 'public.bots'), 1);
});

test('approved owner: direct bot insert works with owner defaulting to auth.uid(); delete cascades and is audited', async () => {
  const [b] = await ctx.as(bob, `insert into public.bots (name) values ('Temp') returning id, owner`);
  assert.equal(b.owner, bob);
  await ctx.as(bob, `insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, now(), 'X', 'tmp')`, [b.id]);
  assert.equal((await ctx.as(bob, `delete from public.bots where id = $1 returning 1`, [b.id])).length, 1);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.journal where bot_id = $1`, [b.id]))[0].n, 0);
  const a = await ctx.as(bob, `select action, actor from public.audit where bot_id = $1 and action = 'bot_delete'`, [b.id]);
  assert.deepEqual(a, [{ action: 'bot_delete', actor: bob }]);
  assert.equal(await count(admin, 'public.audit', `bot_id = $1`, [b.id]), 0, 'admin does not see it');
});

test('journal and bot_status cannot be deleted by clients (cascade only)', async () => {
  await assert.rejects(ctx.as(bob, `delete from public.journal where bot_id = $1`, [botB]), /permission denied/);
  await assert.rejects(ctx.as(bob, `delete from public.bot_status where bot_id = $1`, [botB]), /permission denied/);
  await assert.rejects(ctx.as(bob, `delete from public.bot_control where bot_id = $1`, [botB]), /permission denied/);
  await assert.rejects(ctx.as(bob, `insert into public.audit (action) values ('fake')`), /permission denied/);
  await assert.rejects(ctx.as(bob, `truncate public.journal`), /permission denied/);
});

test('presets: owner CRUD with audit rows preset_insert / preset_update / preset_delete (bot_id null)', async () => {
  const [p] = await ctx.as(bob, `insert into public.presets (name, params, notes) values ('p2', '{"InpLotsA":0.03}', 'n') returning id, created_at, updated_at`);
  await ctx.as(bob, `update public.presets set params = '{"InpLotsA":0.04}' where id = $1`, [p.id]);
  const [u] = await ctx.as(bob, `select created_at, updated_at from public.presets where id = $1`, [p.id]);
  assert.ok(new Date(u.updated_at) >= new Date(p.updated_at));
  await ctx.as(bob, `delete from public.presets where id = $1`, [p.id]);
  const rows = await ctx.as(bob, `select action, bot_id, actor, before, after from public.audit where (after->>'id' = $1 or before->>'id' = $1) order by id`, [p.id]);
  assert.deepEqual(rows.map(r => r.action), ['preset_insert', 'preset_update', 'preset_delete']);
  for (const r of rows) { assert.equal(r.bot_id, null); assert.equal(r.actor, bob); }
  assert.equal(rows[1].before.params.InpLotsA, 0.03);
  assert.equal(rows[1].after.params.InpLotsA, 0.04);
  assert.equal(rows[2].after, null);
  // erin cannot see bob's preset audit
  assert.equal(await count(erin, 'public.audit', `after->>'id' = $1 or before->>'id' = $1`, [p.id]), 0);
});

test('storage downloads: approved users read, only the admin writes', async () => {
  assert.equal(await count(bob, 'storage.objects', `bucket_id = 'downloads'`), 1);
  assert.equal(await count(carol, 'storage.objects'), 0);
  await assert.rejects(ctx.as(bob, `insert into storage.objects (bucket_id, name) values ('downloads', 'evil.ex5')`), /row-level security/);
  assert.equal((await ctx.as(bob, `update storage.objects set name = 'x' where bucket_id = 'downloads' returning 1`)).length, 0);
  assert.equal((await ctx.as(bob, `delete from storage.objects where bucket_id = 'downloads' returning 1`)).length, 0);
  await assert.rejects(ctx.as(carol, `insert into storage.objects (bucket_id, name) values ('downloads', 'evil.ex5')`), /row-level security/);
  await ctx.as(admin, `insert into storage.objects (bucket_id, name) values ('downloads', 'agent.zip')`);
  assert.equal((await ctx.as(admin, `update storage.objects set name = 'agent_v2.zip' where name = 'agent.zip' returning 1`)).length, 1);
  assert.equal((await ctx.as(admin, `delete from storage.objects where name = 'agent_v2.zip' returning 1`)).length, 1);
  assert.equal(await count(bob, 'storage.objects'), 1);
});

test('news_events: approved read; only the admin writes', async () => {
  assert.equal(await count(bob, 'public.news_events'), 6);
  await assert.rejects(ctx.as(bob, `insert into public.news_events (ts_utc, name) values (now(), 'fake')`), /row-level security/);
  assert.equal((await ctx.as(bob, `update public.news_events set name = 'x' returning 1`)).length, 0);
  assert.equal((await ctx.as(bob, `delete from public.news_events returning 1`)).length, 0);
  const [n] = await ctx.as(admin, `insert into public.news_events (ts_utc, name, tier, note) values ('2027-01-08T13:30:00Z', 'US NFP (Non-Farm Payrolls)', 1, 'admin added') returning id`);
  assert.equal((await ctx.as(admin, `update public.news_events set note = 'edited' where id = $1 returning 1`, [n.id])).length, 1);
  assert.equal((await ctx.as(admin, `delete from public.news_events where id = $1 returning 1`, [n.id])).length, 1);
});
