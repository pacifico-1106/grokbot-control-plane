-- Follow-up to PR-B (H1): per-org hourly budget windows (migration
-- 20261005400000). Synthetic fixtures only (ids c6000000-…); cleans up.
-- Runs in scripts/test-db-local.py and after the full history in
-- scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no access to the table, no EXECUTE on the RPC; RLS on, no policy
--  (2) allowed up to max → over_first once → over; counts kept
--  (3) per org and per key independent (another org's exhausted budget never blocks)
--  (4) expired window resets (used / overflow / summary_sent)
--  (5) bad input → denied; org delete cascades
\set ON_ERROR_STOP 1
reset role;
create or replace function security_test.ccb_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'channel classify budget: session access not denied: %', command;
end $$;
create or replace function security_test.ccb_check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'channel classify budget: check failed: %', label; end if;
end $$;
grant execute on function security_test.ccb_denied(text), security_test.ccb_check(boolean, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('c6000000-0000-4000-8000-0000000000a1', 'channel-classify-budget-a'),
 ('c6000000-0000-4000-8000-0000000000a2', 'channel-classify-budget-b');

set role service_role;
-- (2)
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)->>'state' = 'allowed', 'first allowed');
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)->>'state' = 'allowed', 'second allowed');
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)->>'state' = 'over_first', 'third → over_first');
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)->>'state' = 'over', 'fourth → over');
select security_test.ccb_check((select used = 2 and overflow = 2 and summary_sent from public.channel_classify_budget_windows
  where org_id = 'c6000000-0000-4000-8000-0000000000a1' and budget_key = 'proposals'), 'counts kept');
-- (3)
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a2', 'proposals', 3600, 2)->>'state' = 'allowed', 'other org independent');
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'notices', 3600, 2)->>'state' = 'allowed', 'other key independent');
reset role;
-- (4)
update public.channel_classify_budget_windows set window_start = now() - interval '2 hours'
  where org_id = 'c6000000-0000-4000-8000-0000000000a1' and budget_key = 'proposals';
set role service_role;
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)->>'state' = 'allowed', 'expired window resets');
select security_test.ccb_check((select used = 1 and overflow = 0 and not summary_sent from public.channel_classify_budget_windows
  where org_id = 'c6000000-0000-4000-8000-0000000000a1' and budget_key = 'proposals'), 'reset counts');
-- (5)
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'Bad Key', 3600, 2)->>'state' = 'denied', 'bad key');
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 10, 2)->>'state' = 'denied', 'bad window');
select security_test.ccb_check(public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 0)->>'state' = 'denied', 'bad max');
select security_test.ccb_check(public.take_channel_classify_budget(null, 'proposals', 3600, 2)->>'state' = 'denied', 'null org');
reset role;

-- (1)
set role anon;
select security_test.ccb_denied($c$select * from public.channel_classify_budget_windows$c$);
select security_test.ccb_denied($c$select public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)$c$);
reset role;
set role authenticated;
select security_test.ccb_denied($c$select * from public.channel_classify_budget_windows$c$);
select security_test.ccb_denied($c$insert into public.channel_classify_budget_windows(org_id, budget_key, window_start) values ('c6000000-0000-4000-8000-0000000000a1', 'proposals', now())$c$);
select security_test.ccb_denied($c$update public.channel_classify_budget_windows set used = 0$c$);
select security_test.ccb_denied($c$select public.take_channel_classify_budget('c6000000-0000-4000-8000-0000000000a1', 'proposals', 3600, 2)$c$);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'channel_classify_budget_windows') then
    raise exception 'channel classify budget: table must have no policy';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.channel_classify_budget_windows'::regclass) then
    raise exception 'channel classify budget: RLS must be enabled';
  end if;
end $$;

-- (5) cascade
delete from public.orgs where id::text like 'c6000000-%';
do $$ begin
  if exists (select 1 from public.channel_classify_budget_windows where org_id::text like 'c6000000-%') then
    raise exception 'channel classify budget: org delete did not cascade';
  end if;
end $$;
drop function security_test.ccb_denied(text);
drop function security_test.ccb_check(boolean, text);
