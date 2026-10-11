-- Thread single-flight pre-flag-ON fixes (migration 20261009150000; 木村
-- 2026-10-09 #286 follow-up items 2 and 5). Synthetic fixtures only (ids
-- c7500000-… / c7600000-… / c7700000-…); cleans up; re-runnable.
--  (1) close_approval_without_send: status + resolved_at + closedWithoutSend in
--      ONE statement; other metadata kept; only from the listed statuses;
--      another org's id → null and untouched (BOLA); bad input → null, untouched
--  (2) a failing close leaves no partial state (one statement: all or nothing)
--  (3) record_thread_self_post keeps job_first_micros = the job's FIRST post;
--      a different job (or no job key) re-anchors
--  (3b) same-job lease reuse: the same employee + job key re-enters its held
--      lease within 10 min of its first post; after that, a different job,
--      another employee, no job key or no post yet → busy; other org denied
--  (3c) record_thread_wake_point (#293 review item 2): per org × employee ×
--      thread, forward-only; another org's employee / bad input → false
--  (4) anon / authenticated: no EXECUTE on close_approval_without_send / 6-arg
--      acquire / record_thread_wake_point; no access to thread_wake_points
\set ON_ERROR_STOP 1
reset role;
create or replace function security_test.tsfp_check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'thread single-flight preflag: check failed: %', label; end if;
end $$;
create or replace function security_test.tsfp_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'thread single-flight preflag: session access not denied: %', command;
end $$;
grant execute on function security_test.tsfp_check(boolean, text), security_test.tsfp_denied(text) to anon, authenticated, service_role;

delete from public.orgs where id::text like 'c7500000-%';
insert into public.orgs(id, name) values
 ('c7500000-0000-4000-8000-0000000000a1', 'thread-sf-preflag-a'),
 ('c7500000-0000-4000-8000-0000000000a2', 'thread-sf-preflag-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('c7600000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1', 'TSFP A1', 'fixture'),
 ('c7600000-0000-4000-8000-000000000003', 'c7500000-0000-4000-8000-0000000000a2', 'TSFP B1', 'fixture');
insert into public.approval_requests(id, org_id, employee_id, purpose, summary, risk, status, tool, metadata) values
 ('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  'comm.internal', 'preflag fixture', 'high', 'approved', 'comm.send', '{"statusToken":"st_keep","invoke":{"tool":"comm.send"}}'::jsonb),
 ('c7700000-0000-4000-8000-000000000002', 'c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  'comm.internal', 'preflag fixture', 'high', 'pending', 'comm.send', '{}'::jsonb),
 ('c7700000-0000-4000-8000-000000000003', 'c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  'comm.internal', 'preflag fixture', 'high', 'approved', 'comm.send', '{"statusToken":"st_three"}'::jsonb);

set role service_role;
-- (1) BOLA first: another org's id → null, untouched
select security_test.tsfp_check(public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a2',
  array['approved'], 'superseded', '{"reason":"thread_moved_on"}'::jsonb) is null, 'other org → null');
-- status not in from → null, untouched
select security_test.tsfp_check(public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1',
  array['pending'], 'superseded', '{"reason":"thread_moved_on"}'::jsonb) is null, 'status not in from → null');
-- bad input → null (never approved / pending as a target, unknown from, non-object patch)
select security_test.tsfp_check(public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1',
  array['approved'], 'approved', '{"reason":"x"}'::jsonb) is null, 'target approved refused');
select security_test.tsfp_check(public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1',
  array['rejected'], 'superseded', '{"reason":"x"}'::jsonb) is null, 'from rejected refused');
select security_test.tsfp_check(public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1',
  array['approved'], 'superseded', '"x"'::jsonb) is null, 'non-object patch refused');
reset role;
select security_test.tsfp_check((select status = 'approved' and resolved_at is null and not (metadata ? 'closedWithoutSend')
  from public.approval_requests where id = 'c7700000-0000-4000-8000-000000000001'), 'untouched after refusals');
set role service_role;
-- success: one statement closes and records the reason; other keys kept
select security_test.tsfp_check((public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1',
  array['approved'], 'superseded', '{"reason":"thread_moved_on","phase":"approval.fulfill"}'::jsonb))->>'status' = 'superseded', 'closed');
reset role;
select security_test.tsfp_check((select status = 'superseded' and resolved_at is not null
  and metadata->'closedWithoutSend'->>'reason' = 'thread_moved_on'
  and metadata->'closedWithoutSend'->>'status' = 'superseded'
  and (metadata->'closedWithoutSend'->>'at')::timestamptz = resolved_at
  and metadata->>'statusToken' = 'st_keep' and metadata->'invoke'->>'tool' = 'comm.send'
  from public.approval_requests where id = 'c7700000-0000-4000-8000-000000000001'), 'status + reason together, other metadata kept');
