-- Path C one-time re-wake store (migration 20261009700000). Synthetic fixtures
-- only (ids c9000000-…); cleans up after itself. Runs in scripts/test-db-local.py
-- and after the full history in scripts/test-db-all-migrations.py.
--  (1) anon / authenticated: no table access, no EXECUTE on the two RPCs; RLS on, no policy
--  (2) record: employee of another org → denied; bad ids → denied; first → recorded;
--      older out-of-order → kept; newer → recorded (replaces)
--  (3) claim: pending / other-org / missing approval → denied; approved own → rows once;
--      second claim → empty (exactly once); other org never sees the row
--  (4) newer skip after a claim reopens; an older one does not; TTL excludes stale rows
--  (5) org delete cascades
\set ON_ERROR_STOP 1
reset role;
create or replace function security_test.ssw_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'skipped wakes: session access not denied: %', command;
end $$;
create or replace function security_test.ssw_check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'skipped wakes: check failed: %', label; end if;
end $$;
grant execute on function security_test.ssw_denied(text), security_test.ssw_check(boolean, text) to anon, authenticated, service_role;

insert into public.orgs(id, name) values
 ('c9000000-0000-4000-8000-0000000000a1', 'skipped-wakes-fixture-a'),
 ('c9000000-0000-4000-8000-0000000000a2', 'skipped-wakes-fixture-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('c9200000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-0000000000a1', 'fixture-a', 'fixture'),
 ('c9200000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-0000000000a2', 'fixture-b', 'fixture');
insert into public.approval_requests(id, org_id, purpose, summary, risk, status, tool) values
 ('c9100000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'approved', 'channels.classify'),
 ('c9100000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-0000000000a2', 'admin.channel', 'fixture', 'high', 'approved', 'channels.classify'),
 ('c9100000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'pending', 'channels.classify'),
 ('c9100000-0000-4000-8000-000000000004', 'c9000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'approved', 'channels.classify');
-- 21:53 (2): the claim accepts only THIS channel's classification ticket.
update public.approval_requests set metadata = '{"adminMutation":{"surface":"slack","externalId":"C0SSWTEST1","classification":"internal"}}'::jsonb
  where id in ('c9100000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-000000000002', 'c9100000-0000-4000-8000-000000000003', 'c9100000-0000-4000-8000-000000000004');
insert into public.approval_requests(id, org_id, purpose, summary, risk, status, tool, metadata) values
 ('c9100000-0000-4000-8000-000000000005', 'c9000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'approved', 'channels.classify', '{"adminMutation":{"surface":"slack","externalId":"C0SSWOTHER","classification":"internal"}}'),
 ('c9100000-0000-4000-8000-000000000006', 'c9000000-0000-4000-8000-0000000000a1', 'admin.party', 'fixture', 'high', 'approved', 'parties.upsert', '{"adminMutation":{"surface":"slack","externalId":"C0SSWTEST1"}}'),
 ('c9100000-0000-4000-8000-000000000007', 'c9000000-0000-4000-8000-0000000000a1', 'config.change', 'fixture', 'high', 'approved', 'config.change_request', '{"configChange":{"proposal":{"kind":"channel_classification","surface":"slack","externalId":"C0SSWTEST1","classification":"internal"}}}'),
 ('c9100000-0000-4000-8000-000000000008', 'c9000000-0000-4000-8000-0000000000a1', 'config.change', 'fixture', 'high', 'approved', 'config.change_request', '{"configChange":{"proposal":{"kind":"instructions","mode":"append","text":"x"}}}'),
 ('c9100000-0000-4000-8000-000000000009', 'c9000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'approved', 'channels.classify', '{}'),
 ('c9100000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-0000000000a1', 'admin.channel', 'fixture', 'high', 'approved', 'channels.classify', '{"adminMutation":{"surface":"line","externalId":"C0SSWTEST1"}}');

-- (1) sessions
set role anon;
select security_test.ssw_denied($c$select * from public.slack_skipped_channel_wakes$c$);
select security_test.ssw_denied($c$select public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000001', 3600)$c$);
reset role;
set role authenticated;
select security_test.ssw_denied($c$select * from public.slack_skipped_channel_wakes$c$);
select security_test.ssw_denied($c$insert into public.slack_skipped_channel_wakes(org_id, employee_id, channel_id, event_ts, event_id, speaker_slack_user_id, subscriber_slack_user_id, subscriber_team_id) values ('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100001.000001', 'Ev1', 'U0SPEAK1', 'U0SUB1', 'T0TEAM1')$c$);
select security_test.ssw_denied($c$update public.slack_skipped_channel_wakes set claimed_at = null$c$);
select security_test.ssw_denied($c$select public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100001.000001', null, 'Ev1', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')$c$);
select security_test.ssw_denied($c$select public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000001', 3600)$c$);
reset role;
do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'slack_skipped_channel_wakes') then
    raise exception 'skipped wakes: table must have no policy';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.slack_skipped_channel_wakes'::regclass) then
    raise exception 'skipped wakes: RLS must be enabled';
  end if;
end $$;

set role service_role;
-- (2) record
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000002', 'C0SSWTEST1', '1788100001.000001', null, 'Ev1', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'denied', 'employee of another org refused');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'D0NOTACHAN', '1788100001.000001', null, 'Ev1', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'denied', 'DM id refused');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', 'nope', null, 'Ev1', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'denied', 'bad ts refused');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100001.000001', null, 'Ev1', '<b>', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'denied', 'bad speaker refused');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100005.000005', null, 'Ev5', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'recorded', 'first recorded');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100002.000002', null, 'Ev2', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'kept', 'older kept');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100009.000009', '1788100001.000001', 'Ev9', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'recorded', 'newer replaces');
select security_test.ssw_check((select count(*) = 1 and min(event_id) = 'Ev9' from public.slack_skipped_channel_wakes where org_id = 'c9000000-0000-4000-8000-0000000000a1'), 'one row, the latest');

-- (3) claim
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000003', 3600)->>'state' = 'denied', 'pending approval refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000002', 3600)->>'state' = 'denied', 'other org approval refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a2', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000002', 3600)->'rows' = '[]'::jsonb, 'other org sees nothing');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-0000000000ff', 3600)->>'state' = 'denied', 'missing approval refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000005', 3600)->>'state' = 'denied', 'approved ticket for another channel refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000006', 3600)->>'state' = 'denied', 'approved ticket of another tool refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000008', 3600)->>'state' = 'denied', 'non-classification config change refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000009', 3600)->>'state' = 'denied', 'classify ticket without a target refused');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-00000000000a', 3600)->>'state' = 'denied', 'classify ticket for another surface refused');
select security_test.ssw_check((select claimed_at is null from public.slack_skipped_channel_wakes where org_id = 'c9000000-0000-4000-8000-0000000000a1'), 'refused claims left the row unclaimed');
select security_test.ssw_check(jsonb_array_length(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000001', 3600)->'rows') = 1, 'own approved claim → 1 row');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000004', 3600)->'rows' = '[]'::jsonb, 'second claim (other approval) → nothing');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000007', 3600)->>'state' = 'ok', 'config-change channel_classification for this channel accepted');
select security_test.ssw_check((select claimed_approval_id = 'c9100000-0000-4000-8000-000000000001' from public.slack_skipped_channel_wakes where org_id = 'c9000000-0000-4000-8000-0000000000a1'), 'claimed by the first approval');

