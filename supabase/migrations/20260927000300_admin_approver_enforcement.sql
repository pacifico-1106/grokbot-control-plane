-- P0 Item 1: Admin-class approvals require explicit account-approver policy
-- This migration adds per-org enforcement for admin approval routing.
--
-- ROLLOUT STEPS:
-- 1. Apply migration (enforcement OFF by default)
-- 2. Configure explicit admin routes OR verify org owners exist
-- 3. Set admin_approver_enforcement = true on org(s)
--
-- ENFORCEMENT RULES when admin_approver_enforcement = true:
-- - Admin-class tickets can only be resolved by:
--   a) Voters in explicit admin route (approval_workflow_policy.routes[class=admin])
--   b) Org owners (org_members.role = 'owner') if no explicit admin route
-- - Business-route voters cannot resolve admin-class tickets
-- - W1 path (any approver) is restricted to org owners for admin-class tickets

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Add per-org admin_approver_enforcement setting
-- ---------------------------------------------------------------------------
alter table public.orgs
  add column if not exists admin_approver_enforcement boolean not null default false;

comment on column public.orgs.admin_approver_enforcement is
  'P0 Item 1: When true, admin-class tickets can only be resolved by admin-route voters or org owners (default approvers). Requires explicit admin route OR org owners; rejects if neither exists. Turn ON after configuring approvers.';

-- ---------------------------------------------------------------------------
-- METADATA-DRIVEN classification: check metadata.approvalClass FIRST
-- Legacy fallback for pre-existing rows without approvalClass
-- ---------------------------------------------------------------------------
create or replace function public.is_admin_class_approval(
  p_purpose text,
  p_tool text,
  p_metadata jsonb
)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $f$
declare
  approval_class text;
  audit_class text;
  admin_tool text;
begin
  -- PRIMARY: Check metadata.approvalClass (metadata-driven)
  approval_class := p_metadata->>'approvalClass';
  if approval_class = 'admin' then return true; end if;
  if approval_class = 'business' then return false; end if;

  -- SECONDARY: Check metadata.auditClass (legacy)
  audit_class := p_metadata->>'auditClass';
  if audit_class = 'admin' then return true; end if;
  if audit_class = 'business' then return false; end if;

  -- Admin MCP tool marker
  if (p_metadata->>'isAdminMcpTool')::boolean = true then return true; end if;

  -- Purpose prefix
  if p_purpose like 'admin.%' then return true; end if;

  -- LEGACY FALLBACK: tool classification for pre-existing rows
  -- New tickets MUST have metadata.approvalClass set at creation
  admin_tool := coalesce(p_tool, p_metadata->>'adminTool', p_metadata->>'tool');
  if admin_tool is not null and (
    admin_tool like 'admin.%' or
    admin_tool like 'setup.%' or
    admin_tool like 'orgs.%' or
    admin_tool like 'internalAudienceRule.%' or
    admin_tool like 'approvalWorkflow.%' or
    admin_tool like 'ingressHandoff.%' or
    admin_tool like 'schedulingPolicy.%' or
    admin_tool like 'replyPolicy.%' or
    admin_tool like 'mailPolicy.%' or
    admin_tool like 'stuckWatch.%' or
    admin_tool like 'approvals.%' or
    admin_tool in ('employees.issue', 'link', 'policy.patch', 'parties.upsert',
                   'channels.classify', 'roles.propose')
  ) then
    return true;
  end if;
  
  return false;
end $f$;

comment on function public.is_admin_class_approval is
  'P0 Item 1: Check if approval is admin-class. METADATA-FIRST: checks metadata.approvalClass first, falls back to legacy tool/purpose classification for pre-existing rows.';

-- ---------------------------------------------------------------------------
-- Check if org-level policy has a valid admin route
-- ---------------------------------------------------------------------------
create or replace function public.has_valid_admin_route(p_policy jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $f$
declare
  route jsonb;
  stages jsonb;
  stage jsonb;
begin
  if p_policy is null or jsonb_typeof(p_policy->'routes') <> 'array' then
    return false;
  end if;
  
  for route in select value from jsonb_array_elements(p_policy->'routes') loop
    if route->>'class' = 'admin' then
      stages := route->'stages';
      if jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) > 0 then
        for stage in select value from jsonb_array_elements(stages) loop
          if jsonb_typeof(stage->'voterUserIds') = 'array' and 
             jsonb_array_length(stage->'voterUserIds') > 0 then
            return true;
          end if;
        end loop;
      end if;
    end if;
  end loop;
  
  return false;
end $f$;

-- ---------------------------------------------------------------------------
-- Check if voter/resolver is in admin route
-- ---------------------------------------------------------------------------
create or replace function public.is_voter_in_admin_route(p_policy jsonb, p_voter text)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $f$
declare
  route jsonb;
  stages jsonb;
  stage jsonb;
