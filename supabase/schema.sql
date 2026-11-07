-- =====================================================================================================
-- Dobby Web - database schema for Supabase (contract: SPEC.md section 2)
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

alter table public.profiles    enable row level security;
alter table public.invites     enable row level security;
alter table public.bots        enable row level security;
alter table public.bot_status  enable row level security;
alter table public.journal     enable row level security;
alter table public.bot_control enable row level security;
alter table public.presets     enable row level security;
alter table public.audit       enable row level security;
alter table public.news_events enable row level security;


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

-- Spec addition: the live gate (SPEC 2.4) as a function, so the website can ask before it shows the switch.
-- Returns 'ok', 'reauth_required' or 'mfa_required' for the CALLER (auth.uid() and the caller's own JWT).
--   (a) the JWT claim amr must hold a password / otp / totp sign-in whose timestamp is within the last 300 s;
--   (b) if the caller has a verified MFA factor, the JWT claim aal must be 'aal2'.
create or replace function public.live_gate_status()
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
      and (e ->> 'timestamp')::numeric >= extract(epoch from now()) - 300
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

-- bots: last_seen is stamped with the SERVER clock whenever the agent reports it (PC clocks drift)
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


-- -----------------------------------------------------------------------------------------------------
-- 5. Privileges. anon: nothing. authenticated: only what the policies below allow. (Supabase's default
--    privileges grant ALL, incl. TRUNCATE, to anon/authenticated on new objects, so revoke everything first.)
-- -----------------------------------------------------------------------------------------------------
revoke all on table public.profiles, public.invites, public.bots, public.bot_status, public.journal,
                    public.bot_control, public.presets, public.audit, public.news_events
  from anon, authenticated;
revoke all on sequence public.journal_id_seq, public.audit_id_seq, public.news_events_id_seq
  from anon, authenticated;

grant select                         on table public.profiles, public.invites, public.audit to authenticated;
grant select, insert, update, delete on table public.bots, public.presets, public.news_events to authenticated;
grant select, insert, update         on table public.bot_status, public.journal to authenticated;
grant select, update                 on table public.bot_control to authenticated;  -- NO insert: register_bot only
grant usage, select on sequence public.journal_id_seq, public.news_events_id_seq to authenticated;

-- RPCs and helpers used by policies: authenticated only
revoke execute on function public.is_approved()                               from public, anon;
revoke execute on function public.is_admin()                                  from public, anon;
revoke execute on function public.owns_bot(uuid)                              from public, anon;
revoke execute on function public.live_gate_status()                          from public, anon;
revoke execute on function public.redeem_invite(text)                         from public, anon;
revoke execute on function public.create_invite(text, int, text)              from public, anon;
revoke execute on function public.revoke_invite(text)                         from public, anon;
revoke execute on function public.admin_set_user(uuid, text, boolean, boolean) from public, anon;
revoke execute on function public.set_display_name(text)                      from public, anon;
revoke execute on function public.admin_overview()                            from public, anon;
revoke execute on function public.register_bot(text, jsonb)                   from public, anon;

grant execute on function public.is_approved()                               to authenticated, service_role;
grant execute on function public.is_admin()                                  to authenticated, service_role;
grant execute on function public.owns_bot(uuid)                              to authenticated, service_role;
grant execute on function public.live_gate_status()                          to authenticated, service_role;
grant execute on function public.redeem_invite(text)                         to authenticated, service_role;
grant execute on function public.create_invite(text, int, text)              to authenticated, service_role;
grant execute on function public.revoke_invite(text)                         to authenticated, service_role;
grant execute on function public.admin_set_user(uuid, text, boolean, boolean) to authenticated, service_role;
grant execute on function public.set_display_name(text)                      to authenticated, service_role;
grant execute on function public.admin_overview()                            to authenticated, service_role;
grant execute on function public.register_bot(text, jsonb)                   to authenticated, service_role;

-- internal functions: nobody but the owner (triggers fire regardless of EXECUTE rights)
revoke execute on function public.gen_invite_code()        from public, anon, authenticated;
revoke execute on function public.handle_new_user()        from public, anon, authenticated;
revoke execute on function public.bot_control_before()     from public, anon, authenticated;
revoke execute on function public.bot_control_audit()      from public, anon, authenticated;
revoke execute on function public.presets_before()         from public, anon, authenticated;
revoke execute on function public.presets_audit()          from public, anon, authenticated;
revoke execute on function public.bots_before()            from public, anon, authenticated;
revoke execute on function public.bots_audit_delete()      from public, anon, authenticated;
revoke execute on function public.bot_status_before()      from public, anon, authenticated;
revoke execute on function public.journal_skip_duplicate() from public, anon, authenticated;


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
drop policy if exists bot_control_update on public.bot_control;
create policy bot_control_update on public.bot_control for update to authenticated
  using ((select public.is_approved())
         and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())))
  with check ((select public.is_approved())
              and bot_id in (select b.id from public.bots b where b.owner = (select auth.uid())));

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
