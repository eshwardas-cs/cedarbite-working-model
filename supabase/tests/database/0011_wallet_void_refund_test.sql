begin;

select plan(10);

insert into public.wallet_accounts(student_id, balance_paisa)
values ('9999999', 100000)
on conflict (student_id) do update set balance_paisa = excluded.balance_paisa;

insert into public.orders(id, pickup_code, status, source, mode, student_id, total_paisa,
  payment_method, payment_status, data)
values (
  'test-wallet-void-restore', 'CBTEST11', 'SUBMITTED', 'ONLINE', 'QUICK', '9999999', 50000,
  'wallet', 'PAID',
  '{"id":"test-wallet-void-restore","pickup_code":"CBTEST11","status":"SUBMITTED","student_id":"9999999","total_paisa":50000,"payment_method":"wallet","payment_status":"PAID"}'::jsonb
);
insert into public.wallet_entries(id, idempotency_key, student_id, kind, amount_paisa, method,
  label, recorded_by, order_id)
values ('test-order-payment', 'order-payment:test-wallet-void-restore', '9999999', 'debit',
  50000, 'wallet', 'Order payment CBTEST11', 'test', 'test-wallet-void-restore');

select is((select balance_paisa from public.wallet_accounts where student_id = '9999999'),
  100000::bigint, 'wallet starts at the funded balance');
select is((public.cedar_void_order('test-wallet-void-restore', 'test', 'test removal', array['SUBMITTED'])->>'status'),
  'VOIDED', 'voiding a wallet-paid order records a void');
select is((select balance_paisa from public.wallet_accounts where student_id = '9999999'),
  150000::bigint, 'voiding returns the order amount to the wallet');

select public.cedar_void_order('test-wallet-void-restore', 'test', 'duplicate removal', array['SUBMITTED']);
select is((select balance_paisa from public.wallet_accounts where student_id = '9999999'),
  150000::bigint, 'repeating a void does not issue a second refund');
select is((select count(*) from public.wallet_entries where order_id = 'test-wallet-void-restore'
    and kind = 'credit' and method = 'wallet_void_refund'),
  1::bigint, 'one void refund ledger entry is recorded');

update public.wallet_accounts set balance_paisa = 10000 where student_id = '9999999';
select is((public.cedar_restore_order('test-wallet-void-restore', 'test')->>'error'),
  'INSUFFICIENT_WALLET_BALANCE', 'restore is refused when the student spent the refund');
select is((select balance_paisa from public.wallet_accounts where student_id = '9999999'),
  10000::bigint, 'a refused restore leaves the remaining balance unchanged');

update public.wallet_accounts set balance_paisa = 60000 where student_id = '9999999';
select is((public.cedar_restore_order('test-wallet-void-restore', 'test')->>'status'),
  'SUBMITTED', 'restore succeeds after the wallet has enough funds');
select is((select balance_paisa from public.wallet_accounts where student_id = '9999999'),
  10000::bigint, 'restoring charges back the refunded order amount');
select is((select count(*) from public.wallet_entries where order_id = 'test-wallet-void-restore'
    and kind = 'debit' and method = 'wallet_void_restore'),
  1::bigint, 'one wallet debit records the restored order charge');

select * from finish();
rollback;
