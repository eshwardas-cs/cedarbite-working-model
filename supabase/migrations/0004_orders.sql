-- CedarBite: orders move from Netlify storage to Supabase (Step 2 of the Supabase move)
--
-- Paste this whole file into Supabase > SQL Editor and press Run. Safe to run more than once.
-- It only ADDS a table: the live site keeps working before and after.
-- Run it BEFORE deploying the code that uses it. The first request after that deploy copies
-- the existing orders across from Netlify storage automatically.

-- ============================================================
-- 1. The orders table
--    `data` holds the whole order exactly as the app uses it (items, pickup slot, refund details...).
--    The other columns are copies of the parts we search and sort by.
-- ============================================================
create table if not exists public.orders (
  id               text primary key check (char_length(id) between 1 and 80),
  pickup_code      text not null,
  status           text not null,
  is_active        boolean generated always as (status <> 'COLLECTED') stored,
  source           text not null default 'ONLINE',
  mode             text not null default 'QUICK',
  customer_user_id uuid references auth.users (id) on delete set null,
  student_id       text,
  total_paisa      integer not null default 0 check (total_paisa >= 0),
  payment_method   text,
  payment_status   text,
  pickup_start_at  timestamptz,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  updated_at       timestamptz not null default now(),
  data             jsonb not null check (jsonb_typeof(data) = 'object')
);

create index if not exists orders_active_created_idx   on public.orders (is_active, created_at);
create index if not exists orders_completed_idx        on public.orders (completed_at desc) where not is_active;
create index if not exists orders_customer_created_idx on public.orders (customer_user_id, created_at desc);

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ============================================================
-- 2. Security: only the server (Netlify function, secret key) can read or change orders.
--    Row Level Security is on with NO policies, and browsers' keys get no access at all.
--    Students see their own orders through the server, which checks their Google sign-in.
-- ============================================================
alter table public.orders enable row level security;
revoke all on table public.orders from anon, authenticated;
