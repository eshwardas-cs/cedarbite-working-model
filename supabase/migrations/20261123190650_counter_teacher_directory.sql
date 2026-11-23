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

insert into public.counter_teacher_directory (cedar_email, full_name)
values
  ('abdul.noor@cedar.edu.pk', 'Abdul Ghani Noor'),
  ('abdullah.ghelli@cedar.edu.pk', 'Abdullah Saleem Ghelli'),
  ('abdullah.shahmeer@cedar.edu.pk', 'Abdullah Shahmeer'),
  ('adam.asif@cedar.edu.pk', 'Adam Asif'),
  ('adeel.paperwala@cedar.edu.pk', 'Adeel Paperwala'),
  ('adil.usman@cedar.edu.pk', 'Adil Usman'),
  ('ahmad.karim@cedar.edu.pk', 'Ahmad Karim'),
  ('ammar.abid@cedar.edu.pk', 'Ammar Abid'),
  ('anushay.anis@cedar.edu.pk', 'Anushay Anis'),
  ('arsalan.farrukh@cedar.edu.pk', 'Arsalan Farrukh'),
  ('asad.kothari@cedar.edu.pk', 'Asad Kothari'),
  ('asma.raza@cedar.edu.pk', 'Asma Raza'),
  ('aysha.sheikh@cedar.edu.pk', 'Aysha Sheikh'),
  ('bilal.kurd@cedar.edu.pk', 'Bilal Kurd'),
  ('dilnaz.avari@cedar.edu.pk', 'Dilnaz X Avari'),
  ('mustafa.arif@cedar.edu.pk', 'Dr Mustafa Arif'),
  ('fareeha.ghafoor@cedar.edu.pk', 'Fareeha Ghafoor'),
  ('farhan.khan@cedar.edu.pk', 'Farhan Khan'),
  ('hamza.shafiq@cedar.edu.pk', 'Hamza Shafiq'),
  ('hiba.saigal@cedar.edu.pk', 'Hiba Saigal'),
  ('iftikhar.zaidi@cedar.edu.pk', 'Iftikhar Zaidi'),
  ('jarrar.hashmi@cedar.edu.pk', 'Jarrar Hashmi'),
  ('junaina.junaid@cedar.edu.pk', 'Junaina Junaid'),
  ('kamran.salam@cedar.edu.pk', 'Kamran Abdul Salam'),
  ('khalida.uzma@cedar.edu.pk', 'Khalida Uzma'),
  ('mariam.reza@cedar.edu.pk', 'Mariam Reza'),
  ('moinuddin.ali@cedar.edu.pk', 'Moinuddin Ali'),
  ('muhammad.khan@cedar.edu.pk', 'Muhammad Ali Khan'),
  ('muhammad.anas@cedar.edu.pk', 'Muhammad Anas'),
  ('muhammad.haris@cedar.edu.pk', 'Muhammad Haris'),
  ('muzammil.abbas@cedar.edu.pk', 'Muzammil Abbas'),
  ('nida.malik@cedar.edu.pk', 'Nida Malik'),
  ('omair.masood@cedar.edu.pk', 'Omair Masood'),
  ('parsa.asif@cedar.edu.pk', 'Parsa Asif'),
  ('roque.dmello@cedar.edu.pk', 'Roque Martin D''Mello'),
  ('salma.baig@cedar.edu.pk', 'Salma Baig'),
  ('salman.amin@cedar.edu.pk', 'Salman Amin'),
  ('saman.bashir@cedar.edu.pk', 'Saman Bashir'),
  ('shahzad.naeem@cedar.edu.pk', 'Shahzad Naeem'),
  ('shahzaib.latafat@cedar.edu.pk', 'Shahzaib Latafat'),
  ('sheheryar.rashid@cedar.edu.pk', 'Sheheryar Rashid'),
  ('tayyaba.khan@cedar.edu.pk', 'Tayyaba Sami Khan'),
  ('yawer.hussain@cedar.edu.pk', 'Yawer Hussain'),
  ('zain.merchant@cedar.edu.pk', 'Zain Merchant'),
  ('zarmina.raza@cedar.edu.pk', 'Zarmina Raza'),
  ('zeeshan.warsi@cedar.edu.pk', 'Zeeshan Warsi'),
  ('zehra.ali@cedar.edu.pk', 'Zehra Ali'),
  ('zufashan.hasan@cedar.edu.pk', 'Zufashan Hasan')
on conflict (cedar_email) do update
set full_name = excluded.full_name,
    is_active = true,
    updated_at = now();

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
