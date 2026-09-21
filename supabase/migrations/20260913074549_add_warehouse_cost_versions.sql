-- Keep warehouse master data separate from its time-effective fulfilment cost.
-- Profit calculations must select the latest active version whose effective_date
-- is on or before the order date; the warehouse row itself never stores a cost.
create table public.warehouse_cost_versions (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  amount numeric(18, 4) not null check (amount >= 0),
  currency_code char(3) not null default 'CNY' check (currency_code = 'CNY'),
  billing_unit text not null check (billing_unit in ('per_order', 'per_package')),
  effective_date date not null,
  note text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index warehouse_cost_versions_lookup_idx
  on public.warehouse_cost_versions (warehouse_id, effective_date desc, created_at desc);

alter table public.warehouse_cost_versions enable row level security;
grant select on public.warehouse_cost_versions to authenticated;

create policy "warehouse cost versions: administrators read" on public.warehouse_cost_versions
  for select to authenticated using (private.is_administrator());

-- These functions make the warehouse row and its first/new cost version a
-- single database transaction. They are intentionally callable only by the
-- server's service role; browser clients continue to use the authenticated API.
create or replace function public.create_warehouse_with_initial_cost(
  p_name text,
  p_country_code char(2),
  p_is_active boolean,
  p_amount numeric,
  p_billing_unit text,
  p_effective_date date,
  p_note text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warehouse_id uuid;
begin
  insert into public.warehouses (name, country_code, is_active)
  values (p_name, p_country_code, p_is_active)
  returning id into v_warehouse_id;

  insert into public.warehouse_cost_versions
    (warehouse_id, amount, currency_code, billing_unit, effective_date, note, created_by)
  values
    (v_warehouse_id, p_amount, 'CNY', p_billing_unit, p_effective_date, nullif(trim(p_note), ''), p_created_by);

  return v_warehouse_id;
end;
$$;

create or replace function public.update_warehouse_with_cost_version(
  p_warehouse_id uuid,
  p_name text,
  p_country_code char(2),
  p_is_active boolean,
  p_amount numeric,
  p_billing_unit text,
  p_effective_date date,
  p_note text,
  p_created_by uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.warehouses
  set name = p_name, country_code = p_country_code, is_active = p_is_active
  where id = p_warehouse_id;
  if not found then raise exception 'warehouse not found'; end if;

  insert into public.warehouse_cost_versions
    (warehouse_id, amount, currency_code, billing_unit, effective_date, note, created_by)
  values
    (p_warehouse_id, p_amount, 'CNY', p_billing_unit, p_effective_date, nullif(trim(p_note), ''), p_created_by);
end;
$$;

revoke all on function public.create_warehouse_with_initial_cost(text, char, boolean, numeric, text, date, text, uuid) from public;
revoke all on function public.update_warehouse_with_cost_version(uuid, text, char, boolean, numeric, text, date, text, uuid) from public;
grant execute on function public.create_warehouse_with_initial_cost(text, char, boolean, numeric, text, date, text, uuid) to service_role;
grant execute on function public.update_warehouse_with_cost_version(uuid, text, char, boolean, numeric, text, date, text, uuid) to service_role;
