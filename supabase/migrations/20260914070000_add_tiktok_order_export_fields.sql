-- TikTok order export fields, stored in normalized order-header and SKU-line tables.
alter table public.orders
  add column shop_code text,
  add column country_code text,
  add column order_substatus text,
  add column normal_or_pre_order text,
  add column paid_at timestamptz,
  add column rts_at timestamptz,
  add column delivered_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancel_by text,
  add column cancel_reason text,
  add column fulfillment_type text,
  add column warehouse_name text,
  add column delivery_option text,
  add column buyer_message text,
  add column buyer_username text,
  add column recipient text,
  add column recipient_phone text,
  add column destination_country text,
  add column province text,
  add column district text,
  add column commune text,
  add column detail_address text,
  add column additional_address_information text,
  add column payment_method text,
  add column package_id text,
  add column seller_note text,
  add column checked_status text,
  add column checked_marked_by text,
  add column order_channel text,
  add column creator_handle text;

alter table public.order_items
  add column seller_sku text,
  add column variation text,
  add column sku_quantity_of_return integer not null default 0,
  add column sku_unit_original_price numeric(18, 4),
  add column sku_subtotal_before_discount numeric(18, 4),
  add column sku_platform_discount numeric(18, 4),
  add column sku_seller_discount numeric(18, 4),
  add column sku_subtotal_after_discount numeric(18, 4),
  add column shipping_fee_after_discount numeric(18, 4),
  add column original_shipping_fee numeric(18, 4),
  add column shipping_fee_seller_discount numeric(18, 4),
  add column shipping_fee_platform_discount numeric(18, 4),
  add column payment_platform_discount numeric(18, 4),
  add column taxes numeric(18, 4),
  add column weight_kg numeric(12, 4),
  add column product_category text;

create index orders_shop_code_idx on public.orders (shop_code);
create index orders_tracking_id_idx on public.orders (tracking_number);
create index order_items_seller_sku_idx on public.order_items (seller_sku);
