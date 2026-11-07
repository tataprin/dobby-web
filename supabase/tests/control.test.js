// register_bot, bot_control version bump + audit, the LIVE GATE, insert-bypass attempts, journal dedupe,
// bot_status upsert, server-side stamps.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, claims } from './helpers.js';

let ctx, bob, erin;
before(async () => {
  ctx = await freshDb({ runs: 2 });
  await ctx.approvedUser('admin@example.test', 'admin');
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
});

const STALE = uid => ({ uid, age: 600 });                 // signed in 10 minutes ago
const FRESH = uid => ({ uid, age: 10 });                  // signed in 10 seconds ago
const FRESH_AAL2 = uid => ({ uid, age: 10, aal: 'aal2' });
const ctl = async bot => (await ctx.sql(`select version, desired, updated_by from public.bot_control where bot_id = $1`, [bot]))[0];
const setDesired = (who, bot, desired) =>
  ctx.as(who, `update public.bot_control set desired = $2::jsonb where bot_id = $1 returning version`, [bot, JSON.stringify(desired)]);

test('register_bot: creates bots + bot_control (version 1) for the caller and audits it', async () => {
  const desired = { live: false, control: { mode: 'run', lots: 0.03, allow_long: true, allow_short: true }, blackouts: [] };
  const id = await ctx.registerBot(bob, ' Main PC ', desired);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const [b] = await ctx.sql(`select owner, name from public.bots where id = $1`, [id]);
  assert.deepEqual(b, { owner: bob, name: 'Main PC' });
  const c = await ctl(id);
  assert.deepEqual(c, { version: 1, desired, updated_by: bob });
  const a = await ctx.as(bob, `select actor, action, before, after from public.audit where bot_id = $1`, [id]);
  assert.deepEqual(a, [{ actor: bob, action: 'control', before: null, after: desired }]);
});

test('register_bot: live = true is accepted WITHOUT re-auth (stale sign-in, or no amr at all)', async () => {
  const id1 = (await ctx.as(STALE(bob), `select public.register_bot('Live PC', '{"live":true,"control":{"mode":"run"}}') as id`))[0].id;
  assert.equal((await ctl(id1)).desired.live, true);
  const id2 = (await ctx.as({ uid: bob, amr: null }, `select public.register_bot('Live PC 2', '{"live":true}') as id`))[0].id;
  assert.equal((await ctl(id2)).desired.live, true);
});

test('register_bot: validates name and desired', async () => {
  await assert.rejects(ctx.as(bob, `select public.register_bot('  ', '{}')`), /name_invalid/);
  await assert.rejects(ctx.as(bob, `select public.register_bot('x', '[1,2]')`), /desired_invalid/);
  await assert.rejects(ctx.as(bob, `select public.register_bot('x', null)`), /desired_invalid/);
  await assert.rejects(ctx.as(bob, `select public.register_bot('x', '{"live":"yes"}')`), /desired_invalid/);
});

test('bot_control update: version = old + 1, updated_by = caller, client cannot set version or bot_id; audit before/after', async () => {
  const id = await ctx.registerBot(bob, 'Ver PC', { live: false, control: { mode: 'run' } });
  await setDesired(bob, id, { live: false, control: { mode: 'pause' } });
  let c = await ctl(id);
  assert.equal(c.version, 2);
  assert.equal(c.updated_by, bob);
  await ctx.as(bob, `update public.bot_control set version = 100, updated_by = $2 where bot_id = $1`, [id, erin]);
  c = await ctl(id);
  assert.equal(c.version, 3);
  assert.equal(c.updated_by, bob);
  const other = await ctx.registerBot(bob, 'Other PC');
  await assert.rejects(ctx.as(bob, `update public.bot_control set bot_id = $2 where bot_id = $1`, [id, other]), /bot_id_immutable|duplicate key/);
  const a = await ctx.as(bob, `select before, after from public.audit where bot_id = $1 and action = 'control' order by id`, [id]);
  assert.equal(a.length, 3);
  assert.deepEqual(a[1].before, { live: false, control: { mode: 'run' } });
  assert.deepEqual(a[1].after, { live: false, control: { mode: 'pause' } });
});

