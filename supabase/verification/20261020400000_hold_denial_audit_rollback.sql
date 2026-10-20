-- Rollback for 20261020400000_hold_denial_audit.sql (same statements as
-- the migration's ROLLBACK block).
begin;
delete from public.mcp_auth_failures where failure_kind in ('org_on_hold', 'employee_on_hold');
drop function if exists public.record_hold_mcp_denial(text, uuid, uuid, uuid, text);
drop index if exists public.mcp_auth_failures_hold_denial_throttle_uidx;
alter table public.mcp_auth_failures drop column if exists hold_id;
alter table public.mcp_auth_failures drop constraint if exists mcp_auth_failures_failure_kind_check;
alter table public.mcp_auth_failures add constraint mcp_auth_failures_failure_kind_check
  check (failure_kind in ('missing_credential', 'invalid', 'expired'));
commit;
