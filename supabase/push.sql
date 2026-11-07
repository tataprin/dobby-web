-- =====================================================================================================
-- Dobby Web - push notifications (SPEC 9.7). NOT part of schema.sql: this file needs the pg_net and pg_cron
-- extensions. Run it AFTER schema.sql and after the Edge Function "notify" is deployed (supabase/README.md).
--
-- 1. Replace the TWO placeholders in angle brackets in the first block below (keep the quotes around them):
--      PROJECT_REF    your project id, the part before .supabase.co in the project URL
--      NOTIFY_SECRET  the long random text you saved as the Edge Function secret NOTIFY_SECRET
--    Each placeholder appears exactly once in this file.
-- 2. SQL Editor -> New query -> paste this whole file -> Run.
-- Safe to run again (for example with a new secret): everything is "create or replace" / "if not exists".
-- =====================================================================================================

do $$
declare
  v_ref    text := btrim('<PROJECT_REF>');
  v_secret text := btrim('<NOTIFY_SECRET>');
begin
  if v_ref !~ '^[a-z0-9]{10,40}$' then
    raise exception 'push.sql: put your project id (the part before .supabase.co) into the first block of this file';
  end if;
  if char_length(v_secret) < 24 or v_secret ~ '[<>''\s]' then
    raise exception 'push.sql: put the NOTIFY_SECRET value (at least 24 characters, no spaces) into the first block';
  end if;
  create schema if not exists dobby_private;
  create table if not exists dobby_private.push_settings (key text primary key, value text not null);
  insert into dobby_private.push_settings (key, value) values
    ('notify_url', 'https://' || v_ref || '.supabase.co/functions/v1/notify'),
    ('notify_secret', v_secret)
  on conflict (key) do update set value = excluded.value;
end;
$$;

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Nothing in dobby_private is reachable by clients (the website / agent): not through PostgREST and not by SQL.
revoke all on schema dobby_private from public, anon, authenticated;
revoke all on all tables in schema dobby_private from public, anon, authenticated;


-- -----------------------------------------------------------------------------------------------------
-- 1. Journal rows OPEN / CLOSE / DAYCAP -> POST {bot_id, event, row} to the function (async through pg_net)
-- -----------------------------------------------------------------------------------------------------
-- Only fresh rows are pushed: ts_server (server time) converted with bots.server_utc_offset_min must be at most
-- 30 minutes old. An agent's first upload (history) or a late batch after a long outage therefore never floods the
-- phone, and while the bot's offset is still unknown nothing is pushed. The owner must be approved, not disabled,
-- and have at least one subscription with the event. A push problem never blocks the journal insert.
create or replace function dobby_private.journal_push()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_event  text := lower(new.event);
  v_off    int;
  v_url    text;
  v_secret text;
begin
  select b.server_utc_offset_min into v_off from public.bots b where b.id = new.bot_id;
  if v_off is null
     or new.ts_server - make_interval(mins => v_off) < (now() at time zone 'utc') - interval '30 minutes' then
    return null;
  end if;
  if not exists (select 1
                 from public.bots b
                 join public.profiles p on p.id = b.owner and p.approved and not p.disabled
                 join public.push_subscriptions s on s.user_id = b.owner and v_event = any (s.events)
                 where b.id = new.bot_id) then
    return null;
  end if;
  select value into v_url from dobby_private.push_settings where key = 'notify_url';
  select value into v_secret from dobby_private.push_settings where key = 'notify_secret';
  perform net.http_post(
    url                  := v_url,
    body                 := jsonb_build_object('bot_id', new.bot_id, 'event', v_event,
                                               'row', to_jsonb(new) - 'line_hash'),
    headers              := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    timeout_milliseconds := 5000);
  return null;
exception when others then
  raise warning 'dobby push: journal row % not pushed: %', new.id, sqlerrm;
  return null;
end;
$$;

drop trigger if exists dobby_journal_push on public.journal;
create trigger dobby_journal_push
  after insert on public.journal
  for each row
  when (new.event in ('OPEN', 'CLOSE', 'DAYCAP'))
  execute function dobby_private.journal_push();


-- -----------------------------------------------------------------------------------------------------
-- 2. "Bot offline": every 5 minutes, bots whose last_seen is 5-60 minutes old and not yet notified.
--    bots.offline_notified_at is set here; schema.sql (bots_before) clears it when last_seen moves again.
-- -----------------------------------------------------------------------------------------------------
create or replace function dobby_private.push_offline_bots()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  r        record;
  n        int := 0;
  v_url    text;
  v_secret text;
begin
  select value into v_url from dobby_private.push_settings where key = 'notify_url';
  select value into v_secret from dobby_private.push_settings where key = 'notify_secret';
  for r in
    select b.id, b.name, b.last_seen
    from public.bots b
    join public.profiles p on p.id = b.owner and p.approved and not p.disabled
    where b.last_seen <= now() - interval '5 minutes'
      and b.last_seen >  now() - interval '60 minutes'
      and b.offline_notified_at is null
      and exists (select 1 from public.push_subscriptions s where s.user_id = b.owner and 'offline' = any (s.events))
    for update of b skip locked
  loop
    begin
      perform net.http_post(
        url                  := v_url,
        body                 := jsonb_build_object('bot_id', r.id, 'event', 'offline',
                                                   'row', jsonb_build_object('name', r.name, 'last_seen', r.last_seen)),
        headers              := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
        timeout_milliseconds := 5000);
    exception when others then
      raise warning 'dobby push: offline bot % not pushed: %', r.id, sqlerrm;
    end;
    update public.bots set offline_notified_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function dobby_private.journal_push()      from public, anon, authenticated;
revoke execute on function dobby_private.push_offline_bots() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'dobby-push-offline';
  perform cron.schedule('dobby-push-offline', '*/5 * * * *', 'select dobby_private.push_offline_bots()');
end;
$$;


-- The SQL editor shows this last result: where the pushes go (the secret is not shown) and the job.
select (select value from dobby_private.push_settings where key = 'notify_url')        as notify_url,
       (select count(*) from cron.job where jobname = 'dobby-push-offline')::int        as offline_job,
       (select count(*) from pg_trigger where tgname = 'dobby_journal_push')::int       as journal_trigger;
