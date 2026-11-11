// Structure, idempotency, privileges, realtime, storage bucket, news seed, profile trigger, bootstrap.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, SCHEMA_SQL, SEED_SQL, CODE_RE } from './helpers.js';

const TABLES = ['profiles', 'invites', 'bots', 'bot_status', 'journal', 'bot_control', 'presets', 'audit',
  'news_events', 'bars', 'cash_flows', 'trade_notes', 'rounds', 'ai_config', 'ai_conversations', 'ai_messages', 'ai_usage',
  'shadow_decisions', 'shadow_reviews', 'shadow_lessons'];
const SEQUENCES = ['journal_id_seq', 'audit_id_seq', 'news_events_id_seq', 'cash_flows_id_seq',
  'ai_messages_id_seq', 'ai_usage_id_seq', 'rounds_id_seq', 'shadow_decisions_id_seq',
  'shadow_reviews_id_seq', 'shadow_lessons_id_seq'];
const RPCS = ['is_approved()', 'is_admin()', 'owns_bot(uuid)', 'live_gate_status()', 'redeem_invite(text)',
  'create_invite(text,integer,text)', 'revoke_invite(text)', 'admin_set_user(uuid,text,boolean,boolean)',
  'set_display_name(text)', 'admin_overview()', 'register_bot(text,jsonb)', 'ai_quota()'];
// callable by service_role only (the Edge Function `chat`), never by a client
const SERVICE_RPCS = ['ai_start_turn(uuid,uuid)',
  'ai_finish_turn(bigint,text,integer,integer,integer,integer,numeric,uuid)',
  'shadow_start(uuid,uuid,bigint)', 'shadow_record(uuid,uuid,jsonb)',
  'shadow_review_start(uuid,uuid,bigint)', 'shadow_review_record(uuid,uuid,jsonb,jsonb)'];
const INTERNAL = ['gen_invite_code()', 'handle_new_user()', 'bot_control_before()', 'bot_control_audit()',
  'presets_before()', 'presets_audit()', 'bots_before()', 'bots_audit_delete()', 'bot_status_before()',
  'journal_skip_duplicate()', 'cash_flows_before()', 'cash_flows_audit()', 'trade_notes_before()',
  'rounds_before()', 'rounds_audit()',
  'ai_used_today(uuid)', 'ai_month_cost()', 'shadow_month_cost()', 'ai_config_before()', 'ai_config_audit()',
  'ai_messages_touch_conversation()'];

let ctx;
before(async () => { ctx = await freshDb({ runs: 2 }); });

test('schema.sql runs twice without error and shows the same bootstrap code both times', () => {
  assert.equal(ctx.schemaRuns.length, 2);
  const a = ctx.bootstrapRow(0), b = ctx.bootstrapRow(1);
  assert.match(a.bootstrap_admin_invite, CODE_RE);
  assert.equal(a.bootstrap_admin_invite, b.bootstrap_admin_invite);
});

