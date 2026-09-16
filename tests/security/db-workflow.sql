-- Synthetic fixtures only. Run inside scripts/test-db-local.py's disposable cluster.
create or replace function security_test.fails(command text, expected text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'expected failure: %',expected;
end $$;
grant execute on all functions in schema security_test to service_role;
select security_test.check_true(public.workflow_quorum_required('{"type":"ratio","numerator":2,"denominator":3}',3)=2);
select security_test.check_true(public.workflow_quorum_required('{"type":"ratio","numerator":2,"denominator":3}',4)=3);
select security_test.check_true(public.workflow_quorum_required('{"type":"majority"}',4)=3);
select security_test.fails($q$select public.workflow_quorum_required('{"type":"count","n":1.5}',3)$q$,'workflow_invalid_policy');

insert into orgs(id,name) values ('10000000-0000-4000-8000-000000000001','Workflow fixture'),('10000000-0000-4000-8000-000000000002','Other fixture');
insert into auth.users(id) select ('20000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,6) n;
insert into org_members(id,org_id,user_id,email,capabilities,status,role)
select ('30000000-0000-4000-8000-00000000000'||n)::uuid,'10000000-0000-4000-8000-000000000001',
  ('20000000-0000-4000-8000-00000000000'||n)::uuid,'fixture'||n||'@example.invalid',
  case when n=6 then '{}'::text[] else array['approve_actions'] end,'active',case when n=1 then 'admin' else 'member' end
from generate_series(1,6) n;

-- W1: no workflow remains a single decision, even if a policy is set later.
insert into approval_requests(id,org_id,purpose,summary,risk,status)
values('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','fixture','W1','low','pending');
insert into approval_requests(id,org_id,purpose,summary,risk,status)
values('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','fixture','Legacy W1','low','pending');
update approval_requests set workflow_initialized=false where id='40000000-0000-4000-8000-000000000002';
update approval_requests set status='approved' where id='40000000-0000-4000-8000-000000000002';
select security_test.check_true((select workflow_initialized from approval_requests where id='40000000-0000-4000-8000-000000000002'));
update orgs set approval_workflow_policy='{
 "version":1,"policyId":"fixture-policy","policyName":"Fixture multi-stage",
 "stages":[
  {"id":"committee","nameJa":"Committee","voterUserIds":["30000000-0000-4000-8000-000000000001","30000000-0000-4000-8000-000000000002","30000000-0000-4000-8000-000000000003"],"quorum":{"type":"count","n":2},"onReject":"fail_closed"},
  {"id":"review","nameJa":"Review","voterUserIds":["30000000-0000-4000-8000-000000000003"],"quorum":{"type":"any"},"onReject":"fail_closed"}],
 "finalGoUserId":"30000000-0000-4000-8000-000000000004"}'
where id='10000000-0000-4000-8000-000000000001';
update approval_requests set status='approved' where id='40000000-0000-4000-8000-000000000001';
select security_test.check_true(public.approval_workflow_can_execute('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'));

insert into approval_requests(id,org_id,purpose,summary,risk,status)
select ('40000000-0000-4000-8000-0000000000'||n)::uuid,'10000000-0000-4000-8000-000000000001','fixture','F8 fixture','low','pending'
from generate_series(10,19) n;
select security_test.check_true((select count(*)=10 from approval_workflow_instances where org_id='10000000-0000-4000-8000-000000000001'));

-- A small test helper uses the same production RPC; no alternate voting implementation.
create function security_test.vote(ticket integer,member integer,decision text default 'approve') returns jsonb language sql as $$
 select public.cast_approval_workflow_vote(('40000000-0000-4000-8000-0000000000'||ticket)::uuid,
 '10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-00000000000'||member,decision,'fixture-reviewer');
$$;
grant execute on function security_test.vote(integer,integer,text) to service_role;
set role service_role;
select security_test.check_true(security_test.vote(10,1)->>'accepted'='true');
select security_test.check_true(security_test.vote(10,1)->>'accepted'='false');
select security_test.check_true(security_test.vote(10,4)->>'accepted'='false');
select security_test.check_true((select status='pending' from approval_requests where id='40000000-0000-4000-8000-000000000010'));
select security_test.check_true(not public.approval_workflow_can_execute('40000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001'));
select security_test.fails($q$update approval_requests set status='approved' where id='40000000-0000-4000-8000-000000000010'$q$,'workflow_resolution_required');
select security_test.check_true(security_test.vote(10,2)#>>'{instance,current_stage_index}'='1');
select security_test.check_true(security_test.vote(10,3)#>>'{instance,final_go_pending}'='true');
select security_test.check_true((select status='pending' from approval_requests where id='40000000-0000-4000-8000-000000000010'));
select security_test.check_true(security_test.vote(10,4)#>>'{approval,status}'='approved');
select security_test.check_true(public.approval_workflow_can_execute('40000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001'));
-- Losing membership/capability after a vote revokes execution authority as well.
update org_members set capabilities='{}' where id='30000000-0000-4000-8000-000000000001';
select security_test.check_true(not public.approval_workflow_can_execute('40000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001'));
select security_test.fails($q$select public.claim_approval_execution('40000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001',gen_random_uuid())$q$,'workflow_not_approved');
select security_test.check_true((select count(*)=0 from approval_execution_claims where approval_id='40000000-0000-4000-8000-000000000010'));
update org_members set capabilities=array['approve_actions'] where id='30000000-0000-4000-8000-000000000001';
select security_test.check_true(security_test.vote(11,1,'reject')#>>'{approval,status}'='rejected');
select security_test.check_true(security_test.vote(11,2)->>'accepted'='false');

-- Chat identities require a current binding in this exact tenant/channel.
insert into approval_workflow_voter_bindings(org_id,provider,channel_key,external_user_id,member_id,expires_at)
values('10000000-0000-4000-8000-000000000001','slack','fixture-channel','U_FIXTURE','30000000-0000-4000-8000-000000000001',now()-interval '1 day');
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001',null,'approve','slack:U_FIXTURE',null,null,'slack','fixture-channel','U_FIXTURE','fixture-slack-event')->>'reason'='voter_binding_required');
update approval_workflow_voter_bindings set expires_at=null;
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001',null,'approve','slack:U_FIXTURE',null,null,'slack','wrong-channel','U_FIXTURE','fixture-slack-event')->>'accepted'='false');
update org_members set status='disabled' where id='30000000-0000-4000-8000-000000000001';
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001',null,'approve','slack:U_FIXTURE',null,null,'slack','fixture-channel','U_FIXTURE','fixture-slack-event')->>'reason'='voter_not_authorized');
update org_members set status='active' where id='30000000-0000-4000-8000-000000000001';
reset role;
-- Even accidentally re-granted table/column access cannot defeat restrictive RLS.
grant select(status),update(status) on approval_workflow_instances to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false);
select security_test.check_true(public.is_org_admin('10000000-0000-4000-8000-000000000001'));
select security_test.check_true((select count(status)=0 from approval_workflow_instances));
with modified as (update approval_workflow_instances set status='approved' returning status)
  select security_test.check_true((select count(*)=0 from modified));
reset role;
revoke select(status),update(status) on approval_workflow_instances from authenticated;
update auth.users set banned_until=now()+interval '1 day' where id='20000000-0000-4000-8000-000000000001';
select security_test.check_true(security_test.vote(15,1)->>'reason'='voter_not_authorized');
update auth.users set banned_until=null,deleted_at=now() where id='20000000-0000-4000-8000-000000000001';
select security_test.check_true(security_test.vote(15,1)->>'reason'='voter_not_authorized');
update auth.users set deleted_at=null where id='20000000-0000-4000-8000-000000000001';
set role service_role;
select security_test.check_true(security_test.vote(15,6)->>'reason'='voter_not_authorized');
select security_test.check_true((select count(*)=0 from approval_workflow_ballots b join approval_workflow_instances w on w.id=b.instance_id where w.approval_id='40000000-0000-4000-8000-000000000015' and b.vote is not null));
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001',null,'approve','slack:U_FIXTURE',null,null,'slack','fixture-channel','U_FIXTURE','fixture-slack-event')->>'accepted'='true');
update approval_workflow_voter_bindings set revoked_at=now();
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000016','10000000-0000-4000-8000-000000000001',null,'approve','slack:U_FIXTURE',null,null,'slack','fixture-channel','U_FIXTURE','fixture-slack-event')->>'accepted'='false');

-- Self-approval is checked before the first/intermediate vote, not just at finalization.
-- A provider retry cannot become a new vote in the next stage for the same voter.
select security_test.vote(19,1);
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000019','10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003','approve','fixture',null,null,null,null,null,'fixture-event','committee')->>'accepted'='true');
select security_test.check_true(public.cast_approval_workflow_vote('40000000-0000-4000-8000-000000000019','10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000003','approve','fixture',null,null,null,null,null,'fixture-event','review')->>'reason'='duplicate_decision');
select security_test.check_true((select vote is null from approval_workflow_ballots b join approval_workflow_instances w on w.id=b.instance_id
  where w.approval_id='40000000-0000-4000-8000-000000000019' and b.stage_id='review'));
update approval_requests set metadata='{"adminRequester":{"kind":"admin_agent","actorId":"30000000-0000-4000-8000-000000000001"}}' where id='40000000-0000-4000-8000-000000000016';
select security_test.fails($q$select security_test.vote(16,1)$q$,'self_approval_denied');

-- Recover a legacy completed-instance/pending-ticket state without adding votes.
update approval_workflow_ballots b set vote='approve',voted_at=now() from approval_workflow_instances w
  where w.id=b.instance_id and w.approval_id='40000000-0000-4000-8000-000000000017';
update approval_workflow_instances set status='approved',final_go_pending=false where approval_id='40000000-0000-4000-8000-000000000017';
select security_test.check_true(security_test.vote(17,1)->>'reason'='recovered');
select security_test.check_true((select status='approved' from approval_requests where id='40000000-0000-4000-8000-000000000017'));

-- Atomic rollback if the base approval update fails after the final ballot.
select security_test.vote(18,1);
select security_test.vote(18,2);
select security_test.vote(18,3);
reset role;
create function security_test.block_resolution() returns trigger language plpgsql as $$
begin if new.id='40000000-0000-4000-8000-000000000018'::uuid and new.status='approved' then
  raise exception 'fixture_resolution_failure'; end if; return new; end $$;
create trigger fixture_resolution_failure before update of status on approval_requests for each row execute function security_test.block_resolution();
set role service_role;
select security_test.fails($q$select security_test.vote(18,4)$q$,'fixture_resolution_failure');
select security_test.check_true((select status='active' and final_go_pending from approval_workflow_instances where approval_id='40000000-0000-4000-8000-000000000018'));
select security_test.check_true((select b.vote is null from approval_workflow_ballots b join approval_workflow_instances w on w.id=b.instance_id where w.approval_id='40000000-0000-4000-8000-000000000018' and b.is_final_go));
reset role;
drop trigger fixture_resolution_failure on approval_requests;
set role service_role;
select security_test.check_true(security_test.vote(18,4)#>>'{approval,status}'='approved');

-- Related IDs cannot cross organizations, even through the privileged data client.
select security_test.bad_relation($q$insert into approval_workflow_instances(approval_id,org_id,policy_id,policy_snapshot)
 values('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','bad','{}')$q$);
select security_test.bad_relation($q$insert into approval_workflow_ballots(instance_id,org_id,stage_id,stage_index,voter_user_id)
 select id,'10000000-0000-4000-8000-000000000002','bad',0,'bad' from approval_workflow_instances where approval_id='40000000-0000-4000-8000-000000000010'$q$);
select security_test.bad_relation($q$insert into approval_workflow_voter_bindings(org_id,provider,channel_key,external_user_id,member_id)
 values('10000000-0000-4000-8000-000000000002','slack','bad','bad','30000000-0000-4000-8000-000000000001')$q$);
reset role;

-- Tenant admin cannot fabricate terminal state, another voter's ballot, or a binding.
set role authenticated;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false);
select security_test.denied('update approval_workflow_instances set status=''approved''');
select security_test.denied('update approval_workflow_ballots set vote=''approve''');
select security_test.denied('delete from approval_workflow_ballots');
select security_test.denied('delete from approval_workflow_instances');
select security_test.denied('select * from approval_workflow_voter_bindings');
select security_test.denied($q$select public.cast_approval_workflow_vote(gen_random_uuid(),gen_random_uuid(),'x','approve','x')$q$);
select security_test.denied($q$select public.initialize_approval_workflow(gen_random_uuid(),gen_random_uuid())$q$);
select security_test.denied($q$select public.approval_workflow_can_execute(gen_random_uuid(),gen_random_uuid())$q$);
select security_test.denied($q$update orgs set approval_workflow_policy=null where id='10000000-0000-4000-8000-000000000001'$q$);
select security_test.denied($q$update approval_requests set workflow_initialized=false where id='40000000-0000-4000-8000-000000000019'$q$);
reset role;
set role anon;
select security_test.denied('select * from approval_workflow_instances');
select security_test.denied('select * from approval_workflow_ballots');
select security_test.denied($q$select public.cast_approval_workflow_vote(gen_random_uuid(),gen_random_uuid(),'x','approve','x')$q$);
reset role;
