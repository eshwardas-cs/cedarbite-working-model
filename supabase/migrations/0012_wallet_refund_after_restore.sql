-- CedarBite: a wallet order can be refunded again after a void and restore.
--
-- Before: the refund ledger key was always 'wallet-refund:<order>'. If an order was refunded,
-- voided, restored (which takes the refund back) and then refunded again, the second refund
-- found the old key, skipped the credit, and still marked the order REFUNDED: no money returned.
-- Now each refund gets its own key, saved on the order as refund_wallet_key, and void/restore
-- reverse exactly that refund. Replaces three functions only; safe to run more than once.
-- Run after 0011.

create or replace function public.cedar_wallet_refund_order(p_order_id text, p_actor text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_amount bigint;
  v_balance bigint;
  v_ref text;
  v_previous_refunds integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.data->>'status' <> 'COLLECTED' or v_order.data->>'payment_method' <> 'wallet' then return null; end if;
  v_before := v_order.data;
  if v_before->>'refund_status' = 'REFUNDED' then return v_before; end if;
  v_amount := coalesce(nullif(v_before->>'total_paisa', '')::bigint, v_order.total_paisa);
  if v_amount < 1 then return null; end if;
  if coalesce(v_before->>'student_id', '') !~ '^[0-9]{7}$' then return null; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cedarbite-wallet:' || (v_before->>'student_id'), 0));
  insert into public.wallet_accounts(student_id) values (v_before->>'student_id') on conflict do nothing;
  select balance_paisa into v_balance from public.wallet_accounts where student_id = v_before->>'student_id' for update;

  -- The first refund keeps the original key; later ones (after a void and restore) get their own.
  select count(*) into v_previous_refunds from public.wallet_entries
    where order_id = p_order_id and method = 'wallet_refund';
  v_ref := 'wallet-refund:' || p_order_id || case when v_previous_refunds = 0 then '' else ':' || (v_previous_refunds + 1)::text end;

  update public.wallet_accounts set balance_paisa = v_balance + v_amount, updated_at = now() where student_id = v_before->>'student_id';
  insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa, method, label, recorded_by, order_id)
  values ('refund-' || p_order_id || case when v_previous_refunds = 0 then '' else '-' || (v_previous_refunds + 1)::text end,
    v_ref, v_before->>'student_id', 'credit', v_amount, 'wallet_refund',
    'Refund for order ' || coalesce(v_before->>'pickup_code', p_order_id), left(coalesce(p_actor, 'manager'), 80), p_order_id);

  v_after := v_before || pg_catalog.jsonb_build_object('refund_status', 'REFUNDED', 'refund_method', 'wallet',
    'refunded_at', now(), 'refunded_by', coalesce(p_actor, 'manager'), 'refund_amount_paisa', v_amount,
    'refund_wallet_key', v_ref);
  update public.orders set data = v_after where id = p_order_id;
  insert into public.order_audit_events(order_id, action, actor, before_data, after_data)
    values (p_order_id, 'wallet_refunded', coalesce(p_actor, 'manager'), v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.cedar_void_order(p_order_id text, p_actor text, p_reason text, p_allowed_statuses text[])
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_status text;
  v_student_id text;
  v_amount bigint;
  v_balance bigint;
  v_refund_key text;
  v_void_number bigint;
  v_wallet_refunded boolean := false;
  v_now timestamptz := now();
begin
  select data into v_before from public.orders where id = p_order_id for update;
  if not found then return null; end if;
  if v_before->>'status' = 'VOIDED' then return v_before; end if;
  v_status := v_before->>'status';
  if not coalesce(v_status = any(coalesce(p_allowed_statuses, array[]::text[])), false) then return null; end if;

  if lower(coalesce(v_before->>'payment_method', '')) = 'wallet'
     and upper(coalesce(v_before->>'payment_status', '')) = 'PAID' then
    v_student_id := coalesce(v_before->>'student_id', '');
    v_amount := coalesce(nullif(v_before->>'total_paisa', '')::bigint, 0);
    if v_student_id !~ '^[0-9]{7}$' or v_amount < 1 then return null; end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cedarbite-wallet:' || v_student_id, 0));
    insert into public.wallet_accounts(student_id) values (v_student_id) on conflict do nothing;
    select balance_paisa into v_balance from public.wallet_accounts where student_id = v_student_id for update;

    -- A previously recorded wallet refund already returned these funds; restoration
    -- will reverse it. Otherwise each void cycle receives its own idempotent ledger key.
    if v_before->>'refund_status' = 'REFUNDED' and lower(coalesce(v_before->>'refund_method', '')) = 'wallet' then
      v_refund_key := coalesce(nullif(v_before->>'refund_wallet_key', ''), 'wallet-refund:' || p_order_id);
      if not exists (select 1 from public.wallet_entries where idempotency_key = v_refund_key
          and order_id = p_order_id and student_id = v_student_id and kind = 'credit') then
        return null;
      end if;
      v_wallet_refunded := true;
    else
      select count(*) + 1 into v_void_number from public.order_audit_events
        where order_id = p_order_id and action = 'voided';
      v_refund_key := 'wallet-void-refund:' || p_order_id || ':' || v_void_number::text;
      update public.wallet_accounts set balance_paisa = balance_paisa + v_amount, updated_at = v_now
        where student_id = v_student_id returning balance_paisa into v_balance;
      insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa,
        method, label, recorded_by, order_id, created_at)
      values ('wallet-void-refund-' || pg_catalog.md5(v_refund_key), v_refund_key, v_student_id,
        'credit', v_amount, 'wallet_void_refund',
        left('Refund for voided order ' || coalesce(v_before->>'pickup_code', p_order_id), 160),
        left(coalesce(p_actor, 'manager'), 80), p_order_id, v_now);
    end if;

    v_after := v_before || pg_catalog.jsonb_build_object('status', 'VOIDED', 'voided_at', v_now,
      'voided_by', coalesce(p_actor, 'manager'), 'void_reason', left(coalesce(p_reason, ''), 240),
      'voided_previous_status', v_status, 'void_wallet_refund_key', v_refund_key,
      'void_wallet_refund_student_id', v_student_id, 'void_wallet_refund_amount_paisa', v_amount);
    if not v_wallet_refunded then
      v_after := v_after || pg_catalog.jsonb_build_object('refund_status', 'REFUNDED',
        'refund_method', 'wallet', 'refunded_at', v_now, 'refunded_by', coalesce(p_actor, 'manager'),
        'refund_amount_paisa', v_amount);
    end if;
  else
    v_after := v_before || pg_catalog.jsonb_build_object('status', 'VOIDED', 'voided_at', v_now,
      'voided_by', coalesce(p_actor, 'manager'), 'void_reason', left(coalesce(p_reason, ''), 240),
      'voided_previous_status', v_status);
  end if;

  update public.orders set status = 'VOIDED', completed_at = v_now, data = v_after where id = p_order_id;
  insert into public.order_audit_events (order_id, action, actor, reason, before_data, after_data)
    values (p_order_id, 'voided', coalesce(p_actor, 'manager'), left(coalesce(p_reason, ''), 240), v_before, v_after);
  return v_after;
