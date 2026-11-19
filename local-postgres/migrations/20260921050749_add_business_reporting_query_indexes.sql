-- Business dashboard, profit summary and order details read these paths on every filtered request.
create index if not exists user_shop_permissions_user_shop_idx
  on public.user_shop_permissions (user_id, shop_id);

create index if not exists order_items_sku_id_idx
  on public.order_items (sku_id)
  where sku_id is not null;

create index if not exists tiktok_bill_records_shop_related_active_idx
  on public.tiktok_bill_records (shop_id, related_order_id, source_type)
  where replacement_status = 'active';

create index if not exists tiktok_bill_records_shop_source_active_updated_idx
  on public.tiktok_bill_records (shop_id, source_type, updated_at desc)
  where replacement_status = 'active';
