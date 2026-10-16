-- Restores public.release_employee_hold from 20261012500000 (no actor_email
-- on the release audit insert). Same signature / grants / search_path.
begin;

create or replace function public.release_employee_hold(
  p_org uuid, p_hold uuid, p_audit_summary text, p_audit_metadata jsonb, p_at timestamptz
) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $rlh$
declare h public.employee_holds%rowtype; a public.approval_requests%rowtype;
        approver text; eligible integer; is_eligible boolean; n integer; subj uuid;
begin
  -- Lock order = start_employee_hold: the employee (or org) row FIRST, then the hold row.
  -- (木村 10/12: hold-then-employee here vs employee-then-hold in start deadlocked a
  -- concurrent detector upgrade.) After the subject lock, re-read the hold: an upgrade
  -- that won the race has superseded it → hold_not_found, the employee stays held.
  select employee_id into subj from public.employee_holds where id = p_hold and org_id = p_org;
  if not found then raise exception 'hold_not_found'; end if;
  if subj is null then perform 1 from public.orgs where id = p_org for update;
  else perform 1 from public.employees where id = subj and org_id = p_org for update; end if;
  select * into h from public.employee_holds where id = p_hold and org_id = p_org and released_at is null and superseded_at is null for update;
  if not found then raise exception 'hold_not_found'; end if;
  if h.started_via = 'ops_console' or h.started_by like 'ops:%' then raise exception 'ops_hold_ops_only'; end if;
  if h.release_approval_id is null or h.release_requested_by is null then raise exception 'release_not_requested'; end if;
  select * into a from public.approval_requests where id = h.release_approval_id and org_id = p_org for update;
  if not found or coalesce(a.metadata->>'adminTool', a.tool, '') <> 'employee.hold.release'
     or a.metadata->>'holdId' is distinct from p_hold::text
     or a.metadata->>'requestedBy' is distinct from h.release_requested_by then
    raise exception 'release_ticket_invalid';
  end if;
  if a.status <> 'approved' or a.resolved_by is null then raise exception 'release_not_approved'; end if;
  approver := 'member:' || a.resolved_by::text;
  -- Approver: an ACTIVE owner or designated admin of THIS org.
  select exists (
    select 1 from public.org_members m join public.orgs o on o.id = m.org_id
     where m.id = a.resolved_by and m.org_id = p_org and m.status = 'active'
       and (m.role = 'owner' or m.id = any(o.designated_admin_member_ids))) into is_eligible;
  if not is_eligible then raise exception 'release_approver_not_allowed'; end if;
  -- the requester must still be an active member of this org at release time
  if not exists (select 1 from public.org_members m
                  where m.id = substr(h.release_requested_by, 8)::uuid and m.org_id = p_org and m.status = 'active') then
    raise exception 'release_requester_invalid';
  end if;
  if approver = h.release_requested_by then
    -- Single-owner exception (decision 2): only with exactly one eligible approver.
    select count(*) into eligible from public.org_members m join public.orgs o on o.id = m.org_id
     where m.org_id = p_org and m.status = 'active'
       and (m.role = 'owner' or m.id = any(o.designated_admin_member_ids));
    -- 木村 10/12 (4): never for anomaly-triggered or quarantined holds (decoy-key design).
    if h.kind = 'quarantined' or h.started_via = 'anomaly' or h.trigger is not null then
      raise exception 'release_approver_not_allowed';
    end if;
    if eligible <> 1 or coalesce(a.metadata->>'singleOwnerSelfRelease', '') <> 'true'
       or char_length(btrim(coalesce(h.release_reason, ''))) = 0 then
      raise exception 'release_approver_not_allowed';
    end if;
  end if;
  -- Audit first, same transaction: if it fails, nothing below happens.
  insert into public.audit_events(org_id, employee_id, action, summary, metadata)
  values (p_org, h.employee_id, 'employee.hold.released',
          left(coalesce(nullif(btrim(p_audit_summary), ''), 'employee hold released'), 500),
          coalesce(p_audit_metadata, '{}'::jsonb) || jsonb_build_object(
            'auditClass', 'admin', 'holdId', h.id, 'approvalId', a.id, 'kind', h.kind,
            'requestedBy', h.release_requested_by, 'releasedBy', approver,
            'singleOwnerSelfRelease', approver = h.release_requested_by));
  perform set_config('staffpass.hold_write', 'on', true);
  update public.employee_holds set released_by = approver, released_at = coalesce(p_at, now()) where id = h.id;
  if h.employee_id is null then
    update public.orgs set hold_state = null, hold_id = null where id = p_org and hold_id = h.id;
  else
    update public.employees set hold_state = null, hold_id = null where id = h.employee_id and org_id = p_org and hold_id = h.id;
  end if;
  perform set_config('staffpass.hold_write', '', true);
  update public.approval_requests
     set metadata = metadata || jsonb_build_object('holdOutcome', 'closed_by_hold', 'holdReleasedAt', coalesce(p_at, now()))
   where org_id = p_org and metadata->>'heldByHoldId' = h.id::text;
  get diagnostics n = row_count;
  return jsonb_build_object('released', true, 'holdId', h.id, 'closedTickets', n);
end $rlh$;

revoke all on function public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.release_employee_hold(uuid, uuid, text, jsonb, timestamptz) to service_role;

commit;
