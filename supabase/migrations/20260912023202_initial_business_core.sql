-- TikTok Profit Calculation System: initial business core
-- Run through Supabase CLI / SQL editor using an owner role. Browser users are
-- restricted by the RLS policies below; no authorization uses user_metadata.

create schema if not exists private;
revoke all on schema private from public;

create type public.app_role as enum ('business_user', 'finance', 'admin', 'super_admin');
create type public.product_status as enum ('pending_review', 'approved', 'rejected', 'disabled');
create type public.feedback_status as enum ('open', 'in_progress', 'resolved', 'closed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.app_role not null,
  assigned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  country_code char(2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  shop_code text not null unique,
  shop_name text not null,
  country_code char(2) not null,
  currency_code char(3) not null,
  timezone text not null default 'Asia/Shanghai',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shops_currency_code_format check (currency_code ~ '^[A-Z]{3}$')
);

create table public.user_shop_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  product_code text not null,
  product_name text not null,
  image_url text,
  sale_price numeric(18, 4) not null check (sale_price >= 0),
  currency_code char(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  status public.product_status not null default 'pending_review',
  created_by uuid not null references public.profiles(id) on delete restrict,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warehouse_id, product_code)
);
create index products_warehouse_status_idx on public.products (warehouse_id, status);
create index products_product_code_idx on public.products (product_code);

create table public.product_feedbacks (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  issue_type text not null check (issue_type in ('price', 'warehouse', 'code', 'other')),
  content text not null check (char_length(trim(content)) between 1 and 2000),
  status public.feedback_status not null default 'open',
  created_by uuid not null references public.profiles(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_feedbacks_product_created_idx on public.product_feedbacks (product_id, created_at desc);

create table public.general_feedbacks (
  id uuid primary key default gen_random_uuid(),
  feedback_type text not null check (feedback_type in ('feature', 'usage', 'display', 'other')),
  page_key text,
  content text not null check (char_length(trim(content)) between 1 and 2000),
  status public.feedback_status not null default 'open',
  created_by uuid not null references public.profiles(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index general_feedbacks_creator_created_idx on public.general_feedbacks (created_by, created_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_entity_created_idx on public.audit_logs (entity_type, entity_id, created_at desc);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (id, display_name, phone)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), ''),
    new.phone
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.handle_new_user();

create or replace function private.is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role in ('finance', 'admin', 'super_admin')
  );
$$;

create or replace function private.is_administrator()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid())
      and role in ('admin', 'super_admin')
  );
$$;

create or replace function private.has_shop_access(target_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select private.is_privileged()
      or exists (
        select 1 from public.user_shop_permissions
        where user_id = (select auth.uid()) and shop_id = target_shop_id
      );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger warehouses_set_updated_at before update on public.warehouses for each row execute function public.set_updated_at();
create trigger shops_set_updated_at before update on public.shops for each row execute function public.set_updated_at();
create trigger products_set_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger product_feedbacks_set_updated_at before update on public.product_feedbacks for each row execute function public.set_updated_at();
create trigger general_feedbacks_set_updated_at before update on public.general_feedbacks for each row execute function public.set_updated_at();

insert into public.warehouses (name, country_code) values
  ('跨境仓', null),
  ('菲律宾本土', 'PH'),
  ('印尼本土', 'ID'),
  ('越南亚达', 'VN'),
  ('越南904千易', 'VN'),
  ('越南908千易', 'VN'),
  ('泰国本土', 'TH')
on conflict (name) do nothing;

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.warehouses enable row level security;
alter table public.shops enable row level security;
alter table public.user_shop_permissions enable row level security;
alter table public.products enable row level security;
alter table public.product_feedbacks enable row level security;
alter table public.general_feedbacks enable row level security;
alter table public.audit_logs enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.user_roles, public.warehouses, public.shops, public.user_shop_permissions, public.products, public.product_feedbacks, public.general_feedbacks, public.audit_logs to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function private.is_privileged(), private.is_administrator(), private.has_shop_access(uuid) to authenticated;

create policy "profiles: users read own; administrators read all" on public.profiles for select to authenticated
  using ((select auth.uid()) = id or private.is_administrator());
create policy "profiles: users update own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "user roles: users read own; administrators manage" on public.user_roles for select to authenticated
  using ((select auth.uid()) = user_id or private.is_administrator());
create policy "user roles: administrators insert" on public.user_roles for insert to authenticated
  with check (private.is_administrator());
create policy "user roles: administrators update" on public.user_roles for update to authenticated
  using (private.is_administrator()) with check (private.is_administrator());
create policy "user roles: administrators delete" on public.user_roles for delete to authenticated
  using (private.is_administrator());

create policy "warehouses: authenticated users read" on public.warehouses for select to authenticated using (true);
create policy "warehouses: administrators manage" on public.warehouses for all to authenticated
  using (private.is_administrator()) with check (private.is_administrator());

create policy "shops: assigned users read" on public.shops for select to authenticated
  using (private.has_shop_access(id));
create policy "shops: administrators manage" on public.shops for all to authenticated
  using (private.is_administrator()) with check (private.is_administrator());

create policy "shop permissions: users read own; administrators manage" on public.user_shop_permissions for select to authenticated
  using ((select auth.uid()) = user_id or private.is_administrator());
create policy "shop permissions: administrators insert" on public.user_shop_permissions for insert to authenticated
  with check (private.is_administrator());
create policy "shop permissions: administrators update" on public.user_shop_permissions for update to authenticated
  using (private.is_administrator()) with check (private.is_administrator());
create policy "shop permissions: administrators delete" on public.user_shop_permissions for delete to authenticated
  using (private.is_administrator());

create policy "products: approved or own pending products are readable" on public.products for select to authenticated
  using (status = 'approved' or created_by = (select auth.uid()) or private.is_privileged());
create policy "products: authenticated users create pending products" on public.products for insert to authenticated
  with check (created_by = (select auth.uid()) and status = 'pending_review');
create policy "products: privileged users update" on public.products for update to authenticated
  using (private.is_privileged()) with check (private.is_privileged());
create policy "products: administrators delete" on public.products for delete to authenticated
  using (private.is_administrator());

create policy "product feedback: creators or administrators read" on public.product_feedbacks for select to authenticated
  using (created_by = (select auth.uid()) or private.is_administrator());
create policy "product feedback: authenticated users create own" on public.product_feedbacks for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy "product feedback: administrators update" on public.product_feedbacks for update to authenticated
  using (private.is_administrator()) with check (private.is_administrator());

create policy "general feedback: creators or administrators read" on public.general_feedbacks for select to authenticated
  using (created_by = (select auth.uid()) or private.is_administrator());
create policy "general feedback: authenticated users create own" on public.general_feedbacks for insert to authenticated
  with check (created_by = (select auth.uid()));
create policy "general feedback: administrators update" on public.general_feedbacks for update to authenticated
  using (private.is_administrator()) with check (private.is_administrator());

create policy "audit logs: administrators read" on public.audit_logs for select to authenticated
  using (private.is_administrator());

revoke all on function public.set_updated_at() from public;
revoke all on function private.is_privileged(), private.is_administrator(), private.has_shop_access(uuid) from public;
revoke all on function private.handle_new_user() from public;