test('desired.live must be a JSON boolean (a string "true" is refused)', async () => {
  const id = await ctx.registerBot(bob, 'Type PC');
  await assert.rejects(setDesired(FRESH(bob), id, { live: 'true' }), /check constraint|violates/);
  await assert.rejects(setDesired(FRESH(bob), id, { live: 1 }), /check constraint|violates/);
  await assert.rejects(ctx.as(bob, `update public.bot_control set desired = '[]' where bot_id = $1`, [id]), /check constraint|violates/);
});

test('LIVE GATE: false -> true needs a password/otp/totp sign-in within 300 s', async () => {
  const id = await ctx.registerBot(bob, 'Gate PC', { live: false, control: { mode: 'run' } });
  const on = { live: true, control: { mode: 'run' } };
  await assert.rejects(setDesired(STALE(bob), id, on), /reauth_required/);
  await assert.rejects(setDesired({ uid: bob, age: 301 }, id, on), /reauth_required/);
  await assert.rejects(setDesired({ uid: bob, amr: null }, id, on), /reauth_required/);
  await assert.rejects(setDesired({ uid: bob, amr: [] }, id, on), /reauth_required/);
  await assert.rejects(setDesired({ uid: bob, age: 5, method: 'oauth' }, id, on), /reauth_required/);
  await assert.rejects(setDesired({ uid: bob, age: 5, method: 'recovery' }, id, on), /reauth_required/);
  await assert.rejects(setDesired({ uid: bob, amr: [{ method: 'password', timestamp: String(Math.floor(Date.now() / 1000)) }] }, id, on), /reauth_required/);
  // nothing changed by the refused attempts
  assert.deepEqual(await ctl(id), { version: 1, desired: { live: false, control: { mode: 'run' } }, updated_by: bob });

  // fresh password sign-in -> ok
  assert.deepEqual(await setDesired(FRESH(bob), id, on), [{ version: 2 }]);
  assert.equal((await ctl(id)).desired.live, true);
  // fresh otp and totp also count
  for (const method of ['otp', 'totp']) {
    await setDesired(STALE(bob), id, { live: false });
    await setDesired({ uid: bob, age: 30, method }, id, on);
    assert.equal((await ctl(id)).desired.live, true, method);
  }
  // an old stale sign-in plus a fresh one in amr -> ok
  await setDesired(STALE(bob), id, { live: false });
  const now = Math.floor(Date.now() / 1000);
  await setDesired({ uid: bob, amr: [{ method: 'password', timestamp: now - 7200 }, { method: 'totp', timestamp: now - 20 }] }, id, on);
  assert.equal((await ctl(id)).desired.live, true);
});

test('LIVE GATE: live true -> false is always allowed, and edits while live stays true need no re-auth', async () => {
  const id = await ctx.registerBot(bob, 'Off PC', { live: true, control: { mode: 'run', lots: 0.03 } });
  await setDesired(STALE(bob), id, { live: true, control: { mode: 'run', lots: 0.02 } });     // true -> true
  assert.equal((await ctl(id)).desired.control.lots, 0.02);
  await setDesired({ uid: bob, amr: null }, id, { live: false, control: { mode: 'run', lots: 0.02 } });
  assert.equal((await ctl(id)).desired.live, false);
  // missing / null live counts as false -> turning it on again is gated
  await setDesired(STALE(bob), id, { control: { mode: 'run' } });
  await setDesired(STALE(bob), id, { live: null });
  await assert.rejects(setDesired(STALE(bob), id, { live: true }), /reauth_required/);
});

test('LIVE GATE: a verified MFA factor requires aal2 (unverified factors do not count)', async () => {
  const id = await ctx.registerBot(erin, 'MFA PC', { live: false });
  const on = { live: true };
  await ctx.sql(`insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')`, [erin]);
  assert.equal((await ctx.as(FRESH(erin), `select public.live_gate_status() as s`))[0].s, 'ok');
  await ctx.sql(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [erin]);
  await assert.rejects(setDesired(FRESH(erin), id, on), /mfa_required/);
  await assert.rejects(setDesired({ uid: erin, age: 10, aal: 'aal1' }, id, on), /mfa_required/);
  await assert.rejects(setDesired({ uid: erin, age: 600, aal: 'aal2' }, id, on), /reauth_required/);
  assert.deepEqual(await setDesired(FRESH_AAL2(erin), id, on), [{ version: 2 }]);
  await setDesired({ uid: erin, age: 9999 }, id, { live: false });                    // off: always fine
  assert.equal((await ctl(id)).desired.live, false);
});

