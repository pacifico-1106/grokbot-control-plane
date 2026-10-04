-- RLS write holes (migration 20261004500000). Fixture data only.
-- As `authenticated` with a member / admin / owner JWT (and as `anon`), every
-- INSERT / UPDATE / DELETE on orgs, subscriptions, audit_events and
-- approval_requests must fail (permission denied, or RLS leaving 0 rows),
-- reads of the caller's own org must keep working, and `service_role` must
-- still write all four tables. Cleans up its own fixtures (re-runnable).
\set ON_ERROR_STOP 1
reset role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claims', '', false);

create temporary table rls_write_violations (who text, label text, detail text);
grant all on rls_write_violations to public;

-- Runs one write as the current role. Blocked = permission denied, or RLS
-- leaving 0 rows. An allowed write is rolled back (sub-transaction) and
-- recorded, so one run lists every open hole.
create or replace function security_test.write_blocked(label text, command text) returns void
language plpgsql as $$
declare n integer;
begin
  begin
    execute command;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception using errcode = 'P0420', message = n::text || ' row(s)';
    end if;
  exception
    when insufficient_privilege then
      return;
    when sqlstate 'P0420' then
      insert into rls_write_violations values (current_user || ':' || coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '-'), label, 'ALLOWED ' || sqlerrm);
    when others then
      insert into rls_write_violations values (current_user || ':' || coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '-'), label, 'unexpected ' || sqlstate || ' ' || sqlerrm);
  end;
end $$;

create or replace function security_test.as_user(sub text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(sub, ''), false);
  perform set_config('request.jwt.claim.role', case when sub is null then 'anon' else 'authenticated' end, false);
  perform set_config('request.jwt.claims',
    case when sub is null then '{"role":"anon"}'
         else json_build_object('sub', sub, 'role', 'authenticated')::text end, false);
end $$;

-- Org A (subscription, pending approval, audit row) and org A2 (same people,
-- no subscription yet: lets an INSERT on subscriptions be attempted without a
-- unique violation). Org B is another tenant.
insert into public.orgs (id, name, stripe_customer_id) values
 ('a5000000-0000-4000-8000-0000000000a1', 'rls-write-fixture-a', 'cus_fixture_a'),
 ('a5000000-0000-4000-8000-0000000000a2', 'rls-write-fixture-a2', null),
 ('a5000000-0000-4000-8000-0000000000b1', 'rls-write-fixture-b', 'cus_fixture_b');
insert into public.org_members (id, org_id, user_id, email, role, capabilities, status) values
 ('a5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-0000000000a1','a5100000-0000-4000-8000-000000000001','rw-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing}','active'),
 ('a5000000-0000-4000-8000-000000000002','a5000000-0000-4000-8000-0000000000a1','a5100000-0000-4000-8000-000000000002','rw-admin@fixture.invalid','admin','{view_dashboard,manage_team}','active'),
 ('a5000000-0000-4000-8000-000000000003','a5000000-0000-4000-8000-0000000000a1','a5100000-0000-4000-8000-000000000003','rw-member@fixture.invalid','member','{view_dashboard}','active'),
 ('a5000000-0000-4000-8000-000000000011','a5000000-0000-4000-8000-0000000000a2','a5100000-0000-4000-8000-000000000001','rw-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing}','active'),
 ('a5000000-0000-4000-8000-000000000012','a5000000-0000-4000-8000-0000000000a2','a5100000-0000-4000-8000-000000000002','rw-admin@fixture.invalid','admin','{view_dashboard,manage_team}','active'),
 ('a5000000-0000-4000-8000-000000000013','a5000000-0000-4000-8000-0000000000a2','a5100000-0000-4000-8000-000000000003','rw-member@fixture.invalid','member','{view_dashboard}','active'),
 ('a5000000-0000-4000-8000-000000000021','a5000000-0000-4000-8000-0000000000b1','a5100000-0000-4000-8000-000000000021','rw-b-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing}','active');
insert into public.subscriptions (id, org_id, plan_key, status) values
 ('a5200000-0000-4000-8000-0000000000a1','a5000000-0000-4000-8000-0000000000a1','starter','active'),
 ('a5200000-0000-4000-8000-0000000000b1','a5000000-0000-4000-8000-0000000000b1','starter','active');
insert into public.approval_requests (id, org_id, purpose, summary, risk, status, metadata) values
 ('a5300000-0000-4000-8000-0000000000a1','a5000000-0000-4000-8000-0000000000a1','rls.fixture','pending fixture','high','pending','{}'::jsonb);
insert into public.audit_events (id, org_id, action, summary) values
 ('a5400000-0000-4000-8000-0000000000a1','a5000000-0000-4000-8000-0000000000a1','rls.fixture','genuine audit row');

