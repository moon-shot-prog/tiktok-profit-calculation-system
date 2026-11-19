create table public.order_import_batches (
  id uuid primary key default gen_random_uuid(),
  import_type text not null check (import_type in ('orders', 'settlements')),
  file_name text not null,
  total_rows integer not null default 0 check (total_rows >= 0),
  success_rows integer not null default 0 check (success_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  failure_summary jsonb not null default '[]'::jsonb,
  imported_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index order_import_batches_created_idx on public.order_import_batches (created_at desc);
alter table public.order_import_batches enable row level security;
grant select on public.order_import_batches to authenticated;
create policy "order import batches: administrators read" on public.order_import_batches for select to authenticated using (private.is_administrator());
