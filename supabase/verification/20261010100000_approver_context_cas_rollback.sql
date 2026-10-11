-- Rollback for 20261010100000_approver_context_cas.sql (same statements as
-- the migration's ROLLBACK block). Turn APPROVER_AUTHORITY_ENABLED off first.
-- Drops the two compare-and-swap RPCs only; PR-D (20261005500000) stays.
begin;
drop function if exists public.approver_cas_write_employee_policy(uuid, uuid, uuid, text, jsonb, text[], text[], text, jsonb, text, jsonb);
drop function if exists public.approver_cas_write_scheduling_policy(uuid, uuid, uuid, text, jsonb, text, jsonb);
commit;
