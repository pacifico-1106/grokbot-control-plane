-- Operator notices (migration 20261016200000). Synthetic fixtures only
-- (ids b1000000-… / ntc_ + 26 Crockford chars). Cleans up after itself.
--  (1) anon / authenticated: no SELECT / INSERT / UPDATE / DELETE on any of
--      the 6 tables, and cannot execute the visibility functions
--  (2) service_role reads / writes (RLS on, no policy, BYPASSRLS)
--  (3) tenant isolation: org-A notice is invisible to org-B employee;
--      ack/receipt insert for the other org raises operator_notice_receipt_not_visible;
--      target employee in another org raises operator_notice_cross_org
--  (4) audience_scope=all cannot have targets; published audience is locked
--  (5) value CHECKs (id, status, severity, title length, body combined 8000)
--  (6) visibility SQL uses orgs.created_at (sticky vs new tenant)
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.opntc_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'operator notices: session access not denied: %', command;
end $$;
create or replace function security_test.opntc_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 then return; end if;
    raise exception 'operator notices: % failed with "%" (expected "%")', command, sqlerrm, expected;
  end;
  raise exception 'operator notices: not rejected: %', command;
end $$;
grant execute on function security_test.opntc_denied(text), security_test.opntc_rejects(text, text) to anon, authenticated, service_role;

insert into public.orgs(id, name, created_at) values
 ('b1000000-0000-4000-8000-0000000000a1', 'op-notices-a', '2020-01-01T00:00:00Z'),
 ('b1000000-0000-4000-8000-0000000000a2', 'op-notices-b', '2020-01-01T00:00:00Z'),
 ('b1000000-0000-4000-8000-0000000000a3', 'op-notices-new', '2026-10-01T00:00:00Z');
insert into public.employees(id, org_id, display_name, role_label) values
 ('b1100000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-0000000000a1', 'Notices A1', 'fixture'),
 ('b1100000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-0000000000a2', 'Notices B1', 'fixture'),
 ('b1100000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-0000000000a3', 'Notices New', 'fixture');

set role service_role;

-- (2) service_role writes a published all-audience notice + an org-A notice
insert into public.operator_notices
  (id, version, status, severity, title, change_summary, ai_usage_change, effective_at,
   audience_scope, sticky, apply_mode, body_hash, published_at)
values
  ('ntc_00000000000000000000000001', 1, 'published', 'normal', 'all tenants', 'summary', 'usage', now(),
   'all', false, 'self_rules', repeat('a', 64), '2026-06-01T00:00:00Z'),
  ('ntc_00000000000000000000000002', 1, 'published', 'urgent', 'org A only', 'secret-a', 'do-not-leak', now(),
   'orgs', false, 'self_rules', repeat('b', 64), now());
insert into public.operator_notice_versions
  (notice_id, version, kind, title, change_summary, ai_usage_change, body_hash)
values
  ('ntc_00000000000000000000000001', 1, 'initial', 'all tenants', 'summary', 'usage', repeat('a', 64)),
  ('ntc_00000000000000000000000002', 1, 'initial', 'org A only', 'secret-a', 'do-not-leak', repeat('b', 64));
insert into public.operator_notice_targets (notice_id, org_id, employee_id)
values ('ntc_00000000000000000000000002', 'b1000000-0000-4000-8000-0000000000a1', null);

