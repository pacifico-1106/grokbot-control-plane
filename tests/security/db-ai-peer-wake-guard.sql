-- AI→AI wake allowlist + thread cap/stop (migration 20261016100000).
-- Synthetic fixtures only (ids a1600000-…); cleans up after itself.
--  (1) anon / authenticated: no table access, no EXECUTE; RLS on, no policy
--  (2) allowlist: another org's employee refused; self pair refused; created_by
--      must be member:<uuid> (ai: refused)
--  (3) claim: first 4 allowed, 5th capped (notify once), then notify false;
--      other org isolated; bad ids denied
--  (4) stop: member only; already_stopped; other org not_found; AI prefix denied
--  (5) resume: member only; resets count; other org not_found
--  (6) org delete cascades
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.apw_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'ai peer wake: session access not denied: %', command;
end $$;
create or replace function security_test.apw_check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ai peer wake: check failed: %', label; end if;
end $$;
create or replace function security_test.apw_raises(command text, needle text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(needle in sqlerrm) > 0 then return; end if;
    raise exception 'ai peer wake: expected "%" but got "%" for: %', needle, sqlerrm, command;
  end;
  raise exception 'ai peer wake: expected "%" but the command succeeded: %', needle, command;
end $$;
grant execute on function security_test.apw_denied(text), security_test.apw_check(boolean, text), security_test.apw_raises(text, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
  ('a1600000-0000-4000-8000-0000000000a1', 'apw org a'),
  ('a1600000-0000-4000-8000-0000000000a2', 'apw org b')
on conflict (id) do nothing;
insert into public.org_members(id, org_id, email, role, status) values
  ('a1630000-0000-4000-8000-000000000001', 'a1600000-0000-4000-8000-0000000000a1', 'apw-owner@a.invalid', 'owner', 'active'),
  ('a1630000-0000-4000-8000-000000000002', 'a1600000-0000-4000-8000-0000000000a2', 'apw-owner@b.invalid', 'owner', 'active')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
  ('a1610000-0000-4000-8000-000000000001', 'a1600000-0000-4000-8000-0000000000a1', 'apw a1', 'r'),
  ('a1610000-0000-4000-8000-000000000002', 'a1600000-0000-4000-8000-0000000000a1', 'apw a2', 'r'),
  ('a1610000-0000-4000-8000-000000000003', 'a1600000-0000-4000-8000-0000000000a2', 'apw b1', 'r')
on conflict (id) do nothing;

-- (1) sessions
set role anon;
select security_test.apw_denied($q$select * from public.ai_peer_wake_allowlist$q$);
select security_test.apw_denied($q$select * from public.ai_peer_wake_threads$q$);
select security_test.apw_denied($q$select public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1',null,'1787911800.000001',4,1800)$q$);
reset role;
set role authenticated;
select security_test.apw_denied($q$insert into public.ai_peer_wake_allowlist(org_id, from_employee_id, to_employee_id, created_by) values ('a1600000-0000-4000-8000-0000000000a1','a1610000-0000-4000-8000-000000000001','a1610000-0000-4000-8000-000000000002','member:a1630000-0000-4000-8000-000000000001')$q$);
select security_test.apw_denied($q$select public.stop_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a1','a1600000-0000-4000-8000-000000000099','member:a1630000-0000-4000-8000-000000000001')$q$);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('ai_peer_wake_allowlist', 'ai_peer_wake_threads')) then
    raise exception 'ai peer wake: unexpected policy'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ai_peer_wake_allowlist'::regclass) then
    raise exception 'ai peer wake: allowlist RLS off'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ai_peer_wake_threads'::regclass) then
    raise exception 'ai peer wake: threads RLS off'; end if;
  if has_function_privilege('anon', 'public.ai_peer_wake_allowlist_guard()', 'execute')
    or has_function_privilege('authenticated', 'public.ai_peer_wake_allowlist_guard()', 'execute') then
    raise exception 'ai peer wake: trigger fn executable by session'; end if;
end $$;

set role service_role;
-- (2) allowlist
select security_test.apw_raises($q$insert into public.ai_peer_wake_allowlist(org_id, from_employee_id, to_employee_id, created_by) values ('a1600000-0000-4000-8000-0000000000a1','a1610000-0000-4000-8000-000000000003','a1610000-0000-4000-8000-000000000002','member:a1630000-0000-4000-8000-000000000001')$q$, 'ai_peer_wake_allowlist_cross_org');
select security_test.apw_raises($q$insert into public.ai_peer_wake_allowlist(org_id, from_employee_id, to_employee_id, created_by) values ('a1600000-0000-4000-8000-0000000000a1','a1610000-0000-4000-8000-000000000001','a1610000-0000-4000-8000-000000000001','member:a1630000-0000-4000-8000-000000000001')$q$, 'ai_peer_wake_allowlist_no_self');
select security_test.apw_raises($q$insert into public.ai_peer_wake_allowlist(org_id, from_employee_id, to_employee_id, created_by) values ('a1600000-0000-4000-8000-0000000000a1','a1610000-0000-4000-8000-000000000001','a1610000-0000-4000-8000-000000000002','ai:agent')$q$, 'ai_peer_wake_allowlist');
insert into public.ai_peer_wake_allowlist(org_id, from_employee_id, to_employee_id, created_by)
  values ('a1600000-0000-4000-8000-0000000000a1','a1610000-0000-4000-8000-000000000001','a1610000-0000-4000-8000-000000000002','member:a1630000-0000-4000-8000-000000000001');

-- (3) claim
select security_test.apw_check(public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000001',4,1800)->>'state' = 'allowed', '1 allowed');
select security_test.apw_check(public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000002',4,1800)->>'state' = 'allowed', '2 allowed');
select security_test.apw_check(public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000003',4,1800)->>'state' = 'allowed', '3 allowed');
select security_test.apw_check(public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000004',4,1800)->>'state' = 'allowed', '4 allowed');
select security_test.apw_check((public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000005',4,1800)->>'state' = 'capped')
  and (public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000005',4,1800)->>'notify' = 'false'), '5 capped, second notify false');
select security_test.apw_check(public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a2','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000001',4,1800)->>'state' = 'allowed', 'other org isolated');
select security_test.apw_check(public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','bad','C0CHAN1',null,'1787911800.000001',4,1800)->>'state' = 'denied', 'bad team denied');

-- (4) stop
do $$
declare
  tid uuid;
  r jsonb;
begin
  select id into tid from public.ai_peer_wake_threads
    where org_id = 'a1600000-0000-4000-8000-0000000000a1' and slack_channel_id = 'C0CHAN1' and thread_key = '1787911797.502889';
  r := public.stop_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a1', tid, 'ai:emp');
  if r->>'state' <> 'denied' then raise exception 'ai peer wake: AI stop not denied %', r; end if;
  r := public.stop_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a2', tid, 'member:a1630000-0000-4000-8000-000000000002');
  if r->>'state' <> 'not_found' then raise exception 'ai peer wake: cross-org stop %', r; end if;
  r := public.stop_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a1', tid, 'member:a1630000-0000-4000-8000-000000000001');
  if r->>'state' <> 'stopped' then raise exception 'ai peer wake: stop %', r; end if;
  r := public.stop_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a1', tid, 'member:a1630000-0000-4000-8000-000000000001');
  if r->>'state' <> 'already_stopped' then raise exception 'ai peer wake: already %', r; end if;
  r := public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000006',4,1800);
  if r->>'state' <> 'stopped' then raise exception 'ai peer wake: claim after stop %', r; end if;
  -- (5) resume
  r := public.resume_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a2', tid, 'member:a1630000-0000-4000-8000-000000000002');
  if r->>'state' <> 'not_found' then raise exception 'ai peer wake: cross-org resume %', r; end if;
  r := public.resume_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a1', tid, 'ai:emp');
  if r->>'state' <> 'denied' then raise exception 'ai peer wake: AI resume %', r; end if;
  r := public.resume_ai_peer_wake_thread('a1600000-0000-4000-8000-0000000000a1', tid, 'member:a1630000-0000-4000-8000-000000000001');
  if r->>'state' <> 'resumed' then raise exception 'ai peer wake: resume %', r; end if;
  r := public.claim_ai_peer_wake('a1600000-0000-4000-8000-0000000000a1','T0TEAM1','C0CHAN1','1787911797.502889','1787911800.000007',4,1800);
  if r->>'state' <> 'allowed' or (r->>'count')::int <> 1 then raise exception 'ai peer wake: after resume %', r; end if;
end $$;

-- (6) cascade
delete from public.orgs where id in ('a1600000-0000-4000-8000-0000000000a1', 'a1600000-0000-4000-8000-0000000000a2');
select security_test.apw_check(not exists (select 1 from public.ai_peer_wake_allowlist where org_id::text like 'a1600000-%'), 'allowlist cascaded');
select security_test.apw_check(not exists (select 1 from public.ai_peer_wake_threads where org_id::text like 'a1600000-%'), 'threads cascaded');
reset role;
