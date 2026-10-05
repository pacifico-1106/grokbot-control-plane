-- PR-D (木村 2026-10-05, 八坂判断済み): approver authority — who may approve
-- changes to approvers and permissions. Application side: lib/approver-authority,
-- flag APPROVER_AUTHORITY_ENABLED (default OFF).
--
-- NOT APPLIED BY THE PR. Apply BEFORE setting APPROVER_AUTHORITY_ENABLED=true
-- (with the flag ON and these columns missing, filing a target ticket fails
-- instead of silently losing its requirement; approving fails closed).
-- With the flag OFF the application never sends p_enforce_approver_authority,
-- never writes the new columns and never calls the new functions: behaviour is
-- unchanged. Re-runnable; one explicit transaction.
--
-- Adds
--   orgs.designated_admin_member_ids uuid[]   指定管理者 (org_members ids, role admin);
--                                              written only by the owner-approved
--                                              approvers.designatedAdmins.set fulfil
--   approval_requests.required_approver_kind  'owner_or_designated_admin' | 'owner' | null
--   approval_requests.approver_member_id      verified approver (org_members.id)
--   approval_requests.approver_role           'owner' | 'designated_admin'
--   approval_requests.approver_authority      jsonb: classification reasons,
--                                              designated-admin endorsements, verifiedAt
--   approver_authority_check(org, member, kind, requester_ids) jsonb outcome / reason / approver_role
--   approver_authority_requester_ids(metadata)             requester ids (adminRequester.actorId, requesterMemberId)
--   approver_authority_with_endorsement(jsonb, member, at) helper
--   record_approver_authority(id, org, member, mode)       F8 vote path ('verified' / 'endorse')
-- Replaces
--   resolve_approval_w1_checked: + p_enforce_approver_authority boolean default false.
--   The old 7-argument signature is DROPPED (two overloads would make PostgREST
--   calls ambiguous); 7 named arguments resolve to the new function with the
--   default false = exactly the previous behaviour.
-- All functions: security definer, search_path pinned, EXECUTE only for service_role.
--
-- ROLLBACK (down) — restores the 7-argument RPC and drops everything added here:
--   drop function if exists public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text,boolean);
--   drop function if exists public.record_approver_authority(uuid,uuid,uuid,text);
--   drop function if exists public.approver_authority_check(uuid,uuid,text,text[]);
--   drop function if exists public.approver_authority_requester_ids(jsonb);
--   drop function if exists public.approver_authority_with_endorsement(jsonb,uuid,timestamptz);
--   alter table public.approval_requests drop constraint if exists approval_requests_required_approver_kind_check;
--   alter table public.approval_requests drop constraint if exists approval_requests_approver_role_check;
--   alter table public.approval_requests drop column if exists approver_authority;
--   alter table public.approval_requests drop column if exists approver_role;
--   alter table public.approval_requests drop column if exists approver_member_id;
--   alter table public.approval_requests drop column if exists required_approver_kind;
--   alter table public.orgs drop column if exists designated_admin_member_ids;
--   create or replace function public.resolve_approval_w1_checked(
--     p_id uuid,
--     p_org uuid,
--     p_member_id uuid,
--     p_decision text,  -- 'approved' or 'rejected'
--     p_actor text,     -- audit actor string (e.g. 'slack:U123', 'web:user@example.com')
--     p_revision_note text default null,
--     p_decision_id text default null
--   )
--   returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $f$
--   declare
--     a public.approval_requests;
--     org_row record;
--     is_admin boolean;
--     resolver_check record;
--     now_ts timestamptz := now();
--   begin
--     -- Validate decision
--     if p_decision not in ('approved', 'rejected', 'revision_requested') then
--       return jsonb_build_object('ok', false, 'reason', 'invalid_decision');
--     end if;
--     
--     -- revision_requested requires a note
--     if p_decision = 'revision_requested' and coalesce(trim(p_revision_note), '') = '' then
--       return jsonb_build_object('ok', false, 'reason', 'revision_note_required');
--     end if;
--     
--     -- Get the approval with FOR UPDATE lock
--     select * into a from public.approval_requests
--     where id = p_id and org_id = p_org
--     for update;
--     
--     if not found then
--       return jsonb_build_object('ok', false, 'reason', 'not_found');
--     end if;
--     
--     if a.status <> 'pending' then
--       return jsonb_build_object('ok', false, 'reason', 'not_pending', 'current_status', a.status);
--     end if;
--     
--     -- Get org settings
--     select o.admin_approver_enforcement, o.approval_workflow_policy
--     into org_row
--     from public.orgs o where o.id = p_org;
--     
--     -- Check admin enforcement
--     if coalesce(org_row.admin_approver_enforcement, false) then
--       is_admin := public.is_admin_class_approval(a.purpose, a.tool, a.metadata);
--       
--       if is_admin then
--         -- For admin-class tickets with enforcement ON, member_id is REQUIRED
--         if p_member_id is null then
--           return jsonb_build_object('ok', false, 'reason', 'member_id_required_for_admin_class');
--         end if;
--         
--         -- Verify the member exists and belongs to this org
--         if not exists (
--           select 1 from public.org_members
--           where id = p_member_id and org_id = p_org and status = 'active'
--         ) then
--           return jsonb_build_object('ok', false, 'reason', 'invalid_member_for_org');
--         end if;
--         
--         -- Check resolver authorization
--         select * into resolver_check
--         from public.can_resolve_admin_approval(p_org, p_member_id::text, org_row.approval_workflow_policy);
--         
--         if not resolver_check.allowed then
--           return jsonb_build_object('ok', false, 'reason', resolver_check.reason);
--         end if;
--       end if;
--     end if;
--     
--     -- Perform the update
--     if p_decision = 'revision_requested' then
--       update public.approval_requests set
--         status = 'revision_requested',
--         resolved_at = now_ts,
--         resolved_by = p_member_id,
--         revision_note = p_revision_note,
--         revision_count = a.revision_count + 1,
--         metadata = coalesce(a.metadata, '{}'::jsonb) || 
--           jsonb_build_object('w1DecisionId', p_decision_id, 'w1Actor', p_actor)
--       where id = p_id and org_id = p_org and status = 'pending';
--     else
--       update public.approval_requests set
--         status = p_decision,
--         resolved_at = now_ts,
--         resolved_by = p_member_id,
--         metadata = coalesce(a.metadata, '{}'::jsonb) || 
--           jsonb_build_object('w1DecisionId', p_decision_id, 'w1Actor', p_actor)
--       where id = p_id and org_id = p_org and status = 'pending';
--     end if;
--     
--     if not found then
--       -- Race condition: status changed between select and update
--       return jsonb_build_object('ok', false, 'reason', 'concurrent_update');
--     end if;
--     
--     return jsonb_build_object(
--       'ok', true,
--       'approval_id', p_id,
--       'decision', p_decision,
--       'resolved_by', p_member_id
--     );
--   end $f$;
--   revoke all on function public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text) from public, anon, authenticated;
--   grant execute on function public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text) to service_role;
--   comment on function public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text) is
--     'P0 Item 1: Security definer RPC for W1 admin-class approval resolution. Atomically checks authorization and updates. The ONLY path for resolving admin-class tickets with enforcement ON.';
-- END ROLLBACK

