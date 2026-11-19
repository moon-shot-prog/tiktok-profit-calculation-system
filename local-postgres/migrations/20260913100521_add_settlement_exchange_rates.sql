-- Settlement exchange rates maintained by administrators.  A rate is never
-- physically removed by the application: it is deactivated and its version
-- history remains available for future order-profit traceability.

create table public.settlement_exchange_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency char(3) not null check (base_currency ~ '^[A-Z]{3}$'),
  quote_currency char(3) not null check (quote_currency ~ '^[A-Z]{3}$'),
  settlement_rate numeric(20, 8) not null check (settlement_rate > 0),
  effective_date date not null,
  note text,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint settlement_exchange_rates_currency_pair check (base_currency <> quote_currency),
  unique (base_currency, quote_currency, effective_date)
);

create index settlement_exchange_rates_pair_date_idx
  on public.settlement_exchange_rates (base_currency, quote_currency, effective_date desc);

create table public.settlement_exchange_rate_versions (
  id bigint generated always as identity primary key,
  rate_id uuid not null references public.settlement_exchange_rates(id) on delete restrict,
  action text not null check (action in ('created', 'updated', 'deactivated')),
  previous_data jsonb,
  current_data jsonb not null,
  operated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index settlement_exchange_rate_versions_rate_created_idx
  on public.settlement_exchange_rate_versions (rate_id, created_at desc);

create or replace function private.record_settlement_exchange_rate_version()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.settlement_exchange_rate_versions (rate_id, action, current_data, operated_by)
    values (new.id, 'created', to_jsonb(new), new.created_by);
    return new;
  end if;

  insert into public.settlement_exchange_rate_versions (rate_id, action, previous_data, current_data, operated_by)
  values (
    new.id,
    case when old.is_active and not new.is_active then 'deactivated' else 'updated' end,
    to_jsonb(old),
    to_jsonb(new),
    coalesce(new.updated_by, new.created_by)
  );
  return new;
end;
$$;

create trigger settlement_exchange_rates_set_updated_at
  before update on public.settlement_exchange_rates
  for each row execute function public.set_updated_at();

create trigger settlement_exchange_rates_record_version
  after insert or update on public.settlement_exchange_rates
  for each row execute function private.record_settlement_exchange_rate_version();

alter table public.settlement_exchange_rates enable row level security;
alter table public.settlement_exchange_rate_versions enable row level security;

grant select, insert, update on public.settlement_exchange_rates to authenticated;
grant select on public.settlement_exchange_rate_versions to authenticated;
grant usage, select on all sequences in schema public to authenticated;

create policy "settlement rates: administrators manage"
  on public.settlement_exchange_rates for all to authenticated
  using (private.is_administrator()) with check (private.is_administrator());

create policy "settlement rate versions: administrators read"
  on public.settlement_exchange_rate_versions for select to authenticated
  using (private.is_administrator());

revoke all on function private.record_settlement_exchange_rate_version() from public;
