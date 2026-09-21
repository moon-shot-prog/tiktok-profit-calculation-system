-- TikTok 已结算/未结算账单。原始列完整保留在 raw_data，常用金额字段单独标准化。
create table public.tiktok_bill_records (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  source_type text not null check (source_type in ('settled', 'unsettled')),
  source_fingerprint text not null,
  transaction_type text not null,
  transaction_id text not null,
  related_order_id text,
  sku_id text,
  product_name text,
  sku_name text,
  quantity integer,
  currency_code char(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  settlement_document_id text,
  settlement_date date,
  transaction_created_at timestamptz,
  estimated_settlement_at timestamptz,
  unsettled_reason text,
  settlement_amount numeric(18, 4),
  total_income numeric(18, 4),
  total_fees numeric(18, 4),
  fee_breakdown jsonb not null default '{}'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  import_batch_id uuid references public.order_import_batches(id) on delete set null,
  replacement_status text not null default 'active' check (replacement_status in ('active', 'superseded', 'needs_review')),
  replaced_by_id uuid references public.tiktok_bill_records(id) on delete set null,
  replaces_record_id uuid references public.tiktok_bill_records(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, source_type, source_fingerprint)
);

create index tiktok_bill_records_shop_status_date_idx
  on public.tiktok_bill_records (shop_id, source_type, replacement_status, settlement_date desc, transaction_created_at desc);
create index tiktok_bill_records_match_idx
  on public.tiktok_bill_records (shop_id, transaction_type, transaction_id, sku_id);
create index tiktok_bill_records_batch_idx on public.tiktok_bill_records (import_batch_id);

create trigger tiktok_bill_records_set_updated_at
  before update on public.tiktok_bill_records
  for each row execute function public.set_updated_at();

alter table public.tiktok_bill_records enable row level security;
grant select on public.tiktok_bill_records to authenticated;
create policy "tiktok bill records: administrators read"
  on public.tiktok_bill_records for select to authenticated
  using (private.is_administrator());

alter table public.order_import_batches
  drop constraint if exists order_import_batches_import_type_check;
alter table public.order_import_batches
  add constraint order_import_batches_import_type_check
  check (import_type in ('orders', 'settlements', 'settled_bills', 'unsettled_bills'));
