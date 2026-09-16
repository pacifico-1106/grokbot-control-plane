create function security_test.check_true(value boolean) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'security assertion failed'; end if; end $$;
insert into public.orgs(id,name) values ('00000000-0000-4000-8000-000000000001','Fixture A'),('00000000-0000-4000-8000-000000000002','Fixture B');
insert into public.org_admin_agents(id,org_id,credential_fingerprint,credential_generation,status,grok_bot_agent_id)
values ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001','fixture-hash',1,'linked','fixture-agent');
insert into public.approval_requests(id,org_id,purpose,summary,risk,status,metadata)
select ('00000000-0000-4000-8000-0000000000' || i::text)::uuid,'00000000-0000-4000-8000-000000000001','admin.policy','fixture','low','approved','{}'::jsonb from generate_series(10,14) i;
update approval_requests set metadata='{"adminRequester":{"kind":"admin_agent","actorId":"00000000-0000-4000-8000-000000000020","credentialGeneration":1,"grokBotAgentId":"fixture-agent"},"adminFulfillment":{"ok":true,"oneTimeSecret":"fixture-only"},"fulfillment":{"ok":true,"oneTimeSecret":"fixture-only"}}'::jsonb where id='00000000-0000-4000-8000-000000000011';

set role anon;
select security_test.denied($cmd$select * from public.approval_execution_claims$cmd$);
select security_test.denied($cmd$select public.claim_approval_execution(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())$cmd$);
select security_test.denied($cmd$select public.consume_admin_approval_secret(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1)$cmd$);
select security_test.denied($cmd$select public.merge_approval_metadata(gen_random_uuid(),gen_random_uuid(),'{}')$cmd$);
select security_test.denied($cmd$select public.finish_approval_execution(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'failed')$cmd$);
reset role;
set role authenticated;
select security_test.denied($cmd$insert into public.approval_execution_claims values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'running',now(),null)$cmd$);
select security_test.denied($cmd$select public.claim_approval_execution(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())$cmd$);
select security_test.denied($cmd$select public.consume_admin_approval_secret(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1)$cmd$);
select security_test.denied($cmd$select public.merge_approval_metadata(gen_random_uuid(),gen_random_uuid(),'{}')$cmd$);
select security_test.denied($cmd$select public.finish_approval_execution(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'failed')$cmd$);
reset role;
set role service_role;
-- Cross-tenant claim and metadata writes have no effect.
select security_test.check_true(public.claim_approval_execution('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000002',gen_random_uuid())->>'state'='denied');
select security_test.check_true(public.merge_approval_metadata('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000002','{"tampered":true}') is null);
select security_test.check_true((select count(*)=0 from approval_execution_claims));
select security_test.check_true(public.consume_admin_approval_secret('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000020',1) is null);
select security_test.check_true(public.consume_admin_approval_secret('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',1) is null);
select security_test.check_true(public.consume_admin_approval_secret('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000020',2) is null);
update approval_requests set status='pending' where id='00000000-0000-4000-8000-000000000012';
select security_test.check_true(public.claim_approval_execution('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001',gen_random_uuid())->>'state'='denied');
-- A stale lease is never auto-reclaimed. Its provider outcome is unknown.
insert into approval_execution_claims(approval_id,org_id,claim_id,state,claimed_at) values('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000030','running','2000-01-01');
select security_test.check_true(public.claim_approval_execution('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001',gen_random_uuid())->>'state'='running');
select security_test.check_true(not public.finish_approval_execution('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001',gen_random_uuid(),'failed'));
select security_test.check_true(public.finish_approval_execution('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000030','failed'));
select security_test.check_true(public.claim_approval_execution('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001',gen_random_uuid())->>'state'='claimed');
-- Consumed markers cannot be undone by an ordinary metadata patch.
update approval_requests set metadata='{"adminSecretConsumed":true,"fulfillment":{"ok":true}}' where id='00000000-0000-4000-8000-000000000014';
select security_test.check_true(public.merge_approval_metadata('00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000001','{"adminSecretConsumed":false,"fulfillment":{"oneTimeSecret":"must-not-return"}}') #>> '{metadata,adminSecretConsumed}'='true');
select security_test.check_true((select metadata #>> '{fulfillment,oneTimeSecret}' is null from approval_requests where id='00000000-0000-4000-8000-000000000014'));
reset role;