set role service_role;
-- already closed → null (terminal)
select security_test.tsfp_check(public.close_approval_without_send('c7700000-0000-4000-8000-000000000001', 'c7500000-0000-4000-8000-0000000000a1',
  array['approved', 'pending'], 'expired', '{"reason":"approval_ttl_elapsed"}'::jsonb) is null, 'terminal');
-- pending → expired
select security_test.tsfp_check((public.close_approval_without_send('c7700000-0000-4000-8000-000000000002', 'c7500000-0000-4000-8000-0000000000a1',
  array['pending'], 'expired', '{"reason":"approval_ttl_elapsed"}'::jsonb))->'metadata'->'closedWithoutSend'->>'reason' = 'approval_ttl_elapsed', 'pending → expired');
reset role;

-- (2) a failing statement leaves no partial state: a trigger that rejects the
-- metadata change makes the WHOLE close fail; status stays approved.
create or replace function security_test.tsfp_reject_meta() returns trigger language plpgsql as $$
begin
  if new.id = 'c7700000-0000-4000-8000-000000000003' and new.metadata ? 'closedWithoutSend' then
    raise exception 'tsfp_injected_metadata_failure';
  end if;
  return new;
end $$;
create trigger tsfp_reject_meta before update on public.approval_requests
  for each row execute function security_test.tsfp_reject_meta();
set role service_role;
do $$ begin
  begin
    perform public.close_approval_without_send('c7700000-0000-4000-8000-000000000003', 'c7500000-0000-4000-8000-0000000000a1',
      array['approved'], 'superseded', '{"reason":"thread_moved_on"}'::jsonb);
    raise exception 'injected failure did not surface';
  exception when others then
    if position('tsfp_injected_metadata_failure' in sqlerrm) = 0 then raise; end if;
  end;
end $$;
reset role;
drop trigger tsfp_reject_meta on public.approval_requests;
select security_test.tsfp_check((select status = 'approved' and resolved_at is null and not (metadata ? 'closedWithoutSend')
  from public.approval_requests where id = 'c7700000-0000-4000-8000-000000000003'), 'no partial state after a failed close');