begin
  if p_policy is null or jsonb_typeof(p_policy->'routes') <> 'array' then
    return false;
  end if;
  
  for route in select value from jsonb_array_elements(p_policy->'routes') loop
    if route->>'class' = 'admin' then
      stages := route->'stages';
      if jsonb_typeof(stages) = 'array' then
        for stage in select value from jsonb_array_elements(stages) loop
          if (stage->'voterUserIds') ? p_voter then
            return true;
          end if;
        end loop;
      end if;
    end if;
  end loop;
  
  return false;
end $f$;

-- ---------------------------------------------------------------------------
-- Check if voter is ONLY in business route (cannot resolve admin tickets)
-- ---------------------------------------------------------------------------
create or replace function public.is_voter_only_in_business_route(p_policy jsonb, p_voter text)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $f$
declare
  route jsonb;
  stages jsonb;
  stage jsonb;
  in_business boolean := false;
  in_admin boolean := false;
begin
  if p_policy is null or jsonb_typeof(p_policy->'routes') <> 'array' then
    return false;
  end if;
  
  for route in select value from jsonb_array_elements(p_policy->'routes') loop
    stages := route->'stages';
    if jsonb_typeof(stages) = 'array' then
      for stage in select value from jsonb_array_elements(stages) loop
        if (stage->'voterUserIds') ? p_voter then
          if route->>'class' = 'admin' then
            in_admin := true;
          elsif route->>'class' = 'business' then
            in_business := true;
          end if;
        end if;
      end loop;
    end if;
  end loop;
  
  return in_business and not in_admin;
end $f$;

-- ---------------------------------------------------------------------------
-- Check if a member ID is an org owner
-- ---------------------------------------------------------------------------
create or replace function public.is_org_owner_member(p_org_id uuid, p_member_id text)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $f$
begin
  return exists (
    select 1 from public.org_members
    where org_id = p_org_id
      and id::text = p_member_id
      and role = 'owner'
      and status = 'active'
  );
end $f$;

-- ---------------------------------------------------------------------------
-- Check if resolver can resolve admin-class approval
-- Returns: allowed (true/false), reason (text)
-- ---------------------------------------------------------------------------
create or replace function public.can_resolve_admin_approval(
  p_org_id uuid,
  p_resolver_id text,
  p_policy jsonb
)
returns table (allowed boolean, reason text)
language plpgsql stable security invoker set search_path=pg_catalog,public as $f$
begin
  -- Check if resolver is in explicit admin route
  if public.has_valid_admin_route(p_policy) then
    if public.is_voter_in_admin_route(p_policy, p_resolver_id) then
      return query select true, 'in_admin_route';
    end if;
    -- Explicit admin route exists but resolver not in it
    if public.is_voter_only_in_business_route(p_policy, p_resolver_id) then
      return query select false, 'business_voter_on_admin_ticket';
    end if;
    return query select false, 'not_in_admin_route';
  end if;

  -- No explicit admin route - check if resolver is org owner
  if public.is_org_owner_member(p_org_id, p_resolver_id) then
    return query select true, 'org_owner_default';
  end if;

  -- Not in admin route and not org owner
  return query select false, 'non_owner_on_admin_ticket';
end $f$;

-- ---------------------------------------------------------------------------
-- Guard trigger for admin-class approval resolution
-- Only fires when admin_approver_enforcement = true on the org
--
-- SECURITY FIX: null resolved_by is ONLY allowed for:
-- - status = 'expired' (system expiration)
-- - status = 'rejected' with null resolved_by (system rejection)
-- For 'approved' status, resolved_by MUST be set to a valid member ID
-- ---------------------------------------------------------------------------
create or replace function public.guard_admin_class_approval()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $f$
declare
  org_row record;
  is_admin boolean;
  resolver_check record;
begin
  -- Only guard status changes to approved/rejected/expired
  if new.status is not distinct from old.status then return new; end if;
  if new.status not in ('approved', 'rejected', 'expired') then return new; end if;
  
  -- Get org with enforcement setting
  select o.admin_approver_enforcement, o.approval_workflow_policy
  into org_row
  from public.orgs o
  where o.id = coalesce(old.org_id, new.org_id);
  
  -- Skip if enforcement is OFF
  if not coalesce(org_row.admin_approver_enforcement, false) then
    return new;
  end if;
  
  -- Check if this is an admin-class approval
  is_admin := public.is_admin_class_approval(
    coalesce(old.purpose, new.purpose),
    coalesce(old.tool, new.tool),
    coalesce(old.metadata, new.metadata, '{}'::jsonb)
  );
  
  if not is_admin then return new; end if;
  
  -- SECURITY: For admin-class + enforcement ON + approved status:
  -- resolved_by MUST be set to a verified member ID
  if new.status = 'approved' and new.resolved_by is null then
    raise exception 'admin_approval_requires_resolver: approved admin-class tickets must have resolved_by set';
  end if;
  
  -- Allow expired status with null resolver (system expiration)
  if new.status = 'expired' then
    return new;
  end if;
  
  -- Allow rejected status with null resolver (system rejection, e.g. workflow timeout)
  if new.status = 'rejected' and new.resolved_by is null then
    return new;
  end if;

  -- Check resolver authorization for all other cases
  select * into resolver_check
  from public.can_resolve_admin_approval(
    coalesce(old.org_id, new.org_id),
    new.resolved_by::text,
    org_row.approval_workflow_policy
  );

  if not resolver_check.allowed then
    raise exception 'admin_approval_unauthorized: %', resolver_check.reason;
  end if;
  
  return new;
