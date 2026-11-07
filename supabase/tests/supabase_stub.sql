-- Minimal stand-ins for what a real Supabase project already has, so schema.sql can run on PGlite.
-- Only what schema.sql touches is mimicked: roles, default privileges, auth.users / auth.mfa_factors,
-- auth.uid() / auth.jwt() (same definitions as Supabase: they read the request.jwt.claims setting),
-- storage.buckets / storage.objects (RLS on), and the supabase_realtime publication.

-- Roles used by PostgREST. noinherit/nologin like Supabase; service_role bypasses RLS like Supabase.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants everything on new public objects to the API roles; schema.sql must revoke what it does not want.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- auth ------------------------------------------------------------------------------------------------
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      varchar(255),
  created_at timestamptz not null default now()
);

create type auth.factor_status as enum ('unverified', 'verified');
create table auth.mfa_factors (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      auth.factor_status not null default 'unverified',
  factor_type text not null default 'totp',
  created_at  timestamptz not null default now()
);
-- no grants on auth tables for anon/authenticated (same as Supabase): only security definer code can read them

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

-- storage ---------------------------------------------------------------------------------------------
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id         text primary key,
  name       text not null,
  owner      uuid,
  public     boolean default false,
  created_at timestamptz default now()
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz default now()
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets to anon, authenticated, service_role;
grant all on storage.objects to anon, authenticated, service_role;

-- realtime --------------------------------------------------------------------------------------------
create publication supabase_realtime;
