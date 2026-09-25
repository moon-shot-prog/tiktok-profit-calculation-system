create table public.promotion_expenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  campaign_name text not null check (char_length(trim(campaign_name)) between 1 and 120),
  promotion_date date not null,
  cost_amount numeric(18, 4) not null check (cost_amount >= 0),
  sku_count integer not null default 0 check (sku_count >= 0),
  order_count integer not null default 0 check (order_count >= 0),
  revenue_amount numeric(18, 4) not null default 0 check (revenue_amount >= 0),
  currency_code char(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  note text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index promotion_expenses_shop_date_idx on public.promotion_expenses (shop_id, promotion_date desc, created_at desc);
create trigger promotion_expenses_set_updated_at before update on public.promotion_expenses for each row execute function public.set_updated_at();

alter table public.promotion_expenses enable row level security;
grant select, insert, update, delete on public.promotion_expenses to authenticated;
create policy "promotion expenses: administrators manage" on public.promotion_expenses for all to authenticated
  using (private.is_administrator()) with check (private.is_administrator());
