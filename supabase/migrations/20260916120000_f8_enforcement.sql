-- Apply before the matching application. No tenant policy or binding is written.
-- Existing inconsistent rows fail validation; this migration never repairs/deletes data.
-- Production's FIXED/split constraint variant is already applied (rollout report).
-- This file aligns repository history; it does not require a production re-run.
begin;
set local lock_timeout = '5s';
alter table public.approval_requests add column if not exists workflow_initialized boolean not null default false;
alter table public.approval_workflow_ballots add column if not exists decision_id text;
create unique index if not exists workflow_ballot_decision_uidx on public.approval_workflow_ballots(instance_id,decision_id) where decision_id is not null;
-- Explicit FK parent constraints. Keep existing equivalent constraints (including
-- different names from a split/manual rollout) and any legacy indexes intact.
do $f8$ declare t text; parent regclass; begin
  foreach t in array array['org_members','approval_requests','approval_workflow_instances'] loop
    parent:=format('public.%I',t)::regclass;
    if not exists (
      select 1 from pg_constraint c
      where c.conrelid=parent and c.contype='u' and not c.condeferrable and c.convalidated
        and c.conkey=array[
          (select attnum from pg_attribute where attrelid=parent and attname='id' and not attisdropped),
          (select attnum from pg_attribute where attrelid=parent and attname='org_id' and not attisdropped)
        ]::smallint[]
    ) then
      execute format('alter table public.%I add constraint %I unique (id, org_id)',t,t||'_id_org_key');
    end if;
  end loop;
end $f8$;
do $f8$ begin
  if not exists(select 1 from pg_constraint where conname='workflow_approval_same_org' and conrelid='public.approval_workflow_instances'::regclass) then
    alter table public.approval_workflow_instances add constraint workflow_approval_same_org
      foreign key(approval_id,org_id) references public.approval_requests(id,org_id) on delete cascade not valid;
  end if;
  if not exists(select 1 from pg_constraint where conname='workflow_ballot_same_org' and conrelid='public.approval_workflow_ballots'::regclass) then
    alter table public.approval_workflow_ballots add constraint workflow_ballot_same_org
      foreign key(instance_id,org_id) references public.approval_workflow_instances(id,org_id) on delete cascade not valid;
  end if;
end $f8$;
alter table public.approval_workflow_instances validate constraint workflow_approval_same_org;
alter table public.approval_workflow_ballots validate constraint workflow_ballot_same_org;

-- Canonical voter IDs are org_members.id, never unqualified chat user IDs.
-- channel_key is the authenticated notification channel UUID, or telegram:global.
create table if not exists public.approval_workflow_voter_bindings (
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check(provider in ('slack','telegram','line')),
  channel_key text not null check(length(channel_key)>0),
  external_user_id text not null check(length(external_user_id)>0),
  member_id uuid not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  primary key(org_id,provider,channel_key,external_user_id),
  foreign key(member_id,org_id) references public.org_members(id,org_id) on delete cascade
);
alter table public.approval_workflow_voter_bindings enable row level security;
drop policy if exists workflow_instances_write_admin on public.approval_workflow_instances;
drop policy if exists workflow_ballots_write_admin on public.approval_workflow_ballots;
revoke all on public.approval_workflow_instances,public.approval_workflow_ballots,public.approval_workflow_voter_bindings from public,anon,authenticated;
grant select,insert,update,delete on public.approval_workflow_instances,public.approval_workflow_ballots,public.approval_workflow_voter_bindings to service_role;
-- A later/default/column GRANT must not reopen direct client access. Only the
-- already-trusted BYPASSRLS server role (or DB owner) can access these tables.
do $f8$ declare t text; c record; begin
  foreach t in array array['approval_workflow_instances','approval_workflow_ballots','approval_workflow_voter_bindings'] loop
    execute format('drop policy if exists workflow_server_only on public.%I',t);
    execute format('create policy workflow_server_only on public.%I as restrictive for all to public using (false) with check (false)',t);
    for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop
      execute format('revoke select (%I), insert (%I), update (%I), references (%I) on public.%I from public,anon,authenticated',
        c.column_name,c.column_name,c.column_name,c.column_name,t);
    end loop;
  end loop;
end $f8$;

