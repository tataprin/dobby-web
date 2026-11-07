// Bootstrap redeem, invites (create / redeem / reuse / revoke / expiry), admin RPCs, admin_overview, audit.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, CODE_RE } from './helpers.js';

let ctx, alice, bob, carol, dave, erin;
before(async () => {
  ctx = await freshDb({ runs: 2 });
  alice = await ctx.createUser('alice@example.test');   // the owner: will redeem the bootstrap code
  bob = await ctx.createUser('bob@example.test');
  carol = await ctx.createUser('carol@example.test');
  dave = await ctx.createUser('dave@example.test');
  erin = await ctx.createUser('erin@example.test');
});

const rpc = (who, sql, params) => ctx.as(who, sql, params).then(r => r[0] && Object.values(r[0])[0]);

test('before any admin: nobody can create invites', async () => {
  await assert.rejects(rpc(alice, `select public.create_invite()`), /admin_only/);
});

test('bootstrap code: redeeming it (lower case, spaces, dash) makes the caller an approved admin', async () => {
  const code = ctx.bootstrapRow().bootstrap_admin_invite;
  const messy = `  ${code.slice(0, 5).toLowerCase()}-${code.slice(5).toLowerCase()} `;
  assert.equal(await rpc(alice, `select public.redeem_invite($1)`, [messy]), 'ok');
  const [p] = await ctx.sql(`select role, approved, disabled from public.profiles where id = $1`, [alice]);
  assert.deepEqual(p, { role: 'admin', approved: true, disabled: false });
  const [inv] = await ctx.sql(`select used_by, used_at from public.invites where code = $1`, [code]);
  assert.equal(inv.used_by, alice);
  assert.ok(inv.used_at);
  assert.equal(await rpc(alice, `select public.is_admin()`), true);
  assert.equal(await rpc(alice, `select public.is_approved()`), true);
});

test('after an admin exists, re-running schema.sql creates no new admin invite and says so', async () => {
  const before = (await ctx.sql(`select count(*)::int as n from public.invites`))[0].n;
  const row = await ctx.runSchemaAgain();
  assert.match(row.bootstrap_admin_invite, /admin already exists/);
  assert.equal(row.expires_at, null);
  assert.equal((await ctx.sql(`select count(*)::int as n from public.invites`))[0].n, before);
  // the admin is still admin after the re-run (data kept)
  assert.equal((await ctx.sql(`select role from public.profiles where id = $1`, [alice]))[0].role, 'admin');
});

test('create_invite: admin only; default member, 7 days; validates role and days', async () => {
  const code = await rpc(alice, `select public.create_invite()`);
  assert.match(code, CODE_RE);
  const [inv] = await ctx.sql(`select * from public.invites where code = $1`, [code]);
  assert.equal(inv.role, 'member');
  assert.equal(inv.created_by, alice);
  const days = (new Date(inv.expires_at) - Date.now()) / 86400e3;
  assert.ok(days > 6.9 && days <= 7.01);
  const c2 = await rpc(alice, `select public.create_invite('member', 2, 'for Bob')`);
  const [i2] = await ctx.sql(`select note, expires_at from public.invites where code = $1`, [c2]);
  assert.equal(i2.note, 'for Bob');
  assert.ok(Math.abs((new Date(i2.expires_at) - Date.now()) / 86400e3 - 2) < 0.01);
  await assert.rejects(rpc(alice, `select public.create_invite('owner')`), /role_invalid/);
  await assert.rejects(rpc(alice, `select public.create_invite('member', 0)`), /days_invalid/);
  await assert.rejects(rpc(bob, `select public.create_invite()`), /admin_only/);    // unapproved member
});

test('redeem: member invite approves the caller; the same code cannot be used twice', async () => {
  const code = await rpc(alice, `select public.create_invite('member', 7, 'bob')`);
  assert.equal(await rpc(bob, `select public.redeem_invite($1)`, [code]), 'ok');
  const [p] = await ctx.sql(`select role, approved from public.profiles where id = $1`, [bob]);
  assert.deepEqual(p, { role: 'member', approved: true });
  await assert.rejects(rpc(carol, `select public.redeem_invite($1)`, [code]), /invite_invalid/);
  assert.equal((await ctx.sql(`select approved from public.profiles where id = $1`, [carol]))[0].approved, false);
});

