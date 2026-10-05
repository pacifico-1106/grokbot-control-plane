-- Duplicate post guard v2 (migration 20261005200000). Synthetic fixtures only;
-- runs inside scripts/test-db-local.py's disposable cluster after
-- db-comm-reply-dedup.sql (reuses its orgs / employees a1 / a2 / b1).
\set ON_ERROR_STOP 1
reset role;
insert into public.approval_requests(id,org_id,employee_id,purpose,summary,risk,status,tool,created_at) values
 ('83000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-0000000000a1','81000000-0000-4000-8000-000000000001','comm.internal','guard v2 fixture','high','approved','comm.send', now() - interval '20 minutes'),
 ('83000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-0000000000a1','81000000-0000-4000-8000-000000000002','comm.internal','guard v2 fixture','high','approved','comm.send', now() - interval '20 minutes')
on conflict (id) do nothing;

-- (1) ACL: anon / authenticated cannot call the v2 RPCs.
set role anon;
select security_test.denied($c$select public.claim_outbound_send_v2(gen_random_uuid(),gen_random_uuid(),repeat('a',64),repeat('a',64),null,repeat('1',64),null,'comm.reply',null,1800,0.6,172800,true,'block',false)$c$);
select security_test.denied($c$select public.release_uncertain_outbound_send(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())$c$);
reset role;
set role authenticated;
select security_test.denied($c$select public.claim_outbound_send_v2(gen_random_uuid(),gen_random_uuid(),repeat('a',64),repeat('a',64),null,repeat('1',64),null,'comm.reply',null,1800,0.6,172800,true,'block',false)$c$);
select security_test.denied($c$select public.release_uncertain_outbound_send(gen_random_uuid(),gen_random_uuid(),gen_random_uuid())$c$);
select security_test.denied($c$select * from public.comm_reply_send_fingerprints$c$);
reset role;

-- (2) semantics as service_role. Failures are collected so the count is reported.
create or replace function security_test.claim2(
  emp text, org text, conv text, chan text, job text, body text, sk integer[], appr text,
  win integer, cross_thread boolean, cross_emp text, dry boolean default false, tool text default 'comm.reply')
returns jsonb language sql security invoker as $$
  select public.claim_outbound_send_v2(org::uuid, emp::uuid, conv, chan, job, body, sk, tool, appr::uuid,
    win, 0.6, 2592000, cross_thread, cross_emp, dry)
$$;
grant execute on function security_test.claim2(text,text,text,text,text,text,integer[],text,integer,boolean,text,boolean,text) to service_role;
set role service_role;
do $$
declare
  org_a text := '80000000-0000-4000-8000-0000000000a1';
  org_b text := '80000000-0000-4000-8000-0000000000a2';
  e1 text := '81000000-0000-4000-8000-000000000001';
  e2 text := '81000000-0000-4000-8000-000000000002';
  e3 text := '81000000-0000-4000-8000-000000000003';
  top text := repeat('a',64);    -- channel top level
  thr text := repeat('b',64);    -- a thread in the same channel
  chan text := repeat('c',64);   -- channel-level key shared by both
  job text := repeat('9',64);
  sk integer[] := array_fill(7, array[128]);
  sk_close integer[];
  sk_other integer[] := array(select 5000 + g from generate_series(1,128) g);
  fails text[] := '{}';
  r jsonb;
  rid uuid;
