-- Shared Cedar teacher directory used by counter orders.
-- Browser roles cannot enumerate the staff list; the server reads it with the Supabase secret key.
create table if not exists public.counter_teacher_directory (
  cedar_email text primary key
    check (cedar_email = lower(btrim(cedar_email)) and cedar_email ~ '^[a-z0-9][a-z0-9._+-]*@cedar\.edu\.pk$'),
  full_name text not null
    check (char_length(btrim(full_name)) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.counter_teacher_directory enable row level security;
revoke all on table public.counter_teacher_directory from anon, authenticated;
grant select on table public.counter_teacher_directory to service_role;

-- The teacher rows themselves are NOT kept in this public repo (they are real Cedar staff
-- names and emails). They were loaded directly into Supabase. To reload or update them, use a
-- private seed file (kept outside git, e.g. supabase/private/counter_teacher_directory_seed.sql)
-- and paste it into Supabase > SQL Editor.

-- Until a teacher signs in, keep the counter-confirmed directory name available
-- to match that teacher's first email-linked account and order history.
create table if not exists public.counter_teacher_names (
  cedar_email text primary key references public.counter_teacher_directory (cedar_email) on delete cascade,
  full_name text not null
    check (char_length(btrim(full_name)) between 1 and 100),
  recorded_by text not null default 'counter'
    check (char_length(btrim(recorded_by)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.counter_teacher_names enable row level security;
revoke all on table public.counter_teacher_names from anon, authenticated;
grant select, insert, update, delete on table public.counter_teacher_names to service_role;

-- Existing verified profiles already have an authoritative name.
delete from public.counter_teacher_names names
using public.profiles profiles
where profiles.role = 'teacher'
  and lower(profiles.email) = names.cedar_email;
-- Remove a fallback once the teacher has an authoritative Cedar profile.
create or replace function private.clear_counter_teacher_name_after_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'teacher' then
    delete from public.counter_teacher_names
    where cedar_email = lower(btrim(new.email));
  end if;
  return new;
end;
$$;

revoke all on function private.clear_counter_teacher_name_after_profile() from public, anon, authenticated;
drop trigger if exists clear_counter_teacher_name_after_profile on public.profiles;
create trigger clear_counter_teacher_name_after_profile
  after insert or update of email, role on public.profiles
  for each row execute function private.clear_counter_teacher_name_after_profile();
