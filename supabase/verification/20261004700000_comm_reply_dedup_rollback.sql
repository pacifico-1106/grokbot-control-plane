-- Rollback for supabase/migrations/20261004700000_comm_reply_dedup.sql.
-- Run only after COMM_REPLY_DEDUP_ENABLED is OFF in every environment.
-- Exercised by scripts/test-db-local.py (rollback, then re-apply).
begin;
drop function if exists public.finish_comm_reply_send(uuid, uuid, text);
drop function if exists public.claim_comm_reply_send(uuid, uuid, text, text, integer[], text, uuid, integer, double precision, integer);
drop table if exists public.comm_reply_send_fingerprints;
-- Closed-without-send tickets stay closed (never reopened): superseded → expired.
-- Done while the new guard (which allows superseded → expired) is still installed.
update public.approval_requests set status = 'expired' where status = 'superseded';
alter table public.approval_requests drop constraint if exists approval_requests_status_check;
alter table public.approval_requests add constraint approval_requests_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'revision_requested'));
-- guard_workflow_approval_status() exactly as in 20260916120000_f8_enforcement.sql.
create or replace function public.guard_workflow_approval_status()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $f8$
declare w public.approval_workflow_instances; p jsonb;
begin
  if new.status is not distinct from old.status then return new; end if;
  select * into w from public.approval_workflow_instances where approval_id=old.id and org_id=old.org_id;
  if found then
    if new.status not in ('approved','rejected') or new.status<>w.status
      or (new.status='approved' and not public.workflow_instance_satisfied(w.id,old.org_id)) then
      raise exception 'workflow_resolution_required'; end if;
  elsif not old.workflow_initialized then
    -- No recursive UPDATE of this same row inside a BEFORE UPDATE trigger.
    select coalesce(e.approval_workflow_policy,o.approval_workflow_policy) into p
      from public.orgs o left join public.employees e on e.id=old.employee_id and e.org_id=o.id where o.id=old.org_id;
    if p is not null then raise exception 'workflow_initialization_required'; end if;
    new.workflow_initialized:=true;
  end if;
  return new;
end $f8$;
commit;
