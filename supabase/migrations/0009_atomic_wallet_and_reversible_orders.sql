-- CedarBite: transactional pickup reservations and wallet ledger; reversible order removal.
-- Apply after 0008 on the Supabase project before deploying the matching Netlify function code.

drop index if exists public.orders_active_created_idx;
drop index if exists public.orders_completed_idx;
alter table public.orders drop column if exists is_active;
alter table public.orders alter column total_paisa type bigint;
alter table public.orders
  add column is_active boolean generated always as
    (status not in ('COLLECTED', 'CANCELLED', 'VOIDED')) stored;
create index if not exists orders_active_created_idx on public.orders (is_active, created_at);
create index if not exists orders_completed_idx on public.orders (completed_at desc) where not is_active;

create table if not exists public.order_audit_events (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders(id),
  action text not null,
  actor text not null,
  reason text not null default '',
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists order_audit_events_order_created_idx
  on public.order_audit_events (order_id, created_at desc);

create table if not exists public.wallet_accounts (
  student_id text primary key check (student_id ~ '^[0-9]{7}$'),
  balance_paisa bigint not null default 0 check (balance_paisa >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.wallet_entries (
  id text primary key,
  idempotency_key text not null unique,
  student_id text not null references public.wallet_accounts(student_id),
  kind text not null check (kind in ('credit', 'debit')),
  amount_paisa bigint not null check (amount_paisa > 0),
  method text not null,
  label text not null default '',
  recorded_by text not null default '',
  order_id text references public.orders(id),
  created_at timestamptz not null default now()
);
create index if not exists wallet_entries_student_created_idx
  on public.wallet_entries (student_id, created_at desc);
create table if not exists public.wallet_legacy_imports (
  student_id text primary key references public.wallet_accounts(student_id),
  imported_at timestamptz not null default now(),
  imported_entries integer not null default 0,
  legacy_ledger_imported boolean not null default false
);

alter table public.order_audit_events enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.wallet_entries enable row level security;
alter table public.wallet_legacy_imports enable row level security;
revoke all on public.order_audit_events, public.wallet_accounts, public.wallet_entries, public.wallet_legacy_imports from anon, authenticated;
grant all on public.order_audit_events, public.wallet_accounts, public.wallet_entries, public.wallet_legacy_imports to service_role;

create or replace function public.cedar_create_order_atomic(p_row jsonb, p_capacity integer default 20, p_actor text default 'online')
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_id text := p_row->>'id';
  v_data jsonb := p_row->'data';
  v_mode text := p_row->>'mode';
  v_start timestamptz := nullif(p_row->>'pickup_start_at', '')::timestamptz;
  v_count integer;
  v_existing jsonb;
  v_wallet public.wallet_accounts%rowtype;
  v_amount bigint;
  v_now timestamptz := now();
begin
  if jsonb_typeof(p_row) <> 'object' or jsonb_typeof(v_data) <> 'object' or v_id is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_ORDER');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cedarbite-order:' || v_id, 0));
  select data into v_existing from public.orders where id = v_id for update;
  if found then return jsonb_build_object('ok', true, 'duplicate', true, 'order', v_existing); end if;

  if v_mode = 'SCHEDULED' then
    if v_start is null or extract(epoch from v_start)::bigint % 600 <> 0 then
      return jsonb_build_object('ok', false, 'error', 'INVALID_PICKUP_SLOT');
    end if;
    if p_capacity < 1 or p_capacity > 200 then
      return jsonb_build_object('ok', false, 'error', 'INVALID_CAPACITY');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('cedarbite-slot:' || v_start::text, 0));
    select count(*) into v_count from public.orders
      where pickup_start_at = v_start and is_active;
    if v_count >= p_capacity then
      return jsonb_build_object('ok', false, 'error', 'SLOT_FULL');
    end if;
  end if;

  if lower(coalesce(v_data->>'payment_method', '')) = 'wallet' then
    if v_data->>'source' = 'COUNTER' and coalesce(v_data->>'customer_type', '') <> 'STUDENT' then
      return jsonb_build_object('ok', false, 'error', 'WALLET_STUDENT_ONLY');
    end if;
    if coalesce(v_data->>'student_id', '') !~ '^[0-9]{7}$' then
      return jsonb_build_object('ok', false, 'error', 'WALLET_STUDENT_ONLY');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('cedarbite-wallet:' || (v_data->>'student_id'), 0));
    v_amount := (p_row->>'total_paisa')::bigint;
    select * into v_wallet from public.wallet_accounts
      where student_id = v_data->>'student_id' for update;
    if not found or v_wallet.balance_paisa < v_amount then
      return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_WALLET_BALANCE');
    end if;
    update public.wallet_accounts set balance_paisa = balance_paisa - v_amount, updated_at = v_now
      where student_id = v_data->>'student_id';
    v_data := jsonb_set(v_data, '{payment_status}', '"PAID"'::jsonb, true);
    v_data := jsonb_set(v_data, '{paid_at}', to_jsonb(v_now::text), true);
    p_row := jsonb_set(p_row, '{payment_status}', '"PAID"'::jsonb, true);
    p_row := jsonb_set(p_row, '{data}', v_data, true);
  end if;

  insert into public.orders (id, pickup_code, status, source, mode, customer_user_id, student_id,
    total_paisa, payment_method, payment_status, pickup_start_at, created_at, ready_at, completed_at, data)
  values (v_id, p_row->>'pickup_code', p_row->>'status', coalesce(p_row->>'source', 'ONLINE'), v_mode,
    nullif(p_row->>'customer_user_id', '')::uuid, nullif(p_row->>'student_id', ''),
    coalesce((p_row->>'total_paisa')::bigint, 0), p_row->>'payment_method', p_row->>'payment_status',
    v_start, coalesce(nullif(p_row->>'created_at', '')::timestamptz, v_now),
    nullif(p_row->>'ready_at', '')::timestamptz, nullif(p_row->>'completed_at', '')::timestamptz, v_data);
  if lower(coalesce(v_data->>'payment_method', '')) = 'wallet' then
    insert into public.wallet_entries (id, idempotency_key, student_id, kind, amount_paisa, method, label, recorded_by, order_id, created_at)
    values ('order-payment-' || v_id, 'order-payment:' || v_id, v_data->>'student_id', 'debit', v_amount,
      'wallet', 'Order payment ' || coalesce(v_data->>'pickup_code', v_id), coalesce(p_actor, ''), v_id, v_now);
  end if;
  insert into public.order_audit_events (order_id, action, actor, after_data)
    values (v_id, 'created', coalesce(p_actor, 'system'), v_data);
  return jsonb_build_object('ok', true, 'duplicate', false, 'order', v_data);
