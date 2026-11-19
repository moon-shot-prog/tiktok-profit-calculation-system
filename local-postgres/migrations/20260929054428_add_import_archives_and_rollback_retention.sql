-- Private archive metadata for import source files. The application server
-- accesses this table and bucket with its secret key; browser roles get no
-- direct access to the imported business files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'import-archives',
  'import-archives',
  false,
  104857600,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/json'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.import_archives (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null unique references public.order_import_batches(id) on delete restrict,
  storage_bucket text not null default 'import-archives' check (storage_bucket = 'import-archives'),
  storage_path text not null unique,
  source_file_name text not null,
  source_content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null,
  row_count integer,
  archived_at timestamptz not null default now(),
  archived_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.import_archives enable row level security;
revoke all on table public.import_archives from anon, authenticated;

alter table public.order_import_batches
  add column if not exists rollback_expires_at timestamptz;

update public.order_import_batches
set rollback_expires_at = created_at + interval '30 days'
where rollback_expires_at is null
  and import_type in ('settled_bills', 'unsettled_bills');

create index if not exists import_archives_batch_id_idx on public.import_archives(batch_id);
create index if not exists order_import_batches_rollback_expires_at_idx
  on public.order_import_batches(rollback_expires_at)
  where rollback_expires_at is not null;
