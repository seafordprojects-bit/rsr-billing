-- test/supabase_shim.sql -- what a BRAND-NEW Supabase project already has
-- before any SQL of ours runs: the roles, the auth/storage/extensions
-- schemas, auth.uid()/email(), and the storage tables sqlText() writes
-- policies against. Applied to pglite so the generated SQL is proven on
-- day zero (the class of defect that only fires on rebuild day).
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.email() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.email', true), '') $$;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
grant usage on schema public, extensions to anon, authenticated, service_role;
