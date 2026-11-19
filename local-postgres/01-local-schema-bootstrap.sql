-- Run this file as tiktok_app before the existing migrations.
-- The application server, not PostgreSQL RLS, will enforce local sessions and
-- shop permissions after the local-auth migration is enabled.

create extension if not exists pgcrypto;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$ select null::uuid $$;

grant usage on schema auth to tiktok_app;
grant all privileges on all tables in schema auth to tiktok_app;
grant all privileges on all sequences in schema auth to tiktok_app;
