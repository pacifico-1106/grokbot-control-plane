-- Rollback for 20261012500000_employee_holds.sql (S1). Same as the migration's ROLLBACK block.
begin;
drop function if exists public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz);
drop function if exists public.request_employee_hold_release(uuid, uuid, text, text, uuid, timestamptz);
drop function if exists public.start_employee_hold(uuid, uuid, text, text, text, text, text, timestamptz);
drop trigger if exists employees_hold_guard on public.employees;
drop trigger if exists orgs_hold_guard on public.orgs;
alter table public.employees drop constraint if exists employees_hold_id_fkey;
alter table public.employees drop constraint if exists employees_hold_state_check;
alter table public.employees drop column if exists hold_id, drop column if exists hold_state;
alter table public.orgs drop constraint if exists orgs_hold_id_fkey;
alter table public.orgs drop constraint if exists orgs_hold_state_check;
alter table public.orgs drop column if exists hold_id, drop column if exists hold_state;
drop table if exists public.employee_holds;
drop function if exists public.hold_columns_guard();
drop function if exists public.employee_holds_guard();
commit;
