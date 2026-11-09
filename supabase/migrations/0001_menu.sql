-- CedarBite: menu tables (Step 1 of the Supabase move)
-- Paste this whole file into Supabase > SQL Editor and press Run.
-- Safe to run more than once.

-- ============================================================
-- 1. Menu sections (categories)
-- ============================================================
create table if not exists public.menu_categories (
  id          bigint generated always as identity primary key,
  name        text not null unique check (length(name) between 1 and 80),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- 2. Menu items (each food / drink)
-- ============================================================
create table if not exists public.menu_items (
  id                 bigint generated always as identity primary key,
  category_id        bigint not null references public.menu_categories(id) on delete restrict,
  name               text not null check (length(name) between 1 and 120),
  description        text not null default '',
  price_paisa        integer not null check (price_paisa >= 0),      -- whole paisa, never decimals
  addon_name         text check (addon_name is null or length(addon_name) <= 80),
  addon_price_paisa  integer not null default 0 check (addon_price_paisa >= 0),
  is_available       boolean not null default true,   -- sold out today?
  is_active          boolean not null default true,   -- still on the menu at all?
  quick_allowed      boolean not null default false,  -- order for pickup now
  scheduled_allowed  boolean not null default true,   -- pre-order for a time slot
  prep_minutes       integer check (prep_minutes is null or prep_minutes between 0 and 240),
  image_path         text,                            -- file path inside the menu-images folder
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists menu_items_category_id_idx on public.menu_items (category_id);

-- Keep updated_at correct automatically whenever an item changes
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists menu_items_set_updated_at on public.menu_items;
create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function public.set_updated_at();

-- ============================================================
-- 3. Security rules (Row Level Security)
--    Website visitors may READ only. Nobody can change the menu
--    through the website yet; staff editing comes with the users step.
-- ============================================================
alter table public.menu_categories enable row level security;
alter table public.menu_items      enable row level security;

drop policy if exists "Anyone can read categories" on public.menu_categories;
create policy "Anyone can read categories"
  on public.menu_categories for select
  to anon, authenticated
  using (true);

drop policy if exists "Anyone can read active items" on public.menu_items;
create policy "Anyone can read active items"
  on public.menu_items for select
  to anon, authenticated
  using (is_active);

-- Belt and braces: the website's key may only read these tables.
revoke all on public.menu_categories, public.menu_items from anon, authenticated;
grant select on public.menu_categories, public.menu_items to anon, authenticated;

-- ============================================================
-- 4. Photo folder (Supabase Storage)
--    Public = anyone can view a photo by its link.
--    Uploading is NOT allowed from the website (no upload rule exists).
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
