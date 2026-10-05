-- PR-B channel classification proposals (migration 20261005200000). Synthetic
-- fixtures only (ids c5000000-…); cleans up after itself. Runs in
-- scripts/test-db-local.py and after the full history in
-- scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no access to both tables and no EXECUTE on the RPCs
--  (2) org_channels accepts surface 'telegram' (other surfaces unchanged, bogus rejected)
--  (3) claim: first → claimed; again (no ticket yet, fresh) → in_flight;
--      attach; pending ticket → pending; rejected + same facts → decided;
--      facts changed → claimed again; another org never sees the row
--  (4) attach refuses another org's approval; release only drops an unattached claim
--  (5) notice window: allowed once per window, then suppressed (counted)
--  (6) bad input → denied; org delete cascades
\set ON_ERROR_STOP 1
reset role;
create or replace function security_test.ccp_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'channel classify: session access not denied: %', command;
end $$;
create or replace function security_test.ccp_check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'channel classify: check failed: %', label; end if;
end $$;
grant execute on function security_test.ccp_denied(text), security_test.ccp_check(boolean, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('c5000000-0000-4000-8000-0000000000a1', 'channel-classify-fixture-a'),
 ('c5000000-0000-4000-8000-0000000000a2', 'channel-classify-fixture-b');
insert into public.approval_requests(id, org_id, purpose, summary, risk, status, tool) values
 ('c5100000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'pending', 'channels.classify'),
 ('c5100000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-0000000000a2', 'admin.channel', 'fixture', 'high', 'pending', 'channels.classify');

-- (2) telegram surface
insert into public.org_channels(org_id, surface, external_id, classification, mixed)
  values ('c5000000-0000-4000-8000-0000000000a1', 'telegram', '-1005550001', 'shared_external', true);
do $$ begin
  begin
    insert into public.org_channels(org_id, surface, external_id) values ('c5000000-0000-4000-8000-0000000000a1', 'fax', 'x');
    raise exception 'channel classify: bogus surface accepted';
  exception when check_violation then null;
  end;
end $$;

set role service_role;
-- (3) claim lifecycle
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('a', 64), 600)->>'state' = 'claimed', 'first claim');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('a', 64), 600)->>'state' = 'in_flight', 'unattached fresh claim → in_flight');
-- (4) attach: another org's approval refused, own accepted
select security_test.ccp_check(public.attach_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', 'c5100000-0000-4000-8000-000000000002') = false, 'cross-org attach refused');
select security_test.ccp_check(public.attach_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', 'c5100000-0000-4000-8000-000000000001') = true, 'attach own');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('b', 64), 600)->>'state' = 'pending', 'pending ticket blocks even with new facts');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('a', 64), 600)->>'approval_id' = 'c5100000-0000-4000-8000-000000000001', 'pending returns the ticket id');
-- another org never sees org a's row
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a2', 'channel:slack:C0DBTEST01', repeat('a', 64), 600)->>'state' = 'claimed', 'org isolation');
reset role;
update public.approval_requests set status = 'rejected' where id = 'c5100000-0000-4000-8000-000000000001';
set role service_role;
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('a', 64), 600)->>'state' = 'decided', 'rejected + same facts → decided');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('a', 64), 600)->>'status' = 'rejected', 'decided carries status');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('c', 64), 600)->>'state' = 'claimed', 'facts changed → claimed');
-- release drops only an unattached claim
select security_test.ccp_check(public.release_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01') = true, 'release unattached');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0DBTEST01', repeat('c', 64), 600)->>'state' = 'claimed', 'claim after release');
-- (5) notice window
select security_test.ccp_check((public.take_channel_stuck_notice('c5000000-0000-4000-8000-0000000000a1', 'unregistered_channel_denied:slack:C0DBTEST01', 3600)->>'allowed')::boolean, 'first notice allowed');
select security_test.ccp_check(not (public.take_channel_stuck_notice('c5000000-0000-4000-8000-0000000000a1', 'unregistered_channel_denied:slack:C0DBTEST01', 3600)->>'allowed')::boolean, 'second notice suppressed');
select security_test.ccp_check((public.take_channel_stuck_notice('c5000000-0000-4000-8000-0000000000a2', 'unregistered_channel_denied:slack:C0DBTEST01', 3600)->>'allowed')::boolean, 'other org independent');
select security_test.ccp_check((select suppressed from public.channel_stuck_notice_windows where org_id = 'c5000000-0000-4000-8000-0000000000a1') = 1, 'suppressed counted');
-- (6) bad input
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'bogus key with spaces', repeat('a', 64), 600)->>'state' = 'denied', 'bad key denied');
select security_test.ccp_check(public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0X', 'nothex', 600)->>'state' = 'denied', 'bad hash denied');
select security_test.ccp_check((public.take_channel_stuck_notice('c5000000-0000-4000-8000-0000000000a1', 'k', 0)->>'state') = 'denied', 'bad window denied');
reset role;

-- (1) sessions
set role anon;
select security_test.ccp_denied($c$select * from public.channel_classify_proposals$c$);
select security_test.ccp_denied($c$select * from public.channel_stuck_notice_windows$c$);
select security_test.ccp_denied($c$select public.claim_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0Z', repeat('a', 64), 600)$c$);
select security_test.ccp_denied($c$select public.take_channel_stuck_notice('c5000000-0000-4000-8000-0000000000a1', 'k', 60)$c$);
reset role;
set role authenticated;
select security_test.ccp_denied($c$select * from public.channel_classify_proposals$c$);
select security_test.ccp_denied($c$insert into public.channel_stuck_notice_windows(org_id, notice_key, window_start) values ('c5000000-0000-4000-8000-0000000000a1', 'k', now())$c$);
select security_test.ccp_denied($c$select public.attach_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0Z', 'c5100000-0000-4000-8000-000000000001')$c$);
select security_test.ccp_denied($c$select public.release_channel_classify_proposal('c5000000-0000-4000-8000-0000000000a1', 'channel:slack:C0Z')$c$);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('channel_classify_proposals', 'channel_stuck_notice_windows')) then
    raise exception 'channel classify: tables must have no policy';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.channel_classify_proposals'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.channel_stuck_notice_windows'::regclass) then
    raise exception 'channel classify: RLS must be enabled';
  end if;
end $$;

-- (6) cascade
delete from public.orgs where id::text like 'c5000000-%';
do $$ begin
  if exists (select 1 from public.channel_classify_proposals where org_id::text like 'c5000000-%')
     or exists (select 1 from public.channel_stuck_notice_windows where org_id::text like 'c5000000-%')
     or exists (select 1 from public.org_channels where org_id::text like 'c5000000-%') then
    raise exception 'channel classify: org delete did not cascade';
  end if;
end $$;
drop function security_test.ccp_denied(text);
drop function security_test.ccp_check(boolean, text);