begin;
set local lock_timeout = '5s';

alter table public.orgs
  add column if not exists designated_admin_member_ids uuid[] not null default '{}';

alter table public.approval_requests
  add column if not exists required_approver_kind text,
  add column if not exists approver_member_id uuid,
  add column if not exists approver_role text,
  add column if not exists approver_authority jsonb not null default '{}'::jsonb;

alter table public.approval_requests drop constraint if exists approval_requests_required_approver_kind_check;
alter table public.approval_requests add constraint approval_requests_required_approver_kind_check
  check (required_approver_kind is null or required_approver_kind in ('owner_or_designated_admin', 'owner'));
alter table public.approval_requests drop constraint if exists approval_requests_approver_role_check;
alter table public.approval_requests add constraint approval_requests_approver_role_check
  check (approver_role is null or approver_role in ('owner', 'designated_admin'));

comment on column public.orgs.designated_admin_member_ids is
  'PR-D: 指定管理者 (org_members.id, role admin). Besides owners, they may approve standard approver/permission changes. Changed only by an owner-approved approvers.designatedAdmins.set ticket.';
comment on column public.approval_requests.required_approver_kind is
  'PR-D: recorded at filing (APPROVER_AUTHORITY_ENABLED). owner_or_designated_admin = standard, owner = sensitive.';

