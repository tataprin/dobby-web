// supabase/push.sql on PGlite. pg_net and pg_cron do not exist here, so the test strips the two
// "create extension" lines and stubs what push.sql calls: net.http_post (records each call in net.calls) and
// cron.schedule / cron.unschedule / cron.job. Everything else in push.sql runs as written.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUSH_SQL = readFileSync(join(here, '..', 'push.sql'), 'utf8');
const REF = 'abcdefghijklmnopqrst';
const SECRET = 'test-secret-0123456789abcdefghijklmnop';
const prepared = sql => sql.replace(/^create extension[^\n]*\n/gm, '');
const filled = prepared(PUSH_SQL).replace('<PROJECT_REF>', REF).replace('<NOTIFY_SECRET>', SECRET);

const STUBS = `
create schema net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_ms int);
create table net.fail (on_ boolean);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                              headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
                              timeout_milliseconds int default 5000) returns bigint
language plpgsql as $$
declare v bigint;
begin
  if exists (select 1 from net.fail where on_) then raise exception 'pg_net is down'; end if;
  insert into net.calls (url, body, headers, timeout_ms) values (url, body, headers, timeout_milliseconds) returning id into v;
  return v;
end $$;
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create function cron.unschedule(job_id bigint) returns boolean language sql as $$
  delete from cron.job where jobid = job_id returning true $$;
`;

let ctx, bob, erin, dave, botB, botE, botD, runs;

const serverNow = (offMin, agoMin = 0) => {
  const d = new Date(Date.now() + (offMin - agoMin) * 60000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
const calls = async () => ctx.sql(`select url, body, headers, timeout_ms from net.calls order by id`);
const clearCalls = () => ctx.sql(`delete from net.calls`);
const journal = (who, bot, event, ts, hash, extra = {}) => ctx.as(who,
  `insert into public.journal (bot_id, ts_server, event, tag, side, lots, price, pnl, detail, line_hash)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [bot, ts, event, extra.tag ?? 'C5G', extra.side ?? 'BUY', extra.lots ?? 0.1, extra.price ?? 4121.78,
    extra.pnl ?? null, extra.detail ?? '', hash]);
const setLastSeen = async (bot, minutesAgo) => {
  await ctx.db.exec(`set session_replication_role = replica`);          // skip bots_before (it stamps now())
  await ctx.db.query(`update public.bots set last_seen = now() - make_interval(mins => $2) where id = $1`, [bot, minutesAgo]);
  await ctx.db.exec(`set session_replication_role = origin`);
};

before(async () => {
  ctx = await freshDb({ runs: 2 });
  await ctx.db.exec(STUBS);
  runs = [await ctx.db.exec(filled), await ctx.db.exec(filled)];            // idempotent: runs twice
  bob = await ctx.approvedUser('bob@example.test');
  erin = await ctx.approvedUser('erin@example.test');
  dave = await ctx.approvedUser('dave@example.test');
  botB = await ctx.registerBot(bob, 'Bob PC');
  botE = await ctx.registerBot(erin, 'Erin PC');
  botD = await ctx.registerBot(dave, 'Dave PC');
  for (const [who, bot] of [[bob, botB], [erin, botE], [dave, botD]])
    await ctx.as(who, `update public.bots set server_utc_offset_min = 120, last_seen = now() where id = $1`, [bot]);
  await ctx.as(bob, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.test/bob', 'k', 'a')`);
  await ctx.as(erin, `insert into public.push_subscriptions (endpoint, p256dh, auth, events) values ('https://push.test/erin', 'k', 'a', '{open}')`);
  await ctx.as(dave, `insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.test/dave', 'k', 'a')`);
});

test('push.sql refuses to run while the placeholders are still in it', async () => {
  await assert.rejects(ctx.db.exec(prepared(PUSH_SQL)), /project id/);
  await assert.rejects(ctx.db.exec(prepared(PUSH_SQL).replace('<PROJECT_REF>', REF)), /NOTIFY_SECRET/);
  const [s] = await ctx.sql(`select value from dobby_private.push_settings where key = 'notify_secret'`);
  assert.equal(s.value, SECRET, 'the good values stay');
});

test('push.sql runs twice: one cron job every 5 minutes, one journal trigger, settings shown without the secret', async () => {
  const last = runs[1].at(-1).rows[0];
  assert.deepEqual(last, { notify_url: `https://${REF}.supabase.co/functions/v1/notify`, offline_job: 1, journal_trigger: 1 });
  assert.ok(!JSON.stringify(runs[1].at(-1).rows).includes(SECRET));
  const jobs = await ctx.sql(`select jobname, schedule, command from cron.job`);
  assert.deepEqual(jobs, [{ jobname: 'dobby-push-offline', schedule: '*/5 * * * *', command: 'select dobby_private.push_offline_bots()' }]);
});

test('clients cannot reach dobby_private (settings with the secret, the push functions)', async () => {
  await assert.rejects(ctx.as(bob, `select * from dobby_private.push_settings`), /permission denied/);
  await assert.rejects(ctx.as(bob, `select dobby_private.push_offline_bots()`), /permission denied/);
});

