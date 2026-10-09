-- Thread single-flight (migration 20261009100000). Synthetic fixtures only
-- (ids c7000000-… / c7100000-…); cleans up. Runs in scripts/test-db-local.py and
-- after the full history in scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no access to either table, no EXECUTE on the 3 RPCs; RLS on, no policy
--  (2) acquire → busy (with retry_after) → expired lease taken over; release by holder only
--  (3) BOLA: another org's lease on the same key never blocks; another org cannot release;
--      an employee of another org is denied
--  (4) self posts: only move forward; per org × employee × key
--  (5) bad input denied / false; org delete cascades
\set ON_ERROR_STOP 1
reset role;
create or replace function security_test.tsf_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'thread single-flight: session access not denied: %', command;
end $$;
create or replace function security_test.tsf_check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'thread single-flight: check failed: %', label; end if;
end $$;
grant execute on function security_test.tsf_denied(text), security_test.tsf_check(boolean, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('c7000000-0000-4000-8000-0000000000a1', 'thread-sf-a'),
 ('c7000000-0000-4000-8000-0000000000a2', 'thread-sf-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-0000000000a1', 'TSF A1', 'fixture'),
 ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-0000000000a1', 'TSF A2', 'fixture'),
 ('c7100000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-0000000000a2', 'TSF B1', 'fixture');

set role service_role;
-- (2)
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7100000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000001', 60)->>'state' = 'acquired', 'first acquired');
select security_test.tsf_check((public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7100000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000002', 60)->>'state') = 'busy', 'second busy');
select security_test.tsf_check((public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7100000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000002', 60)->>'retry_after_seconds')::int between 1 and 60, 'retry_after');
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7100000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000003', 60)->>'state' = 'acquired', 'other key independent');
select security_test.tsf_check(not public.release_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7200000-0000-4000-8000-000000000002'), 'non-holder cannot release');
reset role;
update public.thread_send_leases set expires_at = now() - interval '1 second'
  where org_id = 'c7000000-0000-4000-8000-0000000000a1' and thread_key = repeat('a', 64);
set role service_role;
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7100000-0000-4000-8000-000000000002', 'c7200000-0000-4000-8000-000000000004', 60)->>'state' = 'acquired', 'expired taken over');
select security_test.tsf_check(not public.release_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7200000-0000-4000-8000-000000000001'), 'old holder cannot release the re-taken lease');
-- (3)
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a2', repeat('a', 64),
  'c7100000-0000-4000-8000-000000000003', 'c7200000-0000-4000-8000-000000000005', 60)->>'state' = 'acquired', 'other org same key independent');
select security_test.tsf_check(not public.release_thread_send_lease('c7000000-0000-4000-8000-0000000000a2', repeat('a', 64),
  'c7200000-0000-4000-8000-000000000004'), 'other org cannot release');
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('c', 64),
  'c7100000-0000-4000-8000-000000000003', 'c7200000-0000-4000-8000-000000000006', 60)->>'state' = 'denied', 'employee of another org denied');
select security_test.tsf_check(public.release_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7200000-0000-4000-8000-000000000004'), 'holder releases');
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64),
  'c7100000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000007', 60)->>'state' = 'acquired', 'free after release');
-- (4)
select security_test.tsf_check(public.record_thread_self_post('c7000000-0000-4000-8000-0000000000a1', 'c7100000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105000000002, repeat('d', 64)), 'record');
select security_test.tsf_check(public.record_thread_self_post('c7000000-0000-4000-8000-0000000000a1', 'c7100000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105000000001, repeat('e', 64)), 'older accepted call');
select security_test.tsf_check((select message_micros = 1791105000000002 and job_key = repeat('d', 64) from public.thread_self_posts
  where org_id = 'c7000000-0000-4000-8000-0000000000a1' and employee_id = 'c7100000-0000-4000-8000-000000000001' and thread_key = repeat('a', 64)), 'only moves forward');
select security_test.tsf_check(not public.record_thread_self_post('c7000000-0000-4000-8000-0000000000a2', 'c7100000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105000000009, null), 'employee of another org refused');
select security_test.tsf_check((select count(*) = 0 from public.thread_self_posts where org_id = 'c7000000-0000-4000-8000-0000000000a2'), 'no cross-org row');
-- (5)
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', 'not-a-key',
  'c7100000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000008', 60)->>'state' = 'denied', 'bad key');
select security_test.tsf_check(public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('f', 64),
  'c7100000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000008', 0)->>'state' = 'denied', 'bad ttl');
select security_test.tsf_check(not public.record_thread_self_post('c7000000-0000-4000-8000-0000000000a1', 'c7100000-0000-4000-8000-000000000001',
  repeat('a', 64), 0, null), 'bad micros');
reset role;

-- (1)
set role anon;
select security_test.tsf_denied($c$select * from public.thread_send_leases$c$);
select security_test.tsf_denied($c$select * from public.thread_self_posts$c$);
select security_test.tsf_denied($c$select public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'c7100000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000009', 60)$c$);
reset role;
set role authenticated;
select security_test.tsf_denied($c$select * from public.thread_send_leases$c$);
select security_test.tsf_denied($c$delete from public.thread_send_leases$c$);
select security_test.tsf_denied($c$select * from public.thread_self_posts$c$);
select security_test.tsf_denied($c$update public.thread_self_posts set message_micros = 1$c$);
select security_test.tsf_denied($c$select public.acquire_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'c7100000-0000-4000-8000-000000000001', 'c7200000-0000-4000-8000-000000000009', 60)$c$);
select security_test.tsf_denied($c$select public.release_thread_send_lease('c7000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'c7200000-0000-4000-8000-000000000007')$c$);
select security_test.tsf_denied($c$select public.record_thread_self_post('c7000000-0000-4000-8000-0000000000a1', 'c7100000-0000-4000-8000-000000000001', repeat('a', 64), 1791105000000099, null)$c$);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('thread_send_leases', 'thread_self_posts')) then
    raise exception 'thread single-flight: tables must have no policy';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.thread_send_leases'::regclass)
    or not (select relrowsecurity from pg_class where oid = 'public.thread_self_posts'::regclass) then
    raise exception 'thread single-flight: RLS must be enabled';
  end if;
end $$;

-- (5) cascade
delete from public.orgs where id::text like 'c7000000-%';
do $$ begin
  if exists (select 1 from public.thread_send_leases where org_id::text like 'c7000000-%')
    or exists (select 1 from public.thread_self_posts where org_id::text like 'c7000000-%') then
    raise exception 'thread single-flight: org delete did not cascade';
  end if;
end $$;
