-- P0 Item 1: Admin-class approvals require explicit account-approver policy
-- This migration is NOT applied to production. Rollout steps:
-- 1. Deploy code with ADMIN_APPROVER_POLICY_REQUIRED=false (default)
-- 2. Apply migration to staging/test
-- 3. Verify tests pass
-- 4. Apply migration to production
-- 5. Enable flag gradually: ADMIN_APPROVER_POLICY_REQUIRED=true
--
-- Feature flag: ADMIN_APPROVER_POLICY_REQUIRED (env var)
-- When flag is OFF (default), these functions return permissive results.

begin;
set local lock_timeout = '5s';

-- Check if an approval is admin-class by purpose/tool/metadata
create or replace function public.is_admin_class_approval(p_purpose text, p_tool text, p_metadata jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $f$
declare
  audit_class text;
  admin_tool text;
begin
  -- Check metadata.auditClass
  audit_class := p_metadata->>'auditClass';
  if audit_class = 'admin' then return true; end if;
  
  -- Check always_human + adminTool
  if (p_metadata->>'always_human')::boolean = true and p_metadata ? 'adminTool' then
    return true;
  end if;
  
  -- Check purpose prefix
  if p_purpose like 'admin.%' then return true; end if;
  
  -- Check tool prefixes (admin tools by class, not name enumeration)
  admin_tool := coalesce(p_tool, p_metadata->>'adminTool', p_metadata->>'tool');
  if admin_tool is not null and (
    admin_tool like 'admin.%' or
    admin_tool like 'setup.%' or
    admin_tool like 'orgs.%' or
    admin_tool like 'billing.%' or
    admin_tool like 'portal.%' or
    admin_tool like 'externalContractCard.%' or
    admin_tool like 'internalAudienceRule.%' or
    admin_tool like 'approvalWorkflow.%' or
    admin_tool in ('employees.issue', 'link', 'policy.patch', 'parties.upsert',
                   'channels.classify', 'roles.propose', 'ingressHandoff.patch',
                   'schedulingPolicy.patch', 'replyPolicy.patch', 'mailPolicy.patch',
                   'stuckWatch.patch')
  ) then
    return true;
  end if;
  
  return false;
end $f$;

-- Check if org-level policy has a valid admin route
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

-- Check if voter is in admin route (not business route) for admin-class tickets
create or replace function public.is_voter_in_admin_route(p_policy jsonb, p_voter text)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $f$
declare
  route jsonb;
  stages jsonb;
  stage jsonb;
begin
  if p_policy is null or jsonb_typeof(p_policy->'routes') <> 'array' then
    -- No routes defined, fall back to stages
    return true;
  end if;
  
  -- Check if voter is in admin route
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

-- Check if voter is ONLY in business route (cannot vote on admin tickets)
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

-- Guard function for admin-class approvals
-- Only enforced when ADMIN_APPROVER_POLICY_REQUIRED env var is set
create or replace function public.guard_admin_class_approval()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $f$
declare
  org_policy jsonb;
  is_admin boolean;
begin
  -- Only guard status changes to approved
  if new.status is not distinct from old.status then return new; end if;
  if new.status <> 'approved' then return new; end if;
  
  -- Check if this is an admin-class approval
  is_admin := public.is_admin_class_approval(
    coalesce(old.purpose, new.purpose),
    coalesce(old.tool, new.tool),
    coalesce(old.metadata, new.metadata, '{}'::jsonb)
  );
  
  if not is_admin then return new; end if;
  
  -- Get org policy
  select approval_workflow_policy into org_policy
  from public.orgs where id = coalesce(old.org_id, new.org_id);
  
  -- Check for valid admin route
  -- Note: The actual flag check happens in app layer; this is a defense-in-depth guard
  -- that only enforces when routes are defined but admin route is missing
  if org_policy is not null and 
     jsonb_typeof(org_policy->'routes') = 'array' and
     jsonb_array_length(org_policy->'routes') > 0 and
     not public.has_valid_admin_route(org_policy) then
    raise exception 'admin_policy_required: admin-class approval requires org-level admin route policy';
  end if;
  
  return new;
end $f$;

-- Create trigger for admin-class approval guard
drop trigger if exists guard_admin_class_approval_trigger on public.approval_requests;
create trigger guard_admin_class_approval_trigger
  before update of status on public.approval_requests
  for each row
  execute function public.guard_admin_class_approval();

-- Update cast_approval_workflow_vote to check admin class voter restrictions
-- This extends the existing function with admin-class voter checks
create or replace function public.cast_approval_workflow_vote_with_admin_check(
  p_id uuid, p_org uuid, p_voter text, p_vote text, p_actor text,
  p_actor_id text default null, p_agent text default null,
  p_provider text default null, p_channel text default null, p_external text default null,
  p_decision_id text default null, p_expected_stage text default null,
  p_check_admin_class boolean default false
)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $f$
declare
  a public.approval_requests;
  org_policy jsonb;
  is_admin boolean;
begin
  -- Get the approval first to check admin class
  select * into a from public.approval_requests where id = p_id and org_id = p_org;
  if not found then
    raise exception 'workflow_approval_not_found';
  end if;
  
  -- Check admin class restrictions if flag is on
  if p_check_admin_class then
    is_admin := public.is_admin_class_approval(a.purpose, a.tool, a.metadata);
    
    if is_admin then
      -- Get org policy
      select approval_workflow_policy into org_policy
      from public.orgs where id = p_org;
      
      -- Check if voter is only in business route (cannot vote on admin tickets)
      if public.is_voter_only_in_business_route(org_policy, p_voter) then
        return jsonb_build_object('accepted', false, 'reason', 'business_voter_on_admin_ticket');
      end if;
      
      -- Check if admin route exists and voter is not in it
      if org_policy is not null and 
         jsonb_typeof(org_policy->'routes') = 'array' and
         jsonb_array_length(org_policy->'routes') > 0 and
         public.has_valid_admin_route(org_policy) and
         not public.is_voter_in_admin_route(org_policy, p_voter) then
        return jsonb_build_object('accepted', false, 'reason', 'not_in_admin_route');
      end if;
    end if;
  end if;
  
  -- Delegate to existing vote function
  return public.cast_approval_workflow_vote(
    p_id, p_org, p_voter, p_vote, p_actor, p_actor_id, p_agent,
    p_provider, p_channel, p_external, p_decision_id, p_expected_stage
  );
end $f$;

-- Revoke public access to new functions
do $f$ declare fn record; begin
  for fn in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname in
    ('is_admin_class_approval','has_valid_admin_route','is_voter_in_admin_route',
     'is_voter_only_in_business_route','guard_admin_class_approval',
     'cast_approval_workflow_vote_with_admin_check') loop
    execute format('revoke all on function %s from public,anon,authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
  end loop;
end $f$;

-- Add comment for documentation
comment on function public.is_admin_class_approval is 
'P0 Item 1: Check if approval is admin-class by purpose/tool/metadata. Admin-class tickets require org-level admin route policy when ADMIN_APPROVER_POLICY_REQUIRED flag is enabled.';

comment on function public.has_valid_admin_route is
'P0 Item 1: Check if org-level policy has a valid admin route with at least one stage and voter.';

comment on function public.guard_admin_class_approval is
'P0 Item 1: Defense-in-depth guard preventing direct W1 resolve of admin-class tickets when routes are defined but admin route is missing.';

commit;
