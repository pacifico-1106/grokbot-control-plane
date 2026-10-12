-- Rollback for 20261013200000_employee_comm_accounts.sql.
-- Refuses while any account is active: dropping the table would silently orphan a
-- live LINE webhook (it would start answering 404) and lose its secrets. Disable the
-- accounts first (status = 'disabled'), then roll back.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regclass('public.employee_comm_accounts') is not null
     and exists (select 1 from public.employee_comm_accounts where status = 'active') then
    raise exception 'ROLLBACK_REFUSED: active employee_comm_accounts exist; disable them first';
  end if;
end $$;
drop function if exists public.comm_link_code_record_failure(uuid, text, text, timestamptz);
drop function if exists public.comm_link_code_gate(uuid, text, text, timestamptz);
drop table if exists public.comm_link_code_locks;
drop table if exists public.comm_link_code_failures;
drop table if exists public.comm_inbound_events;
drop table if exists public.employee_comm_account_secrets;
drop table if exists public.employee_comm_accounts;
commit;
