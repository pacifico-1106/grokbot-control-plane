-- Duplicate-reply prevention (migration 20261004700000). Synthetic fixtures only;
-- runs inside scripts/test-db-local.py's disposable cluster after db-workflow.sql.
\set ON_ERROR_STOP 1
reset role;
insert into public.orgs(id,name) values
 ('80000000-0000-4000-8000-0000000000a1','dedup-fixture-a'),
 ('80000000-0000-4000-8000-0000000000a2','dedup-fixture-b');
insert into public.employees(id,org_id,display_name,role_label) values
 ('81000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-0000000000a1','Dedup A1','fixture'),
 ('81000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-0000000000a1','Dedup A2','fixture'),
 ('81000000-0000-4000-8000-000000000003','80000000-0000-4000-8000-0000000000a2','Dedup B1','fixture');
insert into public.approval_requests(id,org_id,employee_id,purpose,summary,risk,status,tool,created_at) values
 ('82000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-0000000000a1','81000000-0000-4000-8000-000000000001','comm.internal','dedup fixture','high','approved','comm.send', now() - interval '20 minutes'),
 ('82000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-0000000000a1','81000000-0000-4000-8000-000000000001','comm.internal','dedup fixture','high','pending','comm.send', now()),
 ('82000000-0000-4000-8000-000000000003','80000000-0000-4000-8000-0000000000a1','81000000-0000-4000-8000-000000000001','comm.internal','dedup fixture','high','pending','comm.send', now());

-- (1) status constraint: superseded allowed, unknown status still rejected.
update public.approval_requests set status='superseded' where id='82000000-0000-4000-8000-000000000003';
select security_test.check_true((select status from public.approval_requests where id='82000000-0000-4000-8000-000000000003')='superseded');
select security_test.fails($q$update public.approval_requests set status='bogus' where id='82000000-0000-4000-8000-000000000002'$q$,'approval_requests_status_check');

-- (2) status guard: closing a ticket that has a workflow instance is allowed
-- (superseded / expired), approving it outside the workflow is still refused.
-- The workflow fixture org from db-workflow.sql has a policy: a new ticket gets an instance.
insert into public.approval_requests(id,org_id,purpose,summary,risk,status,tool)
values ('82000000-0000-4000-8000-0000000000f1','10000000-0000-4000-8000-000000000001','comm.internal','dedup workflow fixture','high','pending','comm.send');
do $$
declare wid uuid := '82000000-0000-4000-8000-0000000000f1';
begin
  if not exists (select 1 from public.approval_workflow_instances w where w.approval_id=wid) then
    raise exception 'fixture: workflow instance was not created';
  end if;
  begin
    update public.approval_requests set status='approved' where id=wid;
    raise exception 'guard allowed approving outside the workflow';
  exception when others then
    if position('workflow_resolution_required' in sqlerrm)=0 then raise; end if;
  end;
  update public.approval_requests set status='superseded' where id=wid;
  if (select status from public.approval_requests where id=wid) <> 'superseded' then raise exception 'close failed'; end if;
  update public.approval_requests set status='expired' where id=wid;  -- rollback mapping path
  if (select status from public.approval_requests where id=wid) <> 'expired' then raise exception 'superseded→expired failed'; end if;
end $$;

-- (3) ACL: anon / authenticated cannot read / write the ledger or call the RPCs.
set role anon;
select security_test.denied($c$select * from public.comm_reply_send_fingerprints$c$);
select security_test.denied($c$select public.claim_comm_reply_send(gen_random_uuid(),gen_random_uuid(),repeat('a',64),repeat('1',64),null,'comm.reply',null,1800,0.6,172800)$c$);
select security_test.denied($c$select public.finish_comm_reply_send(gen_random_uuid(),gen_random_uuid(),'sent')$c$);
reset role;
set role authenticated;
select security_test.denied($c$select * from public.comm_reply_send_fingerprints$c$);
select security_test.denied($c$insert into public.comm_reply_send_fingerprints(org_id,employee_id,conversation_key,body_hash,tool) values ('80000000-0000-4000-8000-0000000000a1','81000000-0000-4000-8000-000000000001',repeat('a',64),repeat('1',64),'comm.reply')$c$);
select security_test.denied($c$select public.claim_comm_reply_send(gen_random_uuid(),gen_random_uuid(),repeat('a',64),repeat('1',64),null,'comm.reply',null,1800,0.6,172800)$c$);
select security_test.denied($c$select public.finish_comm_reply_send(gen_random_uuid(),gen_random_uuid(),'sent')$c$);
reset role;

-- (4) claim semantics as service_role.
create or replace function security_test.claim(emp text, org text, conv text, body text, sk integer[], appr text, sim double precision)
returns jsonb language sql security invoker as $$
  select public.claim_comm_reply_send(org::uuid, emp::uuid, conv, body, sk, 'comm.reply', appr::uuid, 1800, sim, 172800)
$$;
grant execute on function security_test.claim(text, text, text, text, integer[], text, double precision) to service_role;
set role service_role;
do $$
declare
  org_a text := '80000000-0000-4000-8000-0000000000a1';
  org_b text := '80000000-0000-4000-8000-0000000000a2';
  e1 text := '81000000-0000-4000-8000-000000000001';
  e2 text := '81000000-0000-4000-8000-000000000002';
  e3 text := '81000000-0000-4000-8000-000000000003';
  conv text := repeat('a',64);
  sk integer[] := array_fill(7, array[128]);
  sk_close integer[];
  sk_far integer[];
  r jsonb;
  id1 uuid;
