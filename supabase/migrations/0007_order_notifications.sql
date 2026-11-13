-- CedarBite email receipts, collection reminders, and browser push subscriptions.
-- Run this in Supabase before deploying the notification code.

alter table public.orders add column if not exists ready_at timestamptz;
create index if not exists orders_ready_at_idx on public.orders (ready_at) where status = 'READY';

create table if not exists public.push_subscriptions (
  endpoint text primary key check (char_length(endpoint) between 1 and 2048),
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth_secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant all on table public.push_subscriptions to service_role;

create table if not exists public.notification_deliveries (
  id uuid primary key,
  order_id text not null references public.orders (id) on delete cascade,
  kind text not null check (kind in ('receipt', 'collection_reminder')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);
create index if not exists notification_deliveries_pending_idx
  on public.notification_deliveries (created_at) where status = 'pending';
alter table public.notification_deliveries enable row level security;
revoke all on table public.notification_deliveries from anon, authenticated;
grant all on table public.notification_deliveries to service_role;
