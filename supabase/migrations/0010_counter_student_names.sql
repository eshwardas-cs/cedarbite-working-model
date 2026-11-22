-- Names recorded by counter staff for students who have not signed in yet.
-- Keep these separate from auth-backed profiles; profile names remain authoritative.
create table if not exists public.counter_student_names (
  student_id text primary key
    check (student_id ~ '^[0-9]{7}$'),
  full_name text not null
    check (char_length(btrim(full_name)) between 1 and 100),
  recorded_by text not null default 'counter'
    check (char_length(btrim(recorded_by)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.counter_student_names enable row level security;

-- The Netlify server function uses the Supabase secret key. Browser roles must
-- not be able to enumerate, read, or alter staff-entered student names.
revoke all on table public.counter_student_names from anon, authenticated;
grant select, insert, update on table public.counter_student_names to service_role;
