alter table public.warehouses
  add column if not exists delivery_option text,
  add column if not exists shipping_provider_name text;