exception when unique_violation then
  select data into v_existing from public.orders where id = v_id;
  if v_existing is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'order', v_existing); end if;
  raise;
end;
$$;

create or replace function public.cedar_update_order_atomic(p_row jsonb, p_expected_status text default null, p_actor text default 'system')
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_id text := p_row->>'id';
  v_before jsonb;
  v_after jsonb := p_row->'data';
  v_status text := p_row->>'status';
begin
  select data into v_before from public.orders where id = v_id for update;
  if not found or (p_expected_status is not null and v_before->>'status' <> p_expected_status) then return null; end if;
  if v_before->>'status' = 'VOIDED' then return null; end if;
  update public.orders set pickup_code = p_row->>'pickup_code', status = v_status,
    source = coalesce(p_row->>'source', 'ONLINE'), mode = coalesce(p_row->>'mode', 'QUICK'),
    customer_user_id = nullif(p_row->>'customer_user_id', '')::uuid,
    student_id = nullif(p_row->>'student_id', ''), total_paisa = coalesce((p_row->>'total_paisa')::bigint, 0),
    payment_method = p_row->>'payment_method', payment_status = p_row->>'payment_status',
    pickup_start_at = nullif(p_row->>'pickup_start_at', '')::timestamptz,
    created_at = coalesce(nullif(p_row->>'created_at', '')::timestamptz, created_at),
    ready_at = nullif(p_row->>'ready_at', '')::timestamptz,
    completed_at = nullif(p_row->>'completed_at', '')::timestamptz, data = v_after
    where id = v_id;
  insert into public.order_audit_events (order_id, action, actor, before_data, after_data)
    values (v_id, case when v_before->>'status' is distinct from v_status then 'status_changed' else 'updated' end,
      coalesce(p_actor, 'system'), v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.cedar_void_order(p_order_id text, p_actor text, p_reason text, p_allowed_statuses text[])
returns jsonb language plpgsql set search_path = '' as $$
declare v_before jsonb; v_after jsonb;
begin
  select data into v_before from public.orders where id = p_order_id for update;
  if not found then return null; end if;
  if v_before->>'status' = 'VOIDED' then return v_before; end if;
  if not ((v_before->>'status') = any(p_allowed_statuses)) then return null; end if;
  v_after := v_before || jsonb_build_object('status', 'VOIDED', 'voided_at', now(),
    'voided_by', coalesce(p_actor, 'manager'), 'void_reason', left(coalesce(p_reason, ''), 240),
    'voided_previous_status', v_before->>'status');
  update public.orders set status = 'VOIDED', completed_at = now(), data = v_after where id = p_order_id;
  insert into public.order_audit_events (order_id, action, actor, reason, before_data, after_data)
    values (p_order_id, 'voided', coalesce(p_actor, 'manager'), left(coalesce(p_reason, ''), 240), v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.cedar_restore_order(p_order_id text, p_actor text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_previous text;
begin
  select data into v_before from public.orders where id = p_order_id for update;
  if not found or v_before->>'status' <> 'VOIDED' then return null; end if;
  v_previous := v_before->>'voided_previous_status';
  if v_previous not in ('SUBMITTED', 'COLLECTED', 'CANCELLED') then return null; end if;
  v_after := (v_before - 'voided_at' - 'voided_by' - 'void_reason' - 'voided_previous_status') || jsonb_build_object('status', v_previous);
  update public.orders set status = v_previous,
    completed_at = case when v_previous in ('COLLECTED', 'CANCELLED') then nullif(v_after->>'completed_at', '')::timestamptz else null end,
    data = v_after where id = p_order_id;
  insert into public.order_audit_events (order_id, action, actor, before_data, after_data)
    values (p_order_id, 'restored', coalesce(p_actor, 'manager'), v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.cedar_wallet_cash_topup(p_student_id text, p_amount_paisa bigint,
  p_idempotency_key text, p_label text, p_actor text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_existing public.wallet_entries%rowtype; v_balance bigint; v_now timestamptz := now();
begin
  if p_student_id !~ '^[0-9]{7}$' or p_amount_paisa < 5000 or p_amount_paisa > 500000 or p_idempotency_key = '' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_TOPUP');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cedarbite-wallet:' || p_student_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('cedarbite-wallet-ref:' || p_idempotency_key, 0));
  select * into v_existing from public.wallet_entries where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.student_id <> p_student_id or v_existing.amount_paisa <> p_amount_paisa then
      return jsonb_build_object('ok', false, 'error', 'REFERENCE_REUSED');
    end if;
    select balance_paisa into v_balance from public.wallet_accounts where student_id = p_student_id;
    return jsonb_build_object('ok', true, 'duplicate', true, 'balance_paisa', coalesce(v_balance, 0), 'entry', to_jsonb(v_existing));
  end if;
  insert into public.wallet_accounts(student_id) values (p_student_id) on conflict do nothing;
  select balance_paisa into v_balance from public.wallet_accounts where student_id = p_student_id for update;
  update public.wallet_accounts set balance_paisa = v_balance + p_amount_paisa, updated_at = v_now where student_id = p_student_id returning balance_paisa into v_balance;
  insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa, method, label, recorded_by, created_at)
  values (p_idempotency_key, p_idempotency_key, p_student_id, 'credit', p_amount_paisa, 'cash_at_counter', left(coalesce(p_label, 'Cash wallet top-up'), 160), left(coalesce(p_actor, 'cashier'), 80), v_now)
  returning * into v_existing;
  return jsonb_build_object('ok', true, 'duplicate', false, 'balance_paisa', v_balance, 'entry', to_jsonb(v_existing));
end;
$$;

-- Imports the former Netlify Blobs wallet exactly once per student. The opening balance is
-- carried into the SQL account; old ledger rows are copied for history without changing it.
create or replace function public.cedar_import_legacy_wallet(p_student_id text, p_balance_paisa bigint, p_entries jsonb, p_complete boolean default false)
returns jsonb language plpgsql set search_path = '' as $$
declare v_count integer := 0; v_entry jsonb; v_id text; v_amount bigint; v_kind text; v_now timestamptz := now(); v_already_imported boolean := false; v_ledger_complete boolean := false;
begin
  if p_student_id !~ '^[0-9]{7}$' or p_balance_paisa < 0 or jsonb_typeof(coalesce(p_entries, '[]'::jsonb)) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_LEGACY_WALLET');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cedarbite-wallet:' || p_student_id, 0));
  insert into public.wallet_accounts(student_id) values (p_student_id) on conflict do nothing;
  select true, legacy_ledger_imported into v_already_imported, v_ledger_complete
    from public.wallet_legacy_imports where student_id = p_student_id;
  v_already_imported := coalesce(v_already_imported, false);
  v_ledger_complete := coalesce(v_ledger_complete, false);
  if v_already_imported and v_ledger_complete then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if not v_already_imported then
    update public.wallet_accounts set balance_paisa = balance_paisa + p_balance_paisa, updated_at = v_now
      where student_id = p_student_id;
  end if;
  for v_entry in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    v_id := left(coalesce(v_entry->>'id', md5(v_entry::text)), 160);
    v_kind := v_entry->>'kind';
    v_amount := nullif(v_entry->>'amount_paisa', '')::bigint;
    if v_kind not in ('credit', 'debit') or v_amount is null or v_amount <= 0 then continue; end if;
    insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa, method, label, recorded_by, created_at)
    values ('legacy-' || p_student_id || '-' || md5(v_id), 'legacy:' || p_student_id || ':' || md5(v_id), p_student_id,
      v_kind, v_amount, left(coalesce(v_entry->>'method', 'legacy'), 80), left(coalesce(v_entry->>'label', 'Prior wallet activity'), 160),
      left(coalesce(v_entry->>'recorded_by', 'prior system'), 80), coalesce(nullif(v_entry->>'created_at', '')::timestamptz, v_now))
    on conflict (idempotency_key) do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  insert into public.wallet_legacy_imports(student_id, imported_entries, legacy_ledger_imported)
    values (p_student_id, v_count, p_complete)
    on conflict (student_id) do update set imported_entries = public.wallet_legacy_imports.imported_entries + excluded.imported_entries,
      legacy_ledger_imported = public.wallet_legacy_imports.legacy_ledger_imported or excluded.legacy_ledger_imported;
  return jsonb_build_object('ok', true, 'duplicate', v_already_imported, 'imported_entries', v_count);