-- (3) org B cannot see org-A-only notice; org A can
do $$
declare n int; u int; uu int; p int;
begin
  select count(*) into n from public.operator_notices_for_employee(
    'b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000001')
    where id = 'ntc_00000000000000000000000002';
  if n <> 1 then raise exception 'operator notices: org A missed its notice'; end if;
  select count(*) into n from public.operator_notices_for_employee(
    'b1000000-0000-4000-8000-0000000000a2', 'b1100000-0000-4000-8000-000000000002')
    where id = 'ntc_00000000000000000000000002';
  if n <> 0 then raise exception 'operator notices: org B saw org A notice'; end if;
  -- swapped employee / org (credential mix-up) → empty, not an error
  select count(*) into n from public.operator_notices_for_employee(
    'b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000002');
  if n <> 0 then raise exception 'operator notices: mixed org/employee was visible'; end if;
  -- counts: org B unread for the A-only notice stays 0
  select unread, urgent_unread, pending_apply into u, uu, p
    from public.operator_notice_counts_for_employee(
      'b1000000-0000-4000-8000-0000000000a2', 'b1100000-0000-4000-8000-000000000002');
  -- org B still sees the all-audience notice (org created before publish)
  if u < 1 then raise exception 'operator notices: org B should still see the all-audience notice'; end if;
  select unread, urgent_unread into u, uu
    from public.operator_notice_counts_for_employee(
      'b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000001');
  if uu < 1 then raise exception 'operator notices: org A urgent unread missing'; end if;
end $$;

-- (6) new tenant (created after published_at) does not see non-sticky all-audience
do $$
declare n int;
begin
  select count(*) into n from public.operator_notices_for_employee(
    'b1000000-0000-4000-8000-0000000000a3', 'b1100000-0000-4000-8000-000000000003')
    where id = 'ntc_00000000000000000000000001';
  if n <> 0 then raise exception 'operator notices: new tenant saw non-sticky all notice'; end if;
end $$;

-- (3) receipt for the other org is rejected
select security_test.opntc_rejects($c$
  insert into public.operator_notice_receipts (notice_id, org_id, employee_id, state)
  values ('ntc_00000000000000000000000002', 'b1000000-0000-4000-8000-0000000000a2', 'b1100000-0000-4000-8000-000000000002', 'delivered')
$c$, 'operator_notice_receipt_not_visible');

-- mixed org on a visible all-audience notice (employee B + org A)
select security_test.opntc_rejects($c$
  insert into public.operator_notice_receipts (notice_id, org_id, employee_id, state)
  values ('ntc_00000000000000000000000001', 'b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000002', 'delivered')
$c$, 'operator_notice_receipt_not_visible');

-- same-org receipt for the A-only notice is allowed
insert into public.operator_notice_receipts (notice_id, org_id, employee_id, state)
values ('ntc_00000000000000000000000002', 'b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000001', 'delivered');

-- target employee in another org
insert into public.operator_notices
  (id, version, status, severity, title, change_summary, ai_usage_change, effective_at,
   audience_scope, apply_mode, body_hash)
values
  ('ntc_00000000000000000000000003', 1, 'draft', 'info', 'draft emp', 's', 'u', now(),
   'employees', 'none', repeat('c', 64));
select security_test.opntc_rejects($c$
  insert into public.operator_notice_targets (notice_id, org_id, employee_id)
  values ('ntc_00000000000000000000000003', 'b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000002')
$c$, 'operator_notice_cross_org');

-- (4) all-scope cannot gain targets; published audience locked
select security_test.opntc_rejects($c$
  insert into public.operator_notice_targets (notice_id, org_id)
  values ('ntc_00000000000000000000000001', 'b1000000-0000-4000-8000-0000000000a1')
$c$, 'operator_notice_all_has_no_targets');
select security_test.opntc_rejects($c$
  insert into public.operator_notice_targets (notice_id, org_id)
  values ('ntc_00000000000000000000000002', 'b1000000-0000-4000-8000-0000000000a2')
$c$, 'operator_notice_targets_locked');
select security_test.opntc_rejects($c$
  update public.operator_notices set audience_scope = 'orgs' where id = 'ntc_00000000000000000000000001'
$c$, 'operator_notice_audience_locked');

-- (5) shape
select security_test.opntc_rejects($c$
  insert into public.operator_notices (id, title, change_summary, ai_usage_change, effective_at, body_hash)
  values ('ntc_short', 't', 's', 'u', now(), repeat('d', 64))
$c$, 'operator_notices_id_check');
select security_test.opntc_rejects($c$
  insert into public.operator_notices (id, title, change_summary, ai_usage_change, effective_at, body_hash, status)
  values ('ntc_00000000000000000000000009', 't', 's', 'u', now(), repeat('d', 64), 'live')
$c$, 'operator_notices_status_check');
select security_test.opntc_rejects($c$
  insert into public.operator_notices (id, title, change_summary, ai_usage_change, effective_at, body_hash)
  values ('ntc_00000000000000000000000009', repeat('t', 121), 's', 'u', now(), repeat('d', 64))
$c$, 'operator_notices_title_check');

