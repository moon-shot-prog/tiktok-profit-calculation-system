alter table public.order_import_batches
  drop constraint if exists order_import_batches_validation_status_check;

alter table public.order_import_batches
  add constraint order_import_batches_validation_status_check
  check (validation_status in ('previewed', 'processing', 'completed', 'partial', 'failed'));
