create table public.country_sites (
  code char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name text not null unique check (char_length(trim(name)) between 1 and 80),
  default_currency char(3) not null check (default_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.country_sites (code, name, default_currency) values
  ('US', '美国', 'USD'), ('PH', '菲律宾', 'PHP'), ('ID', '印尼', 'IDR'),
  ('VN', '越南', 'VND'), ('TH', '泰国', 'THB'), ('MY', '马来西亚', 'MYR')
on conflict (code) do nothing;

create trigger country_sites_set_updated_at before update on public.country_sites
  for each row execute function public.set_updated_at();

alter table public.country_sites enable row level security;
grant select on public.country_sites to authenticated;
create policy "country sites: administrators read" on public.country_sites
  for select to authenticated using (private.is_administrator());
create policy "country sites: administrators manage" on public.country_sites
  for all to authenticated using (private.is_administrator()) with check (private.is_administrator());