end;
$$;

create or replace function public.cedar_wallet_refund_order(p_order_id text, p_actor text)
returns jsonb language plpgsql set search_path = '' as $$
declare v_order public.orders%rowtype; v_before jsonb; v_after jsonb; v_amount bigint; v_balance bigint; v_ref text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.data->>'status' <> 'COLLECTED' or v_order.data->>'payment_method' <> 'wallet' then return null; end if;
  v_before := v_order.data;
  if v_before->>'refund_status' = 'REFUNDED' then return v_before; end if;
  v_amount := coalesce(nullif(v_before->>'total_paisa', '')::bigint, v_order.total_paisa);
  if v_amount < 1 then return null; end if;
  if coalesce(v_before->>'student_id', '') !~ '^[0-9]{7}$' then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('cedarbite-wallet:' || (v_before->>'student_id'), 0));
  insert into public.wallet_accounts(student_id) values (v_before->>'student_id') on conflict do nothing;
  select balance_paisa into v_balance from public.wallet_accounts where student_id = v_before->>'student_id' for update;
  v_ref := 'wallet-refund:' || p_order_id;
  if not exists (select 1 from public.wallet_entries where idempotency_key = v_ref) then
    update public.wallet_accounts set balance_paisa = v_balance + v_amount, updated_at = now() where student_id = v_before->>'student_id';
    insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa, method, label, recorded_by, order_id)
    values ('refund-' || p_order_id, v_ref, v_before->>'student_id', 'credit', v_amount, 'wallet_refund',
      'Refund for order ' || coalesce(v_before->>'pickup_code', p_order_id), left(coalesce(p_actor, 'manager'), 80), p_order_id);
  end if;
  v_after := v_before || jsonb_build_object('refund_status', 'REFUNDED', 'refund_method', 'wallet',
    'refunded_at', now(), 'refunded_by', coalesce(p_actor, 'manager'), 'refund_amount_paisa', v_amount);
  update public.orders set data = v_after where id = p_order_id;
  insert into public.order_audit_events(order_id, action, actor, before_data, after_data)
    values (p_order_id, 'wallet_refunded', coalesce(p_actor, 'manager'), v_before, v_after);
  return v_after;
end;
$$;

revoke all on function public.cedar_create_order_atomic(jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.cedar_update_order_atomic(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.cedar_void_order(text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.cedar_restore_order(text, text) from public, anon, authenticated;
revoke all on function public.cedar_wallet_cash_topup(text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.cedar_import_legacy_wallet(text, bigint, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.cedar_wallet_refund_order(text, text) from public, anon, authenticated;
grant execute on function public.cedar_create_order_atomic(jsonb, integer, text) to service_role;
grant execute on function public.cedar_update_order_atomic(jsonb, text, text) to service_role;
grant execute on function public.cedar_void_order(text, text, text, text[]) to service_role;
grant execute on function public.cedar_restore_order(text, text) to service_role;
grant execute on function public.cedar_wallet_cash_topup(text, bigint, text, text, text) to service_role;
grant execute on function public.cedar_import_legacy_wallet(text, bigint, jsonb, boolean) to service_role;
grant execute on function public.cedar_wallet_refund_order(text, text) to service_role;
