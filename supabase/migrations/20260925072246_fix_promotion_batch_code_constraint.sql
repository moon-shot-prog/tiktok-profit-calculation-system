alter table public.promotion_import_batches
  drop constraint promotion_import_batches_batch_code_check,
  add constraint promotion_import_batches_batch_code_check
    check (batch_code ~ '^[0-9]{8}-[0-9]{4}$');
