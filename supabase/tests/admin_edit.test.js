// 2026-11-10: the admin may change a member's bot settings (bot_control only) after signing in again with the admin's
// own password within 30 min (admin_edit_status), with 2FA when the admin has it; live ON keeps the 300 s live gate.
// Members still never touch another member's bot, and every other table of a member's bot stays read only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';

let ctx, admin, admin2, bob, erin, botB, botE;
before(async () => {
  ctx = await freshDb({ runs: 2 });
  admin = await ctx.approvedUser('admin@example.test', 'admin');
  admin2 = await ctx.approvedUser('admin2@example.test', 'admin');   // has 2FA (verified factor) below
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  botB = await ctx.registerBot(bob, 'Bob PC', { live: false, control: { mode: 'run' }, blackouts: [] });
  botE = await ctx.registerBot(erin, 'Erin PC', { live: false, control: { mode: 'run' }, blackouts: [] });
  await ctx.sql(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [admin2]);
});

const at = (uid, ageS, extra = {}) => ({ uid, age: ageS, ...extra });
const ctl = async (bot) => (await ctx.sql(`select version, desired, updated_by from public.bot_control where bot_id = $1`, [bot]))[0];
const setDesired = (who, bot, desired) =>
  ctx.as(who, `update public.bot_control set desired = $2::jsonb where bot_id = $1 returning version`, [bot, JSON.stringify(desired)]);
const status = async (who) => (await ctx.as(who, `select public.admin_edit_status() as s`))[0].s;

test('admin_edit_status: admin_only for members; for the admin it follows the 30 min sign-in window and 2FA', async () => {
  assert.equal(await status(at(bob, 10)), 'admin_only');
  assert.equal(await status(at(admin, 10)), 'ok');
  assert.equal(await status(at(admin, 1790)), 'ok');
  assert.equal(await status(at(admin, 1810)), 'admin_reauth_required');
  assert.equal(await status({ uid: admin, amr: null }), 'admin_reauth_required');
  assert.equal(await status(at(admin, 10, { method: 'refresh_token' })), 'admin_reauth_required');
  assert.equal(await status(at(admin2, 10)), 'admin_mfa_required');
  assert.equal(await status(at(admin2, 10, { aal: 'aal2' })), 'ok');
});

test('the admin changes a member bot after a fresh sign-in: version + 1, updated_by = admin, audit row the owner can read', async () => {
  const before = await ctl(botB);
  const want = { live: false, control: { mode: 'pause', lots: 0.02 }, blackouts: [] };
  const rows = await setDesired(at(admin, 60), botB, want);
  assert.equal(rows.length, 1);
  const after = await ctl(botB);
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.desired, want);
  assert.equal(after.updated_by, admin);
  const seen = await ctx.as(bob, `select actor, action, after from public.audit where bot_id = $1 and action = 'control' order by id desc limit 1`, [botB]);
  assert.deepEqual(seen, [{ actor: admin, action: 'control', after: want }]);
});

test('the admin is refused without a fresh sign-in (30 min) or without 2FA when the admin has it; nothing changes', async () => {
  const before = await ctl(botB);
  await assert.rejects(setDesired(at(admin, 1900), botB, { live: false, control: { mode: 'run' } }), /admin_reauth_required/);
  await assert.rejects(setDesired(at(admin2, 10), botB, { live: false, control: { mode: 'run' } }), /admin_mfa_required/);
  assert.deepEqual(await ctl(botB), before);
  assert.equal((await setDesired(at(admin2, 10, { aal: 'aal2' }), botB, { live: false, control: { mode: 'run' } })).length, 1);
});

test('live ON on a member bot also needs the live gate (300 s); live OFF only the admin gate', async () => {
  await assert.rejects(setDesired(at(admin, 600), botE, { live: true, control: { mode: 'run' } }), /reauth_required/);
  assert.equal((await ctl(botE)).desired.live, false);
  assert.equal((await setDesired(at(admin, 30), botE, { live: true, control: { mode: 'run' } })).length, 1);
  assert.equal((await ctl(botE)).desired.live, true);
  assert.equal((await setDesired(at(admin, 900), botE, { live: false, control: { mode: 'run' } })).length, 1);
  assert.equal((await ctl(botE)).desired.live, false);
});

test('the admin own bot keeps the owner rules (no admin gate on a stale sign-in)', async () => {
  const mine = await ctx.registerBot(admin, 'Admin PC', { live: false, control: { mode: 'run' } });
  assert.equal((await setDesired(at(admin, 7200), mine, { live: false, control: { mode: 'pause' } })).length, 1);
});

test('members still cannot touch another member bot, fresh sign-in or not', async () => {
  const before = await ctl(botB);
  assert.equal((await setDesired(at(erin, 10), botB, { live: false, control: { mode: 'pause' } })).length, 0);
  assert.equal((await setDesired(at(erin, 10, { aal: 'aal2' }), botB, { live: true })).length, 0);
  assert.deepEqual(await ctl(botB), before);
});

test('a disabled admin is a plain user again: no edit of member bots', async () => {
  const before = await ctl(botB);
  await ctx.as(at(admin, 10), `select public.admin_set_user($1, null, null, true)`, [admin2]);
  assert.equal(await status(at(admin2, 10, { aal: 'aal2' })), 'admin_only');
  assert.equal((await setDesired(at(admin2, 10, { aal: 'aal2' }), botB, { live: false, control: { mode: 'pause' } })).length, 0);
  assert.deepEqual(await ctl(botB), before);
  await ctx.as(at(admin, 10), `select public.admin_set_user($1, null, null, false)`, [admin2]);
});

test('every other table of a member bot stays read only for the admin, even right after signing in', async () => {
  const fresh = at(admin, 10, { aal: 'aal2' });
  assert.equal((await ctx.as(fresh, `update public.bots set name = 'x' where id = $1 returning 1`, [botB])).length, 0);
  assert.equal((await ctx.as(fresh, `delete from public.bots where id = $1 returning 1`, [botB])).length, 0);
  assert.equal((await ctx.as(fresh, `update public.bot_status set status = '{}' where bot_id = $1 returning 1`, [botB])).length, 0);
  await assert.rejects(ctx.as(fresh, `insert into public.cash_flows (bot_id, ts, amount, source) values ($1, now(), 5, 'manual')`, [botB]), /row-level security/);
  await assert.rejects(ctx.as(fresh, `insert into public.bot_control (bot_id, desired) values ($1, '{}')`, [botB]), /permission denied|row-level security/);
});

test('fresh_auth_status is internal; admin_edit_status is for signed-in users only', async () => {
  await assert.rejects(ctx.as(at(admin, 10), `select public.fresh_auth_status(99999)`), /permission denied/);
  await assert.rejects(ctx.asRole('anon', `select public.admin_edit_status()`), /permission denied/);
});
