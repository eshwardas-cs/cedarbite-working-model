-- CedarBite: staff menu editing goes to Supabase (Step 1b of the Supabase move)
-- Before this, staff edits were saved in Netlify storage while students read the menu
-- from Supabase, so sold-out switches, prices and new items never reached students.
--
-- Paste this whole file into Supabase > SQL Editor and press Run. Safe to run more than once.
-- It only ADDS things: the live menu keeps working before and after.

-- ============================================================
-- 1. Item position inside its category (for staff drag-to-reorder)
-- ============================================================
alter table public.menu_items add column if not exists sort_order integer not null default 0;

-- One time only: number the existing items 1, 2, 3 ... inside each category,
-- in the order they show today, so nothing moves for students.
update public.menu_items m
   set sort_order = s.position
  from (
    select id, row_number() over (partition by category_id order by id) as position
    from public.menu_items
  ) s
 where m.id = s.id
   and not exists (select 1 from public.menu_items where sort_order <> 0);

create index if not exists menu_items_category_sort_idx on public.menu_items (category_id, sort_order);

-- ============================================================
-- 2. Reorder the whole menu in one all-or-nothing step
--    p_categories = [{ "id": 3, "item_ids": [7, 5, 6] }, ...] in the new order.
--    If another screen changed the menu meanwhile, it refuses (MENU_STALE)
--    instead of mixing two versions.
-- ============================================================
create or replace function public.staff_reorder_menu(p_categories jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cat            jsonb;
  cat_id         bigint;
  cat_position   integer := 0;
  item_position  integer;
  item_id        bigint;
  listed_ids     bigint[] := '{}';
begin
  if jsonb_typeof(p_categories) is distinct from 'array' or jsonb_array_length(p_categories) = 0 then
    raise exception 'MENU_INVALID: The menu order is empty.';
  end if;

  -- Every current category must be listed exactly once.
  select array_agg((value ->> 'id')::bigint) into listed_ids from jsonb_array_elements(p_categories);
  if (select count(distinct x) from unnest(listed_ids) x) <> array_length(listed_ids, 1)
     or (select count(*) from public.menu_categories) <> array_length(listed_ids, 1)
     or exists (select 1 from unnest(listed_ids) x where not exists (select 1 from public.menu_categories c where c.id = x)) then
    raise exception 'MENU_STALE: The categories changed on another screen.';
  end if;

  for cat in select value from jsonb_array_elements(p_categories) loop
    cat_position := cat_position + 1;
    cat_id := (cat ->> 'id')::bigint;
    update public.menu_categories set sort_order = cat_position where id = cat_id;

    -- Every active item of this category must be listed exactly once.
    if (select count(*) from public.menu_items i where i.category_id = cat_id and i.is_active)
       <> jsonb_array_length(coalesce(cat -> 'item_ids', '[]'::jsonb)) then
      raise exception 'MENU_STALE: The items changed on another screen.';
    end if;

    item_position := 0;
    for item_id in select (value #>> '{}')::bigint from jsonb_array_elements(coalesce(cat -> 'item_ids', '[]'::jsonb)) loop
      item_position := item_position + 1;
      update public.menu_items
         set sort_order = item_position
       where id = item_id and category_id = cat_id and is_active;
      if not found then
        raise exception 'MENU_STALE: An item moved on another screen.';
      end if;
    end loop;
  end loop;
end;
$$;

-- ============================================================
-- 3. Remove a category in one step: move its items first, then delete it
-- ============================================================
create or replace function public.staff_remove_category(p_category_id bigint, p_target_category_id bigint default null)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_id   bigint := p_target_category_id;
  next_order  integer;
begin
  if not exists (select 1 from public.menu_categories where id = p_category_id) then
    raise exception 'MENU_STALE: That category was already removed.';
  end if;
  if (select count(*) from public.menu_categories) <= 1 then
    raise exception 'MENU_INVALID: Keep at least one menu category.';
  end if;
  if target_id = p_category_id then
    raise exception 'MENU_INVALID: Choose a different category to move the items into.';
  end if;
  if target_id is not null and not exists (select 1 from public.menu_categories where id = target_id) then
    raise exception 'MENU_STALE: The chosen category no longer exists.';
  end if;
  if target_id is null and exists (select 1 from public.menu_items where category_id = p_category_id and is_active) then
    raise exception 'MENU_INVALID: Choose another category to move these items into first.';
  end if;

  -- Removed (hidden) items still belong to a category so old orders keep their history.
  if target_id is null then
    select id into target_id from public.menu_categories
     where id <> p_category_id order by sort_order, id limit 1;
  end if;

  select coalesce(max(sort_order), 0) into next_order from public.menu_items where category_id = target_id;
  update public.menu_items i
     set category_id = target_id,
         sort_order  = next_order + s.position
    from (
      select id, row_number() over (order by sort_order, id) as position
      from public.menu_items where category_id = p_category_id
    ) s
   where i.id = s.id;

  delete from public.menu_categories where id = p_category_id;
end;
$$;

-- ============================================================
-- 4. Only the server (secret key) may run these. Browsers cannot.
-- ============================================================
revoke all on function public.staff_reorder_menu(jsonb) from public, anon, authenticated;
revoke all on function public.staff_remove_category(bigint, bigint) from public, anon, authenticated;
grant execute on function public.staff_reorder_menu(jsonb) to service_role;
grant execute on function public.staff_remove_category(bigint, bigint) to service_role;
