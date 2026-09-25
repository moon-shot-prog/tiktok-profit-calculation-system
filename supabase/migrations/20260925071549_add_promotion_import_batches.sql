create table public.promotion_import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_code text not null unique check (batch_code ~ '^[0-9]{8}-[0-9]{4}$'),
  shop_id uuid not null references public.shops(id) on delete restrict,
  file_name text not null,
  total_rows integer not null check (total_rows >= 0),
  success_rows integer not null default 0 check (success_rows >= 0),
  updated_rows integer not null default 0 check (updated_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  imported_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.promotion_expenses
  add column import_batch_id uuid references public.promotion_import_batches(id) on delete set null;

create unique index promotion_expenses_shop_day_key on public.promotion_expenses (shop_id, promotion_date);
create index promotion_import_batches_shop_created_idx on public.promotion_import_batches (shop_id, created_at desc);

alter table public.promotion_import_batches enable row level security;
grant select, insert, update on public.promotion_import_batches to authenticated;
create policy "promotion import batches: administrators manage" on public.promotion_import_batches for all to authenticated
  using (private.is_administrator()) with check (private.is_administrator());
