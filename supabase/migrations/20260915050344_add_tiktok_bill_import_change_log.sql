create table public.tiktok_bill_import_changes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.order_import_batches(id) on delete cascade,
  record_id uuid references public.tiktok_bill_records(id) on delete set null,
  operation text not null check (operation in ('insert', 'update', 'replacement')),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index tiktok_bill_import_changes_batch_idx on public.tiktok_bill_import_changes (batch_id, created_at desc);

alter table public.tiktok_bill_import_changes enable row level security;
grant select on public.tiktok_bill_import_changes to authenticated;
create policy "tiktok bill import changes: administrators read"
  on public.tiktok_bill_import_changes for select to authenticated
  using (private.is_administrator());