test('every public table exists and has RLS enabled', async () => {
  const rows = await ctx.sql(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relkind = 'r'`);
  const map = Object.fromEntries(rows.map(r => [r.relname, r.relrowsecurity]));
  for (const t of TABLES) assert.equal(map[t], true, `RLS on ${t}`);
  assert.equal(rows.length, TABLES.length, 'no unexpected tables');
});

test('anon has no privileges on any table, sequence or RPC', async () => {
  for (const t of TABLES) {
    const [r] = await ctx.sql(`select has_table_privilege('anon', $1, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as p`, [`public.${t}`]);
    assert.equal(r.p, false, `anon on ${t}`);
  }
  for (const s of SEQUENCES) {
    const [r] = await ctx.sql(`select has_sequence_privilege('anon', $1, 'USAGE,SELECT,UPDATE') as p`, [`public.${s}`]);
    assert.equal(r.p, false, `anon on ${s}`);
  }
  for (const f of [...RPCS, ...SERVICE_RPCS, ...INTERNAL]) {
    const [r] = await ctx.sql(`select has_function_privilege('anon', $1, 'EXECUTE') as p`, [`public.${f}`]);
    assert.equal(r.p, false, `anon execute ${f}`);
  }
});

test('authenticated gets exactly the intended table privileges (no TRUNCATE, no bot_control/audit insert, no bars delete)', async () => {
  const expected = {
    profiles: ['SELECT'], invites: ['SELECT'], audit: ['SELECT'],
    bots: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], presets: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    news_events: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    bot_status: ['SELECT', 'INSERT', 'UPDATE'], journal: ['SELECT', 'INSERT', 'UPDATE'],
    bot_control: ['SELECT', 'UPDATE'],
    bars: ['SELECT', 'INSERT', 'UPDATE'],
    cash_flows: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], trade_notes: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    rounds: ['SELECT', 'INSERT', 'DELETE'],                  // + UPDATE on the name column only (below)
    ai_config: ['SELECT', 'UPDATE'],
    ai_conversations: ['SELECT', 'INSERT', 'DELETE'],        // + UPDATE on the title column only (below)
    ai_messages: ['SELECT', 'INSERT', 'DELETE'],
    ai_usage: ['SELECT'], shadow_decisions: ['SELECT'], shadow_reviews: ['SELECT'], shadow_lessons: ['SELECT'],
  };
  assert.deepEqual(Object.keys(expected).sort(), [...TABLES].sort(), 'every table has an expectation');
  for (const [t, privs] of Object.entries(expected)) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const [r] = await ctx.sql(`select has_table_privilege('authenticated', $1, $2) as ok`, [`public.${t}`, p]);
      assert.equal(r.ok, privs.includes(p), `authenticated ${p} on ${t}`);
    }
  }
  for (const col of ['id', 'user_id', 'title', 'created_at', 'updated_at']) {
    const [r] = await ctx.sql(`select has_column_privilege('authenticated', 'public.ai_conversations', $1, 'UPDATE') as ok`, [col]);
    assert.equal(r.ok, col === 'title', `authenticated UPDATE on ai_conversations.${col}`);
  }
  for (const col of ['id', 'bot_id', 'started_at', 'name', 'base', 'created_at', 'created_by']) {
    const [r] = await ctx.sql(`select has_column_privilege('authenticated', 'public.rounds', $1, 'UPDATE') as ok`, [col]);
    assert.equal(r.ok, col === 'name', `authenticated UPDATE on rounds.${col}`);
  }
  // sequences: only the ones behind client inserts
  for (const s of SEQUENCES) {
    const [r] = await ctx.sql(`select has_sequence_privilege('authenticated', $1, 'USAGE') as ok`, [`public.${s}`]);
    assert.equal(r.ok, ['journal_id_seq', 'news_events_id_seq', 'cash_flows_id_seq', 'ai_messages_id_seq', 'rounds_id_seq'].includes(s),
      `authenticated USAGE on ${s}`);
  }
});

test('RPCs: executable by authenticated, security definer, search_path=public; internal functions locked', async () => {
  for (const f of RPCS) {
    const [r] = await ctx.sql(`select has_function_privilege('authenticated', $1, 'EXECUTE') as p,
                                      p.prosecdef, p.proconfig
                               from pg_proc p where p.oid = $1::regprocedure`, [`public.${f}`]);
    assert.equal(r.p, true, `authenticated execute ${f}`);
    assert.equal(r.prosecdef, true, `${f} security definer`);
    assert.deepEqual(r.proconfig, ['search_path=public'], `${f} search_path`);
  }
  for (const f of SERVICE_RPCS) {
    const [r] = await ctx.sql(`select has_function_privilege('authenticated', $1, 'EXECUTE') as a,
                                      has_function_privilege('service_role', $1, 'EXECUTE') as s,
                                      p.prosecdef, p.proconfig
                               from pg_proc p where p.oid = $1::regprocedure`, [`public.${f}`]);
    assert.equal(r.a, false, `authenticated must not execute ${f}`);
    assert.equal(r.s, true, `service_role executes ${f}`);
    assert.equal(r.prosecdef, true, `${f} security definer`);
    assert.deepEqual(r.proconfig, ['search_path=public'], `${f} search_path`);
  }
  for (const f of INTERNAL) {
    const [r] = await ctx.sql(`select has_function_privilege('authenticated', $1, 'EXECUTE') as p`, [`public.${f}`]);
    assert.equal(r.p, false, `authenticated must not execute ${f}`);
  }
  // the gate trigger must run as the caller (it decides by current_user)
  const [g] = await ctx.sql(`select prosecdef from pg_proc where oid = 'public.bot_control_before()'::regprocedure`);
  assert.equal(g.prosecdef, false);
  const stableHelpers = await ctx.sql(`select proname, provolatile from pg_proc where oid = any($1::regprocedure[])`,
    [['public.is_approved()', 'public.is_admin()', 'public.owns_bot(uuid)', 'public.live_gate_status()']]);
  for (const r of stableHelpers) assert.equal(r.provolatile, 's', `${r.proname} stable`);
});

test('clients cannot read auth tables directly', async () => {
  const uid = await ctx.createUser('probe@example.test');
  await assert.rejects(ctx.as(uid, `select * from auth.users`), /permission denied/);
  await assert.rejects(ctx.as(uid, `select * from auth.mfa_factors`), /permission denied/);
});

test('realtime publication holds bot_status, bot_control, bots, journal exactly once', async () => {
  const rows = await ctx.sql(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1`);
  assert.deepEqual(rows.map(r => r.tablename), ['bot_control', 'bot_status', 'bots', 'journal']);
});

test('storage bucket downloads exists and is private', async () => {
  const rows = await ctx.sql(`select id, name, public from storage.buckets`);
  assert.deepEqual(rows, [{ id: 'downloads', name: 'downloads', public: false }]);
  const pols = await ctx.sql(`select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1`);
  assert.deepEqual(pols.map(p => p.cmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
});

test('profile trigger: new auth user -> member profile, unapproved, display_name = email prefix', async () => {
  const uid = await ctx.createUser('somchai.k@example.test');
  const [p] = await ctx.sql(`select * from public.profiles where id = $1`, [uid]);
  assert.equal(p.display_name, 'somchai.k');
  assert.equal(p.role, 'member');
  assert.equal(p.approved, false);
  assert.equal(p.disabled, false);
  // deleting the auth user cascades
  await ctx.sql(`delete from auth.users where id = $1`, [uid]);
  assert.equal((await ctx.sql(`select 1 from public.profiles where id = $1`, [uid])).length, 0);
});

test('bootstrap: exactly one unused admin invite, valid ~7 days, matches the code alphabet', async () => {
  const rows = await ctx.sql(`select * from public.invites where role = 'admin'`);
  assert.equal(rows.length, 1);
  const inv = rows[0];
  assert.match(inv.code, CODE_RE);
  assert.equal(inv.used_by, null);
  assert.equal(inv.revoked, false);
  const days = (new Date(inv.expires_at) - Date.now()) / 86400e3;
  assert.ok(days > 6.9 && days <= 7.01, `expires in ${days} days`);
  assert.equal(inv.code, ctx.bootstrapRow().bootstrap_admin_invite);
});

test('bootstrap: an expired bootstrap invite is replaced on the next run', async () => {
  const db2 = await freshDb({ runs: 1 });
  const old = db2.bootstrapRow().bootstrap_admin_invite;
  await db2.sql(`update public.invites set expires_at = now() - interval '1 minute' where code = $1`, [old]);
  const row = await db2.runSchemaAgain();
  assert.match(row.bootstrap_admin_invite, CODE_RE);
  assert.notEqual(row.bootstrap_admin_invite, old);
  assert.equal((await db2.sql(`select count(*)::int as n from public.invites where role = 'admin'`))[0].n, 2);
});

test('invite codes: 10 chars from A-Z2-9 without I O 0 1, all distinct', async () => {
  const rows = await ctx.sql(`select public.gen_invite_code() as c from generate_series(1, 2000)`);
  const seen = new Set();
  for (const { c } of rows) { assert.match(c, CODE_RE); seen.add(c); }
  assert.equal(seen.size, rows.length);
  const all = rows.map(r => r.c).join('');
  for (const bad of ['I', 'O', '0', '1']) assert.ok(!all.includes(bad), `no ${bad}`);
  // every symbol of the alphabet shows up (no stuck bits)
  for (const ch of 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') assert.ok(all.includes(ch), `uses ${ch}`);
});

test('seed_news.sql is identical to the seed block inside schema.sql', () => {
  const m = SCHEMA_SQL.match(/-- BEGIN seed_news\.sql\r?\n([\s\S]*?)-- END seed_news\.sql/);
  assert.ok(m, 'markers present');
  const norm = s => s.replace(/\r\n/g, '\n').trim();
  assert.equal(norm(m[1]), norm(SEED_SQL));
});

test('news seed: 6 tier-1 rows, UTC times convert back to the ET time in the note (DST aware)', async () => {
  const rows = await ctx.sql(`select ts_utc, name, tier, note from public.news_events order by ts_utc, name`);
  assert.equal(rows.length, 6);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (const r of rows) {
    assert.equal(r.tier, 1);
    const [, d, t] = r.note.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ET/);
    const p = Object.fromEntries(fmt.formatToParts(new Date(r.ts_utc)).map(x => [x.type, x.value]));
    assert.equal(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`, `${d} ${t}`, r.name);
    assert.ok(new Date(r.ts_utc) >= new Date('2026-11-01T00:00:00Z'));
  }
  // EST (UTC-5) after the 2026-11-01 switch
  assert.equal(new Date(rows.find(r => r.name === 'US CPI').ts_utc).toISOString(), '2026-11-10T13:30:00.000Z');
  assert.equal(new Date(rows.find(r => r.name === 'FOMC rate decision').ts_utc).toISOString(), '2026-12-09T19:00:00.000Z');
  const names = new Set(rows.map(r => r.name));
  assert.deepEqual([...names].sort(), ['FOMC press conference', 'FOMC rate decision', 'US CPI', 'US NFP (Non-Farm Payrolls)']);
});

test('seed is re-runnable (on conflict do nothing)', async () => {
  await ctx.db.exec(SEED_SQL);
  const [r] = await ctx.sql(`select count(*)::int as n from public.news_events`);
  assert.equal(r.n, 6);
});