create temporary table rls_write_before as
  select 'orgs' as t, md5(string_agg(o::text, ',' order by o.id)) as h from public.orgs o where o.id::text like 'a5000000-%'
  union all select 'subscriptions', md5(string_agg(s::text, ',' order by s.id)) from public.subscriptions s where s.org_id::text like 'a5000000-%'
  union all select 'approval_requests', md5(string_agg(a::text, ',' order by a.id)) from public.approval_requests a where a.org_id::text like 'a5000000-%'
  union all select 'audit_events', md5(string_agg(e::text, ',' order by e.id)) from public.audit_events e where e.org_id::text like 'a5000000-%';
grant select on rls_write_before to public;

-- 1) member / admin / owner JWTs of org A, then anon
do $$
declare
  sub text;
  a constant text := 'a5000000-0000-4000-8000-0000000000a1';
  a2 constant text := 'a5000000-0000-4000-8000-0000000000a2';
  has_plan_cols boolean := exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orgs' and column_name = 'plan_key');
begin
  foreach sub in array array['a5100000-0000-4000-8000-000000000003', 'a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', null] loop
    perform security_test.as_user(sub);
    if sub is null then set local role anon; else set local role authenticated; end if;

    if sub is not null then
      -- reads of the caller's own org keep working; other tenant stays invisible
      if (select count(*) from public.orgs where id::text like 'a5000000-%') <> 2 then raise exception 'orgs read broken for %', sub; end if;
      if (select count(*) from public.subscriptions where org_id::text like 'a5000000-%') <> 1 then raise exception 'subscriptions read broken for %', sub; end if;
      if (select count(*) from public.approval_requests where org_id = a::uuid) <> 1 then raise exception 'approvals read broken for %', sub; end if;
      if (select count(*) from public.audit_events where org_id = a::uuid) <> 1 then raise exception 'audit read broken for %', sub; end if;
    end if;

    -- orgs: rename, billing rewrite, insert, delete
    perform security_test.write_blocked('orgs rename', format('update public.orgs set name = %L where id = %L', 'renamed-by-session', a));
    perform security_test.write_blocked('orgs billing', format('update public.orgs set stripe_customer_id = %L, trial_ends_at = now() + interval ''10 years'' where id = %L', 'cus_forged', a));
    if has_plan_cols then
      perform security_test.write_blocked('orgs plan', format('update public.orgs set plan_key = %L, billing_status = %L, scheduled_plan_key = null where id = %L', 'managed', 'active', a));
    end if;
    perform security_test.write_blocked('orgs insert', format('insert into public.orgs (name) values (%L)', 'session-created-org'));
    perform security_test.write_blocked('orgs delete', format('delete from public.orgs where id = %L', a));
    -- subscriptions: plan rewrite, insert, delete
    perform security_test.write_blocked('subscriptions plan', format('update public.subscriptions set plan_key = %L, status = %L where org_id = %L', 'managed', 'active', a));
    perform security_test.write_blocked('subscriptions insert', format('insert into public.subscriptions (org_id, plan_key, status) values (%L, %L, %L)', a2, 'managed', 'active'));
    perform security_test.write_blocked('subscriptions delete', format('delete from public.subscriptions where org_id = %L', a));
    -- audit_events: forged insert, tamper, delete
    perform security_test.write_blocked('audit insert', format('insert into public.audit_events (org_id, action, summary) values (%L, %L, %L)', a, 'setup.tool_succeeded', 'forged'));
    perform security_test.write_blocked('audit update', format('update public.audit_events set summary = %L where org_id = %L', 'tampered', a));
    perform security_test.write_blocked('audit delete', format('delete from public.audit_events where org_id = %L', a));
    -- approval_requests: self-approve, metadata tamper, insert pre-approved, delete
    perform security_test.write_blocked('approval status', format('update public.approval_requests set status = %L, resolved_at = now() where org_id = %L', 'approved', a));
    perform security_test.write_blocked('approval metadata', format('update public.approval_requests set metadata = metadata || %L::jsonb, summary = %L where org_id = %L', '{"forged":true}', 'tampered', a));
    perform security_test.write_blocked('approval insert', format('insert into public.approval_requests (org_id, purpose, summary, risk, status) values (%L, %L, %L, %L, %L)', a, 'forged', 'forged', 'low', 'approved'));
    perform security_test.write_blocked('approval delete', format('delete from public.approval_requests where org_id = %L', a));

    reset role;
  end loop;
end $$;
reset role;
select security_test.as_user(null);
select set_config('request.jwt.claim.sub', '', false);

do $$
declare r record;
begin
  for r in
    select b.t from rls_write_before b
    join (
      select 'orgs' as t, md5(string_agg(o::text, ',' order by o.id)) as h from public.orgs o where o.id::text like 'a5000000-%'
      union all select 'subscriptions', md5(string_agg(s::text, ',' order by s.id)) from public.subscriptions s where s.org_id::text like 'a5000000-%'
      union all select 'approval_requests', md5(string_agg(a::text, ',' order by a.id)) from public.approval_requests a where a.org_id::text like 'a5000000-%'
      union all select 'audit_events', md5(string_agg(e::text, ',' order by e.id)) from public.audit_events e where e.org_id::text like 'a5000000-%'
    ) n on n.t = b.t
    where n.h is distinct from b.h loop
    raise exception 'fixture rows changed by a session write: %', r.t;
  end loop;
  if exists (select 1 from public.orgs where name = 'session-created-org') then
    raise exception 'session created an org';
  end if;
