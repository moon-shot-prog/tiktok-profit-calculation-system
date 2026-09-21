-- An order is the header; the import identity is the order line (order + SKU).
alter table public.order_items
  add column cancellation_return_type text,
  add column source_updated_at timestamptz,
  add column raw_data jsonb,
  add column updated_at timestamptz not null default now();

create unique index order_items_order_sku_unique_idx on public.order_items (order_id, sku_id);
create index order_items_source_updated_idx on public.order_items (source_updated_at desc);
create trigger order_items_set_updated_at before update on public.order_items for each row execute function public.set_updated_at();

alter table public.order_import_batches
  add column batch_code text unique,
  add column shop_id uuid references public.shops(id) on delete restrict,
  add column country_code text,
  add column currency_code char(3),
  add column updated_rows integer not null default 0 check (updated_rows >= 0),
  add column validation_status text not null default 'completed' check (validation_status in ('previewed', 'completed', 'failed'));

create index order_import_batches_shop_created_idx on public.order_import_batches (shop_id, created_at desc);