-- ---------------------------------------------------------------------------
-- Decision (mirrors lib/approver-authority/decide.ts decideApproverAuthority)
-- ---------------------------------------------------------------------------
-- Requester member ids of a ticket (mirrors decide.ts requesterMemberIdsFromMetadata).
create or replace function public.approver_authority_requester_ids(p_metadata jsonb)
returns text[] language sql immutable set search_path=pg_catalog,public as $f$
  select coalesce(array_agg(distinct v), '{}'::text[]) from (
    select nullif(btrim(case when jsonb_typeof(p_metadata->'adminRequester') = 'object'
                             and jsonb_typeof(p_metadata->'adminRequester'->'actorId') = 'string'
                        then p_metadata->'adminRequester'->>'actorId' end), '') as v
    union all
    select nullif(btrim(case when jsonb_typeof(p_metadata->'requesterMemberId') = 'string'
                        then p_metadata->>'requesterMemberId' end), '')
  ) s where v is not null
$f$;

-- Multiple owners (八坂 2026-10-05 10:11 確定): any one active owner other than
-- the requester suffices; a SOLE owner may approve their own request. Only when
-- several owners exist and all are requesters can nobody approve → stop.
create or replace function public.approver_authority_check(
  p_org uuid, p_member_id uuid, p_required_kind text, p_requester_ids text[] default '{}'
)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $f$
declare
  owners integer;
  eligible_owners integer;
  eligible_designated integer;
  requesters text[] := coalesce(p_requester_ids, '{}'::text[]);
  m record;
  designated boolean;
begin
  if p_required_kind is null or p_required_kind not in ('owner_or_designated_admin', 'owner') then
    return jsonb_build_object('outcome', 'deny', 'reason', 'invalid_required_kind');
  end if;
  select count(*), count(*) filter (where not (om.id::text = any(requesters)))
    into owners, eligible_owners
  from public.org_members om
  where om.org_id = p_org and om.role = 'owner' and om.status = 'active';
  if owners < 1 then
    return jsonb_build_object('outcome', 'deny', 'reason', 'org_has_no_owner');
  end if;
  select count(*) into eligible_designated
  from public.orgs o
  join public.org_members om on om.org_id = o.id and om.id = any(o.designated_admin_member_ids)
  where o.id = p_org and om.role = 'admin' and om.status = 'active' and not (om.id::text = any(requesters));
  if owners >= 2 and eligible_owners < 1 and (p_required_kind = 'owner' or eligible_designated < 1) then
    return jsonb_build_object('outcome', 'deny', 'reason', 'no_owner_other_than_requester');
  end if;
  if p_member_id is null then
    return jsonb_build_object('outcome', 'deny', 'reason', 'approver_member_required');
  end if;
  select om.role, om.status into m from public.org_members om where om.id = p_member_id and om.org_id = p_org;
  if not found then
    return jsonb_build_object('outcome', 'deny', 'reason', 'approver_not_found');
  end if;
  if m.status is distinct from 'active' then
    return jsonb_build_object('outcome', 'deny', 'reason', 'approver_inactive');
  end if;
  if p_member_id::text = any(requesters) and not (owners = 1 and m.role = 'owner') then
    return jsonb_build_object('outcome', 'deny', 'reason', 'approver_is_requester');
  end if;
  if m.role = 'owner' then
    return jsonb_build_object('outcome', 'allow', 'approver_role', 'owner');
  end if;
  select coalesce(p_member_id = any(o.designated_admin_member_ids), false) into designated
  from public.orgs o where o.id = p_org;
  if coalesce(designated, false) and m.role = 'admin' then
    if p_required_kind = 'owner' then
      return jsonb_build_object('outcome', 'endorse', 'approver_role', 'designated_admin', 'reason', 'owner_approval_required');
    end if;
    return jsonb_build_object('outcome', 'allow', 'approver_role', 'designated_admin');
  end if;
  return jsonb_build_object('outcome', 'deny', 'reason', 'approver_not_authorized');
end $f$;