-- feedback item / event same-org
insert into public.ops_feedback_items (id, org_id, employee_id, kind, source, title, body, job_id)
values ('fb_00000000000000000000000001', 'b1000000-0000-4000-8000-0000000000a1',
        'b1100000-0000-4000-8000-000000000001', 'request', 'ai_employee', 'please', 'body', 'job-1');
insert into public.ops_feedback_events (item_id, org_id, actor_kind, body)
values ('fb_00000000000000000000000001', 'b1000000-0000-4000-8000-0000000000a1', 'ai_employee', 'opened');
select security_test.opntc_rejects($c$
  insert into public.ops_feedback_events (item_id, org_id, actor_kind, body)
  values ('fb_00000000000000000000000001', 'b1000000-0000-4000-8000-0000000000a2', 'operator', 'nope')
$c$, 'ops_feedback_cross_org');

reset role;

-- (1) sessions: nothing
set role anon;
select security_test.opntc_denied($c$select * from public.operator_notices$c$);
select security_test.opntc_denied($c$select * from public.operator_notice_receipts$c$);
select security_test.opntc_denied($c$select * from public.ops_feedback_items$c$);
select security_test.opntc_denied($c$select public.operator_notices_for_employee('b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000001')$c$);
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'b1200000-0000-4000-8000-000000000001', false);
select security_test.opntc_denied($c$select * from public.operator_notices$c$);
select security_test.opntc_denied($c$select title from public.operator_notices$c$);
select security_test.opntc_denied($c$insert into public.operator_notices (id, title, change_summary, ai_usage_change, effective_at, body_hash)
  values ('ntc_00000000000000000000000008', 'x', 's', 'u', now(), repeat('e', 64))$c$);
select security_test.opntc_denied($c$delete from public.operator_notice_receipts$c$);
select security_test.opntc_denied($c$select public.operator_notice_counts_for_employee('b1000000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-000000000001')$c$);
select set_config('request.jwt.claim.sub', '', false);
reset role;

do $$ begin
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in (
      'operator_notices', 'operator_notice_versions', 'operator_notice_targets',
      'operator_notice_receipts', 'ops_feedback_items', 'ops_feedback_events')) then
    raise exception 'operator notices: tables must have no policy';
  end if;
  if not (select bool_and(relrowsecurity) from pg_class where oid in (
      'public.operator_notices'::regclass, 'public.operator_notice_versions'::regclass,
      'public.operator_notice_targets'::regclass, 'public.operator_notice_receipts'::regclass,
      'public.ops_feedback_items'::regclass, 'public.ops_feedback_events'::regclass)) then
    raise exception 'operator notices: RLS must be enabled';
  end if;
end $$;

-- cleanup fixtures (keep tables)
reset role;
delete from public.ops_feedback_events where item_id like 'fb_000000000000000000000000%';
delete from public.ops_feedback_items where id like 'fb_000000000000000000000000%';
delete from public.operator_notice_receipts where notice_id like 'ntc_000000000000000000000000%';
delete from public.operator_notice_targets where notice_id like 'ntc_000000000000000000000000%';
delete from public.operator_notice_versions where notice_id like 'ntc_000000000000000000000000%';
delete from public.operator_notices where id like 'ntc_000000000000000000000000%';
delete from public.employees where id in (
  'b1100000-0000-4000-8000-000000000001',
  'b1100000-0000-4000-8000-000000000002',
  'b1100000-0000-4000-8000-000000000003');
delete from public.orgs where id in (
  'b1000000-0000-4000-8000-0000000000a1',
  'b1000000-0000-4000-8000-0000000000a2',
  'b1000000-0000-4000-8000-0000000000a3');

drop function if exists security_test.opntc_denied(text);
drop function if exists security_test.opntc_rejects(text, text);
