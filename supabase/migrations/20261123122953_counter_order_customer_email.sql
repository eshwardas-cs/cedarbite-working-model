-- Store a verified Cedar account email beside each order so a counter order can
-- appear in My orders even when the customer had not signed in when it was placed.
alter table public.orders
  add column if not exists customer_email text;

-- Preserve older student counter orders, which already had their seven-digit ID.
update public.orders
set customer_email = lower(nullif(trim(data->>'customer_email'), ''))
where customer_email is null
  and nullif(trim(data->>'customer_email'), '') is not null;

update public.orders
set customer_email = student_id || '@cedar.edu.pk',
    data = data || jsonb_build_object('customer_email', student_id || '@cedar.edu.pk')
where customer_email is null
  and student_id ~ '^[0-9]{7}$';

create index if not exists orders_customer_email_created_idx
  on public.orders (customer_email, created_at desc)
  where customer_email is not null;

-- Keep the searchable email column in step with the private order JSON as the
-- existing atomic create/update functions insert and edit orders.
create or replace function private.sync_order_customer_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.customer_email := lower(coalesce(
    nullif(trim(new.data->>'customer_email'), ''),
    new.customer_email,
    case when new.student_id ~ '^[0-9]{7}$' then new.student_id || '@cedar.edu.pk' end
  ));
  return new;
end;
$$;

grant usage on schema private to service_role;
revoke all on function private.sync_order_customer_email() from public, anon, authenticated;
grant execute on function private.sync_order_customer_email() to service_role;

drop trigger if exists orders_sync_customer_email on public.orders;
create trigger orders_sync_customer_email
  before insert or update of data, student_id, customer_email on public.orders
  for each row execute function private.sync_order_customer_email();