create or replace function public.workflow_voter_is_current(p_org uuid,p_member text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $f8$
  select exists(select 1 from public.org_members m join auth.users u on u.id=m.user_id
    where m.id::text=p_member and m.org_id=p_org and m.status='active'
    and 'approve_actions'=any(m.capabilities) and u.deleted_at is null
    and (u.banned_until is null or u.banned_until<=now()));
$f8$;

create or replace function public.workflow_quorum_required(q jsonb,n integer)
returns integer language plpgsql immutable security invoker set search_path=pg_catalog,public as $f8$
declare r numeric; numerator numeric; denominator numeric;
begin
  if n<1 then raise exception 'workflow_invalid_policy'; end if;
  case q->>'type'
    when 'any' then r:=1;
    when 'majority' then r:=floor(n/2.0)+1;
    when 'count' then
      r:=(q->>'n')::numeric;
      if r is null or r<>trunc(r) then raise exception 'workflow_invalid_policy'; end if;
    when 'ratio' then
      numerator:=(q->>'numerator')::numeric; denominator:=(q->>'denominator')::numeric;
      if numerator is null or denominator is null or numerator<1 or denominator<1 or numerator>denominator
        or numerator<>trunc(numerator) or denominator<>trunc(denominator) then raise exception 'workflow_invalid_policy'; end if;
      r:=ceil(n*numerator/denominator);
    else raise exception 'workflow_invalid_policy';
  end case;
  if r<1 or r>n then raise exception 'workflow_invalid_policy'; end if;
  return r::integer;
end $f8$;

create or replace function public.validate_workflow_snapshot(p jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $f8$
declare s jsonb; ids text[]:='{}'; voters integer;
begin
  if p->>'version' is distinct from '1' or coalesce(p->>'policyId','')='' or jsonb_typeof(p->'stages') is distinct from 'array'
    or jsonb_array_length(p->'stages')=0 then raise exception 'workflow_invalid_policy'; end if;
  for s in select value from jsonb_array_elements(p->'stages') loop
    if coalesce(s->>'id','')='' or s->>'id'='final_go' or s->>'id'=any(ids)
      or s->>'onReject' is null or s->>'onReject' not in ('fail_closed','count_as_vote')
      or jsonb_typeof(s->'voterUserIds') is distinct from 'array' then raise exception 'workflow_invalid_policy'; end if;
    ids:=array_append(ids,s->>'id');
    voters:=jsonb_array_length(s->'voterUserIds');
    if exists(select 1 from jsonb_array_elements(s->'voterUserIds') x where jsonb_typeof(x)<>'string' or btrim(x#>>'{}')='')
      or voters<>(select count(distinct value) from jsonb_array_elements_text(s->'voterUserIds')) then raise exception 'workflow_invalid_policy'; end if;
    perform public.workflow_quorum_required(s->'quorum',voters);
  end loop;
  if p ? 'finalGoUserId' and p->'finalGoUserId'<>'null'::jsonb and
    (jsonb_typeof(p->'finalGoUserId')<>'string' or btrim(p->>'finalGoUserId')='') then raise exception 'workflow_invalid_policy'; end if;
  if p ? 'match' and p->'match'<>'null'::jsonb then
    if jsonb_typeof(p->'match')<>'object' then raise exception 'workflow_invalid_policy'; end if;
    for s in select value from jsonb_each(p->'match') where key in ('tools','purposes') loop
      if jsonb_typeof(s)<>'array' or exists(select 1 from jsonb_array_elements(s) x where jsonb_typeof(x)<>'string') then
        raise exception 'workflow_invalid_policy'; end if;
    end loop;
  end if;
end $f8$;

create or replace function public.initialize_approval_workflow(p_id uuid,p_org uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $f8$
declare a public.approval_requests; w public.approval_workflow_instances; p jsonb; ep jsonb; s jsonb; idx integer;
begin
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then raise exception 'workflow_approval_not_found'; end if;
  select * into w from public.approval_workflow_instances where approval_id=p_id and org_id=p_org;
  if found then
    perform public.validate_workflow_snapshot(w.policy_snapshot);
    if not a.workflow_initialized then update public.approval_requests set workflow_initialized=true where id=p_id; end if;
    return true;
  end if;
  if a.workflow_initialized then return false; end if;
  select approval_workflow_policy into p from public.orgs where id=p_org for share;
  if not found then raise exception 'workflow_org_not_found'; end if;
  if a.employee_id is not null then
    select approval_workflow_policy into ep from public.employees where id=a.employee_id and org_id=p_org for share;
    if not found then raise exception 'workflow_employee_mismatch'; end if;
    p:=coalesce(ep,p);
  end if;
  if p is not null then
    perform public.validate_workflow_snapshot(p);
    if (jsonb_array_length(coalesce(p#>'{match,tools}','[]'))>0 and not (p#>'{match,tools}' ? coalesce(a.tool,'')))
      or (jsonb_array_length(coalesce(p#>'{match,purposes}','[]'))>0 and not (p#>'{match,purposes}' ? a.purpose)) then p:=null; end if;
  end if;
  if p is not null then
    insert into public.approval_workflow_instances(approval_id,org_id,policy_id,policy_snapshot,final_go_user_id)
      values(p_id,p_org,p->>'policyId',p,p->>'finalGoUserId') returning * into w;
    -- All ballot rows are created with the immutable snapshot in the same transaction.
    -- Only the current stage is writable through the vote RPC.
    for s,idx in select value,(ordinality-1)::integer from jsonb_array_elements(p->'stages') with ordinality loop
      insert into public.approval_workflow_ballots(instance_id,org_id,stage_id,stage_index,voter_user_id)
        select w.id,p_org,s->>'id',idx,value from jsonb_array_elements_text(s->'voterUserIds');
    end loop;
    if coalesce(w.final_go_user_id,'')<>'' then
      insert into public.approval_workflow_ballots(instance_id,org_id,stage_id,stage_index,voter_user_id,is_final_go)
        values(w.id,p_org,'final_go',-1,w.final_go_user_id,true);
    end if;
  end if;
  update public.approval_requests set workflow_initialized=true where id=p_id;
  return p is not null;
end $f8$;

create or replace function public.initialize_workflow_after_insert()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $f8$
begin perform public.initialize_approval_workflow(new.id,new.org_id); return new; end $f8$;
drop trigger if exists approval_workflow_initialize on public.approval_requests;
create trigger approval_workflow_initialize after insert on public.approval_requests
  for each row execute function public.initialize_workflow_after_insert();

create or replace function public.workflow_instance_satisfied(p_instance uuid,p_org uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $f8$
declare w public.approval_workflow_instances; s jsonb; idx integer; n integer; approvals integer;
begin
  select * into w from public.approval_workflow_instances where id=p_instance and org_id=p_org;
  if not found or w.status<>'approved' or w.final_go_pending then return false; end if;
  perform public.validate_workflow_snapshot(w.policy_snapshot);
  for s,idx in select value,(ordinality-1)::integer from jsonb_array_elements(w.policy_snapshot->'stages') with ordinality loop
    n:=jsonb_array_length(s->'voterUserIds');
    select count(*) into approvals from public.approval_workflow_ballots b
      where b.instance_id=w.id and b.org_id=p_org and b.stage_id=s->>'id' and b.stage_index=idx and not b.is_final_go
      and b.vote='approve' and s->'voterUserIds' ? b.voter_user_id and public.workflow_voter_is_current(p_org,b.voter_user_id);
    if approvals<public.workflow_quorum_required(s->'quorum',n) then return false; end if;
    if s->>'onReject'='fail_closed' and exists(select 1 from public.approval_workflow_ballots b
      where b.instance_id=w.id and b.stage_id=s->>'id' and b.vote='reject') then return false; end if;
  end loop;
  if coalesce(w.final_go_user_id,'')<>'' and not exists(select 1 from public.approval_workflow_ballots b
    where b.instance_id=w.id and b.org_id=p_org and b.is_final_go and b.voter_user_id=w.final_go_user_id
    and b.vote='approve' and public.workflow_voter_is_current(p_org,b.voter_user_id)) then return false; end if;
  return true;
end $f8$;

create or replace function public.approval_workflow_can_execute(p_id uuid,p_org uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public as $f8$
declare w public.approval_workflow_instances;
begin
  if not public.initialize_approval_workflow(p_id,p_org) then return true; end if;
  select * into w from public.approval_workflow_instances where approval_id=p_id and org_id=p_org;
  return public.workflow_instance_satisfied(w.id,p_org);
end $f8$;

-- Defense at the existing #80 claim boundary without changing its lease/secret contract.
create or replace function public.guard_workflow_execution_claim()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $f8$
begin
  if new.state='running' and not public.approval_workflow_can_execute(new.approval_id,new.org_id) then
    raise exception 'workflow_not_approved'; end if;
  return new;
end $f8$;
drop trigger if exists workflow_execution_claim_guard on public.approval_execution_claims;
create trigger workflow_execution_claim_guard before insert or update on public.approval_execution_claims
  for each row execute function public.guard_workflow_execution_claim();

create or replace function public.cast_approval_workflow_vote(
  p_id uuid,p_org uuid,p_voter text,p_vote text,p_actor text,p_actor_id text default null,p_agent text default null,
  p_provider text default null,p_channel text default null,p_external text default null,
  p_decision_id text default null,p_expected_stage text default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $f8$
declare a public.approval_requests; w public.approval_workflow_instances; s jsonb; b public.approval_workflow_ballots;
  stage text; approvals integer; rejects integer; next_status text; accepted boolean:=false; recovered boolean:=false;
begin
  if p_vote not in ('approve','reject') or p_vote is null then raise exception 'workflow_invalid_vote'; end if;
  -- Always lock approval then instance: same order as initialize/claim/recovery.
  if not public.initialize_approval_workflow(p_id,p_org) then raise exception 'workflow_required'; end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  select * into w from public.approval_workflow_instances where approval_id=p_id and org_id=p_org for update;
  if a.status<>'pending' then return jsonb_build_object('accepted',false,'reason','approval_not_pending'); end if;
  if p_provider is not null then
    if coalesce(p_decision_id,'')='' then return jsonb_build_object('accepted',false,'reason','workflow_event_id_required'); end if;
    select member_id::text into p_voter from public.approval_workflow_voter_bindings
      where org_id=p_org and provider=p_provider and channel_key=p_channel and external_user_id=p_external
      and revoked_at is null and (expires_at is null or expires_at>now()) for share;
    if not found then return jsonb_build_object('accepted',false,'reason','voter_binding_required'); end if;
  end if;
  if not public.workflow_voter_is_current(p_org,p_voter) then return jsonb_build_object('accepted',false,'reason','voter_not_authorized'); end if;
  if a.metadata#>>'{adminRequester,kind}'='admin_agent' and (
      nullif(a.metadata#>>'{adminRequester,actorId}','') in (p_voter,p_actor_id,p_actor)
      or nullif(a.metadata#>>'{adminRequester,grokBotAgentId}','')=nullif(p_agent,'')) then raise exception 'self_approval_denied'; end if;
  if w.status in ('approved','rejected') then
    -- Recover the old implementation's terminal-instance/pending-approval gap.
    -- Only a current member with an already recorded vote can retry finalization.
    if not exists(select 1 from public.approval_workflow_ballots where instance_id=w.id and voter_user_id=p_voter and vote is not null)
      then return jsonb_build_object('accepted',false,'reason','not_a_recorded_voter'); end if;
    if w.status='approved' and not public.workflow_instance_satisfied(w.id,p_org) then
      return jsonb_build_object('accepted',false,'reason','workflow_authority_revoked'); end if;
    recovered:=true;
  elsif w.status='active' then
    stage:=case when w.final_go_pending then 'final_go' else w.policy_snapshot->'stages'->w.current_stage_index->>'id' end;
    if p_expected_stage is not null and stage is distinct from p_expected_stage then return jsonb_build_object('accepted',false,'reason','workflow_stage_changed'); end if;
    if p_decision_id is not null and exists(select 1 from public.approval_workflow_ballots where instance_id=w.id and decision_id=p_decision_id) then
      return jsonb_build_object('accepted',false,'reason','duplicate_decision'); end if;
    update public.approval_workflow_ballots set vote=p_vote,voted_at=now(),decision_id=p_decision_id
      where instance_id=w.id and org_id=p_org and stage_id=stage and voter_user_id=p_voter and vote is null
      returning * into b;
    if not found then return jsonb_build_object('accepted',false,'reason','not_in_stage_or_already_voted'); end if;
    accepted:=true;
    if w.final_go_pending then
      next_status:=case when p_vote='approve' then 'approved' else 'rejected' end;
      update public.approval_workflow_instances set status=next_status,final_go_pending=false,updated_at=now() where id=w.id;
    else
      s:=w.policy_snapshot->'stages'->w.current_stage_index;
      select count(*) filter(where vote='approve' and public.workflow_voter_is_current(p_org,voter_user_id)),
        count(*) filter(where vote='reject') into approvals,rejects from public.approval_workflow_ballots
        where instance_id=w.id and org_id=p_org and stage_id=stage and stage_index=w.current_stage_index and not is_final_go;
      if rejects>0 and s->>'onReject'='fail_closed' then
        update public.approval_workflow_instances set status='rejected',updated_at=now() where id=w.id;
      elsif approvals>=public.workflow_quorum_required(s->'quorum',jsonb_array_length(s->'voterUserIds')) then
        if w.current_stage_index+1<jsonb_array_length(w.policy_snapshot->'stages') then
          update public.approval_workflow_instances set current_stage_index=current_stage_index+1,updated_at=now() where id=w.id;
        elsif coalesce(w.final_go_user_id,'')<>'' then
          update public.approval_workflow_instances set final_go_pending=true,updated_at=now() where id=w.id;
        else update public.approval_workflow_instances set status='approved',updated_at=now() where id=w.id;
        end if;
      end if;
    end if;
  else return jsonb_build_object('accepted',false,'reason','workflow_not_active'); end if;
  select * into w from public.approval_workflow_instances where id=w.id;
  if w.status in ('approved','rejected') then
    if w.status='approved' and not public.workflow_instance_satisfied(w.id,p_org) then raise exception 'workflow_authority_revoked'; end if;
    update public.approval_requests set status=w.status,resolved_at=now(),resolved_by=null where id=p_id and org_id=p_org and status='pending'
      returning * into a;
    if not found then raise exception 'workflow_resolve_failed'; end if;
  end if;
  insert into public.audit_events(org_id,employee_id,credential_id,action,purpose,summary,metadata)
    values(p_org,a.employee_id,a.credential_id,'approval.resolved',a.purpose,'Workflow vote',
      jsonb_build_object('approvalId',p_id,'instanceId',w.id,'voterMemberId',p_voter,'actor',p_actor,'vote',p_vote,'recovered',recovered));
  return jsonb_build_object('accepted',accepted or recovered,'reason',case when recovered then 'recovered' else 'voted' end,
    'approval',to_jsonb(a),'instance',to_jsonb(w));
end $f8$;

-- Prevent a legacy resolver/direct table writer from skipping a configured workflow.
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
drop trigger if exists workflow_approval_status_guard on public.approval_requests;
create trigger workflow_approval_status_guard before update of status on public.approval_requests
  for each row execute function public.guard_workflow_approval_status();

-- Policies and initialization markers are service-managed; table-level grants on
-- orgs/employees/approval_requests must not allow authenticated callers to forge them.
create or replace function public.guard_workflow_service_fields()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $f8$
begin
  if tg_table_name='approval_requests' and tg_op='INSERT' then
    new.workflow_initialized:=false; return new;
  end if;
  if tg_table_name='approval_requests' then
    if old.workflow_initialized and (new.org_id is distinct from old.org_id or new.employee_id is distinct from old.employee_id
      or new.tool is distinct from old.tool or new.purpose is distinct from old.purpose) then
      raise exception 'approval_target_immutable';
    end if;
  end if;
  if not exists(select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    if tg_table_name='approval_requests' then
      if new.workflow_initialized is distinct from old.workflow_initialized then raise insufficient_privilege; end if;
    elsif tg_op='INSERT' then
      if new.approval_workflow_policy is not null then raise insufficient_privilege; end if;
    elsif new.approval_workflow_policy is distinct from old.approval_workflow_policy then raise insufficient_privilege;
    end if;
  end if;
  return new;
end $f8$;
drop trigger if exists workflow_policy_service_only on public.orgs;
create trigger workflow_policy_service_only before insert or update of approval_workflow_policy on public.orgs
  for each row execute function public.guard_workflow_service_fields();
drop trigger if exists workflow_policy_service_only on public.employees;
create trigger workflow_policy_service_only before insert or update of approval_workflow_policy on public.employees
  for each row execute function public.guard_workflow_service_fields();
drop trigger if exists workflow_marker_service_only on public.approval_requests;
create trigger workflow_marker_service_only before insert or update of workflow_initialized,org_id,employee_id,tool,purpose on public.approval_requests
  for each row execute function public.guard_workflow_service_fields();

-- Function creation defaults must not expose any new RPC, including internal helpers.
do $f8$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('workflow_voter_is_current','workflow_quorum_required','validate_workflow_snapshot','initialize_approval_workflow',
     'initialize_workflow_after_insert','workflow_instance_satisfied','approval_workflow_can_execute','guard_workflow_execution_claim',
     'cast_approval_workflow_vote','guard_workflow_approval_status','guard_workflow_service_fields') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $f8$;
commit;
