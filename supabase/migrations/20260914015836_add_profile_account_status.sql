-- A disabled profile is denied by the application on every authenticated
-- request, so an existing JWT cannot continue to access business data.
alter table public.profiles
  add column if not exists is_active boolean not null default true;

create index if not exists profiles_active_idx on public.profiles (is_active);
