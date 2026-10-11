-- 運営からのお知らせ PR-A (migration 20261013100000). Synthetic fixtures only
-- (ids c7…, ntc_C7…); cleans up after itself. Runs in scripts/test-db-local.py
-- and after every migration in scripts/test-db-all-migrations.py.
--  (1) six tables: RLS on, no policy; anon / authenticated hold no privilege
--      and cannot execute the visibility functions
--  (2) visibility (§2.6): 'all' (sticky / created-before), 'orgs', 'employees';
--      draft / withdrawn / expired never visible; org A's notice invisible to org B
--  (3) targets: employee must belong to org (operator_notice_cross_org); shape
--      must match the scope; locked once the notice leaves draft
--  (4) receipts: only for a real (org, employee) pair AND a visible notice —
--      another tenant's receipt is refused even from service_role
--  (5) notices: audience locked after publish; no republish after withdraw;
--      no version going backwards; 'orgs' / 'employees' cannot publish with no target
--  (6) version history and feedback events are append-only; feedback events
--      stay in the item's org; weekly digest carries no free text
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.on_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'operator notices: session access not denied: %', command;
end $$;
create or replace function security_test.on_raises(command text, needle text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(needle in sqlerrm) > 0 or sqlstate = needle then return; end if;
    raise exception 'operator notices: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, needle;
  end;
  raise exception 'operator notices: not rejected: %', command;
end $$;
grant execute on function security_test.on_denied(text), security_test.on_raises(text, text) to anon, authenticated, service_role;

-- (1)
do $$
declare r text; t text;
begin
  foreach t in array array['operator_notices','operator_notice_versions','operator_notice_targets',
                           'operator_notice_receipts','ops_feedback_items','ops_feedback_events'] loop
    if to_regclass('public.' || t) is null then raise exception 'operator notices: table % missing', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'operator notices: RLS off on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'operator notices: unexpected policy on %', t;
    end if;
    foreach r in array array['anon','authenticated'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT') or has_table_privilege(r, 'public.' || t, 'INSERT')
         or has_table_privilege(r, 'public.' || t, 'UPDATE') or has_table_privilege(r, 'public.' || t, 'DELETE') then
        raise exception 'operator notices: % holds a privilege on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r, 'public.operator_notice_visible(text,uuid,uuid,timestamptz)', 'EXECUTE')
       or has_function_privilege(r, 'public.list_visible_operator_notices(uuid,uuid,timestamptz)', 'EXECUTE') then
      raise exception 'operator notices: % can execute a visibility function', r;
    end if;
  end loop;
end $$;
set role anon;
select security_test.on_denied('select * from public.operator_notices');
select security_test.on_denied('select * from public.list_visible_operator_notices(''c7000000-0000-4000-8000-000000000001'',''c7100000-0000-4000-8000-000000000001'')');
reset role;
set role authenticated;
select security_test.on_denied('select * from public.operator_notice_receipts');
select security_test.on_denied('insert into public.ops_feedback_items(id, org_id, kind, source, title) values (''fb_C7000000000000000000000000'', ''c7000000-0000-4000-8000-000000000001'', ''bug'', ''ai_employee'', ''x'')');
reset role;

-- fixtures: org A and B exist since 2026-01; org C is created after the 'all' notice was published
insert into public.orgs(id, name, created_at) values
  ('c7000000-0000-4000-8000-000000000001', 'on org a', '2026-01-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000002', 'on org b', '2026-01-01T00:00:00Z'),
  ('c7000000-0000-4000-8000-000000000003', 'on org c (new)', '2026-10-01T00:00:00Z')
on conflict (id) do nothing;
insert into public.employees(id, org_id, display_name, role_label) values
  ('c7100000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000001', 'on emp a1', 'r'),
  ('c7100000-0000-4000-8000-000000000002', 'c7000000-0000-4000-8000-000000000001', 'on emp a2', 'r'),
  ('c7100000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000002', 'on emp b1', 'r'),
  ('c7100000-0000-4000-8000-000000000004', 'c7000000-0000-4000-8000-000000000003', 'on emp c1', 'r')
on conflict (id) do nothing;

set role service_role;
-- N1 'all' non-sticky published 2026-09-01; N2 'all' sticky; N3 'orgs' → org A;
-- N4 'employees' → a1 only; N5 draft; N6 'all' expired; N7 withdrawn
insert into public.operator_notices(id, status, title, body_hash, created_by_user_id, audience_scope, sticky,
                                    published_at, published_by_user_id, effective_at, expires_at, withdrawn_at) values
  ('ntc_C7000000000000000000000001', 'published', 'n1', repeat('a', 64), 'op', 'all', false, '2026-09-01T00:00:00Z', 'op', '2026-09-01T00:00:00Z', null, null),
  ('ntc_C7000000000000000000000002', 'published', 'n2', repeat('a', 64), 'op', 'all', true,  '2026-09-01T00:00:00Z', 'op', '2026-09-01T00:00:00Z', null, null),
  ('ntc_C7000000000000000000000005', 'draft',     'n5', repeat('a', 64), 'op', 'all', false, null, null, '2026-09-01T00:00:00Z', null, null),
  ('ntc_C7000000000000000000000006', 'published', 'n6', repeat('a', 64), 'op', 'all', true,  '2026-09-01T00:00:00Z', 'op', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', null),
  ('ntc_C7000000000000000000000007', 'withdrawn', 'n7', repeat('a', 64), 'op', 'all', true,  '2026-09-01T00:00:00Z', 'op', '2026-09-01T00:00:00Z', null, '2026-09-03T00:00:00Z');
insert into public.operator_notices(id, title, body_hash, created_by_user_id, audience_scope) values
  ('ntc_C7000000000000000000000003', 'n3', repeat('a', 64), 'op', 'orgs'),
  ('ntc_C7000000000000000000000004', 'n4', repeat('a', 64), 'op', 'employees');

-- (3) target shape / cross-org / scope
select security_test.on_raises($q$insert into public.operator_notice_targets(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000004', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000003')$q$, 'operator_notice_cross_org');
select security_test.on_raises($q$insert into public.operator_notice_targets(notice_id, org_id)
  values ('ntc_C7000000000000000000000004', 'c7000000-0000-4000-8000-000000000001')$q$, 'operator_notice_scope_mismatch');
select security_test.on_raises($q$insert into public.operator_notice_targets(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001')$q$, 'operator_notice_scope_mismatch');
select security_test.on_raises($q$insert into public.operator_notice_targets(notice_id, org_id)
  values ('ntc_C7000000000000000000000005', 'c7000000-0000-4000-8000-000000000001')$q$, 'operator_notice_scope_mismatch');
-- (5) cannot publish a targeted notice with no target
select security_test.on_raises($q$update public.operator_notices set status = 'published', published_at = now(), published_by_user_id = 'op'
  where id = 'ntc_C7000000000000000000000003'$q$, 'operator_notice_no_targets');
insert into public.operator_notice_targets(notice_id, org_id) values ('ntc_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000001');
insert into public.operator_notice_targets(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000004', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001');
update public.operator_notices set status = 'published', published_at = '2026-09-05T00:00:00Z', published_by_user_id = 'op'
 where id in ('ntc_C7000000000000000000000003', 'ntc_C7000000000000000000000004');
-- (3) targets locked after publish (no widening to org B, no removal, no move)
select security_test.on_raises($q$insert into public.operator_notice_targets(notice_id, org_id)
  values ('ntc_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000002')$q$, 'operator_notice_targets_locked');
select security_test.on_raises($q$update public.operator_notice_targets set org_id = 'c7000000-0000-4000-8000-000000000002'
  where notice_id = 'ntc_C7000000000000000000000003'$q$, 'operator_notice_targets_locked');
select security_test.on_raises($q$delete from public.operator_notice_targets where notice_id = 'ntc_C7000000000000000000000003'$q$, 'operator_notice_targets_locked');
-- (5) audience locked after publish; no republish; no version backwards
select security_test.on_raises($q$update public.operator_notices set sticky = true where id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_audience_locked');
select security_test.on_raises($q$update public.operator_notices set audience_scope = 'orgs' where id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_audience_locked');
select security_test.on_raises($q$update public.operator_notices set status = 'published', withdrawn_at = null where id = 'ntc_C7000000000000000000000007'$q$, 'operator_notice_withdrawn');
select security_test.on_raises($q$update public.operator_notices set status = 'draft', published_at = null where id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_status_backwards');
update public.operator_notices set version = 3, ack_required_version = 2 where id = 'ntc_C7000000000000000000000001';
select security_test.on_raises($q$update public.operator_notices set version = 2 where id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_version_backwards');
select security_test.on_raises($q$update public.operator_notices set ack_required_version = 1 where id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_version_backwards');
select security_test.on_raises($q$update public.operator_notices set ack_required_version = 4 where id = 'ntc_C7000000000000000000000001'$q$, 'operator_notices_check');
select security_test.on_raises($q$insert into public.operator_notices(id, title, body_hash, created_by_user_id, change_summary, ai_usage_change)
  values ('ntc_C7000000000000000000000009', 'x', repeat('a', 64), 'op', repeat('x', 4000), repeat('y', 4001))$q$, 'check');
select security_test.on_raises($q$insert into public.operator_notices(id, title, body_hash, created_by_user_id) values ('ntc_bad', 'x', repeat('a', 64), 'op')$q$, 'operator_notices_id_check');
reset role;

-- (2) visibility matrix
do $$
declare
  a1 constant uuid := 'c7100000-0000-4000-8000-000000000001';
  a2 constant uuid := 'c7100000-0000-4000-8000-000000000002';
  b1 constant uuid := 'c7100000-0000-4000-8000-000000000003';
  c1 constant uuid := 'c7100000-0000-4000-8000-000000000004';
  oa constant uuid := 'c7000000-0000-4000-8000-000000000001';
  ob constant uuid := 'c7000000-0000-4000-8000-000000000002';
  oc constant uuid := 'c7000000-0000-4000-8000-000000000003';
  got text;
begin
  select string_agg(title, ',' order by title) into got from public.list_visible_operator_notices(oa, a1) where id like 'ntc_C7%';
  if got is distinct from 'n1,n2,n3,n4' then raise exception 'operator notices: org A / a1 sees %', got; end if;
  select string_agg(title, ',' order by title) into got from public.list_visible_operator_notices(oa, a2) where id like 'ntc_C7%';
  if got is distinct from 'n1,n2,n3' then raise exception 'operator notices: org A / a2 sees %', got; end if;
  select string_agg(title, ',' order by title) into got from public.list_visible_operator_notices(ob, b1) where id like 'ntc_C7%';
  if got is distinct from 'n1,n2' then raise exception 'operator notices: org B sees % (org A only notices leaked?)', got; end if;
  select string_agg(title, ',' order by title) into got from public.list_visible_operator_notices(oc, c1) where id like 'ntc_C7%';
  if got is distinct from 'n2' then raise exception 'operator notices: new org C sees % (only the sticky one expected)', got; end if;
  -- employee passed with the wrong org: nothing at all (not even 'all' notices)
  select string_agg(title, ',') into got from public.list_visible_operator_notices(ob, a1) where id like 'ntc_C7%';
  if got is not null then raise exception 'operator notices: (org B, employee of A) sees %', got; end if;
  if public.operator_notice_visible('ntc_C7000000000000000000000003', ob, b1) then raise exception 'operator notices: N3 visible to org B'; end if;
  if public.operator_notice_visible('ntc_C7000000000000000000000004', oa, a2) then raise exception 'operator notices: N4 visible to a2'; end if;
  if public.operator_notice_visible('ntc_C7000000000000000000000005', oa, a1) then raise exception 'operator notices: draft visible'; end if;
  if public.operator_notice_visible('ntc_C7000000000000000000000006', oa, a1) then raise exception 'operator notices: expired visible'; end if;
  if public.operator_notice_visible('ntc_C7000000000000000000000007', oa, a1) then raise exception 'operator notices: withdrawn visible'; end if;
  if public.operator_notice_visible('ntc_C70000000000000000000000ZZ', oa, a1) then raise exception 'operator notices: unknown id visible'; end if;
end $$;

set role service_role;
-- (4) receipts
insert into public.operator_notice_receipts(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001');
select security_test.on_raises($q$insert into public.operator_notice_receipts(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000002', 'c7100000-0000-4000-8000-000000000003')$q$, 'operator_notice_not_visible');
select security_test.on_raises($q$insert into public.operator_notice_receipts(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000003')$q$, 'operator_notice_cross_org');
select security_test.on_raises($q$insert into public.operator_notice_receipts(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000004', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000002')$q$, 'operator_notice_not_visible');
select security_test.on_raises($q$insert into public.operator_notice_receipts(notice_id, org_id, employee_id)
  values ('ntc_C7000000000000000000000005', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001')$q$, 'operator_notice_not_visible');
select security_test.on_raises($q$update public.operator_notice_receipts set employee_id = 'c7100000-0000-4000-8000-000000000003', org_id = 'c7000000-0000-4000-8000-000000000002'
  where notice_id = 'ntc_C7000000000000000000000003'$q$, 'operator_notice_receipt_immutable_key');
update public.operator_notice_receipts set state = 'read', read_at = now(), read_version = 1
 where notice_id = 'ntc_C7000000000000000000000003' and employee_id = 'c7100000-0000-4000-8000-000000000001';
select security_test.on_raises($q$update public.operator_notice_receipts set state = 'hacked'
  where notice_id = 'ntc_C7000000000000000000000003'$q$, 'check');

-- (6) append-only history; feedback org; digest has no free text
insert into public.operator_notice_versions(notice_id, version, kind, title, change_summary, ai_usage_change, apply_mode, body_hash, created_by_user_id)
  values ('ntc_C7000000000000000000000001', 1, 'initial', 'n1', '', '', 'self_rules', repeat('a', 64), 'op');
select security_test.on_raises($q$update public.operator_notice_versions set title = 'rewritten' where notice_id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_history_append_only');
select security_test.on_raises($q$delete from public.operator_notice_versions where notice_id = 'ntc_C7000000000000000000000001'$q$, 'operator_notice_history_append_only');
insert into public.ops_feedback_items(id, org_id, employee_id, kind, source, title, body, job_id)
  values ('fb_C7000000000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001', 'request', 'ai_employee', 'r', 'b', 'job-1');
select security_test.on_raises($q$insert into public.ops_feedback_items(id, org_id, employee_id, kind, source, title, job_id)
  values ('fb_C7000000000000000000000002', 'c7000000-0000-4000-8000-000000000001', 'c7100000-0000-4000-8000-000000000001', 'request', 'ai_employee', 'r2', 'job-1')$q$, '23505');
select security_test.on_raises($q$insert into public.ops_feedback_items(id, org_id, kind, source, title, body)
  values ('fb_C7000000000000000000000003', 'c7000000-0000-4000-8000-000000000001', 'weekly_digest', 'system_weekly', 'w', 'free text')$q$, 'ops_feedback_items_digest_check');
insert into public.ops_feedback_events(item_id, org_id, actor_kind, body)
  values ('fb_C7000000000000000000000001', 'c7000000-0000-4000-8000-000000000001', 'operator', 'ok');
select security_test.on_raises($q$insert into public.ops_feedback_events(item_id, org_id, actor_kind, body)
  values ('fb_C7000000000000000000000001', 'c7000000-0000-4000-8000-000000000002', 'operator', 'x')$q$, 'ops_feedback_cross_org');
select security_test.on_raises($q$update public.ops_feedback_events set body = 'rewritten' where item_id = 'fb_C7000000000000000000000001'$q$, 'operator_notice_history_append_only');
select security_test.on_raises($q$delete from public.ops_feedback_events where item_id = 'fb_C7000000000000000000000001'$q$, 'operator_notice_history_append_only');
reset role;

-- cleanup (cascades from the parents are allowed by the guards)
delete from public.operator_notices where id like 'ntc_C7%';
delete from public.ops_feedback_items where id like 'fb_C7%';
delete from public.orgs where id::text like 'c70%';
do $$ begin
  if exists (select 1 from public.operator_notice_targets t where t.notice_id like 'ntc_C7%')
     or exists (select 1 from public.operator_notice_versions v where v.notice_id like 'ntc_C7%')
     or exists (select 1 from public.ops_feedback_events e where e.item_id like 'fb_C7%') then
    raise exception 'operator notices: fixture cleanup left rows';
  end if;
end $$;
drop function security_test.on_denied(text);
drop function security_test.on_raises(text, text);