test('live_gate_status() tells the UI what the gate would say', async () => {
  const s = async who => (await ctx.as(who, `select public.live_gate_status() as s`))[0].s;
  assert.equal(await s(STALE(bob)), 'reauth_required');
  assert.equal(await s(FRESH(bob)), 'ok');
  assert.equal(await s(FRESH(erin)), 'mfa_required');
  assert.equal(await s(FRESH_AAL2(erin)), 'ok');
});

test('a client cannot bypass the gate on INSERT', async () => {
  // a bot created directly (allowed by RLS) has no control row; the client tries to create one with live = true
  const [b] = await ctx.as(bob, `insert into public.bots (name) values ('Direct PC') returning id`);
  const ins = `insert into public.bot_control (bot_id, desired) values ('${b.id}', '{"live":true}')`;
  await assert.rejects(ctx.as(FRESH(bob), ins), /permission denied/);                       // layer 1: no INSERT grant
  await assert.rejects(ctx.as(STALE(bob), ins), /permission denied/);
  // pretending to be register_bot through a session setting does nothing (no such flag exists)
  await assert.rejects(ctx.asExec(STALE(bob), `select set_config('dobby.registering', '1', false); ${ins};`), /permission denied/);
  await assert.rejects(ctx.as(STALE(bob), `insert into public.bot_control (bot_id, desired) values ($1, '{"live":false}')`, [b.id]), /permission denied/);
  // upsert onto an existing row is an INSERT too
  const id = await ctx.registerBot(bob, 'Upsert PC', { live: false });
  await assert.rejects(ctx.as(STALE(bob), `insert into public.bot_control (bot_id, desired) values ($1, '{"live":true}') on conflict (bot_id) do update set desired = excluded.desired`, [id]), /permission denied/);
  assert.equal((await ctl(id)).desired.live, false);

  // layer 2: even if a future change granted INSERT + an insert policy by mistake, the trigger still gates it
  await ctx.sql(`grant insert on public.bot_control to authenticated`);
  await ctx.sql(`create policy test_mistake on public.bot_control for insert to authenticated with check (true)`);
  try {
    await assert.rejects(ctx.as(STALE(bob), ins), /reauth_required/);
    await assert.rejects(ctx.asExec(STALE(bob), `select set_config('dobby.registering', '1', false); ${ins};`), /reauth_required/);
    await ctx.as(STALE(bob), `insert into public.bot_control (bot_id, version, desired) values ($1, 99, '{"live":false}')`, [b.id]);
    assert.equal((await ctl(b.id)).version, 1, 'version forced to 1 on insert');
  } finally {
    await ctx.sql(`drop policy test_mistake on public.bot_control`);
    await ctx.sql(`revoke insert on public.bot_control from authenticated`);
  }
});

test('register_bot cannot be used to switch an EXISTING bot live (it always makes a new bot)', async () => {
  const id = await ctx.registerBot(bob, 'Existing PC', { live: false });
  const newId = (await ctx.as(STALE(bob), `select public.register_bot('Existing PC', '{"live":true}') as id`))[0].id;
  assert.notEqual(newId, id);
  assert.deepEqual(await ctl(id), { version: 1, desired: { live: false }, updated_by: bob });
});

test('a fresh token for user A cannot switch user B\'s bot live (the JWT sub decides the user)', async () => {
  // erin has verified MFA. A token for bob (fresh, aal1) cannot touch erin's bot at all.
  const id = (await ctx.as(erin, `select bot_id from public.bot_control limit 1`))[0].bot_id;
  assert.equal((await setDesired(FRESH(bob), id, { live: true })).length, 0);
  assert.equal((await ctl(id)).desired.live, false);
});

