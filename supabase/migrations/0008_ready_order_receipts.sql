-- Send one receipt email for scheduled orders when they are marked ready.
-- Order-time receipts and collection reminder emails are no longer queued.

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_kind_check;

alter table public.notification_deliveries
  add constraint notification_deliveries_kind_check
  check (kind in ('receipt', 'collection_reminder', 'ready_receipt'));
