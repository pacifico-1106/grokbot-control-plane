-- Additive expansion. Apply before deploying the matching application.
-- No existing table grants, RLS policies, or business constraints are changed.
begin;
create table if not exists public.approval_execution_claims (
  approval_id uuid primary key references public.approval_requests(id) on delete cascade,
  org_id uuid not null references public.orgs(id),
  claim_id uuid not null,
  state text not null check (state in ('running','succeeded','failed','uncertain')),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.approval_execution_claims enable row level security;
revoke all on public.approval_execution_claims from public, anon, authenticated;
grant select, insert, update, delete on public.approval_execution_claims to service_role;

create or replace function public.claim_approval_execution(p_id uuid, p_org uuid, p_claim uuid)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; c public.approval_execution_claims;
begin
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found or a.status <> 'approved' then return jsonb_build_object('state','denied'); end if;
  select * into c from public.approval_execution_claims where approval_id=p_id for update;
  if found and c.org_id <> p_org then return jsonb_build_object('state','denied'); end if;
  if c.state in ('running','uncertain') then return jsonb_build_object('state',c.state); end if;
  if c.state = 'succeeded' or a.metadata #>> '{fulfillment,ok}' = 'true' or a.metadata #>> '{adminFulfillment,ok}' = 'true' then
    return jsonb_build_object('state','succeeded','approval',to_jsonb(a));
  end if;
  insert into public.approval_execution_claims(approval_id,org_id,claim_id,state)
    values(p_id,p_org,p_claim,'running') on conflict(approval_id) do update
    set claim_id=p_claim,state='running',claimed_at=now(),finished_at=null;
  return jsonb_build_object('state','claimed','approval',to_jsonb(a));
end $$;

create or replace function public.finish_approval_execution(p_id uuid, p_org uuid, p_claim uuid, p_state text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if p_state not in ('succeeded','failed','uncertain') then raise exception 'invalid_execution_state'; end if;
  update public.approval_execution_claims set state=p_state,finished_at=now()
    where approval_id=p_id and org_id=p_org and claim_id=p_claim and state='running';
  return found;
end $$;

-- Merge into the current row, never the caller's stale copy. The consumed flag
-- is monotonic even when an earlier worker still holds the original secret.
create or replace function public.merge_approval_metadata(p_id uuid, p_org uuid, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; m jsonb;
begin
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid_metadata_patch'; end if;
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found then return null; end if;
  m := coalesce(a.metadata,'{}'::jsonb) || (p_patch - 'adminSecretConsumed');
  if a.metadata->>'adminSecretConsumed' = 'true' then
    m := (m #- '{fulfillment,oneTimeSecret}' #- '{adminFulfillment,oneTimeSecret}') || '{"adminSecretConsumed":true}'::jsonb;
  end if;
  update public.approval_requests set metadata=m where id=p_id returning * into a;
  return to_jsonb(a);
end $$;

create or replace function public.consume_admin_approval_secret(p_id uuid, p_org uuid, p_actor uuid, p_generation integer)
returns text language plpgsql security invoker set search_path = pg_catalog, public as $$
declare a public.approval_requests; g public.org_admin_agents; r jsonb; secret text;
begin
  select * into a from public.approval_requests where id=p_id and org_id=p_org for update;
  if not found or a.status <> 'approved' or a.metadata->>'adminSecretConsumed' = 'true' then return null; end if;
  r := a.metadata->'adminRequester';
  if r->>'kind' is distinct from 'admin_agent' or r->>'actorId' is distinct from p_actor::text then return null; end if;
  select * into g from public.org_admin_agents where id=p_actor and org_id=p_org for share;
  if not found or g.status not in ('linked','unlinked') or g.credential_fingerprint is null or
     g.credential_generation <> p_generation or p_generation < 1 then return null; end if;
  if r ? 'credentialGeneration' and r->>'credentialGeneration' is distinct from p_generation::text then return null; end if;
  if coalesce(r->>'grokBotAgentId','') <> '' and r->>'grokBotAgentId' is distinct from g.grok_bot_agent_id then return null; end if;
  if coalesce(a.metadata #>> '{adminFulfillment,ok}',a.metadata #>> '{fulfillment,ok}') is distinct from 'true' then return null; end if;
  secret := coalesce(a.metadata #>> '{adminFulfillment,oneTimeSecret}',a.metadata #>> '{fulfillment,oneTimeSecret}');
  if secret is null then return null; end if;
  update public.approval_requests set metadata =
    (metadata #- '{fulfillment,oneTimeSecret}' #- '{adminFulfillment,oneTimeSecret}') || '{"adminSecretConsumed":true}'::jsonb where id=p_id;
  return secret;
end $$;

revoke all on function public.claim_approval_execution(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_approval_execution(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.merge_approval_metadata(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.consume_admin_approval_secret(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_approval_execution(uuid,uuid,uuid) to service_role;
grant execute on function public.finish_approval_execution(uuid,uuid,uuid,text) to service_role;
grant execute on function public.merge_approval_metadata(uuid,uuid,jsonb) to service_role;
grant execute on function public.consume_admin_approval_secret(uuid,uuid,uuid,integer) to service_role;
commit;