test('a fresh OPEN row from the agent posts {bot_id, event, row} with the secret header', async () => {
  await clearCalls();
  await journal(bob, botB, 'OPEN', serverNow(120), 'p-open-1');
  const c = await calls();
  assert.equal(c.length, 1);
  assert.equal(c[0].url, `https://${REF}.supabase.co/functions/v1/notify`);
  assert.equal(c[0].headers['x-notify-secret'], SECRET);
  assert.equal(c[0].body.bot_id, botB);
  assert.equal(c[0].body.event, 'open');
  assert.equal(c[0].body.row.tag, 'C5G');
  assert.equal(Number(c[0].body.row.price), 4121.78);
  assert.equal(c[0].body.row.line_hash, undefined);
  // a duplicate line (skipped by journal_skip_duplicate) pushes nothing
  await journal(bob, botB, 'OPEN', serverNow(120), 'p-open-1');
  assert.equal((await calls()).length, 1);
});

test('CLOSE and DAYCAP push; other events, old rows, unknown offset and unsubscribed events do not', async () => {
  await clearCalls();
  await journal(bob, botB, 'CLOSE', serverNow(120, 1), 'p-close-1', { pnl: 83.2, detail: 'reason=LOCK pos=1' });
  await journal(bob, botB, 'DAYCAP', serverNow(120), 'p-cap-1');
  await journal(bob, botB, 'SIGNAL', serverNow(120), 'p-sig-1');
  await journal(bob, botB, 'CLOSE', serverNow(120, 45), 'p-close-old');           // 45 min old: history
  await journal(bob, botB, 'OPEN', serverNow(120, 60 * 24), 'p-open-old');
  await journal(erin, botE, 'CLOSE', serverNow(120), 'p-close-erin');              // erin wants open only
  await journal(erin, botE, 'OPEN', serverNow(120), 'p-open-erin');
  assert.deepEqual((await calls()).map(c => [c.body.bot_id, c.body.event]),
    [[botB, 'close'], [botB, 'daycap'], [botE, 'open']]);
  await clearCalls();
  await ctx.as(bob, `update public.bots set server_utc_offset_min = null where id = $1`, [botB]);
  await journal(bob, botB, 'OPEN', serverNow(120), 'p-open-nooff');
  assert.equal((await calls()).length, 0, 'unknown server offset: nothing is pushed');
  await ctx.as(bob, `update public.bots set server_utc_offset_min = 120 where id = $1`, [botB]);
});

test('a disabled owner gets no pushes', async () => {
  await clearCalls();
  await ctx.sql(`update public.profiles set disabled = true where id = $1`, [dave]);
  await ctx.sql(`insert into public.journal (bot_id, ts_server, event, line_hash) values ($1, $2, 'OPEN', 'p-dave')`, [botD, serverNow(120)]);
  assert.equal((await calls()).length, 0);
  await ctx.sql(`update public.profiles set disabled = false where id = $1`, [dave]);
});

test('a broken pg_net never blocks the journal insert', async () => {
  await ctx.sql(`insert into net.fail values (true)`);
  try {
    await journal(bob, botB, 'OPEN', serverNow(120), 'p-open-fail');
    const [r] = await ctx.sql(`select count(*)::int as n from public.journal where line_hash = 'p-open-fail'`);
    assert.equal(r.n, 1);
  } finally {
    await ctx.sql(`delete from net.fail`);
  }
});

test('offline job: bots 5-60 min silent are pushed once, marked, and pushed again after they came back', async () => {
  await clearCalls();
  await setLastSeen(botB, 10);
  await setLastSeen(botE, 10);                       // erin has no "offline" in her events
  await setLastSeen(botD, 90);                       // silent for too long: already old news
  const run = async () => (await ctx.sql(`select dobby_private.push_offline_bots() as n`))[0].n;
  assert.equal(await run(), 1);
  let c = await calls();
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].body.bot_id, c[0].body.event, c[0].body.row.name], [botB, 'offline', 'Bob PC']);
  assert.equal(c[0].headers['x-notify-secret'], SECRET);
  assert.ok((await ctx.sql(`select offline_notified_at from public.bots where id = $1`, [botB]))[0].offline_notified_at);
  assert.equal(await run(), 0, 'not twice for the same outage');
  // the agent is back (PATCH last_seen) -> flag cleared -> the next outage is pushed again
  await ctx.as(bob, `update public.bots set last_seen = now() where id = $1`, [botB]);
  assert.equal((await ctx.sql(`select offline_notified_at from public.bots where id = $1`, [botB]))[0].offline_notified_at, null);
  assert.equal(await run(), 0, 'online again: nothing to say');
  await setLastSeen(botB, 6);
  assert.equal(await run(), 1);
  c = await calls();
  assert.equal(c.length, 2);
  await setLastSeen(botB, 2);
  await ctx.sql(`update public.bots set offline_notified_at = null where id = $1`, [botB]);
  assert.equal(await run(), 0, 'silent for less than 5 minutes: not yet');
});
