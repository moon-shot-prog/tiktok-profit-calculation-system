create table public.orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  warehouse_id uuid references public.warehouses(id) on delete set null,
  order_number text not null,
  order_status text not null default 'pending_payment',
  refund_status text not null default 'none',
  refund_amount numeric(18, 4) not null default 0 check (refund_amount >= 0),
  payment_amount numeric(18, 4) not null check (payment_amount >= 0),
  currency_code char(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  tracking_number text,
  logistics_carrier text,
  ordered_at timestamptz not null,
  shipped_at timestamptz,
  synced_at timestamptz not null default now(),
  source_identifier text,
  raw_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, order_number)
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_code text,
  sku_id text not null,
  product_name text,
  quantity integer not null check (quantity > 0),
  allocated_payment numeric(18, 4) not null default 0 check (allocated_payment >= 0),
  currency_code char(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now()
);

create table public.settlement_records (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id) on delete restrict,
  settlement_number text not null,
  settlement_date date not null,
  currency_code char(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  transaction_type text not null,
  related_order_number text,
  sku_id text,
  product_name text,
  quantity integer,
  settlement_total numeric(18, 4) not null,
  total_income numeric(18, 4),
  total_fees numeric(18, 4),
  import_status text not null default 'imported',
  source_identifier text,
  raw_data jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, settlement_number, transaction_type, related_order_number, sku_id)
);

create index orders_shop_ordered_idx on public.orders (shop_id, ordered_at desc);
create index order_items_order_idx on public.order_items (order_id);
create index settlement_records_shop_date_idx on public.settlement_records (shop_id, settlement_date desc);

create trigger orders_set_updated_at before update on public.orders for each row execute function public.set_updated_at();
create trigger settlement_records_set_updated_at before update on public.settlement_records for each row execute function public.set_updated_at();

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.settlement_records enable row level security;

grant select on public.orders, public.order_items, public.settlement_records to authenticated;

create policy "orders: administrators read" on public.orders for select to authenticated using (private.is_administrator());
create policy "order items: administrators read" on public.order_items for select to authenticated using (private.is_administrator());
create policy "settlement records: administrators read" on public.settlement_records for select to authenticated using (private.is_administrator());
