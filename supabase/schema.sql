-- =====================================================================================================
-- Dobby Web - database schema for Supabase (contract: SPEC.md sections 2, 9 and 10)
--
-- HOW TO USE: Supabase dashboard -> SQL Editor -> New query -> paste this WHOLE file -> Run.
-- The last result shows the bootstrap admin invite code (first run only; see README.md).
--
-- Re-runnable: it never drops a table or deletes data. Tables use "create ... if not exists", functions use
-- "create or replace", policies and triggers are dropped and created again, the realtime publication and the
-- storage bucket are guarded. Runs as role postgres.
--
-- Safety design (short version, details in README.md):
--   * RLS on every table; anon has no privileges at all; authenticated gets only the privileges it needs.
--   * Live gate (SPEC 2.4) is a BEFORE trigger on bot_control. It is checked for every statement that runs as a
--     client role (anon / authenticated = every request from the website or the agent through the Supabase API).
--   * Clients cannot INSERT into bot_control (no grant, no policy). The only insert path is register_bot(), a
--     SECURITY DEFINER function; inside it current_user is the function owner (postgres), not a client role,
--     so its insert is the one place where live = true is accepted without re-auth. No session variable, flag
--     or nonce is involved, so there is nothing a client could set to imitate it.
-- =====================================================================================================