end $f$;

-- Create/replace trigger
drop trigger if exists guard_admin_class_approval_trigger on public.approval_requests;
create trigger guard_admin_class_approval_trigger
  before update of status on public.approval_requests
  for each row
  execute function public.guard_admin_class_approval();

-- ---------------------------------------------------------------------------
-- Integrate admin check into cast_approval_workflow_vote
-- When check_admin_enforcement = true, validates admin-class restrictions
-- ---------------------------------------------------------------------------
create or replace function public.cast_approval_workflow_vote_checked(
  p_id uuid,
  p_org uuid,
  p_voter text,
  p_vote text,
  p_actor text,
  p_actor_id text default null,
  p_agent text default null,
  p_provider text default null,
  p_channel text default null,
  p_external text default null,
  p_decision_id text default null,
  p_expected_stage text default null,
  p_check_admin_enforcement boolean default true
)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $f$
declare
  a public.approval_requests;
  org_row record;
  is_admin boolean;
  voter_check record;
begin
  -- Get the approval
  select * into a from public.approval_requests where id = p_id and org_id = p_org;
  if not found then
    raise exception 'workflow_approval_not_found';
  end if;
  
  -- Get org settings
  select o.admin_approver_enforcement, o.approval_workflow_policy
  into org_row
  from public.orgs o where o.id = p_org;
  
  -- Check admin enforcement if enabled
  if p_check_admin_enforcement and coalesce(org_row.admin_approver_enforcement, false) then
    is_admin := public.is_admin_class_approval(a.purpose, a.tool, a.metadata);
    
    if is_admin then
      select * into voter_check
      from public.can_resolve_admin_approval(p_org, p_voter, org_row.approval_workflow_policy);
      
      if not voter_check.allowed then
        return jsonb_build_object('accepted', false, 'reason', voter_check.reason);
      end if;
    end if;
  end if;
  
  -- Delegate to existing vote function
  return public.cast_approval_workflow_vote(
    p_id, p_org, p_voter, p_vote, p_actor, p_actor_id, p_agent,
    p_provider, p_channel, p_external, p_decision_id, p_expected_stage
  );
end $f$;

-- ---------------------------------------------------------------------------
-- Security definer RPC for W1 (non-workflow) admin-class approval resolution
-- Atomically checks authorization and performs the conditional update.
-- This is the ONLY path for resolving admin-class approvals with enforcement ON.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_approval_w1_checked(
  p_id uuid,
  p_org uuid,
  p_member_id uuid,
  p_decision text,  -- 'approved' or 'rejected'
  p_actor text,     -- audit actor string (e.g. 'slack:U123', 'web:user@example.com')
  p_revision_note text default null,
  p_decision_id text default null
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $f$
declare
  a public.approval_requests;
  org_row record;
  is_admin boolean;
  resolver_check record;
  now_ts timestamptz := now();
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
    'resolved_by', p_member_id
  );
end $f$;

comment on function public.resolve_approval_w1_checked is
  'P0 Item 1: Security definer RPC for W1 admin-class approval resolution. Atomically checks authorization and updates. The ONLY path for resolving admin-class tickets with enforcement ON.';

-- ---------------------------------------------------------------------------
-- Revoke public access and grant to service_role
-- ---------------------------------------------------------------------------
do $f$ declare fn record; begin
  for fn in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('is_admin_class_approval','has_valid_admin_route','is_voter_in_admin_route',
     'is_voter_only_in_business_route','is_org_owner_member','can_resolve_admin_approval',
     'guard_admin_class_approval','cast_approval_workflow_vote_checked','resolve_approval_w1_checked') loop
    execute format('revoke all on function %s from public,anon,authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $f$;

-- ---------------------------------------------------------------------------
-- Documentation
-- ---------------------------------------------------------------------------
comment on function public.has_valid_admin_route is
  'P0 Item 1: Check if org-level policy has a valid admin route with at least one stage and voter.';

comment on function public.is_org_owner_member is
  'P0 Item 1: Check if a member ID belongs to an org owner. Used as default admin approver when no explicit route.';

comment on function public.can_resolve_admin_approval is
  'P0 Item 1: Check if resolver can resolve admin-class approval. Returns (allowed, reason).';

comment on function public.guard_admin_class_approval is
  'P0 Item 1: Trigger guard for admin-class approval resolution. Only fires when org.admin_approver_enforcement = true.';

comment on function public.cast_approval_workflow_vote_checked is
  'P0 Item 1: Cast workflow vote with admin enforcement check. Use instead of cast_approval_workflow_vote when admin_approver_enforcement is enabled.';

commit;