create or replace function public.approver_authority_with_endorsement(p_authority jsonb, p_member_id uuid, p_at timestamptz)
returns jsonb language sql immutable set search_path=pg_catalog,public as $f$
  select case
    when exists (
      select 1 from jsonb_array_elements(coalesce(p_authority->'endorsements', '[]'::jsonb)) e
      where e->>'memberId' = p_member_id::text
    ) then coalesce(p_authority, '{}'::jsonb)
    else coalesce(p_authority, '{}'::jsonb) || jsonb_build_object('endorsements',
      coalesce(p_authority->'endorsements', '[]'::jsonb) ||
      jsonb_build_array(jsonb_build_object('memberId', p_member_id, 'role', 'designated_admin', 'at', p_at)))
  end
$f$;

-- ---------------------------------------------------------------------------
-- F8 vote path: store the verified approver / a designated-admin endorsement
-- under a row lock, re-checking authority inside the transaction.
-- ---------------------------------------------------------------------------
create or replace function public.record_approver_authority(p_id uuid, p_org uuid, p_member_id uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $f$
declare
  a public.approval_requests;
  d jsonb;
  now_ts timestamptz := now();
begin
  if p_mode is null or p_mode not in ('verified', 'endorse') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_mode');
  end if;
  select * into a from public.approval_requests where id = p_id and org_id = p_org for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if a.required_approver_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_target');
  end if;
  d := public.approver_authority_check(p_org, p_member_id, a.required_approver_kind,
    public.approver_authority_requester_ids(a.metadata));
  if p_mode = 'verified' then
    if a.status <> 'approved' then
      return jsonb_build_object('ok', false, 'reason', 'not_approved');
    end if;
    if d->>'outcome' is distinct from 'allow' then
      return jsonb_build_object('ok', false, 'reason', coalesce(d->>'reason', 'approver_unverified'));
    end if;
    update public.approval_requests set
      approver_member_id = p_member_id,
      approver_role = d->>'approver_role',
      approver_authority = coalesce(a.approver_authority, '{}'::jsonb) ||
        jsonb_build_object('verifiedAt', now_ts, 'verifiedMemberId', p_member_id)
    where id = p_id and org_id = p_org;
    return jsonb_build_object('ok', true, 'approver_role', d->>'approver_role');
  end if;
  if a.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if d->>'outcome' is distinct from 'endorse' then
    return jsonb_build_object('ok', false, 'reason',
      case when d->>'outcome' = 'allow' then 'approver_already_sufficient' else coalesce(d->>'reason', 'approver_unverified') end);
  end if;
  update public.approval_requests set
    approver_authority = public.approver_authority_with_endorsement(a.approver_authority, p_member_id, now_ts)
  where id = p_id and org_id = p_org;
  return jsonb_build_object('ok', true, 'reason', 'owner_approval_required');
end $f$;

-- ---------------------------------------------------------------------------
-- W1 RPC: + p_enforce_approver_authority (default false = previous behaviour)
-- ---------------------------------------------------------------------------
drop function if exists public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text);