test('redeem: an already approved caller gets already_approved and the code stays unused', async () => {
  const code = await rpc(alice, `select public.create_invite('admin')`);
  assert.equal(await rpc(bob, `select public.redeem_invite($1)`, [code]), 'already_approved');
  const [inv] = await ctx.sql(`select used_by, used_at from public.invites where code = $1`, [code]);
  assert.deepEqual(inv, { used_by: null, used_at: null });
  assert.equal((await ctx.sql(`select role from public.profiles where id = $1`, [bob]))[0].role, 'member');
  // the unused admin code still works for someone else -> admin role
  assert.equal(await rpc(erin, `select public.redeem_invite($1)`, [code]), 'ok');
  assert.equal((await ctx.sql(`select role from public.profiles where id = $1`, [erin]))[0].role, 'admin');
  await ctx.sql(`update public.profiles set role = 'member' where id = $1`, [erin]);  // back to member for later tests
});

test('redeem: revoked invite is invalid; revoke_invite is admin only', async () => {
  const code = await rpc(alice, `select public.create_invite()`);
  await assert.rejects(rpc(bob, `select public.revoke_invite($1)`, [code]), /admin_only/);
  await ctx.as(alice, `select public.revoke_invite($1)`, [code]);
  assert.equal((await ctx.sql(`select revoked from public.invites where code = $1`, [code]))[0].revoked, true);
  await assert.rejects(rpc(carol, `select public.redeem_invite($1)`, [code]), /invite_invalid/);
  await assert.rejects(ctx.as(alice, `select public.revoke_invite('ZZZZZZZZZZ')`), /invite_not_found/);
});

test('redeem: expired invite is invalid', async () => {
  const code = await rpc(alice, `select public.create_invite()`);
  await ctx.sql(`update public.invites set expires_at = now() - interval '1 second' where code = $1`, [code]);
  await assert.rejects(rpc(carol, `select public.redeem_invite($1)`, [code]), /invite_invalid/);
  const [inv] = await ctx.sql(`select used_by from public.invites where code = $1`, [code]);
  assert.equal(inv.used_by, null);
});

test('redeem: unknown / empty / null code is invalid', async () => {
  await assert.rejects(rpc(carol, `select public.redeem_invite('ABCDEFGHJK')`), /invite_invalid/);
  await assert.rejects(rpc(carol, `select public.redeem_invite('')`), /invite_invalid/);
  await assert.rejects(rpc(carol, `select public.redeem_invite(null)`), /invite_invalid/);
});

test('redeem: a disabled user cannot redeem (code stays unused)', async () => {
  await ctx.sql(`update public.profiles set disabled = true where id = $1`, [dave]);
  const code = await rpc(alice, `select public.create_invite()`);
  await assert.rejects(rpc(dave, `select public.redeem_invite($1)`, [code]), /account_disabled/);
  assert.equal((await ctx.sql(`select used_by from public.invites where code = $1`, [code]))[0].used_by, null);
  await ctx.sql(`update public.profiles set disabled = false where id = $1`, [dave]);
});

test('invites table: admin can list, members cannot see any row', async () => {
  const adminRows = await ctx.as(alice, `select code from public.invites`);
  assert.ok(adminRows.length >= 5);
  assert.equal((await ctx.as(bob, `select code from public.invites`)).length, 0);
  assert.equal((await ctx.as(carol, `select code from public.invites`)).length, 0);
  // and nobody writes it directly
  await assert.rejects(ctx.as(alice, `insert into public.invites (code, expires_at) values ('ABCDEFGHJK', now() + interval '1 day')`), /permission denied/);
  await assert.rejects(ctx.as(alice, `update public.invites set revoked = false`), /permission denied/);
});

