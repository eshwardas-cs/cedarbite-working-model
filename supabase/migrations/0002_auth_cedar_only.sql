-- CedarBite: sign-in rules (Step B)
-- Only two kinds of people can ever get an account:
--   1. Cedar College Google accounts (signed in through Google, verified Cedar domain)
--   2. Emails the owner has put on the staff list (canteen staff, any email)
-- Everyone else is refused before their account is created.
--
-- Paste this whole file into Supabase > SQL Editor and press Run. Safe to run more than once.

-- A private area for internal functions. The website cannot see or call anything in here.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ============================================================
-- 1. Roles
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role' and typnamespace = 'public'::regnamespace) then
    create type public.app_role as enum ('student', 'teacher', 'staff', 'manager', 'owner');
  end if;
end $$;

-- ============================================================
-- 2. Staff list (only you, in the dashboard, can change this)
-- ============================================================
create table if not exists public.staff_allowlist (
  email     text primary key check (email = lower(trim(email)) and email like '%_@_%'),
  role      public.app_role not null default 'staff' check (role in ('staff', 'manager', 'owner')),
  note      text,
  added_at  timestamptz not null default now()
);

alter table public.staff_allowlist enable row level security;
-- No policies on purpose: the website can neither read nor change the staff list.
revoke all on public.staff_allowlist from anon, authenticated;

-- ============================================================
-- 3. Profiles (one row per person who has an account)
-- ============================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        public.app_role not null,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "People can read their own profile" on public.profiles;
create policy "People can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

-- Read-only for the website: nobody can change their own role or anyone else's.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- ============================================================
-- 4. The gatekeeper: runs BEFORE any new account is saved
-- ============================================================
create or replace function private.enforce_cedar_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_email  text := lower(coalesce(new.email, ''));
  -- app_meta_data is written by Supabase itself; a user cannot fake it.
  provider   text := new.raw_app_meta_data ->> 'provider';
  -- Google's signed "hosted domain" claim: proves the account belongs to Cedar's Google Workspace.
  google_hd  text := lower(coalesce(new.raw_user_meta_data -> 'custom_claims' ->> 'hd', ''));
begin
  -- Staff the owner has approved (any email, any sign-in method)
  if exists (select 1 from public.staff_allowlist s where s.email = new_email) then
    return new;
  end if;

  -- Cedar College Google accounts
  if provider = 'google'
     and new_email like '%@cedar.edu.pk'
     and google_hd = 'cedar.edu.pk' then
    return new;
  end if;

  raise exception 'CEDAR_ONLY: Only Cedar College Google accounts can use CedarBite.'
    using errcode = '42501';
end;
$$;

drop trigger if exists enforce_cedar_signup on auth.users;
create trigger enforce_cedar_signup
  before insert on auth.users
  for each row execute function private.enforce_cedar_signup();

-- ============================================================
-- 5. Create the profile automatically AFTER an account is allowed
-- ============================================================
create or replace function private.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_email   text := lower(new.email);
  staff_role  public.app_role;
begin
  select s.role into staff_role from public.staff_allowlist s where s.email = new_email;

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new_email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    case
      when staff_role is not null then staff_role
      when new_email ~ '^[0-9]{7}@cedar\.edu\.pk$' then 'student'::public.app_role   -- 7-digit student ID
      else 'teacher'::public.app_role                                              -- other Cedar accounts
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists create_profile_for_new_user on auth.users;
create trigger create_profile_for_new_user
  after insert on auth.users
  for each row execute function private.create_profile_for_new_user();
