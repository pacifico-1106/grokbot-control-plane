-- Rollback for 20261012500000_employee_holds.sql (S1). Same as the migration's ROLLBACK block.
-- Refuses (ROLLBACK_REFUSED) while any employee / org is held: dropping the columns would silently un-stop them.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('public.employee_holds') is not null and (
       exists (select 1 from public.employee_holds where released_at is null and superseded_at is null)
       or exists (select 1 from public.employees where hold_state is not null)
       or exists (select 1 from public.orgs where hold_state is not null)) then
    raise exception 'ROLLBACK_REFUSED: open holds exist — release them (or decide explicitly) first';
  end if;
end $$;
drop function if exists public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz);
drop function if exists public.request_employee_hold_release(uuid, uuid, text, text, uuid, timestamptz);
drop function if exists public.start_employee_hold(uuid, uuid, text, text, text, text, text, timestamptz);
drop function if exists public.employee_hold_rank(text, text);
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