-- (4) reopen rules + TTL
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100003.000003', null, 'Ev3', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'kept', 'older skip after claim does not reopen');
select security_test.ssw_check(public.record_slack_skipped_channel_wake('c9000000-0000-4000-8000-0000000000a1', 'c9200000-0000-4000-8000-000000000001', 'C0SSWTEST1', '1788100020.000020', null, 'Ev20', 'U0SPEAK1', 'T0TEAM1', 'U0SUB1', 'T0TEAM1')->>'state' = 'recorded', 'newer skip reopens');
reset role;
update public.slack_skipped_channel_wakes set skipped_at = now() - interval '2 hours' where org_id = 'c9000000-0000-4000-8000-0000000000a1';
set role service_role;
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000001', 3600)->'rows' = '[]'::jsonb, 'stale row excluded by TTL');
select security_test.ssw_check(jsonb_array_length(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000001', 86400)->'rows') = 1, 'in a wider window it is claimed once');
select security_test.ssw_check(public.claim_slack_skipped_channel_wakes('c9000000-0000-4000-8000-0000000000a1', 'C0SSWTEST1', 'c9100000-0000-4000-8000-000000000001', 10)->>'state' = 'denied', 'bad ttl refused');
reset role;

-- (5) cascade
delete from public.orgs where id::text like 'c9000000-%';
do $$ begin
  if exists (select 1 from public.slack_skipped_channel_wakes where org_id::text like 'c9000000-%') then
    raise exception 'skipped wakes: org delete did not cascade';
  end if;
end $$;
drop function security_test.ssw_denied(text);
drop function security_test.ssw_check(boolean, text);