begin
  sk_close := sk; for i in 1..30 loop sk_close[i] := 1000 + i; end loop;   -- ≈ 0.77

  -- same conversation, exact → duplicate (same_conversation)
  r := security_test.claim2(e1, org_a, top, chan, null, repeat('1',64), sk, null, 21600, true, 'block');
  if r->>'state' <> 'claimed' then raise exception 'setup: %', r; end if;
  rid := (r->>'id')::uuid;
  perform public.finish_comm_reply_send(rid, org_a::uuid, 'sent');
  r := security_test.claim2(e1, org_a, top, chan, null, repeat('1',64), sk, null, 21600, true, 'block');
  if r->>'state' <> 'duplicate' or r->>'scope' is distinct from 'same_conversation' then fails := fails || format('same conversation → %s', r); end if;

  -- (2) cross-thread: the thread of the same channel, similar body → duplicate (cross_thread);
  -- with p_cross_thread=false it is another conversation.
  r := security_test.claim2(e1, org_a, thr, chan, null, repeat('2',64), sk_close, null, 21600, true, 'block');
  if r->>'state' <> 'duplicate' or r->>'scope' is distinct from 'cross_thread' or r->>'match' <> 'similar' then fails := fails || format('cross thread → %s', r); end if;
  r := security_test.claim2(e1, org_a, thr, chan, null, repeat('2',64), sk_close, null, 21600, false, 'block', true);
  if r->>'state' <> 'none' then fails := fails || format('cross thread off (dry) → %s', r); end if;

  -- (3) cross-employee: block → duplicate (cross_employee); warn → claimed with a warning; off → plain claim
  r := security_test.claim2(e2, org_a, thr, chan, null, repeat('1',64), sk, null, 21600, true, 'block', true);
  if r->>'state' <> 'duplicate' or r->>'scope' is distinct from 'cross_employee' then fails := fails || format('cross employee block → %s', r); end if;
  if r ? 'matched_id' then fails := fails || format('cross employee leaks the other employee''s row id → %s', r); end if;
  r := security_test.claim2(e2, org_a, thr, chan, null, repeat('1',64), sk, null, 21600, true, 'warn', true);
  if r->>'state' <> 'none' or r->'warning'->>'scope' is distinct from 'cross_employee' then fails := fails || format('cross employee warn → %s', r); end if;
  r := security_test.claim2(e2, org_a, thr, chan, null, repeat('1',64), sk, null, 21600, true, 'off', true);
  if r->>'state' <> 'none' or r ? 'warning' then fails := fails || format('cross employee off → %s', r); end if;
  -- other org never matches
  r := security_test.claim2(e3, org_b, top, chan, null, repeat('1',64), sk, null, 21600, true, 'block', true);
  if r->>'state' <> 'none' then fails := fails || format('other org → %s', r); end if;

  -- dry run writes nothing
  if (select count(*) from public.comm_reply_send_fingerprints where channel_key = chan) <> 1 then
    fails := fails || 'dry run wrote rows'; end if;

  -- (1) same job: once regardless of the window (window 60 s, row 3 days old)
  r := security_test.claim2(e1, org_a, top, chan, job, repeat('3',64), sk_other, null, 21600, true, 'block');
  if r->>'state' <> 'claimed' then raise exception 'job setup: %', r; end if;
  perform public.finish_comm_reply_send((r->>'id')::uuid, org_a::uuid, 'sent');
  update public.comm_reply_send_fingerprints set created_at = now() - interval '3 days' where job_key = job;
  r := security_test.claim2(e1, org_a, top, chan, job, repeat('3',64), sk_other, null, 60, true, 'block', true);
  if r->>'state' <> 'duplicate' or r->>'scope' is distinct from 'same_job' then fails := fails || format('same job outside window → %s', r); end if;
  -- same job, another message → not a duplicate; another job, same body outside the window → not a duplicate
  r := security_test.claim2(e1, org_a, top, chan, job, repeat('4',64), sk, null, 60, true, 'block', true);
  if r->>'state' <> 'none' then fails := fails || format('same job, other body → %s', r); end if;
  r := security_test.claim2(e1, org_a, top, chan, repeat('8',64), repeat('3',64), sk_other, null, 60, true, 'block', true);
  if r->>'state' <> 'none' then fails := fails || format('other job outside window → %s', r); end if;

  -- (5) uncertain rows: reported with matched_state; release only by the same org + employee
  r := security_test.claim2(e1, org_a, repeat('d',64), repeat('e',64), null, repeat('5',64), null, null, 21600, true, 'block');
  rid := (r->>'id')::uuid;
  perform public.finish_comm_reply_send(rid, org_a::uuid, 'uncertain');
  r := security_test.claim2(e1, org_a, repeat('d',64), repeat('e',64), null, repeat('5',64), null, null, 21600, true, 'block');
  if r->>'state' <> 'duplicate' or r->>'matched_state' is distinct from 'uncertain' or (r->>'matched_id')::uuid is distinct from rid then
    fails := fails || format('uncertain match → %s', r); end if;
  if public.release_uncertain_outbound_send(rid, org_a::uuid, e2::uuid) then fails := fails || 'other employee released'; end if;
  if public.release_uncertain_outbound_send(rid, org_b::uuid, e1::uuid) then fails := fails || 'other org released'; end if;
  if not public.release_uncertain_outbound_send(rid, org_a::uuid, e1::uuid) then fails := fails || 'owner could not release'; end if;
  if public.release_uncertain_outbound_send(rid, org_a::uuid, e1::uuid) then fails := fails || 'released twice'; end if;
  -- a sent row is never released
  if public.release_uncertain_outbound_send((select id from public.comm_reply_send_fingerprints where state='sent' and channel_key=chan and job_key is null limit 1), org_a::uuid, e1::uuid) then
    fails := fails || 'sent row released'; end if;

  -- fulfil: an identical reply after the approval → superseded; an uncertain one → duplicate + matched_state (no close)
  r := security_test.claim2(e1, org_a, repeat('f',64), repeat('f',64), null, repeat('6',64), null, null, 60, true, 'block');
  perform public.finish_comm_reply_send((r->>'id')::uuid, org_a::uuid, 'sent');
  r := security_test.claim2(e1, org_a, repeat('f',64), repeat('f',64), null, repeat('6',64), null, '83000000-0000-4000-8000-000000000001', 60, true, 'block');
  if r->>'state' <> 'superseded' then fails := fails || format('fulfil after identical reply → %s', r); end if;
  r := security_test.claim2(e1, org_a, repeat('f',64), repeat('f',64), null, repeat('7',64), null, null, 60, true, 'block');
  perform public.finish_comm_reply_send((r->>'id')::uuid, org_a::uuid, 'uncertain');
  r := security_test.claim2(e1, org_a, repeat('f',64), repeat('f',64), null, repeat('7',64), null, '83000000-0000-4000-8000-000000000001', 60, true, 'block');
  if r->>'state' <> 'duplicate' or r->>'matched_state' is distinct from 'uncertain' then fails := fails || format('fulfil meets uncertain → %s', r); end if;

  -- sns.publish is a guarded tool now; unknown tools and bad keys are denied
  r := security_test.claim2(e1, org_a, repeat('1',64), repeat('1',64), null, repeat('a',64), null, null, 60, false, 'off', false, 'sns.publish');
  if r->>'state' <> 'claimed' then fails := fails || format('sns.publish → %s', r); end if;
  r := security_test.claim2(e1, org_a, top, chan, null, repeat('1',64), sk, null, 60, true, 'block', false, 'mail.send');
  if r->>'state' <> 'denied' then fails := fails || format('mail.send → %s', r); end if;
  r := security_test.claim2(e1, org_a, top, 'not-hex', null, repeat('1',64), sk, null, 60, true, 'block');
  if r->>'state' <> 'denied' then fails := fails || format('bad channel key → %s', r); end if;
  r := security_test.claim2(e1, org_a, top, chan, 'not-hex', repeat('1',64), sk, null, 60, true, 'block');
  if r->>'state' <> 'denied' then fails := fails || format('bad job key → %s', r); end if;
  r := security_test.claim2(e1, org_a, top, chan, null, repeat('1',64), sk, null, 60, true, 'sometimes');
  if r->>'state' <> 'denied' then fails := fails || format('bad cross-employee mode → %s', r); end if;
  r := security_test.claim2(e3, org_a, top, chan, null, repeat('1',64), sk, null, 60, true, 'block');
  if r->>'state' <> 'denied' then fails := fails || format('employee of another org → %s', r); end if;
  r := security_test.claim2(e2, org_a, top, chan, null, repeat('1',64), sk, '83000000-0000-4000-8000-000000000001', 60, true, 'block');
  if r->>'state' <> 'denied' then fails := fails || format('approval of another employee → %s', r); end if;

  if cardinality(fails) > 0 then
    raise exception 'duplicate guard v2: % case(s) wrong: %', cardinality(fails), array_to_string(fails, ' | ');
  end if;
end $$;
reset role;

-- (3) the ledger still holds hashes only (text columns: keys / hashes / tool / state).
select security_test.check_true(not exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='comm_reply_send_fingerprints'
    and data_type='text' and column_name not in ('conversation_key','channel_key','job_key','body_hash','tool','state')));
select security_test.check_true((select relrowsecurity from pg_class where oid='public.comm_reply_send_fingerprints'::regclass));
-- clean up the channel used by the concurrency check in test-db-local.py
delete from public.comm_reply_send_fingerprints where channel_key = repeat('7',64);