end;
$$;

create or replace function public.cedar_restore_order(p_order_id text, p_actor text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_previous text;
  v_student_id text;
  v_amount bigint;
  v_balance bigint;
  v_refund_key text;
  v_restore_key text;
  v_refund public.wallet_entries%rowtype;
  v_now timestamptz := now();
begin
  select data into v_before from public.orders where id = p_order_id for update;
  if not found or v_before->>'status' <> 'VOIDED' then return null; end if;
  v_previous := v_before->>'voided_previous_status';
  if v_previous not in ('SUBMITTED', 'COLLECTED', 'CANCELLED') then return null; end if;

  v_refund_key := nullif(v_before->>'void_wallet_refund_key', '');
  if v_refund_key is not null then
    v_student_id := coalesce(v_before->>'void_wallet_refund_student_id', '');
    v_amount := nullif(v_before->>'void_wallet_refund_amount_paisa', '')::bigint;
    if v_student_id !~ '^[0-9]{7}$' or v_amount is null or v_amount < 1 then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'WALLET_REFUND_RECORD_MISSING');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cedarbite-wallet:' || v_student_id, 0));
    select * into v_refund from public.wallet_entries
      where idempotency_key = v_refund_key and order_id = p_order_id and student_id = v_student_id
        and kind = 'credit' and amount_paisa = v_amount for update;
    if not found then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'WALLET_REFUND_RECORD_MISSING');
    end if;

    select balance_paisa into v_balance from public.wallet_accounts where student_id = v_student_id for update;
    if not found or v_balance < v_amount then
      return pg_catalog.jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_WALLET_BALANCE');
    end if;

    v_restore_key := 'wallet-void-restore:' || pg_catalog.md5(v_refund_key);
    update public.wallet_accounts set balance_paisa = balance_paisa - v_amount, updated_at = v_now
      where student_id = v_student_id returning balance_paisa into v_balance;
    insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa,
      method, label, recorded_by, order_id, created_at)
    values ('wallet-void-restore-' || pg_catalog.md5(v_refund_key), v_restore_key, v_student_id,
      'debit', v_amount, 'wallet_void_restore',
      left('Recharged for restored order ' || coalesce(v_before->>'pickup_code', p_order_id), 160),
      left(coalesce(p_actor, 'manager'), 80), p_order_id, v_now);
  end if;

  v_after := v_before - 'voided_at' - 'voided_by' - 'void_reason' - 'voided_previous_status'
    - 'void_wallet_refund_key' - 'void_wallet_refund_student_id' - 'void_wallet_refund_amount_paisa';
  if v_refund_key is not null then
    v_after := v_after - 'refund_status' - 'refund_method' - 'refunded_at' - 'refunded_by' - 'refund_amount_paisa' - 'refund_wallet_key';
  end if;
  v_after := v_after || pg_catalog.jsonb_build_object('status', v_previous);
  update public.orders set status = v_previous,
    completed_at = case when v_previous in ('COLLECTED', 'CANCELLED') then nullif(v_after->>'completed_at', '')::timestamptz else null end,
    data = v_after where id = p_order_id;
  insert into public.order_audit_events (order_id, action, actor, before_data, after_data)
    values (p_order_id, 'restored', coalesce(p_actor, 'manager'), v_before, v_after);
  return v_after;
end;
$$;

revoke all on function public.cedar_wallet_refund_order(text, text) from public, anon, authenticated;
revoke all on function public.cedar_void_order(text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.cedar_restore_order(text, text) from public, anon, authenticated;
grant execute on function public.cedar_wallet_refund_order(text, text) to service_role;
grant execute on function public.cedar_void_order(text, text, text, text[]) to service_role;
grant execute on function public.cedar_restore_order(text, text) to service_role;
