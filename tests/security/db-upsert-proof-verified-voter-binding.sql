-- upsert_proof_verified_voter_binding (migration 20261021110000).
-- EXECUTE service_role only. Concurrent / second insert cannot re-point an
-- active binding to another member (ON CONFLICT ... DO UPDATE ... WHERE).
\set ON_ERROR_STOP 1
reset role;

do $$
declare r text;
begin
  if to_regprocedure('public.upsert_proof_verified_voter_binding(uuid,text,text,text,uuid,text,timestamptz)') is null then
    raise exception 'voter binding rpc: function missing';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r, 'public.upsert_proof_verified_voter_binding(uuid,text,text,text,uuid,text,timestamptz)', 'EXECUTE') then
      raise exception 'voter binding rpc: % can execute', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.upsert_proof_verified_voter_binding(uuid,text,text,text,uuid,text,timestamptz)', 'EXECUTE') then
    raise exception 'voter binding rpc: service_role missing EXECUTE';
  end if;
end $$;

insert into public.orgs(id, name) values
  ('b0211100-0000-4000-8000-000000000001', 'upvb 1');
insert into public.org_members(id, org_id, email, role, status) values
  ('b0211100-0000-4000-8000-000000000011', 'b0211100-0000-4000-8000-000000000001', 'upvb-a@fixture.invalid', 'admin', 'active'),
  ('b0211100-0000-4000-8000-000000000012', 'b0211100-0000-4000-8000-000000000001', 'upvb-b@fixture.invalid', 'admin', 'active');

set role service_role;
do $$
declare
  first jsonb;
  second jsonb;
  member uuid;
begin
  first := public.upsert_proof_verified_voter_binding(
    'b0211100-0000-4000-8000-000000000001',
    'line',
    'chn-upvb',
    'U-upvb-1',
    'b0211100-0000-4000-8000-000000000011',
    null,
    now() + interval '180 days'
  );
  if first->>'ok' <> 'true' then
    raise exception 'voter binding rpc: first insert failed %', first;
  end if;
  second := public.upsert_proof_verified_voter_binding(
    'b0211100-0000-4000-8000-000000000001',
    'line',
    'chn-upvb',
    'U-upvb-1',
    'b0211100-0000-4000-8000-000000000012',
    null,
    now() + interval '180 days'
  );
  if second->>'ok' = 'true' or second->>'reason' is distinct from 'bound_to_other_member' then
    raise exception 'voter binding rpc: rebind must return bound_to_other_member, got %', second;
  end if;
  select member_id into member
    from public.approval_workflow_voter_bindings
   where org_id = 'b0211100-0000-4000-8000-000000000001'
     and provider = 'line'
     and channel_key = 'chn-upvb'
     and external_user_id = 'U-upvb-1';
  if member is distinct from 'b0211100-0000-4000-8000-000000000011' then
    raise exception 'voter binding rpc: member was re-pointed to %', member;
  end if;
end $$;
reset role;

set role anon;
do $$
begin
  begin
    perform public.upsert_proof_verified_voter_binding(
      'b0211100-0000-4000-8000-000000000001',
      'line', 'chn-upvb', 'U-upvb-x',
      'b0211100-0000-4000-8000-000000000011',
      null, now() + interval '1 day'
    );
  exception when insufficient_privilege then
    reset role;
    delete from public.orgs where id = 'b0211100-0000-4000-8000-000000000001';
    return;
  end;
  raise exception 'voter binding rpc: anon execute was not denied';
end $$;
