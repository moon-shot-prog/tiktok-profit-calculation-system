-- Keep order imports compact: the original file is retained on the
-- importer's approved local archive folder, while Postgres stores only the
-- normalized business fields, batch trace, and a 30-day change snapshot.
alter table public.orders
  add column if not exists extension_data jsonb not null default '{}'::jsonb,
  add column if not exists raw_data_compacted_at timestamptz;

alter table public.order_items
  add column if not exists extension_data jsonb not null default '{}'::jsonb,
  add column if not exists raw_data_compacted_at timestamptz;

create table if not exists public.order_import_changes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.order_import_batches(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  order_item_id uuid references public.order_items(id) on delete set null,
  operation text not null check (operation in ('insert', 'update')),
  before_order jsonb,
  after_order jsonb,
  before_item jsonb,
  after_item jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_import_changes_batch_created_idx
  on public.order_import_changes(batch_id, created_at desc);

alter table public.order_import_changes enable row level security;
grant select on public.order_import_changes to authenticated;

create policy "order import changes: administrators read"
  on public.order_import_changes for select to authenticated
  using (private.is_administrator());

-- Existing batches keep their original timestamp as the start of the
-- protection window. New order imports set this explicitly in the server.
update public.order_import_batches
set rollback_expires_at = created_at + interval '30 days'
where rollback_expires_at is null
  and import_type = 'orders';

create index if not exists orders_raw_data_compaction_idx
  on public.orders(raw_data_compacted_at)
  where raw_data_compacted_at is null;

create index if not exists order_items_raw_data_compaction_idx
  on public.order_items(raw_data_compacted_at)
  where raw_data_compacted_at is null;
