-- CedarBite: students can cancel an order before the canteen accepts it.
-- Cancelled orders must leave the kitchen queue, so "active" now means
-- "not collected AND not cancelled".
--
-- Paste this whole file into Supabase > SQL Editor and press Run. Safe to run more than once.
-- Run it BEFORE deploying the code that adds "Cancel order".

drop index if exists public.orders_active_created_idx;
drop index if exists public.orders_completed_idx;

alter table public.orders drop column if exists is_active;
alter table public.orders
  add column is_active boolean generated always as (status not in ('COLLECTED', 'CANCELLED')) stored;

create index if not exists orders_active_created_idx on public.orders (is_active, created_at);
create index if not exists orders_completed_idx      on public.orders (completed_at desc) where not is_active;
