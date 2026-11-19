create table public.warehouse_country_sites (
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  country_code char(2) not null references public.country_sites(code) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (warehouse_id, country_code)
);

insert into public.warehouse_country_sites (warehouse_id, country_code)
select w.id, w.country_code
from public.warehouses w
join public.country_sites c on c.code = w.country_code
where w.country_code is not null
on conflict do nothing;

alter table public.warehouse_country_sites enable row level security;
grant select on public.warehouse_country_sites to authenticated;
create policy "warehouse country sites: administrators read" on public.warehouse_country_sites
  for select to authenticated using (private.is_administrator());
create policy "warehouse country sites: administrators manage" on public.warehouse_country_sites
  for all to authenticated using (private.is_administrator()) with check (private.is_administrator());