create or replace function public.resolve_approval_w1_checked(
  p_id uuid,
  p_org uuid,
  p_member_id uuid,
  p_decision text,  -- 'approved' or 'rejected'
  p_actor text,     -- audit actor string (e.g. 'slack:U123', 'web:user@example.com')
  p_revision_note text default null,
  p_decision_id text default null,
  p_enforce_approver_authority boolean default false  -- PR-D: sent only when APPROVER_AUTHORITY_ENABLED
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $f$
declare
  a public.approval_requests;
  org_row record;
  is_admin boolean;
  resolver_check record;
  now_ts timestamptz := now();
  authority jsonb := null;
begin
  -- Validate decision
  if p_decision not in ('approved', 'rejected', 'revision_requested') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_decision');
  end if;
  
  -- revision_requested requires a note
  if p_decision = 'revision_requested' and coalesce(trim(p_revision_note), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'revision_note_required');
  end if;
  
  -- Get the approval with FOR UPDATE lock
  select * into a from public.approval_requests
  where id = p_id and org_id = p_org
  for update;
  
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  
  if a.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'current_status', a.status);
  end if;
  
  -- Get org settings
  select o.admin_approver_enforcement, o.approval_workflow_policy
  into org_row
  from public.orgs o where o.id = p_org;
  
  -- Check admin enforcement
  if coalesce(org_row.admin_approver_enforcement, false) then
    is_admin := public.is_admin_class_approval(a.purpose, a.tool, a.metadata);
    
    if is_admin then
      -- For admin-class tickets with enforcement ON, member_id is REQUIRED
      if p_member_id is null then
        return jsonb_build_object('ok', false, 'reason', 'member_id_required_for_admin_class');
      end if;
      
      -- Verify the member exists and belongs to this org
      if not exists (
        select 1 from public.org_members
        where id = p_member_id and org_id = p_org and status = 'active'
      ) then
        return jsonb_build_object('ok', false, 'reason', 'invalid_member_for_org');
      end if;
      
      -- Check resolver authorization
      select * into resolver_check
      from public.can_resolve_admin_approval(p_org, p_member_id::text, org_row.approval_workflow_policy);
      
      if not resolver_check.allowed then
        return jsonb_build_object('ok', false, 'reason', resolver_check.reason);
      end if;
    end if;
  end if;
  
  -- PR-D: approver authority (owner / designated admin). Only approvals are
  -- gated; only when the caller asks (flag ON) and the ticket recorded a kind.
  if p_enforce_approver_authority and p_decision = 'approved' and a.required_approver_kind is not null then
    authority := public.approver_authority_check(p_org, p_member_id, a.required_approver_kind,
      public.approver_authority_requester_ids(a.metadata));
    if authority->>'outcome' = 'endorse' then
      -- Designated admin on an owner-required ticket: record, stay pending, apply nothing.
      update public.approval_requests set
        approver_authority = public.approver_authority_with_endorsement(a.approver_authority, p_member_id, now_ts)
      where id = p_id and org_id = p_org and status = 'pending';
      return jsonb_build_object('ok', false, 'reason', 'owner_approval_required', 'endorsed', true);
    elsif authority->>'outcome' is distinct from 'allow' then
      return jsonb_build_object('ok', false, 'reason', coalesce(authority->>'reason', 'approver_unverified'));
    end if;
  end if;

  -- Perform the update
  if p_decision = 'revision_requested' then
    update public.approval_requests set
      status = 'revision_requested',
      resolved_at = now_ts,
      resolved_by = p_member_id,
      revision_note = p_revision_note,
      revision_count = a.revision_count + 1,
      metadata = coalesce(a.metadata, '{}'::jsonb) || 
        jsonb_build_object('w1DecisionId', p_decision_id, 'w1Actor', p_actor)
    where id = p_id and org_id = p_org and status = 'pending';
  elsif authority is not null then
    -- PR-D: store the verified approver (member id + role) with the decision.
    update public.approval_requests set
      status = p_decision,
      resolved_at = now_ts,
      resolved_by = p_member_id,
      approver_member_id = p_member_id,
      approver_role = authority->>'approver_role',
      approver_authority = coalesce(a.approver_authority, '{}'::jsonb) ||
        jsonb_build_object('verifiedAt', now_ts, 'verifiedMemberId', p_member_id),
      metadata = coalesce(a.metadata, '{}'::jsonb) ||
        jsonb_build_object('w1DecisionId', p_decision_id, 'w1Actor', p_actor)
    where id = p_id and org_id = p_org and status = 'pending';
  else
    update public.approval_requests set
      status = p_decision,
      resolved_at = now_ts,
      resolved_by = p_member_id,
      metadata = coalesce(a.metadata, '{}'::jsonb) || 
        jsonb_build_object('w1DecisionId', p_decision_id, 'w1Actor', p_actor)
    where id = p_id and org_id = p_org and status = 'pending';
  end if;
  
  if not found then
    -- Race condition: status changed between select and update
    return jsonb_build_object('ok', false, 'reason', 'concurrent_update');
  end if;
  
  return jsonb_build_object(
    'ok', true,
    'approval_id', p_id,
    'decision', p_decision,
    'resolved_by', p_member_id,
    'approver_role', authority->>'approver_role'
  );
end $f$;

comment on function public.resolve_approval_w1_checked(uuid,uuid,uuid,text,text,text,text,boolean) is
  'P0 Item 1 + PR-D: Security definer RPC for W1 approval resolution. Admin-class enforcement as before; with p_enforce_approver_authority (APPROVER_AUTHORITY_ENABLED) also verifies owner / designated admin and stores approver_member_id / approver_role.';

do $f$ declare fn record; begin
  for fn in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('approver_authority_check','approver_authority_with_endorsement','approver_authority_requester_ids','record_approver_authority','resolve_approval_w1_checked') loop
    execute format('revoke all on function %s from public,anon,authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $f$;

commit;
