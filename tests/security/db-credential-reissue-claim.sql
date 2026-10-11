-- 社員証 reissue pickup claim (migration 20261012200000, #332 follow-up).
-- Synthetic fixtures only (ids cr000000-…); cleans up after itself. Runs in
-- scripts/test-db-local.py (plus a 12-way concurrent claim there) and after
-- every migration in scripts/test-db-all-migrations.py.
--  (1) anon / authenticated cannot execute either function; service_role can
--  (2) claim succeeds once: a second claim (any token) returns false and keeps
--      the first claimer's mark
--  (3) release only with the claimer's own token (wrong token → false, mark kept)
--  (4) another org / another tool's ticket / a pending ticket → false, untouched
--  (5) after an own-token release the ticket can be claimed again
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.crc_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'credential reissue claim: session access not denied: %', command;
end $$;
grant execute on function security_test.crc_denied(text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
  ('c7000000-0000-4000-8000-000000000001', 'crc org a'),
  ('c7000000-0000-4000-8000-000000000002', 'crc org b')
on conflict (id) do nothing;
insert into public.approval_requests(id, org_id, purpose, summary, tool, risk, status, metadata) values
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'admin.policy', 'crc', 'employees.credential.reissue', 'high', 'approved',
   '{"adminTool":"employees.credential.reissue","adminMutation":{"employeeId":"e"}}'),
  ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000001', 'admin.policy', 'crc', 'policy.patch', 'high', 'approved',
   '{"adminTool":"policy.patch"}'),
  ('c7100000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000001', 'admin.policy', 'crc', 'employees.credential.reissue', 'high', 'pending',
   '{"adminTool":"employees.credential.reissue"}');

-- (1)
set role anon;
select security_test.crc_denied($q$select public.claim_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_anon_0123456789abcdef','m',now())$q$);
select security_test.crc_denied($q$select public.release_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_anon_0123456789abcdef')$q$);
reset role;
set role authenticated;
select security_test.crc_denied($q$select public.claim_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_auth_0123456789abcdef','m',now())$q$);
select security_test.crc_denied($q$select public.release_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_auth_0123456789abcdef')$q$);
reset role;

set role service_role;
do $$
declare m jsonb;
begin
  -- (4) other org / other tool / pending
  if public.claim_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000002','tok_other_org_0123456789','m',now()) then
    raise exception 'credential reissue claim: another org claimed the ticket'; end if;
  if public.claim_credential_reissue('c7100000-0000-4000-8000-000000000002','c7000000-0000-4000-8000-000000000001','tok_other_tool_012345678','m',now()) then
    raise exception 'credential reissue claim: another tool''s ticket claimed'; end if;
  if public.claim_credential_reissue('c7100000-0000-4000-8000-000000000003','c7000000-0000-4000-8000-000000000001','tok_pending_0123456789ab','m',now()) then
    raise exception 'credential reissue claim: pending ticket claimed'; end if;
  -- (2) first claim wins, second loses, first mark kept
  if not public.claim_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_first_0123456789abcd','mem_1',now()) then
    raise exception 'credential reissue claim: first claim failed'; end if;
  if public.claim_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_second_0123456789abc','mem_2',now()) then
    raise exception 'credential reissue claim: second claim succeeded'; end if;
  select metadata into m from public.approval_requests where id = 'c7100000-0000-4000-8000-000000000001';
  if m->'credentialReissue'->>'claimToken' <> 'tok_first_0123456789abcd' or m->'credentialReissue'->>'redeemedByMemberId' <> 'mem_1'
     or coalesce(m->'credentialReissue'->>'redeemedAt','') = '' or m->'adminMutation'->>'employeeId' <> 'e' then
    raise exception 'credential reissue claim: mark not the first claimer''s / metadata lost: %', m; end if;
  -- (3) release with the wrong token / wrong org refused
  if public.release_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_second_0123456789abc') then
    raise exception 'credential reissue claim: release with a foreign token succeeded'; end if;
  if public.release_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000002','tok_first_0123456789abcd') then
    raise exception 'credential reissue claim: release from another org succeeded'; end if;
  select metadata into m from public.approval_requests where id = 'c7100000-0000-4000-8000-000000000001';
  if m->'credentialReissue'->>'claimToken' is distinct from 'tok_first_0123456789abcd' then
    raise exception 'credential reissue claim: mark changed by a refused release'; end if;
  -- (5) own-token release, claim again
  if not public.release_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_first_0123456789abcd') then
    raise exception 'credential reissue claim: own release refused'; end if;
  if not public.claim_credential_reissue('c7100000-0000-4000-8000-000000000001','c7000000-0000-4000-8000-000000000001','tok_third_0123456789abcd','mem_3',now()) then
    raise exception 'credential reissue claim: re-claim after release failed'; end if;
  -- short / empty token refused
  begin
    perform public.claim_credential_reissue('c7100000-0000-4000-8000-000000000003','c7000000-0000-4000-8000-000000000001','short','m',now());
    raise exception 'credential reissue claim: short token accepted';
  exception when others then
    if sqlerrm not like '%invalid_claim_token%' then raise; end if;
  end;
end $$;
reset role;

delete from public.approval_requests where id::text like 'c7100000-%';
delete from public.orgs where id::text like 'c7000000-%';
drop function security_test.crc_denied(text);
