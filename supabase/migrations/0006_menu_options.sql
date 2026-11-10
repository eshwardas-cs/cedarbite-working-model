-- CedarBite: selectable menu item options (e.g. the flavour of a cold drink)
-- Matches Eshwar's "selectable menu item options" design:
--   * an item with options REQUIRES the customer to pick one,
--   * each option can be out of stock on its own,
--   * an option does NOT change the price.
--
-- Paste this whole file into Supabase > SQL Editor and press Run. Safe to run more than once.
-- It only ADDS a table: the live site keeps working before and after.

-- ============================================================
-- 1. The options table
-- ============================================================
create table if not exists public.menu_item_options (
  id            text primary key check (char_length(id) between 1 and 36),
  menu_item_id  bigint not null references public.menu_items (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  is_available  boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists menu_item_options_item_sort_idx on public.menu_item_options (menu_item_id, sort_order);

drop trigger if exists menu_item_options_set_updated_at on public.menu_item_options;
create trigger menu_item_options_set_updated_at
  before update on public.menu_item_options
  for each row execute function public.set_updated_at();

-- ============================================================
-- 2. Security: everyone can READ the options of items on the menu;
--    only the server (Netlify function, secret key) can add, change or remove them.
-- ============================================================
alter table public.menu_item_options enable row level security;

drop policy if exists "Anyone can read options of active items" on public.menu_item_options;
create policy "Anyone can read options of active items"
  on public.menu_item_options
  for select
  to anon, authenticated
  using (exists (
    select 1 from public.menu_items i
    where i.id = menu_item_options.menu_item_id and i.is_active
  ));

revoke all on public.menu_item_options from anon, authenticated;
grant select on public.menu_item_options to anon, authenticated;