-- (3) job_first_micros
set role service_role;
select security_test.tsfp_check(public.record_thread_self_post('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105000000000, repeat('d', 64)), 'first post of job d');
select security_test.tsfp_check(public.record_thread_self_post('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105300000000, repeat('d', 64)), 'second post of job d');
reset role;
select security_test.tsfp_check((select message_micros = 1791105300000000 and job_first_micros = 1791105000000000 from public.thread_self_posts
  where org_id = 'c7500000-0000-4000-8000-0000000000a1' and thread_key = repeat('a', 64)), 'same job keeps its first-post anchor');
set role service_role;
select security_test.tsfp_check(public.record_thread_self_post('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105400000000, repeat('e', 64)), 'post of job e');
reset role;
select security_test.tsfp_check((select job_key = repeat('e', 64) and job_first_micros = 1791105400000000 from public.thread_self_posts
  where org_id = 'c7500000-0000-4000-8000-0000000000a1' and thread_key = repeat('a', 64)), 'a different job re-anchors');
set role service_role;
select security_test.tsfp_check(public.record_thread_self_post('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105100000000, repeat('d', 64)), 'older post accepted call');
select security_test.tsfp_check(public.record_thread_self_post('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105500000000, null), 'post without a job key');
reset role;
select security_test.tsfp_check((select job_key is null and job_first_micros = 1791105500000000 and message_micros = 1791105500000000 from public.thread_self_posts
  where org_id = 'c7500000-0000-4000-8000-0000000000a1' and thread_key = repeat('a', 64)), 'older ignored; no job key re-anchors');
set role service_role;
select security_test.tsfp_check(not public.record_thread_self_post('c7500000-0000-4000-8000-0000000000a2', 'c7600000-0000-4000-8000-000000000001',
  repeat('a', 64), 1791105900000000, repeat('d', 64)), 'employee of another org refused');
reset role;

-- (3b) same-job lease reuse (#293 decision 1): 6-arg acquire with a job key
set role service_role;
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-000000000001', 60, repeat('d', 64))->>'state' = 'acquired', 'job d acquires');
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-000000000002', 60, repeat('d', 64))->>'state' = 'busy', 'no post yet → busy');
reset role;
insert into public.thread_self_posts(org_id, employee_id, thread_key, message_micros, job_key, job_first_micros)
  values ('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001', repeat('b', 64),
          (extract(epoch from now()) * 1000000)::bigint, repeat('d', 64), (extract(epoch from now()) * 1000000)::bigint - 60000000);
insert into public.employees(id, org_id, display_name, role_label) values
 ('c7600000-0000-4000-8000-000000000002', 'c7500000-0000-4000-8000-0000000000a1', 'TSFP A2', 'fixture');
set role service_role;
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-000000000003', 60, repeat('e', 64))->>'state' = 'busy', 'different job → busy');
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000002', 'c7800000-0000-4000-8000-000000000004', 60, repeat('d', 64))->>'state' = 'busy', 'other employee, same job key → busy');
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-000000000005', 60, null)->>'state' = 'busy', 'no job key → busy');
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-000000000006', 60, repeat('d', 64))->>'state' = 'acquired', 'same job within 10 min re-enters');
select security_test.tsfp_check(not public.release_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7800000-0000-4000-8000-000000000001'), 'the replaced lease id can no longer release');
reset role;
update public.thread_self_posts set job_first_micros = (extract(epoch from now()) * 1000000)::bigint - 601000000
  where org_id = 'c7500000-0000-4000-8000-0000000000a1' and thread_key = repeat('b', 64);
set role service_role;
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-000000000007', 60, repeat('d', 64))->>'state' = 'busy', 'same job after 10 min → busy');
-- BOLA: org B's post with the same job key on the same thread key never lets org A's lease be re-entered by org B
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a2', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000003', 'c7800000-0000-4000-8000-000000000008', 60, repeat('d', 64))->>'state' = 'acquired', 'other org independent');
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64),
  'c7600000-0000-4000-8000-000000000003', 'c7800000-0000-4000-8000-000000000009', 60, repeat('d', 64))->>'state' = 'denied', 'employee of another org denied');
select security_test.tsfp_check(public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('c', 64),
  'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-00000000000a', 60, 'not-hex')->>'state' = 'denied', 'bad job key denied');
reset role;

-- (3c)
set role service_role;
select security_test.tsfp_check(public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1',
  'c7600000-0000-4000-8000-000000000001', repeat('e', 64), 2000000), 'wake recorded');
select security_test.tsfp_check(public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1',
  'c7600000-0000-4000-8000-000000000001', repeat('e', 64), 1000000), 'older wake accepted (no-op)');
select security_test.tsfp_check((select wake_micros from public.thread_wake_points where org_id = 'c7500000-0000-4000-8000-0000000000a1'
  and employee_id = 'c7600000-0000-4000-8000-000000000001' and thread_key = repeat('e', 64)) = 2000000, 'forward only');
select security_test.tsfp_check(public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1',
  'c7600000-0000-4000-8000-000000000001', repeat('e', 64), 3000000), 'newer wake');
select security_test.tsfp_check((select wake_micros from public.thread_wake_points where org_id = 'c7500000-0000-4000-8000-0000000000a1'
  and employee_id = 'c7600000-0000-4000-8000-000000000001' and thread_key = repeat('e', 64)) = 3000000, 'moved forward');
select security_test.tsfp_check(not public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1',
  'c7600000-0000-4000-8000-000000000003', repeat('e', 64), 4000000), 'BOLA: employee of another org → false');
select security_test.tsfp_check(not exists (select 1 from public.thread_wake_points where employee_id = 'c7600000-0000-4000-8000-000000000003'), 'BOLA: nothing written');
select security_test.tsfp_check(not public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1',
  'c7600000-0000-4000-8000-000000000001', 'not-hex', 4000000), 'bad key → false');
select security_test.tsfp_check(not public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1',
  'c7600000-0000-4000-8000-000000000001', repeat('e', 64), 0), 'bad ts → false');
reset role;

-- (4)
set role anon;
select security_test.tsfp_denied($c$select public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001', repeat('e', 64), 5000000)$c$);
select security_test.tsfp_denied($c$select public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64), 'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-00000000000c', 60, repeat('d', 64))$c$);
select security_test.tsfp_denied($c$select public.close_approval_without_send('c7700000-0000-4000-8000-000000000003', 'c7500000-0000-4000-8000-0000000000a1', array['approved'], 'superseded', '{}'::jsonb)$c$);
reset role;
set role authenticated;
select security_test.tsfp_denied($c$select public.close_approval_without_send('c7700000-0000-4000-8000-000000000003', 'c7500000-0000-4000-8000-0000000000a1', array['approved'], 'superseded', '{}'::jsonb)$c$);
select security_test.tsfp_denied($c$update public.thread_self_posts set job_first_micros = 1$c$);
select security_test.tsfp_denied($c$select * from public.thread_wake_points$c$);
select security_test.tsfp_denied($c$select public.record_thread_wake_point('c7500000-0000-4000-8000-0000000000a1', 'c7600000-0000-4000-8000-000000000001', repeat('e', 64), 5000000)$c$);
select security_test.tsfp_denied($c$select public.acquire_thread_send_lease('c7500000-0000-4000-8000-0000000000a1', repeat('b', 64), 'c7600000-0000-4000-8000-000000000001', 'c7800000-0000-4000-8000-00000000000b', 60, repeat('d', 64))$c$);
reset role;

delete from public.approval_requests where id::text like 'c7700000-%';
delete from public.orgs where id::text like 'c7500000-%';
