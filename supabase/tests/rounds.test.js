// Counting rounds (SPEC 9.8): the approved owner adds, renames and deletes; another member and unapproved users see
// nothing; the admin reads but never writes; only the name can change; server stamps; audit rows; cascade.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

let ctx, admin, bob, erin, carol;
let botB, botE;

before(async () => {
  ctx = await freshDb({ runs: 2 });
  admin = await ctx.approvedUser('admin@example.test', 'admin');
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  carol = await ctx.createUser('carol@example.test');            // never approved
  botB = await ctx.registerBot(bob, 'Bob PC');
  botE = await ctx.registerBot(erin, 'Erin PC');
});

const touched = async (who, q, params) => (await ctx.as(who, `with x as (${q} returning 1) select count(*)::int as n from x`, params))[0].n;

test('rounds: the owner adds round 1 (no start) and round 2 in one insert; server stamps; future start clamped', async () => {
  const rows = await ctx.as(bob, `insert into public.rounds (bot_id, started_at, name, base, created_at, created_by) values
      ($1, null, 'ทดลอง 0.03', '{}', '2000-01-01', $2),
      ($1, now() + interval '2 days', null, '{"balance": 623.5, "v_balance": 485.9, "v_start": 300}', '2000-01-01', $2)
      returning id, started_at, created_at, created_by, base`, [botB, erin]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].started_at, null);
  assert.ok(new Date(rows[1].started_at) <= new Date(Date.now() + 60000), 'a start in the future becomes now()');
  for (const r of rows) {
    assert.ok(new Date(r.created_at).getFullYear() >= 2026, 'created_at is the server time');
    assert.equal(r.created_by, bob, 'created_by is the caller');
  }
  assert.equal(Number(rows[1].base.balance), 623.5);
});

test('rounds: one round 1 per bot, one round per start time; name and base checks; at most 200 rounds', async () => {
  await assert.rejects(ctx.as(bob, `insert into public.rounds (bot_id, started_at) values ($1, null)`, [botB]), /duplicate key/);
  const [r] = await ctx.as(bob, `select started_at from public.rounds where bot_id = $1 and started_at is not null`, [botB]);
  await assert.rejects(ctx.as(bob, `insert into public.rounds (bot_id, started_at) values ($1, $2)`, [botB, r.started_at]), /duplicate key/);
  await assert.rejects(ctx.as(bob, `insert into public.rounds (bot_id, started_at, name) values ($1, now() - interval '1 hour', $2)`, [botB, 'x'.repeat(61)]), /check constraint/);
  await assert.rejects(ctx.as(bob, `insert into public.rounds (bot_id, started_at, base) values ($1, now() - interval '1 hour', '[1]')`, [botB]), /check constraint/);
  const [tmp] = await ctx.as(erin, `insert into public.bots (name) values ('Many rounds') returning id`);
  await ctx.as(erin, `insert into public.rounds (bot_id, started_at) select $1, now() - make_interval(mins => g) from generate_series(1, 200) g`, [tmp.id]);
  await assert.rejects(ctx.as(erin, `insert into public.rounds (bot_id, started_at) values ($1, now() - interval '1 year')`, [tmp.id]), /too many rounds/);
  await ctx.as(erin, `delete from public.bots where id = $1`, [tmp.id]);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.rounds where bot_id = $1`, [tmp.id]))[0].n, 0, 'cascade with the bot');
});

test('rounds: only the name can be updated (column grant), and the trigger keeps the rest', async () => {
  const [r] = await ctx.as(bob, `select id from public.rounds where bot_id = $1 and started_at is not null`, [botB]);
  assert.equal(await touched(bob, `update public.rounds set name = 'หลังฝากเพิ่ม' where id = $1`, [r.id]), 1);
  assert.equal((await ctx.as(bob, `select name from public.rounds where id = $1`, [r.id]))[0].name, 'หลังฝากเพิ่ม');
  await assert.rejects(ctx.as(bob, `update public.rounds set started_at = now() - interval '9 days' where id = $1`, [r.id]), /permission denied/);
  await assert.rejects(ctx.as(bob, `update public.rounds set base = '{}' where id = $1`, [r.id]), /permission denied/);
  await assert.rejects(ctx.as(bob, `update public.rounds set bot_id = $1 where id = $2`, [botE, r.id]), /permission denied/);
});

test('rounds: other members, unapproved users and anon see nothing; the admin reads but never writes', async () => {
  assert.equal((await ctx.as(erin, `select count(*)::int as n from public.rounds where bot_id = $1`, [botB]))[0].n, 0);
  assert.equal((await ctx.as(carol, `select count(*)::int as n from public.rounds`))[0].n, 0);
  await assert.rejects(ctx.asRole('anon', `select count(*) from public.rounds`), /permission denied/);
  assert.equal((await ctx.as(admin, `select count(*)::int as n from public.rounds where bot_id = $1`, [botB]))[0].n, 2);
  await assert.rejects(ctx.as(erin, `insert into public.rounds (bot_id, started_at) values ($1, now() - interval '3 hours')`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(admin, `insert into public.rounds (bot_id, started_at) values ($1, now() - interval '3 hours')`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(carol, `insert into public.rounds (bot_id, started_at) values ($1, now() - interval '3 hours')`, [botB]), /row-level security|permission denied/);
  assert.equal(await touched(erin, `update public.rounds set name = 'x' where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(admin, `update public.rounds set name = 'x' where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(erin, `delete from public.rounds where bot_id = $1`, [botB]), 0);
  assert.equal(await touched(admin, `delete from public.rounds where bot_id = $1`, [botB]), 0);
});

test('rounds: undo = the owner deletes the latest round; insert / update / delete are audited with bot_id', async () => {
  const [r] = await ctx.as(bob, `select id from public.rounds where bot_id = $1 and started_at is not null`, [botB]);
  assert.equal(await touched(bob, `delete from public.rounds where id = $1`, [r.id]), 1);
  const rows = await ctx.as(bob, `select action, bot_id, actor from public.audit where action like 'round_%' and coalesce(after->>'id', before->>'id') = $1 order by id`, [String(r.id)]);
  assert.deepEqual(rows.map((x) => x.action), ['round_insert', 'round_update', 'round_delete']);
  for (const x of rows) { assert.equal(x.bot_id, botB); assert.equal(x.actor, bob); }
  assert.equal((await ctx.as(bob, `select count(*)::int as n from public.rounds where bot_id = $1`, [botB]))[0].n, 1, 'round 1 stays');
});