begin
  sk_close := sk; for i in 1..30 loop sk_close[i] := 1000 + i; end loop;   -- 98/128 ≈ 0.77
  sk_far := sk;   for i in 1..100 loop sk_far[i] := 2000 + i; end loop;    -- 28/128 ≈ 0.22

  r := security_test.claim(e1, org_a, conv, repeat('1',64), sk, null, 0.6);
  if r->>'state' <> 'claimed' then raise exception 'first claim: %', r; end if;
  id1 := (r->>'id')::uuid;
  -- a reserved (in-flight) claim already blocks the same body
  r := security_test.claim(e1, org_a, conv, repeat('1',64), sk, null, 0.6);
  if r->>'state' <> 'duplicate' or r->>'match' <> 'exact' then raise exception 'exact: %', r; end if;
  if not public.finish_comm_reply_send(id1, org_a::uuid, 'sent') then raise exception 'finish sent'; end if;
  -- similar
  r := security_test.claim(e1, org_a, conv, repeat('2',64), sk_close, null, 0.6);
  if r->>'state' <> 'duplicate' or r->>'match' <> 'similar' then raise exception 'similar: %', r; end if;
  -- exact mode (threshold null) lets the re-written body through; far body too
  r := security_test.claim(e1, org_a, conv, repeat('3',64), sk_far, null, 0.6);
  if r->>'state' <> 'claimed' then raise exception 'far: %', r; end if;
  perform public.finish_comm_reply_send((r->>'id')::uuid, org_a::uuid, 'failed');
  if exists (select 1 from public.comm_reply_send_fingerprints where id=(r->>'id')::uuid) then raise exception 'failed did not release'; end if;
  r := security_test.claim(e1, org_a, conv, repeat('2',64), sk_close, null, null);
  if r->>'state' <> 'claimed' then raise exception 'exact mode: %', r; end if;
  perform public.finish_comm_reply_send((r->>'id')::uuid, org_a::uuid, 'uncertain');
  -- isolation: other employee, other conversation
  r := security_test.claim(e2, org_a, conv, repeat('1',64), sk, null, 0.6);
  if r->>'state' <> 'claimed' then raise exception 'other employee: %', r; end if;
  r := security_test.claim(e1, org_a, repeat('b',64), repeat('1',64), sk, null, 0.6);
  if r->>'state' <> 'claimed' then raise exception 'other conversation: %', r; end if;
  -- cross-tenant: employee of org B used with org A → denied; org B own scope is separate
  r := security_test.claim(e3, org_a, conv, repeat('1',64), sk, null, 0.6);
  if r->>'state' <> 'denied' then raise exception 'cross-org employee: %', r; end if;
  r := security_test.claim(e3, org_b, conv, repeat('1',64), sk, null, 0.6);
  if r->>'state' <> 'claimed' then raise exception 'org B scope: %', r; end if;
  -- approval of another org / employee → denied
  r := security_test.claim(e3, org_b, conv, repeat('4',64), sk_far, '82000000-0000-4000-8000-000000000001', 0.6);
  if r->>'state' <> 'denied' then raise exception 'cross-org approval: %', r; end if;
  r := security_test.claim(e2, org_a, conv, repeat('4',64), sk_far, '82000000-0000-4000-8000-000000000001', 0.6);
  if r->>'state' <> 'denied' then raise exception 'other employee approval: %', r; end if;
  -- approval created 20 min ago; replies were sent since → superseded
  r := security_test.claim(e1, org_a, conv, repeat('5',64), null, '82000000-0000-4000-8000-000000000001', 0.6);
  if r->>'state' <> 'superseded' then raise exception 'superseded: %', r; end if;
  -- an approval created now (no later reply) and a new body → claimed
  r := security_test.claim(e1, org_a, repeat('c',64), repeat('6',64), null, '82000000-0000-4000-8000-000000000002', 0.6);
  if r->>'state' <> 'claimed' then raise exception 'fresh approval: %', r; end if;
  -- invalid input → denied (no exception, nothing written)
  r := public.claim_comm_reply_send(org_a::uuid, e1::uuid, 'not-hex', repeat('1',64), null, 'comm.reply', null, 1800, 0.6, 172800);
  if r->>'state' <> 'denied' then raise exception 'invalid key: %', r; end if;
  r := public.claim_comm_reply_send(org_a::uuid, e1::uuid, conv, repeat('1',64), null, 'mail.send', null, 1800, 0.6, 172800);
  if r->>'state' <> 'denied' then raise exception 'invalid tool: %', r; end if;
  r := public.claim_comm_reply_send(org_a::uuid, e1::uuid, conv, repeat('7',64), null, 'comm.reply', null, 1800, 0.1, 172800);
  if r->>'state' <> 'denied' then raise exception 'similarity floor: %', r; end if;
  -- finish is org-scoped
  if public.finish_comm_reply_send(id1, org_b::uuid, 'failed') then raise exception 'cross-org finish'; end if;
end $$;
reset role;

-- (5) the ledger holds no text column besides hashes / tool / state.
select security_test.check_true(not exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='comm_reply_send_fingerprints'
    and data_type='text' and column_name not in ('conversation_key','body_hash','tool','state')));
-- RLS stays on.
select security_test.check_true((select relrowsecurity from pg_class where oid='public.comm_reply_send_fingerprints'::regclass));
-- clean up the conversation used by the concurrency check in test-db-local.py
delete from public.comm_reply_send_fingerprints where conversation_key=repeat('d',64);