-- -----------------------------------------------------------------------------------------------------
-- 1. Tables (SPEC 2.1)
-- -----------------------------------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role         text not null default 'member' check (role in ('admin', 'member')),
  approved     boolean not null default false,
  disabled     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists public.invites (
  code       text primary key check (code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  role       text not null default 'member' check (role in ('admin', 'member')),
  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by    uuid references public.profiles(id) on delete set null,
  used_at    timestamptz,
  revoked    boolean not null default false
);

create table if not exists public.bots (
  id                    uuid primary key default gen_random_uuid(),
  owner                 uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name                  text not null check (btrim(name) <> ''),
  created_at            timestamptz not null default now(),
  last_seen             timestamptz,
  agent_version         text,
  ea_version            text,
  symbol                text,
  server_utc_offset_min int,
  agent_state           jsonb not null default '{}'::jsonb
);
create index if not exists bots_owner_idx on public.bots (owner);

create table if not exists public.bot_status (
  bot_id     uuid primary key references public.bots(id) on delete cascade,
  updated_at timestamptz not null default now(),
  status     jsonb not null
);

create table if not exists public.journal (
  id        bigserial primary key,
  bot_id    uuid not null references public.bots(id) on delete cascade,
  ts_server timestamp not null,
  event     text not null,
  tag       text,
  side      text,
  lots      numeric,
  price     numeric,
  sl        numeric,
  tp        numeric,
  pnl       numeric,
  v_balance numeric,
  step      int,
  detail    text,
  line_hash text not null,
  unique (bot_id, line_hash)
);
create index if not exists journal_bot_ts_idx on public.journal (bot_id, ts_server desc);

create table if not exists public.bot_control (
  bot_id     uuid primary key references public.bots(id) on delete cascade,
  version    int not null default 1,
  -- desired must be a JSON object; desired.live, when present, must be a JSON boolean (or null) so the live gate
  -- and the agent can never disagree about what "live" means.
  desired    jsonb not null check (
               jsonb_typeof(desired) = 'object'
               and (desired -> 'live' is null or jsonb_typeof(desired -> 'live') in ('boolean', 'null'))),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.presets (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name       text not null,
  params     jsonb not null,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists presets_owner_idx on public.presets (owner);

create table if not exists public.audit (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  actor  uuid,
  bot_id uuid,
  action text not null,
  before jsonb,
  after  jsonb
);
create index if not exists audit_bot_ts_idx on public.audit (bot_id, ts desc);
create index if not exists audit_actor_ts_idx on public.audit (actor, ts desc);

create table if not exists public.news_events (
  id     bigserial primary key,
  ts_utc timestamptz not null,
  name   text not null,
  tier   int not null default 1,
  note   text,
  unique (ts_utc, name)
);

-- SPEC 9.1: the EA's M15 bars (uploaded by the agent, read by the trade page). Not in realtime.
create table if not exists public.bars (
  bot_id uuid    not null references public.bots(id) on delete cascade,
  t      timestamptz not null,                     -- bar open time, UTC
  close  numeric not null,
  vwap   numeric,
  primary key (bot_id, t)
);

-- SPEC 9.2: deposits (+) and withdrawals (-); the agent inserts 'auto' suggestions, the owner confirms / dismisses.
create table if not exists public.cash_flows (
  id            bigserial primary key,
  bot_id        uuid not null references public.bots(id) on delete cascade,
  ts            timestamptz not null,
  amount        numeric not null check (amount <> 0),
  source        text not null check (source in ('auto', 'manual')),
  status        text not null default 'confirmed' check (status in ('suggested', 'confirmed', 'dismissed')),
  balance_after numeric,
  note          text check (note is null or char_length(note) <= 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists cash_flows_bot_ts_idx on public.cash_flows (bot_id, ts desc);

-- SPEC 9.6: a note + tags per trade; trade_key = '<tag>|<open ts_server YYYY-MM-DD HH:MM:SS>'.
create table if not exists public.trade_notes (
  bot_id     uuid not null references public.bots(id) on delete cascade,
  trade_key  text not null check (char_length(trade_key) between 1 and 200),
  note       text check (note is null or char_length(note) <= 5000),
  tags       text[] not null default '{}' check (cardinality(tags) <= 30),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (bot_id, trade_key)
);

-- SPEC 9.8: counting rounds (รอบ). Only a way to split the history on the website: the bot never reads it. A round
-- runs from started_at to the next round's started_at; started_at null = round 1, from the very beginning. base =
-- what the status showed at the start (account balance, virtual balance and start), for the % and for the AI.
create table if not exists public.rounds (
  id         bigserial primary key,
  bot_id     uuid not null references public.bots(id) on delete cascade,
  started_at timestamptz,
  name       text check (name is null or char_length(name) <= 60),
  base       jsonb not null default '{}'::jsonb check (jsonb_typeof(base) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index if not exists rounds_bot_start_idx on public.rounds (bot_id, started_at);
create unique index if not exists rounds_bot_first_idx on public.rounds (bot_id) where started_at is null;

-- SPEC 10.1: AI assistant. ai_config is exactly one row (id = 1), seeded here; "on conflict do nothing" keeps the
-- admin's settings on every re-run. (Changing the allowed model list later: drop constraint ai_config_model_check
-- and add the new one.)
create table if not exists public.ai_config (
  id                 int primary key default 1 check (id = 1),
  enabled            boolean not null default true,
  member_daily_limit int not null default 20 check (member_daily_limit between 0 and 1000),
  admin_daily_limit  int not null default 100 check (admin_daily_limit between 0 and 5000),
  monthly_budget_usd numeric not null default 30 check (monthly_budget_usd between 0 and 100000),
  model              text not null default 'claude-opus-5-5'
                       check (model in ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5')),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);
insert into public.ai_config (id) values (1) on conflict (id) do nothing;

-- Chats are private: only the user reads them (no admin read).
create table if not exists public.ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title      text not null default 'บทสนทนาใหม่' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_user_updated_idx on public.ai_conversations (user_id, updated_at desc);

create table if not exists public.ai_messages (
  id              bigserial primary key,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  user_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) between 1 and 30000),
  -- user: {page, bot_id, trade_key, now_th}; assistant: {proposals, tools}
  context         jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  created_at      timestamptz not null default now()
);
create index if not exists ai_messages_conversation_idx on public.ai_messages (conversation_id, id);

-- One row per chat turn, written only by the service_role RPCs ai_start_turn / ai_finish_turn.
-- conversation_id has no FK on purpose: a deleted conversation keeps its cost.
create table if not exists public.ai_usage (
  id                 bigserial primary key,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  conversation_id    uuid,
  ts                 timestamptz not null default now(),
  model              text not null,
  status             text not null default 'pending' check (status in ('pending', 'ok', 'error', 'refused')),
  input_tokens       int not null default 0 check (input_tokens >= 0),
  output_tokens      int not null default 0 check (output_tokens >= 0),
  cache_read_tokens  int not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens int not null default 0 check (cache_write_tokens >= 0),
  cost_usd           numeric(12, 6) not null default 0 check (cost_usd >= 0)
);
create index if not exists ai_usage_user_ts_idx on public.ai_usage (user_id, ts desc);
create index if not exists ai_usage_ts_idx on public.ai_usage (ts);

-- Shadow AI (SPEC 10.6, 2026-11-11): while a bot trade is open, the Dobby app asks the Edge Function `shadow` every
-- few minutes what Claude would do with it (hold / close / tighten the stop / reverse). The answer is ONLY recorded
-- here for a forward test; nothing is ever sent to the EA. Off by default; the admin turns it on and sets its own
-- model, monthly budget and interval (separate from the assistant's budget). Rows are written only by the
-- service_role RPC shadow_record; the owner (and the admin) read them.
alter table public.ai_config add column if not exists shadow_enabled boolean not null default false;
alter table public.ai_config add column if not exists shadow_model text not null default 'claude-opus-5-5'
  check (shadow_model in ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'));
alter table public.ai_config add column if not exists shadow_budget_usd numeric not null default 30
  check (shadow_budget_usd between 0 and 10000);
-- 2026-11-11 (site owner): Opus 5.5 and 30 USD are the defaults. A row made by the first version of this block keeps
-- the admin's values; the admin changes them on ผู้ใช้ > ผู้ช่วย AI.
alter table public.ai_config alter column shadow_model set default 'claude-opus-5-5';
alter table public.ai_config alter column shadow_budget_usd set default 30;
alter table public.ai_config add column if not exists shadow_interval_s int not null default 300
  check (shadow_interval_s between 60 and 3600);

create table if not exists public.shadow_decisions (
  id            bigserial primary key,
  bot_id        uuid not null references public.bots(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  ts            timestamptz not null default now(),
  ticket        bigint not null check (ticket > 0),
  module        text not null check (char_length(module) between 1 and 24),
  side          text not null check (side in ('BUY', 'SELL')),
  lots          numeric,
  open_price    numeric,
  sl            numeric,
  tp            numeric,
  bid           numeric,
  ask           numeric,
  profit        numeric,
  server_time   text check (server_time is null or char_length(server_time) <= 24),
  action        text not null check (action in ('hold', 'close', 'tighten', 'reverse', 'error')),
  new_sl        numeric,
  confidence    int check (confidence is null or confidence between 0 and 100),
  reason        text not null default '' check (char_length(reason) <= 2000),
  valid         boolean not null default true,     -- false: e.g. a tighten whose stop is not between SL and price
  snapshot      jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  model         text,
  input_tokens  int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  cost_usd      numeric(12, 6) not null default 0 check (cost_usd >= 0)
);
-- the numbers behind each action (SPEC 10.6): prices the AI chose and the money they mean at this trade's lots, e.g.
-- {"close_pnl": 55.4} / {"new_sl": 4049.9, "locked_pnl": 5.4} / {"reverse": {"side": "SELL", "entry": .., "sl": ..,
-- "tp": .., "risk": .., "reward": ..}} / {"hold_target": .., "target_pnl": .., "hold_exit": .., "exit_pnl": ..}
alter table public.shadow_decisions add column if not exists details jsonb not null default '{}'::jsonb
  check (jsonb_typeof(details) = 'object');
-- how many reviews the AI's memory held when it decided (0 = before any learning): splits the forward test by stage
alter table public.shadow_decisions add column if not exists memory_rev int not null default 0 check (memory_rev >= 0);
create index if not exists shadow_decisions_bot_ts_idx on public.shadow_decisions (bot_id, ts desc);

-- Shadow AI memory (SPEC 10.7, 2026-11-11): after every closed trade the AI reviews its own decisions against what
-- really happened (shadow_reviews) and keeps a short list of lessons per bot (shadow_lessons) that it reads before every
-- decision. weight = reviews that supported the lesson minus those that contradicted it; at 0 a lesson is retired.
-- At most 20 active lessons per bot (the lowest weight, then the oldest, is retired first). Written only by the
-- service_role RPC shadow_review_record; the owner and the admin read them; the owner may retire a lesson by hand.
create table if not exists public.shadow_reviews (
  id            bigserial primary key,
  bot_id        uuid not null references public.bots(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  ts            timestamptz not null default now(),
  ticket        bigint not null check (ticket > 0),
  module        text,
  side          text,
  outcome       jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome) = 'object'),   -- real result + per-decision checks
  summary       text not null default '' check (char_length(summary) <= 3000),
  mistakes      text not null default '' check (char_length(mistakes) <= 3000),
  ops           jsonb not null default '[]'::jsonb check (jsonb_typeof(ops) = 'array'),          -- lesson changes applied
  model         text,
  input_tokens  int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  cost_usd      numeric(12, 6) not null default 0 check (cost_usd >= 0),
  unique (bot_id, ticket)
);
create index if not exists shadow_reviews_bot_ts_idx on public.shadow_reviews (bot_id, ts desc);

create table if not exists public.shadow_lessons (
  id          bigserial primary key,
  bot_id      uuid not null references public.bots(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  text        text not null check (char_length(btrim(text)) between 1 and 400),
  weight      int not null default 1,
  status      text not null default 'active' check (status in ('active', 'retired')),
  tickets     bigint[] not null default '{}'                    -- the trades whose reviews touched this lesson
);
create index if not exists shadow_lessons_bot_idx on public.shadow_lessons (bot_id, status, weight desc);
create index if not exists shadow_decisions_ticket_idx on public.shadow_decisions (bot_id, ticket, ts);
create index if not exists shadow_decisions_ts_idx on public.shadow_decisions (ts);

-- Push notifications were removed (2026-11-08, site owner's decision). Drop what a run of the 2026-11-07 version of
-- this file created; nothing else used these objects.
drop function if exists public.register_push_subscription(text, text, text, text, text[]);
drop table if exists public.push_subscriptions;
alter table public.bots drop column if exists offline_notified_at;

alter table public.profiles    enable row level security;
alter table public.invites     enable row level security;
alter table public.bots        enable row level security;
alter table public.bot_status  enable row level security;
alter table public.journal     enable row level security;
alter table public.bot_control enable row level security;
alter table public.presets     enable row level security;
alter table public.audit       enable row level security;
alter table public.news_events enable row level security;
alter table public.bars               enable row level security;
alter table public.cash_flows         enable row level security;
alter table public.trade_notes        enable row level security;
alter table public.rounds             enable row level security;
alter table public.ai_config          enable row level security;
alter table public.ai_conversations   enable row level security;
alter table public.ai_messages        enable row level security;
alter table public.ai_usage           enable row level security;
alter table public.shadow_decisions   enable row level security;
alter table public.shadow_reviews     enable row level security;
alter table public.shadow_lessons     enable row level security;


-- -----------------------------------------------------------------------------------------------------
-- 2. Helper functions (security definer, stable, search_path = public; every object fully qualified)
-- -----------------------------------------------------------------------------------------------------
create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.approved and not p.disabled
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.approved and not p.disabled and p.role = 'admin'
  );
$$;

-- Spec addition: true when the caller is approved and owns the bot.
create or replace function public.owns_bot(p_bot uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.bots b join public.profiles p on p.id = b.owner
    where b.id = p_bot and b.owner = auth.uid() and p.approved and not p.disabled
  );
$$;

-- Internal: has the CALLER signed in again recently? Returns 'ok', 'reauth_required' or 'mfa_required' for auth.uid()
-- and the caller's own JWT:
--   (a) the JWT claim amr must hold a password / otp / totp sign-in whose timestamp is within the last p_window_s s;
--   (b) if the caller has a verified MFA factor, the JWT claim aal must be 'aal2'.
create or replace function public.fresh_auth_status(p_window_s int)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid   uuid  := auth.uid();
  v_jwt   jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_amr   jsonb;
  v_fresh boolean;
begin
  if v_uid is null then
    return 'reauth_required';
  end if;
  v_amr := case when jsonb_typeof(v_jwt -> 'amr') = 'array' then v_jwt -> 'amr' else '[]'::jsonb end;
  select exists (
    select 1
    from jsonb_array_elements(v_amr) e
    where jsonb_typeof(e) = 'object'
      and e ->> 'method' in ('password', 'otp', 'totp')
      and jsonb_typeof(e -> 'timestamp') = 'number'
      and (e ->> 'timestamp')::numeric >= extract(epoch from now()) - p_window_s
  ) into v_fresh;
  if not v_fresh then
    return 'reauth_required';
  end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status::text = 'verified')
     and coalesce(v_jwt ->> 'aal', '') <> 'aal2' then
    return 'mfa_required';
  end if;
  return 'ok';
end;
$$;

-- Spec addition: the live gate (SPEC 2.4) as a function, so the website can ask before it shows the switch.
-- Returns 'ok', 'reauth_required' or 'mfa_required' for the CALLER: a fresh sign-in within the last 300 s.
create or replace function public.live_gate_status()
returns text
language plpgsql stable security definer set search_path = public
as $$
begin
  return public.fresh_auth_status(300);
end;
$$;

-- 2026-11-10: the admin may change the settings of a member's bot (bot_control only; see bot_control_before and the
-- bot_control_update policy), after signing in again with the admin's own password within the last 30 min (and 2FA when
-- the admin has it). Returns 'ok', 'admin_only', 'admin_reauth_required' or 'admin_mfa_required' for the CALLER.
-- Turning live ON on that bot still needs the live gate (300 s) on top.
create or replace function public.admin_edit_status()
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v text;
begin
  if not public.is_admin() then
    return 'admin_only';
  end if;
  v := public.fresh_auth_status(1800);
  return case when v = 'ok' then 'ok' else 'admin_' || v end;
end;
$$;

-- Internal: 10-char invite code, alphabet A-Z 2-9 without I O 0 1 (32 symbols). Randomness comes from
-- gen_random_uuid() (built in, uses the server's strong random source); 32 divides 256, so "byte % 32" is
-- unbiased. Byte 6 carries the UUID version nibble, so it is skipped. No pgcrypto needed.
create or replace function public.gen_invite_code()
returns text
language plpgsql volatile set search_path = public
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_code  text  := '';
  i       int;
begin
  foreach i in array array[0, 1, 2, 3, 4, 5, 7, 8, 9, 10] loop
    v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_code;
end;
$$;

-- Internal (SPEC 10.2): a user's ai_usage rows of the current Thai day (Asia/Bangkok), any status (a pending row
-- left by a crashed call counts too).
create or replace function public.ai_used_today(p_user uuid)
returns int
language sql stable set search_path = public
as $$
  select count(*)::int from public.ai_usage u
  where u.user_id = p_user
    and u.ts >= (date_trunc('day', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok');
$$;

-- Internal (SPEC 10.2): total cost of every user's ai_usage rows in the current Thai calendar month.
create or replace function public.ai_month_cost()
returns numeric
language sql stable set search_path = public
as $$
  select coalesce(sum(u.cost_usd), 0) from public.ai_usage u
  where u.ts >= (date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok');
$$;


-- -----------------------------------------------------------------------------------------------------
-- 3. RPCs (SPEC 2.2). Errors are raised with a short code as the message (shown to the UI as error.message).
-- -----------------------------------------------------------------------------------------------------
create or replace function public.redeem_invite(p_code text)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  v_prof public.profiles%rowtype;
  v_inv  public.invites%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  -- create the profile if the auth trigger did not (e.g. user created before this schema was applied)
  insert into public.profiles (id, display_name)
    select u.id, nullif(split_part(coalesce(u.email::text, ''), '@', 1), '') from auth.users u where u.id = v_uid
    on conflict (id) do nothing;
  select * into v_prof from public.profiles where id = v_uid for update;
  if not found then
    raise exception 'not_authenticated';
  end if;
  if v_prof.disabled then
    raise exception 'account_disabled';
  end if;
  if v_prof.approved then
    return 'already_approved';                       -- the code stays unused
  end if;
  select * into v_inv from public.invites where code = v_code for update;
  if not found or v_inv.revoked or v_inv.used_at is not null or v_inv.used_by is not null
     or v_inv.expires_at <= now() then
    raise exception 'invite_invalid';
  end if;
  update public.invites set used_by = v_uid, used_at = now() where code = v_code;
  update public.profiles set approved = true, role = v_inv.role where id = v_uid;
  insert into public.audit (actor, action, before, after)
    values (v_uid, 'invite_redeem', to_jsonb(v_prof),
            jsonb_build_object('code', v_code, 'role', v_inv.role, 'approved', true));
  return 'ok';
end;
$$;

create or replace function public.create_invite(p_role text default 'member', p_days int default 7,
                                                p_note text default null)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_role text := lower(btrim(coalesce(p_role, 'member')));
  v_days int  := coalesce(p_days, 7);
  v_code text;
  v_row  public.invites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;
  if v_role not in ('admin', 'member') then
    raise exception 'role_invalid';
  end if;
  if v_days < 1 or v_days > 365 then
    raise exception 'days_invalid';
  end if;
  loop
    v_code := public.gen_invite_code();
    insert into public.invites (code, role, note, created_by, expires_at)
      values (v_code, v_role, nullif(btrim(p_note), ''), auth.uid(), now() + make_interval(days => v_days))
      on conflict (code) do nothing
      returning * into v_row;
    exit when found;
  end loop;
  insert into public.audit (actor, action, after) values (auth.uid(), 'admin_create_invite', to_jsonb(v_row));
  return v_code;
end;
$$;

create or replace function public.revoke_invite(p_code text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  v_old  public.invites%rowtype;
  v_new  public.invites%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;
  select * into v_old from public.invites where code = v_code for update;
  if not found then
    raise exception 'invite_not_found';
  end if;
  update public.invites set revoked = true where code = v_code returning * into v_new;
  insert into public.audit (actor, action, before, after)
    values (auth.uid(), 'admin_revoke_invite', to_jsonb(v_old), to_jsonb(v_new));
end;
$$;

-- A null argument keeps the current value (spec addition).
create or replace function public.admin_set_user(p_user uuid, p_role text, p_approved boolean, p_disabled boolean)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_old      public.profiles%rowtype;
  v_new      public.profiles%rowtype;
  v_role     text;
  v_approved boolean;
  v_disabled boolean;
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;
  select * into v_old from public.profiles where id = p_user for update;
  if not found then
    raise exception 'user_not_found';
  end if;
  v_role     := coalesce(lower(btrim(p_role)), v_old.role);
  v_approved := coalesce(p_approved, v_old.approved);
  v_disabled := coalesce(p_disabled, v_old.disabled);
  if v_role not in ('admin', 'member') then
    raise exception 'role_invalid';
  end if;
  if p_user = auth.uid() then
    if v_role <> 'admin' or not v_approved then
      raise exception 'cannot_demote_self';
    end if;
    if v_disabled then
      raise exception 'cannot_disable_self';
    end if;
  end if;
  update public.profiles set role = v_role, approved = v_approved, disabled = v_disabled
    where id = p_user returning * into v_new;
  insert into public.audit (actor, action, before, after)
    values (auth.uid(), 'admin_set_user', to_jsonb(v_old), to_jsonb(v_new));
end;
$$;

create or replace function public.set_display_name(p_name text)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_old  public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 60 then
    raise exception 'name_invalid';
  end if;
  select * into v_old from public.profiles where id = auth.uid() for update;
  if not found then
    raise exception 'not_authenticated';
  end if;
  update public.profiles set display_name = v_name where id = auth.uid();
  insert into public.audit (actor, action, before, after)
    values (auth.uid(), 'profile_display_name', jsonb_build_object('display_name', v_old.display_name),
            jsonb_build_object('display_name', v_name));
end;
$$;

-- Who the users are and how many bots they run (the admin reads each bot's status / settings / journal directly
-- through the select policies). email is a spec addition (display_name alone cannot tell two "john" apart).
create or replace function public.admin_overview()
returns table (user_id uuid, display_name text, role text, approved boolean, disabled boolean,
               created_at timestamptz, bots int, last_seen timestamptz, email text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;
  return query
    select p.id,
           p.display_name,
           p.role,
           p.approved,
           p.disabled,
           p.created_at,
           (select count(*)::int from public.bots b where b.owner = p.id),
           (select max(b.last_seen) from public.bots b where b.owner = p.id),
           u.email::text
    from public.profiles p
    left join auth.users u on u.id = p.id
    order by p.created_at, p.id;
end;
$$;

-- The ONLY way to create a bot_control row. Runs as the function owner, so the bot_control trigger sees a
-- non-client current_user and does not apply the insert gate (first registration copies the bot's current state).
create or replace function public.register_bot(p_name text, p_desired jsonb)
returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  if v_uid is null or not public.is_approved() then
    raise exception 'not_approved';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'name_invalid';
  end if;
  if p_desired is null or jsonb_typeof(p_desired) <> 'object'
     or (p_desired -> 'live' is not null and jsonb_typeof(p_desired -> 'live') not in ('boolean', 'null')) then
    raise exception 'desired_invalid';
  end if;
  insert into public.bots (owner, name) values (v_uid, v_name) returning id into v_id;
  insert into public.bot_control (bot_id, version, desired, updated_by) values (v_id, 1, p_desired, v_uid);
  return v_id;
end;
$$;

-- SPEC 10.2: the caller's AI quota. "today" = the Thai day, "month" = the Thai calendar month (Asia/Bangkok).
-- budget_reached = this month's cost of EVERY user >= monthly_budget_usd (a budget of 0 means no AI at all).
-- The admin also gets month_cost_usd and monthly_budget_usd.
create or replace function public.ai_quota()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_prof public.profiles%rowtype;
  v_cfg  public.ai_config%rowtype;
  v_cost numeric;
  v_out  jsonb;
begin
  select * into v_prof from public.profiles where id = v_uid;
  if not found or not v_prof.approved or v_prof.disabled then
    raise exception 'not_approved';
  end if;
  select * into v_cfg from public.ai_config where id = 1;
  if not found then
    raise exception 'ai_disabled';
  end if;
  v_cost := public.ai_month_cost();
  v_out := jsonb_build_object(
    'enabled',        v_cfg.enabled,
    'model',          v_cfg.model,
    'used_today',     public.ai_used_today(v_uid),
    'limit_today',    case when v_prof.role = 'admin' then v_cfg.admin_daily_limit else v_cfg.member_daily_limit end,
    'budget_reached', v_cost >= v_cfg.monthly_budget_usd);
  if v_prof.role = 'admin' then
    v_out := v_out || jsonb_build_object('month_cost_usd', v_cost, 'monthly_budget_usd', v_cfg.monthly_budget_usd);
  end if;
  return v_out;
end;
$$;

-- SPEC 10.2: service_role ONLY (the Edge Function `chat`). Checks in this order: not_approved, ai_disabled,
-- ai_daily_limit, ai_monthly_budget; then inserts a 'pending' ai_usage row with the configured model.
-- The ai_config row is locked (FOR UPDATE) before counting, so parallel turns run these checks one at a time and
-- two of them cannot both take the last free slot (each statement then sees the other's committed row).
create or replace function public.ai_start_turn(p_user uuid, p_conversation uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_prof  public.profiles%rowtype;
  v_cfg   public.ai_config%rowtype;
  v_limit int;
  v_used  int;
  v_id    bigint;
begin
  select * into v_prof from public.profiles where id = p_user;
  if not found or not v_prof.approved or v_prof.disabled then
    raise exception 'not_approved';
  end if;
  select * into v_cfg from public.ai_config where id = 1 for update;
  if not found or not v_cfg.enabled then
    raise exception 'ai_disabled';
  end if;
  v_limit := case when v_prof.role = 'admin' then v_cfg.admin_daily_limit else v_cfg.member_daily_limit end;
  v_used  := public.ai_used_today(p_user);
  if v_used >= v_limit then
    raise exception 'ai_daily_limit';
  end if;
  if public.ai_month_cost() >= v_cfg.monthly_budget_usd then
    raise exception 'ai_monthly_budget';
  end if;
  insert into public.ai_usage (user_id, conversation_id, model, status)
    values (p_user, p_conversation, v_cfg.model, 'pending')
    returning id into v_id;
  return jsonb_build_object('usage_id', v_id, 'model', v_cfg.model, 'used_today', v_used + 1,
                            'limit_today', v_limit, 'role', v_prof.role);
end;
$$;

-- SPEC 10.2: service_role ONLY. Finishes a 'pending' row once; a finished row never changes again
-- (usage_finished). A null token count / cost counts as 0; a null p_conversation keeps the row's conversation.
create or replace function public.ai_finish_turn(p_usage_id bigint, p_status text, p_input int, p_output int,
                                                 p_cache_read int, p_cache_write int, p_cost numeric,
                                                 p_conversation uuid)
returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  if p_status is null or p_status not in ('ok', 'error', 'refused') then
    raise exception 'status_invalid';
  end if;
  if coalesce(p_input, 0) < 0 or coalesce(p_output, 0) < 0
     or coalesce(p_cache_read, 0) < 0 or coalesce(p_cache_write, 0) < 0 then
    raise exception 'tokens_invalid';
  end if;
  if coalesce(p_cost, 0) < 0 then
    raise exception 'cost_invalid';
  end if;
  update public.ai_usage
     set status             = p_status,
         input_tokens       = coalesce(p_input, 0),
         output_tokens      = coalesce(p_output, 0),
         cache_read_tokens  = coalesce(p_cache_read, 0),
         cache_write_tokens = coalesce(p_cache_write, 0),
         cost_usd           = coalesce(p_cost, 0),
         conversation_id    = coalesce(p_conversation, conversation_id)
   where id = p_usage_id and status = 'pending';
  if not found then
    if exists (select 1 from public.ai_usage where id = p_usage_id) then
      raise exception 'usage_finished';
    end if;
    raise exception 'usage_not_found';
  end if;
end;
$$;

-- SPEC 10.6: this Thai calendar month's cost of every shadow decision (the shadow AI has its own budget).
create or replace function public.shadow_month_cost()
returns numeric
language sql stable set search_path = public
as $$
  select coalesce((select sum(d.cost_usd) from public.shadow_decisions d
                   where d.ts >= (date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')), 0)
       + coalesce((select sum(r.cost_usd) from public.shadow_reviews r
                   where r.ts >= (date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')), 0);
$$;

-- SPEC 10.6: service_role ONLY (the Edge Function `shadow`). Checks in this order: not_approved, bot_not_found
-- (the bot must be the user's own), shadow_disabled, shadow_budget, shadow_too_soon (one question per open trade per
-- interval, 20 s grace); returns the model and the interval. The ai_config row is locked so parallel calls queue.
create or replace function public.shadow_start(p_user uuid, p_bot uuid, p_ticket bigint)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_prof public.profiles%rowtype;
  v_cfg  public.ai_config%rowtype;
  v_last timestamptz;
begin
  select * into v_prof from public.profiles where id = p_user;
  if not found or not v_prof.approved or v_prof.disabled then
    raise exception 'not_approved';
  end if;
  if not exists (select 1 from public.bots b where b.id = p_bot and b.owner = p_user) then
    raise exception 'bot_not_found';
  end if;
  select * into v_cfg from public.ai_config where id = 1 for update;
  if not found or not v_cfg.shadow_enabled then
    raise exception 'shadow_disabled';
  end if;
  if public.shadow_month_cost() >= v_cfg.shadow_budget_usd then
    raise exception 'shadow_budget';
  end if;
  select max(d.ts) into v_last from public.shadow_decisions d where d.bot_id = p_bot and d.ticket = p_ticket;
  if v_last is not null and v_last > now() - make_interval(secs => greatest(v_cfg.shadow_interval_s - 20, 30)) then
    raise exception 'shadow_too_soon';
  end if;
  return jsonb_build_object('model', v_cfg.shadow_model, 'interval_s', v_cfg.shadow_interval_s,
                            'memory_rev', (select count(*)::int from public.shadow_reviews r where r.bot_id = p_bot));
end;
$$;

-- SPEC 10.7: service_role ONLY. May the AI review this closed trade? not_approved, bot_not_found, shadow_disabled,
-- shadow_budget, review_done (already reviewed), review_nothing (no decision was recorded for this ticket).
create or replace function public.shadow_review_start(p_user uuid, p_bot uuid, p_ticket bigint)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_prof public.profiles%rowtype;
  v_cfg  public.ai_config%rowtype;
begin
  select * into v_prof from public.profiles where id = p_user;
  if not found or not v_prof.approved or v_prof.disabled then
    raise exception 'not_approved';
  end if;
  if not exists (select 1 from public.bots b where b.id = p_bot and b.owner = p_user) then
    raise exception 'bot_not_found';
  end if;
  select * into v_cfg from public.ai_config where id = 1 for update;
  if not found or not v_cfg.shadow_enabled then
    raise exception 'shadow_disabled';
  end if;
  if public.shadow_month_cost() >= v_cfg.shadow_budget_usd then
    raise exception 'shadow_budget';
  end if;
  if exists (select 1 from public.shadow_reviews r where r.bot_id = p_bot and r.ticket = p_ticket) then
    raise exception 'review_done';
  end if;
  if not exists (select 1 from public.shadow_decisions d where d.bot_id = p_bot and d.ticket = p_ticket) then
    raise exception 'review_nothing';
  end if;
  return jsonb_build_object('model', v_cfg.shadow_model);
end;
$$;

-- SPEC 10.7: service_role ONLY. Stores the review and applies its lesson changes in one transaction. p_ops items:
-- {"op":"add","text":".."} | {"op":"reinforce"|"weaken"|"retire","id":<lesson id of this bot>}. Unknown ids / ops are
-- skipped. Then at most 20 active lessons stay. Returns {review_id, applied: [...]}.
create or replace function public.shadow_review_record(p_user uuid, p_bot uuid, p_row jsonb, p_ops jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_id      bigint;
  v_ticket  bigint := (p_row->>'ticket')::bigint;
  v_op      jsonb;
  v_lesson  bigint;
  v_applied jsonb := '[]'::jsonb;
  v_text    text;
begin
  if not exists (select 1 from public.bots b where b.id = p_bot and b.owner = p_user) then
    raise exception 'bot_not_found';
  end if;
  for v_op in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]'::jsonb end)
  loop
    if v_op->>'op' = 'add' then
      v_text := left(btrim(coalesce(v_op->>'text', '')), 400);
      if v_text <> '' then
        insert into public.shadow_lessons (bot_id, user_id, text, tickets) values (p_bot, p_user, v_text, array[v_ticket])
          returning id into v_lesson;
        v_applied := v_applied || jsonb_build_object('op', 'add', 'id', v_lesson, 'text', v_text, 'why', left(coalesce(v_op->>'why', ''), 400));
      end if;
    elsif v_op->>'op' in ('reinforce', 'weaken', 'retire') and (v_op->>'id') ~ '^\d+$' then
      update public.shadow_lessons l
         set weight = case v_op->>'op' when 'reinforce' then l.weight + 1 when 'weaken' then l.weight - 1 else l.weight end,
             status = case when v_op->>'op' = 'retire' or (v_op->>'op' = 'weaken' and l.weight - 1 <= 0) then 'retired' else l.status end,
             tickets = case when v_ticket = any(l.tickets) then l.tickets else (l.tickets || v_ticket)[greatest(1, cardinality(l.tickets) - 18):] end,
             updated_at = now()
       where l.id = (v_op->>'id')::bigint and l.bot_id = p_bot and l.status = 'active'
       returning l.id into v_lesson;
      if v_lesson is not null then
        v_applied := v_applied || jsonb_build_object('op', v_op->>'op', 'id', v_lesson, 'why', left(coalesce(v_op->>'why', ''), 400));
      end if;
      v_lesson := null;
    end if;
  end loop;
  -- keep at most 20 active lessons
  update public.shadow_lessons set status = 'retired', updated_at = now()
   where id in (select l.id from public.shadow_lessons l where l.bot_id = p_bot and l.status = 'active'
                order by l.weight desc, l.updated_at desc offset 20);
  insert into public.shadow_reviews (bot_id, user_id, ticket, module, side, outcome, summary, mistakes, ops, model,
                                     input_tokens, output_tokens, cost_usd)
  values (p_bot, p_user, v_ticket, p_row->>'module', p_row->>'side',
          case when jsonb_typeof(p_row->'outcome') = 'object' then p_row->'outcome' else '{}'::jsonb end,
          left(coalesce(p_row->>'summary', ''), 3000), left(coalesce(p_row->>'mistakes', ''), 3000), v_applied,
          p_row->>'model', coalesce((p_row->>'input_tokens')::int, 0), coalesce((p_row->>'output_tokens')::int, 0),
          coalesce((p_row->>'cost_usd')::numeric, 0))
  returning id into v_id;
  return jsonb_build_object('review_id', v_id, 'applied', v_applied);
end;
$$;

-- SPEC 10.6: service_role ONLY. Stores one decision (p_row = the columns of shadow_decisions except id / user_id /
-- ts); bot ownership is checked again. Returns the new id.
create or replace function public.shadow_record(p_user uuid, p_bot uuid, p_row jsonb)
returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from public.bots b where b.id = p_bot and b.owner = p_user) then
    raise exception 'bot_not_found';
  end if;
  insert into public.shadow_decisions (bot_id, user_id, ticket, module, side, lots, open_price, sl, tp, bid, ask, profit,
                                       server_time, action, new_sl, confidence, reason, valid, snapshot, details, model,
                                       input_tokens, output_tokens, cost_usd, memory_rev)
  values (p_bot, p_user, (p_row->>'ticket')::bigint, p_row->>'module', p_row->>'side',
          (p_row->>'lots')::numeric, (p_row->>'open_price')::numeric, (p_row->>'sl')::numeric, (p_row->>'tp')::numeric,
          (p_row->>'bid')::numeric, (p_row->>'ask')::numeric, (p_row->>'profit')::numeric, p_row->>'server_time',
          p_row->>'action', (p_row->>'new_sl')::numeric, (p_row->>'confidence')::int, coalesce(p_row->>'reason', ''),
          coalesce((p_row->>'valid')::boolean, true), coalesce(p_row->'snapshot', '{}'::jsonb),
          case when jsonb_typeof(p_row->'details') = 'object' then p_row->'details' else '{}'::jsonb end, p_row->>'model',
          coalesce((p_row->>'input_tokens')::int, 0), coalesce((p_row->>'output_tokens')::int, 0),
          coalesce((p_row->>'cost_usd')::numeric, 0), greatest(coalesce((p_row->>'memory_rev')::int, 0), 0))
  returning id into v_id;
  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------------------------------
-- 4. Trigger functions and triggers (SPEC 2.4)
-- -----------------------------------------------------------------------------------------------------

-- auth.users after insert -> profile (display_name = email prefix)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
    values (new.id, nullif(split_part(coalesce(new.email::text, ''), '@', 1), ''))
    on conflict (id) do nothing;
  return new;
end;
$$;

-- Guarded create (instead of drop + create) so a re-run never needs to drop anything on auth.users.
-- The function body above is replaced on every run, which is all a re-run needs.
do $$
begin
  if not exists (select 1 from pg_trigger
                 where tgname = 'dobby_on_auth_user_created' and tgrelid = 'auth.users'::regclass) then
    create trigger dobby_on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end;
$$;

-- bot_control: version bump + stamps + LIVE GATE.
-- SECURITY INVOKER on purpose: current_user must be the role that runs the statement.
--   client roles  : 'authenticated' / 'anon' (every website / agent request through the Supabase API) -> gated
--   function owner: postgres inside register_bot (security definer)                                   -> not gated
--   postgres / service_role used directly (SQL editor, service key) are fully trusted: they bypass RLS and can drop
--   this trigger anyway; the website and the agent never use them.
create or replace function public.bot_control_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
declare
  v_client boolean := current_user in ('authenticated', 'anon');
  v_gate   text;
begin
  if tg_op = 'INSERT' then
    new.version    := 1;
    new.updated_by := auth.uid();
    new.updated_at := now();
    if v_client and coalesce((new.desired ->> 'live')::boolean, false) then
      v_gate := public.live_gate_status();
      if v_gate <> 'ok' then
        raise exception '%', v_gate;
      end if;
    end if;
  else
    if new.bot_id is distinct from old.bot_id then
      raise exception 'bot_id_immutable';
    end if;
    new.version    := old.version + 1;
    new.updated_by := auth.uid();
    new.updated_at := now();
    -- not the owner: only the admin gets here (policy bot_control_update), with a fresh admin sign-in (2026-11-10)
    if v_client and not public.owns_bot(new.bot_id) then
      v_gate := public.admin_edit_status();
      if v_gate <> 'ok' then
        raise exception '%', v_gate;
      end if;
    end if;
    if v_client
       and coalesce((old.desired ->> 'live')::boolean, false) = false
       and coalesce((new.desired ->> 'live')::boolean, false) = true then
      v_gate := public.live_gate_status();
      if v_gate <> 'ok' then
        raise exception '%', v_gate;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists bot_control_before on public.bot_control;
create trigger bot_control_before
  before insert or update on public.bot_control
  for each row execute function public.bot_control_before();

create or replace function public.bot_control_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit (actor, bot_id, action, before, after)
    values (auth.uid(), new.bot_id, 'control',
            case when tg_op = 'UPDATE' then old.desired else null end, new.desired);
  return null;
end;
$$;

drop trigger if exists bot_control_audit on public.bot_control;
create trigger bot_control_audit
  after insert or update on public.bot_control
  for each row execute function public.bot_control_audit();

-- presets: keep updated_at current; audit every change
create or replace function public.presets_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists presets_before on public.presets;
create trigger presets_before
  before insert or update on public.presets
  for each row execute function public.presets_before();

create or replace function public.presets_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit (actor, bot_id, action, before, after)
    values (auth.uid(), null, 'preset_' || lower(tg_op),
            case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
            case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end);
  return null;
end;
$$;

drop trigger if exists presets_audit on public.presets;
create trigger presets_audit
  after insert or update or delete on public.presets
  for each row execute function public.presets_audit();

-- bots: last_seen is stamped with the SERVER clock whenever the agent reports it (PC clocks drift).
create or replace function public.bots_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if new.last_seen is not null and (tg_op = 'INSERT' or new.last_seen is distinct from old.last_seen) then
    new.last_seen := now();
  end if;
  return new;
end;
$$;

drop trigger if exists bots_before on public.bots;
create trigger bots_before
  before insert or update on public.bots
  for each row execute function public.bots_before();

create or replace function public.bots_audit_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit (actor, bot_id, action, before)
    values (auth.uid(), old.id, 'bot_delete',
            jsonb_build_object('id', old.id, 'owner', old.owner, 'name', old.name, 'created_at', old.created_at));
  return null;
end;
$$;

drop trigger if exists bots_audit_delete on public.bots;
create trigger bots_audit_delete
  after delete on public.bots
  for each row execute function public.bots_audit_delete();

-- bot_status: updated_at is the server time of the last upload
create or replace function public.bot_status_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bot_status_before on public.bot_status;
create trigger bot_status_before
  before insert or update on public.bot_status
  for each row execute function public.bot_status_before();

-- journal: a row whose (bot_id, line_hash) already exists is skipped silently, whatever the client sends
-- (plain insert, or PostgREST upsert without on_conflict, which would otherwise target the id primary key).
-- SECURITY INVOKER: the lookup only sees rows the caller may read, so it cannot probe other users' journals.
create or replace function public.journal_skip_duplicate()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if exists (select 1 from public.journal j where j.bot_id = new.bot_id and j.line_hash = new.line_hash) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists journal_skip_duplicate on public.journal;
create trigger journal_skip_duplicate
  before insert on public.journal
  for each row execute function public.journal_skip_duplicate();

-- cash_flows (SPEC 9.2): keep created_at / updated_at honest; audit every change like presets
create or replace function public.cash_flows_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cash_flows_before on public.cash_flows;
create trigger cash_flows_before
  before insert or update on public.cash_flows
  for each row execute function public.cash_flows_before();

create or replace function public.cash_flows_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit (actor, bot_id, action, before, after)
    values (auth.uid(), case when tg_op = 'DELETE' then old.bot_id else new.bot_id end,
            'cash_flow_' || lower(tg_op),
            case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
            case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end);
  return null;
end;
$$;

drop trigger if exists cash_flows_audit on public.cash_flows;
create trigger cash_flows_audit
  after insert or update or delete on public.cash_flows
  for each row execute function public.cash_flows_audit();

-- trade_notes (SPEC 9.6): updated_at / updated_by are the server's (client values are ignored)
create or replace function public.trade_notes_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trade_notes_before on public.trade_notes;
create trigger trade_notes_before
  before insert or update on public.trade_notes
  for each row execute function public.trade_notes_before();

-- rounds (SPEC 9.8): created_at / created_by are the server's, a start is never in the future, at most 200 rounds per
-- bot, and only the name changes afterwards (also enforced by the column grant); every change is audited.
create or replace function public.rounds_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    if new.started_at is not null and new.started_at > now() then
      new.started_at := now();
    end if;
    if (select count(*) from public.rounds r where r.bot_id = new.bot_id) >= 200 then
      raise exception 'too many rounds for this bot' using errcode = 'check_violation';
    end if;
  else
    new.bot_id := old.bot_id;
    new.started_at := old.started_at;
    new.base := old.base;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

drop trigger if exists rounds_before on public.rounds;
create trigger rounds_before
  before insert or update on public.rounds
  for each row execute function public.rounds_before();

create or replace function public.rounds_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit (actor, bot_id, action, before, after)
    values (auth.uid(), case when tg_op = 'DELETE' then old.bot_id else new.bot_id end,
            'round_' || lower(tg_op),
            case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
            case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end);
  return null;
end;
$$;

drop trigger if exists rounds_audit on public.rounds;
create trigger rounds_audit
  after insert or update or delete on public.rounds
  for each row execute function public.rounds_audit();

-- ai_config (SPEC 10.1): updated_at / updated_by are the server's; every change is audited as ai_config_update
create or replace function public.ai_config_before()
returns trigger
language plpgsql security invoker set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists ai_config_before on public.ai_config;
create trigger ai_config_before
  before update on public.ai_config
  for each row execute function public.ai_config_before();

create or replace function public.ai_config_audit()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit (actor, bot_id, action, before, after)
    values (auth.uid(), null, 'ai_config_update', to_jsonb(old), to_jsonb(new));
  return null;
end;
$$;

drop trigger if exists ai_config_audit on public.ai_config;
create trigger ai_config_audit
  after update on public.ai_config
  for each row execute function public.ai_config_audit();

-- ai_messages (SPEC 10.1): a new message moves its conversation to the top (updated_at = now()).
-- SECURITY DEFINER: clients may update only ai_conversations.title, not updated_at.
create or replace function public.ai_messages_touch_conversation()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.ai_conversations set updated_at = now() where id = new.conversation_id;
  return null;
end;
$$;

drop trigger if exists ai_messages_touch_conversation on public.ai_messages;
create trigger ai_messages_touch_conversation
  after insert on public.ai_messages
  for each row execute function public.ai_messages_touch_conversation();


-- -----------------------------------------------------------------------------------------------------
-- 5. Privileges. anon: nothing. authenticated: only what the policies below allow. (Supabase's default
--    privileges grant ALL, incl. TRUNCATE, to anon/authenticated on new objects, so revoke everything first.)
-- -----------------------------------------------------------------------------------------------------
revoke all on table public.profiles, public.invites, public.bots, public.bot_status, public.journal,
                    public.bot_control, public.presets, public.audit, public.news_events,
                    public.bars, public.cash_flows, public.trade_notes, public.rounds,
                    public.ai_config, public.ai_conversations, public.ai_messages, public.ai_usage,
                    public.shadow_decisions, public.shadow_reviews, public.shadow_lessons
  from anon, authenticated;
revoke all on sequence public.journal_id_seq, public.audit_id_seq, public.news_events_id_seq,
                       public.cash_flows_id_seq, public.ai_messages_id_seq, public.ai_usage_id_seq,
                       public.rounds_id_seq, public.shadow_decisions_id_seq, public.shadow_reviews_id_seq,
                       public.shadow_lessons_id_seq
  from anon, authenticated;

grant select                         on table public.profiles, public.invites, public.audit to authenticated;
grant select, insert, update, delete on table public.bots, public.presets, public.news_events to authenticated;
grant select, insert, update         on table public.bot_status, public.journal to authenticated;
grant select, update                 on table public.bot_control to authenticated;  -- NO insert: register_bot only
grant select, insert, update         on table public.bars to authenticated;         -- no delete: cascade only
grant select, insert, update, delete on table public.cash_flows, public.trade_notes to authenticated;
grant select, insert, delete         on table public.rounds to authenticated;
grant update (name)                  on table public.rounds to authenticated;      -- only the name changes
grant select, update                 on table public.ai_config to authenticated;    -- update: admin (policy)
grant select, insert, delete         on table public.ai_conversations, public.ai_messages to authenticated;
grant update (title)                 on table public.ai_conversations to authenticated;  -- only the title changes
grant select                         on table public.ai_usage to authenticated;     -- writes: service_role RPCs only
grant select                         on table public.shadow_decisions to authenticated;  -- writes: shadow_record only
grant select                         on table public.shadow_reviews to authenticated;    -- writes: shadow_review_record only
grant select                         on table public.shadow_lessons to authenticated;
grant update (status)                on table public.shadow_lessons to authenticated;    -- the owner retires a lesson by hand
grant usage, select on sequence public.journal_id_seq, public.news_events_id_seq, public.cash_flows_id_seq,
                                public.ai_messages_id_seq, public.rounds_id_seq
  to authenticated;

-- RPCs and helpers used by policies: authenticated only
revoke execute on function public.is_approved()                               from public, anon;
revoke execute on function public.is_admin()                                  from public, anon;
revoke execute on function public.owns_bot(uuid)                              from public, anon;
revoke execute on function public.live_gate_status()                          from public, anon;
revoke execute on function public.admin_edit_status()                         from public, anon;
revoke execute on function public.redeem_invite(text)                         from public, anon;
revoke execute on function public.create_invite(text, int, text)              from public, anon;
revoke execute on function public.revoke_invite(text)                         from public, anon;
revoke execute on function public.admin_set_user(uuid, text, boolean, boolean) from public, anon;
revoke execute on function public.set_display_name(text)                      from public, anon;
revoke execute on function public.admin_overview()                            from public, anon;
revoke execute on function public.register_bot(text, jsonb)                   from public, anon;
revoke execute on function public.ai_quota()                                  from public, anon;

grant execute on function public.is_approved()                               to authenticated, service_role;
grant execute on function public.is_admin()                                  to authenticated, service_role;
grant execute on function public.owns_bot(uuid)                              to authenticated, service_role;
grant execute on function public.live_gate_status()                          to authenticated, service_role;
grant execute on function public.admin_edit_status()                         to authenticated, service_role;
grant execute on function public.redeem_invite(text)                         to authenticated, service_role;
grant execute on function public.create_invite(text, int, text)              to authenticated, service_role;
grant execute on function public.revoke_invite(text)                         to authenticated, service_role;
grant execute on function public.admin_set_user(uuid, text, boolean, boolean) to authenticated, service_role;
grant execute on function public.set_display_name(text)                      to authenticated, service_role;
grant execute on function public.admin_overview()                            to authenticated, service_role;
grant execute on function public.register_bot(text, jsonb)                   to authenticated, service_role;
grant execute on function public.ai_quota()                                  to authenticated, service_role;

-- AI turn bookkeeping (SPEC 10.2): service_role ONLY (the Edge Function's service key); no client can call them
revoke execute on function public.ai_start_turn(uuid, uuid)                    from public, anon, authenticated;
revoke execute on function public.ai_finish_turn(bigint, text, int, int, int, int, numeric, uuid)
  from public, anon, authenticated;
grant execute on function public.ai_start_turn(uuid, uuid)                     to service_role;
grant execute on function public.ai_finish_turn(bigint, text, int, int, int, int, numeric, uuid) to service_role;
-- shadow AI bookkeeping (SPEC 10.6): service_role ONLY
revoke execute on function public.shadow_start(uuid, uuid, bigint)             from public, anon, authenticated;
revoke execute on function public.shadow_record(uuid, uuid, jsonb)             from public, anon, authenticated;
revoke execute on function public.shadow_month_cost()                          from public, anon, authenticated;
grant execute on function public.shadow_start(uuid, uuid, bigint)              to service_role;
grant execute on function public.shadow_record(uuid, uuid, jsonb)              to service_role;
revoke execute on function public.shadow_review_start(uuid, uuid, bigint)      from public, anon, authenticated;
revoke execute on function public.shadow_review_record(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.shadow_review_start(uuid, uuid, bigint)       to service_role;
grant execute on function public.shadow_review_record(uuid, uuid, jsonb, jsonb) to service_role;

-- internal functions: nobody but the owner (triggers fire regardless of EXECUTE rights)
revoke execute on function public.gen_invite_code()        from public, anon, authenticated;
revoke execute on function public.fresh_auth_status(int)   from public, anon, authenticated;
revoke execute on function public.handle_new_user()        from public, anon, authenticated;
revoke execute on function public.bot_control_before()     from public, anon, authenticated;
revoke execute on function public.bot_control_audit()      from public, anon, authenticated;
revoke execute on function public.presets_before()         from public, anon, authenticated;
revoke execute on function public.presets_audit()          from public, anon, authenticated;
revoke execute on function public.bots_before()            from public, anon, authenticated;
revoke execute on function public.bots_audit_delete()      from public, anon, authenticated;
revoke execute on function public.bot_status_before()      from public, anon, authenticated;
revoke execute on function public.journal_skip_duplicate() from public, anon, authenticated;
revoke execute on function public.cash_flows_before()      from public, anon, authenticated;
revoke execute on function public.cash_flows_audit()       from public, anon, authenticated;
revoke execute on function public.trade_notes_before()     from public, anon, authenticated;
revoke execute on function public.rounds_before()          from public, anon, authenticated;
revoke execute on function public.rounds_audit()           from public, anon, authenticated;
revoke execute on function public.ai_used_today(uuid)      from public, anon, authenticated;
revoke execute on function public.ai_month_cost()          from public, anon, authenticated;
revoke execute on function public.ai_config_before()       from public, anon, authenticated;
revoke execute on function public.ai_config_audit()        from public, anon, authenticated;
revoke execute on function public.ai_messages_touch_conversation() from public, anon, authenticated;


-- -----------------------------------------------------------------------------------------------------
-- 6. Row Level Security policies (SPEC 2.3). "(select f())" lets Postgres evaluate f once per statement.
-- -----------------------------------------------------------------------------------------------------

-- profiles: own row (even before approval, so the UI can say "enter invite code"); admin all. Writes: RPCs only.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- invites: admin select. Writes: RPCs only.
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select to authenticated
  using ((select public.is_admin()));

-- bots: approved owner all; admin select all
drop policy if exists bots_select on public.bots;
create policy bots_select on public.bots for select to authenticated
  using ((owner = (select auth.uid()) and (select public.is_approved())) or (select public.is_admin()));
drop policy if exists bots_insert on public.bots;
create policy bots_insert on public.bots for insert to authenticated
  with check (owner = (select auth.uid()) and (select public.is_approved()));
drop policy if exists bots_update on public.bots;
create policy bots_update on public.bots for update to authenticated
  using (owner = (select auth.uid()) and (select public.is_approved()))
  with check (owner = (select auth.uid()) and (select public.is_approved()));
drop policy if exists bots_delete on public.bots;
create policy bots_delete on public.bots for delete to authenticated
  using (owner = (select auth.uid()) and (select public.is_approved()));

-- bot_status / journal / bot_control: approved owner of the bot writes; the admin READS every bot (2026-11-07: the
-- owner of the site wants to see what every friend's bot is doing). Writes stay owner-only, so the admin can look
-- but never change another user's bot.
drop policy if exists bot_status_select on public.bot_status;
create policy bot_status_select on public.bot_status for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists bot_status_insert on public.bot_status;
create policy bot_status_insert on public.bot_status for insert to authenticated
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists bot_status_update on public.bot_status;
create policy bot_status_update on public.bot_status for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

drop policy if exists journal_select on public.journal;
create policy journal_select on public.journal for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists journal_insert on public.journal;
create policy journal_insert on public.journal for insert to authenticated
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists journal_update on public.journal;
create policy journal_update on public.journal for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

drop policy if exists bot_control_select on public.bot_control;
create policy bot_control_select on public.bot_control for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists bot_control_insert on public.bot_control;   -- deliberately none: register_bot() only
-- the admin may change a member's bot settings too (2026-11-10); the trigger bot_control_before then asks for a fresh
-- admin sign-in (admin_edit_status, 30 min). Every other table of a member's bot stays read only for the admin.
drop policy if exists bot_control_update on public.bot_control;
create policy bot_control_update on public.bot_control for update to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()))
  with check (((select public.is_approved())
               and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
              or (select public.is_admin()));

-- presets: approved owner all; the admin reads every preset (read only)
drop policy if exists presets_select on public.presets;
create policy presets_select on public.presets for select to authenticated
  using ((owner = (select auth.uid()) and (select public.is_approved())) or (select public.is_admin()));
drop policy if exists presets_insert on public.presets;
create policy presets_insert on public.presets for insert to authenticated
  with check (owner = (select auth.uid()) and (select public.is_approved()));
drop policy if exists presets_update on public.presets;
create policy presets_update on public.presets for update to authenticated
  using (owner = (select auth.uid()) and (select public.is_approved()))
  with check (owner = (select auth.uid()) and (select public.is_approved()));
drop policy if exists presets_delete on public.presets;
create policy presets_delete on public.presets for delete to authenticated
  using (owner = (select auth.uid()) and (select public.is_approved()));

-- audit (approved users): rows I made, rows of bots I own, rows of presets I own, the delete row of my own bot.
-- The admin reads every row (2026-11-07: who changed what on which bot). Inserts only by triggers / RPCs (no grant).
drop policy if exists audit_select on public.audit;
create policy audit_select on public.audit for select to authenticated
  using ((select public.is_approved())
         and (actor = (select auth.uid())
              or bot_id in (select b.id from public.bots b where b.owner = (select auth.uid()))
              or (action like 'preset\_%'
                  and coalesce(after ->> 'owner', before ->> 'owner') = (select auth.uid())::text)
              or (action = 'bot_delete' and before ->> 'owner' = (select auth.uid())::text)
              or (select public.is_admin())));

-- news_events: approved read; admin write
drop policy if exists news_select on public.news_events;
create policy news_select on public.news_events for select to authenticated
  using ((select public.is_approved()));
drop policy if exists news_insert on public.news_events;
create policy news_insert on public.news_events for insert to authenticated
  with check ((select public.is_admin()));
drop policy if exists news_update on public.news_events;
create policy news_update on public.news_events for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists news_delete on public.news_events;
create policy news_delete on public.news_events for delete to authenticated
  using ((select public.is_admin()));

-- bars / cash_flows / trade_notes (SPEC 9): the approved owner of the bot writes, the admin reads every row.
-- bars: no client delete (cascade only); update exists for PostgREST upserts.
drop policy if exists bars_select on public.bars;
create policy bars_select on public.bars for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists bars_insert on public.bars;
create policy bars_insert on public.bars for insert to authenticated
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists bars_update on public.bars;
create policy bars_update on public.bars for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

drop policy if exists cash_flows_select on public.cash_flows;
create policy cash_flows_select on public.cash_flows for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists cash_flows_insert on public.cash_flows;
create policy cash_flows_insert on public.cash_flows for insert to authenticated
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists cash_flows_update on public.cash_flows;
create policy cash_flows_update on public.cash_flows for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists cash_flows_delete on public.cash_flows;
create policy cash_flows_delete on public.cash_flows for delete to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

drop policy if exists trade_notes_select on public.trade_notes;
create policy trade_notes_select on public.trade_notes for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists trade_notes_insert on public.trade_notes;
create policy trade_notes_insert on public.trade_notes for insert to authenticated
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists trade_notes_update on public.trade_notes;
create policy trade_notes_update on public.trade_notes for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists trade_notes_delete on public.trade_notes;
create policy trade_notes_delete on public.trade_notes for delete to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

-- rounds (SPEC 9.8): same rule as cash_flows (the approved owner writes, the admin reads every row)
drop policy if exists rounds_select on public.rounds;
create policy rounds_select on public.rounds for select to authenticated
  using (((select public.is_approved())
          and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
         or (select public.is_admin()));
drop policy if exists rounds_insert on public.rounds;
create policy rounds_insert on public.rounds for insert to authenticated
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists rounds_update on public.rounds;
create policy rounds_update on public.rounds for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));
drop policy if exists rounds_delete on public.rounds;
create policy rounds_delete on public.rounds for delete to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

-- AI assistant (SPEC 10.1). ai_config: approved read, admin update; no client insert / delete (no grant).
drop policy if exists ai_config_select on public.ai_config;
create policy ai_config_select on public.ai_config for select to authenticated
  using ((select public.is_approved()));
drop policy if exists ai_config_update on public.ai_config;
create policy ai_config_update on public.ai_config for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ai_conversations / ai_messages: the approved user's own rows only. NO admin read: chats are private.
-- Conversations: only the title can be updated (column grant). Messages: no update; an insert must point at one of
-- the caller's own conversations.
drop policy if exists ai_conversations_select on public.ai_conversations;
create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));
drop policy if exists ai_conversations_insert on public.ai_conversations;
create policy ai_conversations_insert on public.ai_conversations for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_approved()));
drop policy if exists ai_conversations_update on public.ai_conversations;
create policy ai_conversations_update on public.ai_conversations for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()))
  with check (user_id = (select auth.uid()) and (select public.is_approved()));
drop policy if exists ai_conversations_delete on public.ai_conversations;
create policy ai_conversations_delete on public.ai_conversations for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));

drop policy if exists ai_messages_select on public.ai_messages;
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));
drop policy if exists ai_messages_insert on public.ai_messages;
create policy ai_messages_insert on public.ai_messages for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_approved())
              and conversation_id in (select c.id from public.ai_conversations c
                                      where c.user_id = (select auth.uid())));
drop policy if exists ai_messages_delete on public.ai_messages;
create policy ai_messages_delete on public.ai_messages for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.is_approved()));

-- ai_usage: own rows; the admin reads every row (usage table on the Users page). No client writes (no grant).
drop policy if exists ai_usage_select on public.ai_usage;
create policy ai_usage_select on public.ai_usage for select to authenticated
  using ((user_id = (select auth.uid()) and (select public.is_approved())) or (select public.is_admin()));

-- shadow_decisions (SPEC 10.6): the bot owner's rows; the admin reads every row (cost on the Users page).
-- No client writes (no grant): only shadow_record (service_role) inserts.
drop policy if exists shadow_decisions_select on public.shadow_decisions;
create policy shadow_decisions_select on public.shadow_decisions for select to authenticated
  using (((select public.is_approved()) and (select public.owns_bot(bot_id))) or (select public.is_admin()));

-- shadow_reviews / shadow_lessons (SPEC 10.7): the same readers; the owner may only retire an active lesson
-- (column grant: status; the check keeps it to 'retired').
drop policy if exists shadow_reviews_select on public.shadow_reviews;
create policy shadow_reviews_select on public.shadow_reviews for select to authenticated
  using (((select public.is_approved()) and (select public.owns_bot(bot_id))) or (select public.is_admin()));
drop policy if exists shadow_lessons_select on public.shadow_lessons;
create policy shadow_lessons_select on public.shadow_lessons for select to authenticated
  using (((select public.is_approved()) and (select public.owns_bot(bot_id))) or (select public.is_admin()));
drop policy if exists shadow_lessons_retire on public.shadow_lessons;
create policy shadow_lessons_retire on public.shadow_lessons for update to authenticated
  using ((select public.is_approved()) and (select public.owns_bot(bot_id)))
  with check ((select public.is_approved()) and (select public.owns_bot(bot_id)) and status = 'retired');


-- -----------------------------------------------------------------------------------------------------
-- 7. Storage: private bucket "downloads" (approved read, admin write)
-- -----------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('downloads', 'downloads', false)
  on conflict (id) do nothing;

drop policy if exists dobby_downloads_select on storage.objects;
create policy dobby_downloads_select on storage.objects for select to authenticated
  using (bucket_id = 'downloads' and (select public.is_approved()));
drop policy if exists dobby_downloads_insert on storage.objects;
create policy dobby_downloads_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'downloads' and (select public.is_admin()));
drop policy if exists dobby_downloads_update on storage.objects;
create policy dobby_downloads_update on storage.objects for update to authenticated
  using (bucket_id = 'downloads' and (select public.is_admin()))
  with check (bucket_id = 'downloads' and (select public.is_admin()));
drop policy if exists dobby_downloads_delete on storage.objects;
create policy dobby_downloads_delete on storage.objects for delete to authenticated
  using (bucket_id = 'downloads' and (select public.is_admin()));


-- -----------------------------------------------------------------------------------------------------
-- 8. Realtime (SPEC 2.5), guarded so a re-run does not fail with "already member of publication"
-- -----------------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;                                            -- publication already covers every table
  end if;
  foreach t in array array['bot_status', 'bot_control', 'bots', 'journal'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------------------------------
-- 9. Backfill: profiles for users who signed up before this schema existed
-- -----------------------------------------------------------------------------------------------------
insert into public.profiles (id, display_name)
  select u.id, nullif(split_part(coalesce(u.email::text, ''), '@', 1), '') from auth.users u
  on conflict (id) do nothing;


-- -----------------------------------------------------------------------------------------------------
-- 10. News calendar seed (same content as seed_news.sql; keep the two in sync - a test checks it)
-- -----------------------------------------------------------------------------------------------------
-- BEGIN seed_news.sql
-- Dobby Web: news calendar seed (tier-1 US events, 2026-11-01 onward).
-- Source: research calendar r27 (events_2026.csv, times in US Eastern). Converted to UTC with the
-- America/New_York rules: EDT (UTC-4) from 2026-03-08 to 2026-11-01 02:00, EST (UTC-5) otherwise.
-- All rows below fall after the 2026-11-01 switch, so 08:30 ET = 13:30 UTC and 14:00 ET = 19:00 UTC.
-- PCE and GDP are tier 2/3 in the source, so they are not included. Safe to run again (on conflict do nothing).
insert into public.news_events (ts_utc, name, tier, note) values
  ('2026-11-06T13:30:00+00', 'US NFP (Non-Farm Payrolls)', 1, '2026-11-06 08:30 ET (US Eastern); NFP; source: bls.gov/schedule/2026/home.htm'),
  ('2026-11-10T13:30:00+00', 'US CPI', 1, '2026-11-10 08:30 ET (US Eastern); CPI; source: bls.gov/schedule/2026/home.htm'),
  ('2026-12-04T13:30:00+00', 'US NFP (Non-Farm Payrolls)', 1, '2026-12-04 08:30 ET (US Eastern); NFP; source: bls.gov/schedule/2026/home.htm'),
  ('2026-12-09T19:00:00+00', 'FOMC rate decision', 1, '2026-12-09 14:00 ET (US Eastern); FOMC_DECISION; source: federalreserve.gov/monetarypolicy/fomccalendars.htm (SEP)'),
  ('2026-12-09T19:30:00+00', 'FOMC press conference', 1, '2026-12-09 14:30 ET (US Eastern); FOMC_PRESSER; source: federalreserve.gov/monetarypolicy/fomccalendars.htm (presser assumed; every meeting since 2019)'),
  ('2026-12-10T13:30:00+00', 'US CPI', 1, '2026-12-10 08:30 ET (US Eastern); CPI; source: bls.gov/schedule/2026/home.htm')
on conflict (ts_utc, name) do nothing;
-- END seed_news.sql


-- -----------------------------------------------------------------------------------------------------
-- 11. Bootstrap (SPEC 2.6): no active admin and no usable admin invite -> create one admin invite (7 days)
-- -----------------------------------------------------------------------------------------------------
do $$
declare
  v_code text;
begin
  if not exists (select 1 from public.profiles where role = 'admin' and approved and not disabled)
     and not exists (select 1 from public.invites
                     where role = 'admin' and used_at is null and used_by is null and not revoked
                       and expires_at > now()) then
    loop
      v_code := public.gen_invite_code();
      insert into public.invites (code, role, note, expires_at)
        values (v_code, 'admin', 'bootstrap (schema.sql)', now() + interval '7 days')
        on conflict (code) do nothing;
      exit when found;
    end loop;
    insert into public.audit (action, after)
      values ('admin_bootstrap_invite', jsonb_build_object('code', v_code, 'role', 'admin'));
  end if;
end;
$$;

-- The SQL editor shows this last result: the admin invite code to redeem after signing up on the website.
with adm as (
  select exists (select 1 from public.profiles where role = 'admin' and approved and not disabled) as has_admin
), inv as (
  select code, expires_at from public.invites
  where role = 'admin' and used_at is null and used_by is null and not revoked and expires_at > now()
  order by created_at desc
  limit 1
)
select case when adm.has_admin then 'admin already exists - create invites on the Users page'
            else inv.code end                                              as bootstrap_admin_invite,
       case when adm.has_admin then null else inv.expires_at end           as expires_at
from adm left join inv on true;
