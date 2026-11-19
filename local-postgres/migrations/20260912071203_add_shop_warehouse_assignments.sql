-- Keep the many-to-many relationship explicit: one shop can use multiple
-- warehouses and one warehouse can serve multiple shops.
create table public.shop_warehouses (
  shop_id uuid not null references public.shops(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (shop_id, warehouse_id)
);

create index shop_warehouses_warehouse_idx on public.shop_warehouses (warehouse_id);

alter table public.shop_warehouses enable row level security;

grant select, insert, update, delete on public.shop_warehouses to authenticated;

create policy "shop warehouses: assigned users read" on public.shop_warehouses
  for select to authenticated
  using (private.has_shop_access(shop_id));

create policy "shop warehouses: administrators manage" on public.shop_warehouses
  for all to authenticated
  using (private.is_administrator())
  with check (private.is_administrator());
