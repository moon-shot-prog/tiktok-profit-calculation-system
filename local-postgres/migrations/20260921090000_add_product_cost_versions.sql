-- Product costs are time-effective and warehouse-specific.  Keep the cost
-- history separate from the current product master so historical orders do
-- not change when the current unit price is edited.
create table public.product_cost_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  product_code text not null,
  amount numeric(18, 4) not null check (amount >= 0),
  currency_code char(3) not null default 'CNY' check (currency_code ~ '^[A-Z]{3}$'),
  effective_date date not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index product_cost_versions_lookup_idx
  on public.product_cost_versions (warehouse_id, product_code, effective_date desc, created_at desc);

-- Preserve existing product prices for all historical orders until a later
-- explicit cost version supersedes them.
insert into public.product_cost_versions
  (product_id, warehouse_id, product_code, amount, currency_code, effective_date, created_by)
select id, warehouse_id, product_code, sale_price, currency_code, date '1970-01-01', created_by
from public.products;

alter table public.product_cost_versions enable row level security;
-- The application server uses service_role. No browser role is granted direct
-- access to the internal cost-history table.
revoke all on table public.product_cost_versions from anon, authenticated;
