-- TOCTOU follow-up to PR-D F2 (木村 2026-10-09 23:58, item 2). Additive and
-- re-applicable; depends on 20261005500000_approver_authority.sql
-- (approval_requests.approver_authority). Apply BEFORE setting
-- APPROVER_AUTHORITY_ENABLED=true. With the flag OFF the application never
-- calls these functions (today's write path is unchanged).
--
-- F2 records the judged state's fingerprint at filing and re-checks it right
-- before fulfil. A change between that check and the write could still be
-- overwritten. These RPCs make the approval-executed write a compare-and-swap:
-- in ONE transaction they lock the row(s), compare the stored values with the
-- snapshot the application pinned (the snapshot whose fingerprint matched the
-- one recorded at filing), and write only if they are equal. Otherwise they
-- return {ok:false, reason:'approver_context_changed'} and write nothing.
--
-- 1. approver_cas_write_employee_policy (policy.patch): locks employees
--    (id, org), compares {scopes, approval_policy, action_limits,
--    tool_approval_defaults} with p_expected (jsonb equality), writes the
--    employee and its active credentials (same columns as updateEmployeePolicy).
-- 2. approver_cas_write_scheduling_policy (schedulingPolicy.patch): locks the
--    org row (and the employee row for per-employee writes), compares
--    scheduling_policy with p_expected {org[, employee]}, writes the target.
-- Both also bind the write to the ticket: approval in p_org, status
-- 'approved', same tool, same target employee, and the fingerprint recorded on
-- the ticket equals p_fingerprint (missing → approver_context_changed).
-- security invoker, pinned search_path, EXECUTE service_role only.
begin;

-- 1 ----------------------------------------------------------------------------
create or replace function public.approver_cas_write_employee_policy(
  p_org uuid, p_employee uuid, p_approval uuid, p_fingerprint text, p_expected jsonb,
  p_scopes text[], p_allowed_purposes text[], p_approval_policy text,
  p_tool_approval_defaults jsonb, p_sod_level text, p_action_limits jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  a public.approval_requests;
  e public.employees;
begin
  if p_org is null or p_employee is null or p_approval is null or coalesce(p_fingerprint, '') = ''
    or p_expected is null or jsonb_typeof(p_expected) <> 'object'
    or p_scopes is null or p_allowed_purposes is null or p_approval_policy is null or p_sod_level is null
    or p_action_limits is null or jsonb_typeof(p_action_limits) <> 'object'
    or (p_tool_approval_defaults is not null and jsonb_typeof(p_tool_approval_defaults) <> 'object') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_input');
  end if;
  select * into a from public.approval_requests where id = p_approval and org_id = p_org;
  if not found then return jsonb_build_object('ok', false, 'reason', 'approval_not_found'); end if;
  if a.status is distinct from 'approved' then return jsonb_build_object('ok', false, 'reason', 'approval_not_approved'); end if;
  if coalesce(nullif(a.metadata->>'adminTool', ''), a.tool) is distinct from 'policy.patch' then
    return jsonb_build_object('ok', false, 'reason', 'approval_tool_mismatch');
  end if;
  if lower(btrim(coalesce(a.metadata->'adminMutation'->>'employeeId', ''))) <> p_employee::text then
    return jsonb_build_object('ok', false, 'reason', 'approval_target_mismatch');
  end if;
  if coalesce(a.approver_authority->>'contextFingerprint', '') = ''
    or a.approver_authority->>'contextFingerprint' <> p_fingerprint then
    return jsonb_build_object('ok', false, 'reason', 'approver_context_changed');
  end if;

  select * into e from public.employees where id = p_employee and org_id = p_org for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'employee_not_found'); end if;
  if jsonb_build_object(
       'scopes', to_jsonb(e.scopes), 'approval_policy', to_jsonb(e.approval_policy),
       'action_limits', e.action_limits, 'tool_approval_defaults', e.tool_approval_defaults)
     is distinct from p_expected then
    return jsonb_build_object('ok', false, 'reason', 'approver_context_changed');
  end if;

  update public.employees
     set scopes = p_scopes,
         allowed_purposes = p_allowed_purposes,
         approval_policy = p_approval_policy,
         tool_approval_defaults = coalesce(p_tool_approval_defaults, tool_approval_defaults),
         sod_level = p_sod_level,
         action_limits = p_action_limits,
         updated_at = now()
   where id = p_employee and org_id = p_org
   returning * into e;
  update public.credentials
     set scopes = p_scopes,
         allowed_purposes = p_allowed_purposes,
         approval_policy = p_approval_policy,
         action_limits = p_action_limits
   where employee_id = p_employee and org_id = p_org and revoked_at is null;
  return jsonb_build_object('ok', true, 'employee', to_jsonb(e));
end $$;

revoke all on function public.approver_cas_write_employee_policy(uuid, uuid, uuid, text, jsonb, text[], text[], text, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.approver_cas_write_employee_policy(uuid, uuid, uuid, text, jsonb, text[], text[], text, jsonb, text, jsonb)
  to service_role;

-- 2 ----------------------------------------------------------------------------
create or replace function public.approver_cas_write_scheduling_policy(
  p_org uuid, p_employee uuid, p_approval uuid, p_fingerprint text, p_expected jsonb,
  p_target text, p_policy jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  a public.approval_requests;
  v_org jsonb;
  v_employee jsonb;
begin
  if p_org is null or p_approval is null or coalesce(p_fingerprint, '') = ''
    or p_expected is null or jsonb_typeof(p_expected) <> 'object' or not (p_expected ? 'org')
    or p_target is null or p_target not in ('org', 'employee')
    or (p_target = 'org' and (p_employee is not null or p_policy is null))
    or (p_target = 'employee' and (p_employee is null or not (p_expected ? 'employee')))
    or (p_policy is not null and jsonb_typeof(p_policy) <> 'object') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_input');
  end if;
  select * into a from public.approval_requests where id = p_approval and org_id = p_org;
  if not found then return jsonb_build_object('ok', false, 'reason', 'approval_not_found'); end if;
  if a.status is distinct from 'approved' then return jsonb_build_object('ok', false, 'reason', 'approval_not_approved'); end if;
  if coalesce(nullif(a.metadata->>'adminTool', ''), a.tool) is distinct from 'schedulingPolicy.patch' then
    return jsonb_build_object('ok', false, 'reason', 'approval_tool_mismatch');
  end if;
  if lower(btrim(coalesce(a.metadata->'adminMutation'->>'employeeId', ''))) <> coalesce(p_employee::text, '') then
    return jsonb_build_object('ok', false, 'reason', 'approval_target_mismatch');
  end if;
  if coalesce(a.approver_authority->>'contextFingerprint', '') = ''
    or a.approver_authority->>'contextFingerprint' <> p_fingerprint then
    return jsonb_build_object('ok', false, 'reason', 'approver_context_changed');
  end if;

  -- Lock order: org row, then employee row.
  select coalesce(o.scheduling_policy, 'null'::jsonb) into v_org from public.orgs o where o.id = p_org for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'org_not_found'); end if;
  if p_employee is not null then
    select coalesce(x.scheduling_policy, 'null'::jsonb) into v_employee
      from public.employees x where x.id = p_employee and x.org_id = p_org for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'employee_not_found'); end if;
  end if;
  if v_org is distinct from coalesce(p_expected->'org', 'null'::jsonb)
    or (p_employee is not null and v_employee is distinct from coalesce(p_expected->'employee', 'null'::jsonb)) then
    return jsonb_build_object('ok', false, 'reason', 'approver_context_changed');
  end if;

  if p_target = 'org' then
    update public.orgs set scheduling_policy = p_policy, updated_at = now() where id = p_org;
  else
    update public.employees set scheduling_policy = p_policy, updated_at = now() where id = p_employee and org_id = p_org;
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.approver_cas_write_scheduling_policy(uuid, uuid, uuid, text, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.approver_cas_write_scheduling_policy(uuid, uuid, uuid, text, jsonb, text, jsonb)
  to service_role;

commit;

-- ROLLBACK (down) — turn APPROVER_AUTHORITY_ENABLED off first (with the flag
-- ON and these functions gone, approval-executed policy.patch /
-- schedulingPolicy.patch writes fail closed: the RPC call errors and nothing
-- is written; nothing falls back to the unguarded write). Drops the two RPCs
-- only; PR-D (20261005500000) stays. Same statements as
-- supabase/verification/20261010100000_approver_context_cas_rollback.sql.
-- Run as one transaction:
--   begin;
--   drop function if exists public.approver_cas_write_employee_policy(uuid, uuid, uuid, text, jsonb, text[], text[], text, jsonb, text, jsonb);
--   drop function if exists public.approver_cas_write_scheduling_policy(uuid, uuid, uuid, text, jsonb, text, jsonb);
--   commit;
-- END ROLLBACK