end $$;

do $$
declare msg text;
begin
  select string_agg(format('%s %s: %s', who, label, detail), E'\n' order by who, label) into msg from rls_write_violations;
  if msg is not null then
    raise exception E'session writes not blocked (% case(s)):\n%', (select count(*) from rls_write_violations), msg;
  end if;
end $$;

-- 2) policy + privilege surface
do $$
declare r record;
begin
  for r in select tablename, policyname, cmd from pg_policies
            where schemaname = 'public' and tablename in ('orgs','subscriptions','audit_events','approval_requests')
              and cmd <> 'SELECT' loop
    raise exception 'write policy still present: %.% (%)', r.tablename, r.policyname, r.cmd;
  end loop;
  for r in select role, t, p from unnest(array['anon','authenticated']) role,
             unnest(array['public.orgs','public.subscriptions','public.audit_events','public.approval_requests']) t,
             unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
           where has_table_privilege(role, t, p) loop
    raise exception '% still has % on %', r.role, r.p, r.t;
  end loop;
  for r in select role, t, p from unnest(array['anon','authenticated']) role,
             unnest(array['public.orgs','public.subscriptions','public.audit_events','public.approval_requests']) t,
             unnest(array['INSERT','UPDATE']) p
           where has_any_column_privilege(role, t, p) loop
    raise exception '% still has column-level % on %', r.role, r.p, r.t;
  end loop;
  for r in select t, p from unnest(array['public.orgs','public.subscriptions','public.audit_events','public.approval_requests']) t,
             unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
           where not has_table_privilege('service_role', t, p) loop
    raise exception 'service_role lost % on %', r.p, r.t;
  end loop;
  -- no RPC callable by anon/authenticated writes these tables (SECURITY DEFINER bypasses RLS)
  for r in select p.oid::regprocedure as fn from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prosecdef
              and p.prorettype <> 'trigger'::regtype
              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(orgs|subscriptions|audit_events|approval_requests)\M' loop
    raise exception 'security definer function writable by anon/authenticated: %', r.fn;
  end loop;
end $$;

-- 3) service_role keeps full write access (Stripe webhook / server routes)
set role service_role;
do $$
declare n integer;
  a constant uuid := 'a5000000-0000-4000-8000-0000000000a1';
  a2 constant uuid := 'a5000000-0000-4000-8000-0000000000a2';
begin
  update public.orgs set name = 'renamed-by-server', stripe_customer_id = 'cus_server' where id = a;
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role orgs update: %', n; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orgs' and column_name = 'plan_key') then
    execute format('update public.orgs set plan_key = %L, billing_status = %L where id = %L', 'business', 'active', a);
    get diagnostics n = row_count; if n <> 1 then raise exception 'service_role orgs plan update: %', n; end if;
  end if;
  insert into public.orgs (id, name) values ('a5000000-0000-4000-8000-0000000000c1', 'rls-write-fixture-server');
  insert into public.subscriptions (org_id, plan_key, status) values (a2, 'business', 'trialing');
  update public.subscriptions set plan_key = 'business', status = 'active' where org_id = a;
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role subscriptions update: %', n; end if;
  delete from public.subscriptions where org_id = a2;
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role subscriptions delete: %', n; end if;
  insert into public.audit_events (org_id, action, summary) values (a, 'rls.server', 'server audit row');
  update public.audit_events set summary = 'server edit' where org_id = a and action = 'rls.server';
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role audit update: %', n; end if;
  delete from public.audit_events where org_id = a and action = 'rls.server';
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role audit delete: %', n; end if;
  insert into public.approval_requests (id, org_id, purpose, summary, risk) values ('a5300000-0000-4000-8000-0000000000a2', a, 'rls.server', 'server ticket', 'low');
  update public.approval_requests set metadata = metadata || '{"server":true}'::jsonb where id = 'a5300000-0000-4000-8000-0000000000a2';
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role approval update: %', n; end if;
  delete from public.approval_requests where id = 'a5300000-0000-4000-8000-0000000000a2';
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role approval delete: %', n; end if;
  delete from public.orgs where id = 'a5000000-0000-4000-8000-0000000000c1';
  get diagnostics n = row_count; if n <> 1 then raise exception 'service_role orgs delete: %', n; end if;
end $$;
reset role;

-- cleanup (cascade removes members / subscriptions / approvals / audit rows)
delete from public.orgs where id::text like 'a5000000-%';
drop table rls_write_before;
drop table rls_write_violations;
do $$ begin
  if exists (select 1 from public.org_members where org_id::text like 'a5000000-%')
     or exists (select 1 from public.audit_events where org_id::text like 'a5000000-%') then
    raise exception 'fixture cleanup incomplete';
  end if;
end $$;