test('journal: duplicate line_hash is ignored (plain insert, batch, on conflict); other bots may reuse a hash', async () => {
  const id = await ctx.registerBot(bob, 'Journal PC');
  const row = (h, ev = 'OPEN') => `('${id}', '2026-11-06 10:00:00', '${ev}', 'A', 'BUY', 0.03, 4000.5, 3990, 4020, null, 280, 1, 'detail, with comma', '${h}')`;
  const cols = `(bot_id, ts_server, event, tag, side, lots, price, sl, tp, pnl, v_balance, step, detail, line_hash)`;
  await ctx.as(bob, `insert into public.journal ${cols} values ${row('h1')}, ${row('h2', 'CLOSE')}`);
  const inserted = await ctx.as(bob, `insert into public.journal ${cols} values ${row('h1')} returning id`);
  assert.equal(inserted.length, 0, 'plain duplicate insert is skipped without error');
  await ctx.as(bob, `insert into public.journal ${cols} values ${row('h2')}, ${row('h3')}, ${row('h3')} on conflict (bot_id, line_hash) do nothing`);
  const hashes = (await ctx.as(bob, `select line_hash from public.journal where bot_id = $1 order by id`, [id])).map(r => r.line_hash);
  assert.deepEqual(hashes, ['h1', 'h2', 'h3']);
  const id2 = await ctx.registerBot(bob, 'Journal PC 2');
  await ctx.as(bob, `insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, now(), 'OPEN', 'h1')`, [id2]);
  assert.equal((await ctx.as(bob, `select count(*)::int as n from public.journal where line_hash = 'h1'`))[0].n, 2);
  const [r] = await ctx.as(bob, `select detail, lots::float as lots from public.journal where bot_id = $1 and line_hash = 'h1'`, [id]);
  assert.deepEqual(r, { detail: 'detail, with comma', lots: 0.03 });
});

test('bot_status upsert by the owner works repeatedly; updated_at is server time', async () => {
  const id = await ctx.registerBot(bob, 'Status PC');
  const up = `insert into public.bot_status (bot_id, status, updated_at) values ($1, $2::jsonb, '2000-01-01')
              on conflict (bot_id) do update set status = excluded.status, updated_at = excluded.updated_at`;
  await ctx.as(bob, up, [id, JSON.stringify({ heartbeat_gmt_unix: 1 })]);
  await ctx.as(bob, up, [id, JSON.stringify({ heartbeat_gmt_unix: 2 })]);
  const [s] = await ctx.as(bob, `select status, updated_at from public.bot_status where bot_id = $1`, [id]);
  assert.equal(s.status.heartbeat_gmt_unix, 2);
  assert.ok(Math.abs(new Date(s.updated_at) - Date.now()) < 60e3, 'server-stamped updated_at');
});

test('bots: the agent updates its row; last_seen is stamped with the server clock', async () => {
  const id = await ctx.registerBot(bob, 'Seen PC');
  await ctx.as(bob, `update public.bots set last_seen = '2000-01-01T00:00:00Z', agent_version = '1.0.0', ea_version = '3.03',
                     symbol = 'XAUUSD', server_utc_offset_min = 120, agent_state = '{"applied_version":1}' where id = $1`, [id]);
  const [b] = await ctx.as(bob, `select last_seen, agent_version, symbol, server_utc_offset_min, agent_state from public.bots where id = $1`, [id]);
  assert.ok(Math.abs(new Date(b.last_seen) - Date.now()) < 60e3, 'last_seen = server now()');
  assert.equal(b.agent_version, '1.0.0');
  assert.equal(b.server_utc_offset_min, 120);
  assert.deepEqual(b.agent_state, { applied_version: 1 });
});

test('claims helper sanity: auth.uid() and auth.jwt() see what the test sets', async () => {
  const [r] = await ctx.as(FRESH_AAL2(bob), `select auth.uid() as uid, auth.jwt()->>'aal' as aal, current_user as cu`);
  assert.deepEqual(r, { uid: bob, aal: 'aal2', cu: 'authenticated' });
  const c = claims(bob, { age: 10 });
  assert.equal(c.amr[0].method, 'password');
});
