update public.tiktok_bill_records
set source_fingerprint = lower(regexp_replace(trim(settlement_document_id), '[[:space:]]+', ' ', 'g')) || '::' ||
  lower(regexp_replace(trim(related_order_id), '[[:space:]]+', ' ', 'g')) || '::' ||
  lower(regexp_replace(trim(sku_id), '[[:space:]]+', ' ', 'g')) || '::' ||
  trim(trailing '.' from trim(trailing '0' from settlement_amount::text))
where source_type = 'settled'
  and settlement_document_id is not null and related_order_id is not null and sku_id is not null and settlement_amount is not null;
