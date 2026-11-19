-- Local application authentication. Remote credentials are not copied;
-- this table stores only local session state for the on-premise deployment.
alter table auth.users add column if not exists password_hash text;

create table if not exists public.local_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists local_sessions_active_token_idx
  on public.local_sessions (token_hash, expires_at)
  where revoked_at is null;

grant select, insert, update, delete on public.local_sessions to tiktok_app;