test('admin_set_user: admin only; cannot demote or disable self; changes others; null keeps value', async () => {
  await assert.rejects(ctx.as(bob, `select public.admin_set_user($1, 'admin', true, false)`, [bob]), /admin_only/);
  await assert.rejects(ctx.as(alice, `select public.admin_set_user($1, 'member', true, false)`, [alice]), /cannot_demote_self/);
  await assert.rejects(ctx.as(alice, `select public.admin_set_user($1, 'admin', false, false)`, [alice]), /cannot_demote_self/);
  await assert.rejects(ctx.as(alice, `select public.admin_set_user($1, 'admin', true, true)`, [alice]), /cannot_disable_self/);
  await assert.rejects(ctx.as(alice, `select public.admin_set_user($1, 'boss', true, false)`, [bob]), /role_invalid/);
  await assert.rejects(ctx.as(alice, `select public.admin_set_user(gen_random_uuid(), 'member', true, false)`), /user_not_found/);
  // approve carol without an invite, then disable her, keeping role with null
  await ctx.as(alice, `select public.admin_set_user($1, 'member', true, false)`, [carol]);
  assert.equal(await rpc(carol, `select public.is_approved()`), true);
  await ctx.as(alice, `select public.admin_set_user($1, null, null, true)`, [carol]);
  const [p] = await ctx.sql(`select role, approved, disabled from public.profiles where id = $1`, [carol]);
  assert.deepEqual(p, { role: 'member', approved: true, disabled: true });
  assert.equal(await rpc(carol, `select public.is_approved()`), false);
  // a disabled admin is not an admin
  await ctx.sql(`update public.profiles set role = 'admin' where id = $1`, [carol]);
  assert.equal(await rpc(carol, `select public.is_admin()`), false);
  await ctx.sql(`update public.profiles set role = 'member', approved = false, disabled = false where id = $1`, [carol]);
  // admin RPC writes an audit row
  const a = await ctx.sql(`select actor, action, before, after from public.audit where action = 'admin_set_user' order by id`);
  assert.equal(a.length, 2);
  assert.equal(a[0].actor, alice);
  assert.equal(a[1].before.disabled, false);
  assert.equal(a[1].after.disabled, true);
});

test('profiles: no direct writes by clients; select own row only (admin sees all)', async () => {
  await assert.rejects(ctx.as(bob, `update public.profiles set role = 'admin' where id = $1`, [bob]), /permission denied/);
  await assert.rejects(ctx.as(bob, `insert into public.profiles (id) values (gen_random_uuid())`), /permission denied/);
  await assert.rejects(ctx.as(bob, `delete from public.profiles`), /permission denied/);
  const own = await ctx.as(bob, `select id from public.profiles`);
  assert.deepEqual(own.map(r => r.id), [bob]);
  const all = await ctx.as(alice, `select id from public.profiles`);
  assert.equal(all.length, 5);
});

test('set_display_name: own profile, trimmed, length checked', async () => {
  await ctx.as(carol, `select public.set_display_name('  Carol K  ')`);
  assert.equal((await ctx.sql(`select display_name from public.profiles where id = $1`, [carol]))[0].display_name, 'Carol K');
  await assert.rejects(ctx.as(carol, `select public.set_display_name('   ')`), /name_invalid/);
  await assert.rejects(ctx.as(carol, `select public.set_display_name($1)`, ['x'.repeat(61)]), /name_invalid/);
});

test('admin_overview: admin only, the agreed columns, NO balances, counts bots', async () => {
  await assert.rejects(ctx.as(bob, `select * from public.admin_overview()`), /admin_only/);
  await ctx.registerBot(bob, 'Bob PC 1');
  await ctx.registerBot(bob, 'Bob PC 2');
  await ctx.sql(`insert into public.bot_status (bot_id, status) select id, '{"account":{"balance":1234.5,"equity":1200}}' from public.bots`);
  const rows = await ctx.as(alice, `select * from public.admin_overview()`);
  assert.equal(rows.length, 5);
  const cols = Object.keys(rows[0]);
  assert.deepEqual(cols, ['user_id', 'display_name', 'role', 'approved', 'disabled', 'created_at', 'bots', 'last_seen', 'email']);
  for (const c of cols) assert.doesNotMatch(c, /balance|equity|profit|pnl|status/i);
  assert.doesNotMatch(JSON.stringify(rows), /1234\.5/);
  const b = rows.find(r => r.user_id === bob);
  assert.equal(b.bots, 2);
  assert.equal(b.email, 'bob@example.test');
  assert.equal(rows.find(r => r.user_id === carol).bots, 0);
});

test('audit: invite actions are recorded and visible to the admin only', async () => {
  const actions = (await ctx.as(alice, `select distinct action from public.audit order by 1`)).map(r => r.action);
  for (const a of ['admin_bootstrap_invite', 'admin_create_invite', 'admin_revoke_invite', 'admin_set_user', 'invite_redeem'])
    assert.ok(actions.includes(a), `audit has ${a}`);
  const bobSees = await ctx.as(bob, `select action, actor from public.audit`);
  for (const r of bobSees) assert.ok(r.actor === bob || r.action === 'control', `bob only sees his own rows (${r.action})`);
  assert.ok(!bobSees.some(r => r.action.startsWith('admin_')));
});
