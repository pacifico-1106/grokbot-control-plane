-- RLS write holes, phase 2 (migration 20261004600000). Fixture data only.
-- As `authenticated` with a member / admin / owner JWT (and as `anon`), every
-- INSERT / UPDATE / DELETE on the 14 tenant config / credential tables must
-- fail (permission denied, or RLS leaving 0 rows), reads keep returning
-- exactly the caller's orgs' rows (other tenant invisible), and
-- `service_role` must still write every table. Cleans up its own fixtures
-- (re-runnable). Fixture ids: a6000000-… (orgs/members), a61…/a62… (users,
-- employees).
\set ON_ERROR_STOP 1
reset role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claims', '', false);

create temporary table rls_write_violations (who text, label text, detail text);
grant all on rls_write_violations to public;

-- Same helpers as tests/security/db-rls-write-holes.sql (create or replace).
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

-- Tables under test, and one INSERT per table that would succeed if allowed
-- (targets org A2, which has only employee E2, so no unique/one-per-org clash).
create temporary table rls2_tables (t text primary key, ord int not null, insert_sql text not null);
grant select on rls2_tables to public;
insert into rls2_tables values
 ('credentials', 1, $q$insert into public.credentials (org_id, employee_id, secret_hash) values ('a6000000-0000-4000-8000-0000000000a2', 'a6200000-0000-4000-8000-0000000000a2', 'forged-hash')$q$),
 ('org_admin_agents', 2, $q$insert into public.org_admin_agents (org_id, status) values ('a6000000-0000-4000-8000-0000000000a2', 'linked')$q$),
 ('employees', 3, $q$insert into public.employees (org_id, display_name, role_label) values ('a6000000-0000-4000-8000-0000000000a2', 'forged', 'forged')$q$),
 ('employee_bindings', 4, $q$insert into public.employee_bindings (employee_id, org_id, status, grok_bot_agent_id) values ('a6200000-0000-4000-8000-0000000000a2', 'a6000000-0000-4000-8000-0000000000a2', 'linked', 'forged-agent')$q$),
 ('org_parties', 5, $q$insert into public.org_parties (org_id, kind, identifier, audience) values ('a6000000-0000-4000-8000-0000000000a2', 'email_domain', 'forged.invalid', 'internal')$q$),
 ('org_channels', 6, $q$insert into public.org_channels (org_id, surface, external_id, classification) values ('a6000000-0000-4000-8000-0000000000a2', 'slack', 'C_FORGED', 'internal')$q$),
 ('information_assets', 7, $q$insert into public.information_assets (org_id, ref, class) values ('a6000000-0000-4000-8000-0000000000a2', 'doc:forged', 'public')$q$),
 ('org_notification_channels', 8, $q$insert into public.org_notification_channels (org_id, provider, label) values ('a6000000-0000-4000-8000-0000000000a2', 'slack', 'forged')$q$),
 ('org_conversation_adapters', 9, $q$insert into public.org_conversation_adapters (org_id, surface) values ('a6000000-0000-4000-8000-0000000000a2', 'slack')$q$),
 ('org_sns_adapters', 10, $q$insert into public.org_sns_adapters (org_id, surface) values ('a6000000-0000-4000-8000-0000000000a2', 'x')$q$),
 ('employee_slack_identities', 11, $q$insert into public.employee_slack_identities (employee_id, org_id, slack_user_id) values ('a6200000-0000-4000-8000-0000000000a2', 'a6000000-0000-4000-8000-0000000000a2', 'U_FORGED')$q$),
 ('org_external_contract_payment_methods', 12, $q$insert into public.org_external_contract_payment_methods (org_id, setup_status) values ('a6000000-0000-4000-8000-0000000000a2', 'completed')$q$),
 ('org_projects', 13, $q$insert into public.org_projects (org_id, slug, name) values ('a6000000-0000-4000-8000-0000000000a2', 'forged', 'Forged')$q$),
 ('audit_external_contract_card_events', 14, $q$insert into public.audit_external_contract_card_events (org_id, action) values ('a6000000-0000-4000-8000-0000000000a2', 'setup_completed')$q$);

-- Org A (one row in every table) and org B (another tenant, one row in every
-- table); org A2 has the same people and only employee E2 (insert target).
insert into public.orgs (id, name) values
 ('a6000000-0000-4000-8000-0000000000a1', 'rls2-fixture-a'),
 ('a6000000-0000-4000-8000-0000000000a2', 'rls2-fixture-a2'),
 ('a6000000-0000-4000-8000-0000000000b1', 'rls2-fixture-b');
insert into public.org_members (id, org_id, user_id, email, role, capabilities, status) values
 ('a6000000-0000-4000-8000-000000000001','a6000000-0000-4000-8000-0000000000a1','a6100000-0000-4000-8000-000000000001','rw2-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing,hire_issue_credentials}','active'),
 ('a6000000-0000-4000-8000-000000000002','a6000000-0000-4000-8000-0000000000a1','a6100000-0000-4000-8000-000000000002','rw2-admin@fixture.invalid','admin','{view_dashboard,manage_team,hire_issue_credentials}','active'),
 ('a6000000-0000-4000-8000-000000000003','a6000000-0000-4000-8000-0000000000a1','a6100000-0000-4000-8000-000000000003','rw2-member@fixture.invalid','member','{view_dashboard}','active'),
 ('a6000000-0000-4000-8000-000000000011','a6000000-0000-4000-8000-0000000000a2','a6100000-0000-4000-8000-000000000001','rw2-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing,hire_issue_credentials}','active'),
 ('a6000000-0000-4000-8000-000000000012','a6000000-0000-4000-8000-0000000000a2','a6100000-0000-4000-8000-000000000002','rw2-admin@fixture.invalid','admin','{view_dashboard,manage_team,hire_issue_credentials}','active'),
 ('a6000000-0000-4000-8000-000000000013','a6000000-0000-4000-8000-0000000000a2','a6100000-0000-4000-8000-000000000003','rw2-member@fixture.invalid','member','{view_dashboard}','active'),
 ('a6000000-0000-4000-8000-000000000021','a6000000-0000-4000-8000-0000000000b1','a6100000-0000-4000-8000-000000000021','rw2-b-owner@fixture.invalid','owner','{view_dashboard,approve_actions,manage_team,manage_billing}','active');
insert into public.employees (id, org_id, display_name, role_label) values
 ('a6200000-0000-4000-8000-0000000000a1','a6000000-0000-4000-8000-0000000000a1','fixture-employee-a','sales'),
 ('a6200000-0000-4000-8000-0000000000a2','a6000000-0000-4000-8000-0000000000a2','fixture-employee-a2','sales'),
 ('a6200000-0000-4000-8000-0000000000b1','a6000000-0000-4000-8000-0000000000b1','fixture-employee-b','sales');
do $$
declare o record;
begin
  for o in select * from (values
      ('a6000000-0000-4000-8000-0000000000a1'::uuid, 'a6200000-0000-4000-8000-0000000000a1'::uuid, 'a'),
      ('a6000000-0000-4000-8000-0000000000b1'::uuid, 'a6200000-0000-4000-8000-0000000000b1'::uuid, 'b')) v(org, emp, tag) loop
    insert into public.credentials (org_id, employee_id, secret_hash) values (o.org, o.emp, 'fixture-hash-' || o.tag);
    insert into public.employee_bindings (employee_id, org_id, status) values (o.emp, o.org, 'unlinked');
    insert into public.org_admin_agents (org_id) values (o.org);
    insert into public.org_parties (org_id, kind, identifier, audience) values (o.org, 'email_domain', o.tag || '.fixture.invalid', 'internal');
    insert into public.org_channels (org_id, surface, external_id) values (o.org, 'slack', 'C_FIXTURE_' || o.tag);
    insert into public.information_assets (org_id, ref, class) values (o.org, 'doc:fixture-' || o.tag, 'internal');
    insert into public.org_notification_channels (org_id, provider, label) values (o.org, 'slack', 'fixture-' || o.tag);
    insert into public.org_conversation_adapters (org_id, surface) values (o.org, 'slack');
    insert into public.org_sns_adapters (org_id, surface) values (o.org, 'x');
    insert into public.employee_slack_identities (employee_id, org_id, slack_user_id) values (o.emp, o.org, 'U_FIXTURE_' || o.tag);
    insert into public.org_external_contract_payment_methods (org_id, setup_status) values (o.org, 'pending');
    insert into public.org_projects (org_id, slug, name) values (o.org, 'fixture-' || o.tag, 'Fixture ' || o.tag);
    insert into public.audit_external_contract_card_events (org_id, action) values (o.org, 'link_minted');
  end loop;
end $$;

-- Snapshot (row hashes) and the rows a member of A + A2 must be able to read.
create temporary table rls2_before (t text primary key, h text, visible bigint);
grant select on rls2_before to public;
do $$
declare r record; h text; v bigint;
begin
  for r in select t from rls2_tables loop
    execute format($f$select md5(coalesce(string_agg(x::text, ',' order by x::text), '')),
                            count(*) filter (where x.org_id::text in ('a6000000-0000-4000-8000-0000000000a1', 'a6000000-0000-4000-8000-0000000000a2'))
                     from public.%I x where x.org_id::text like 'a6000000-%%'$f$, r.t) into h, v;
    if v < 1 then raise exception 'fixture missing for %', r.t; end if;
    insert into rls2_before values (r.t, h, v);
  end loop;
end $$;

-- 1) member / admin / owner JWTs of orgs A + A2, then anon
do $$
declare
  sub text;
  r record;
  n bigint;
  a constant text := 'a6000000-0000-4000-8000-0000000000a1';
begin
  foreach sub in array array['a6100000-0000-4000-8000-000000000003', 'a6100000-0000-4000-8000-000000000002', 'a6100000-0000-4000-8000-000000000001', null] loop
    perform security_test.as_user(sub);
    if sub is null then set local role anon; else set local role authenticated; end if;

    for r in select b.t, b.visible, t.insert_sql from rls2_before b join rls2_tables t using (t) order by t.ord loop
      -- reads unchanged: exactly the caller's orgs' rows (B invisible); anon none
      execute format($f$select count(*) from public.%I where org_id::text like 'a6000000-%%'$f$, r.t) into n;
      if n <> (case when sub is null then 0 else r.visible end) then
        raise exception 'read of % broken for %: saw % row(s), expected %', r.t, coalesce(sub, 'anon'), n, case when sub is null then 0 else r.visible end;
      end if;
      perform security_test.write_blocked(r.t || ' insert', r.insert_sql);
      perform security_test.write_blocked(r.t || ' update', format('update public.%I set org_id = org_id where org_id = %L', r.t, a));
      perform security_test.write_blocked(r.t || ' delete', format('delete from public.%I where org_id = %L', r.t, a));
    end loop;
    -- a few targeted takeovers on the HIGH tables
    perform security_test.write_blocked('credentials widen', format($f$update public.credentials set scopes = array['*'], revoked_at = null where org_id = %L$f$, a));
    perform security_test.write_blocked('employees policy', format($f$update public.employees set approval_policy = 'auto', status = 'active' where org_id = %L$f$, a));
    perform security_test.write_blocked('bindings relink', format($f$update public.employee_bindings set grok_bot_agent_id = 'attacker-agent', status = 'linked' where org_id = %L$f$, a));
    perform security_test.write_blocked('admin agent relink', format($f$update public.org_admin_agents set grok_bot_agent_id = 'attacker-agent', status = 'linked' where org_id = %L$f$, a));

    reset role;
  end loop;
end $$;
reset role;
select security_test.as_user(null);
select set_config('request.jwt.claim.sub', '', false);

do $$
declare r record; now_h text;
begin
  for r in select b.t, b.h from rls2_before b loop
    execute format($f$select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.%I x where x.org_id::text like 'a6000000-%%'$f$, r.t) into now_h;
    if now_h is distinct from r.h then raise exception 'fixture rows changed by a session write: %', r.t; end if;
  end loop;
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
  tabs text[] := array(select 'public.' || t from rls2_tables order by ord);
begin
  for r in select tablename, policyname, cmd from pg_policies
            where schemaname = 'public' and tablename in (select t from rls2_tables) and cmd <> 'SELECT' loop
    raise exception 'write policy still present: %.% (%)', r.tablename, r.policyname, r.cmd;
  end loop;
  -- reads: every table keeps exactly one member SELECT policy and the SELECT grant
  for r in select t from rls2_tables
           where (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t
                    and p.cmd = 'SELECT' and p.qual = 'is_org_member(org_id)') <> 1 loop
    raise exception 'SELECT policy changed on %', r.t;
  end loop;
  for r in select role, t from unnest(array['anon','authenticated']) role, unnest(tabs) t
           where not has_table_privilege(role, t, 'SELECT') loop
    raise exception '% lost SELECT on %', r.role, r.t;
  end loop;
  for r in select role, t, p from unnest(array['anon','authenticated']) role, unnest(tabs) t,
             unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
           where has_table_privilege(role, t, p) loop
    raise exception '% still has % on %', r.role, r.p, r.t;
  end loop;
  for r in select role, t, p from unnest(array['anon','authenticated']) role, unnest(tabs) t,
             unnest(array['INSERT','UPDATE']) p
           where has_any_column_privilege(role, t, p) loop
    raise exception '% still has column-level % on %', r.role, r.p, r.t;
  end loop;
  for r in select t, p from unnest(tabs) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
           where not has_table_privilege('service_role', t, p) loop
    raise exception 'service_role lost % on %', r.p, r.t;
  end loop;
  -- no RPC callable by anon/authenticated writes these tables (SECURITY DEFINER bypasses RLS)
  for r in select p.oid::regprocedure as fn from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prosecdef
              and p.prorettype <> 'trigger'::regtype
              and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              and p.prosrc ~* ('(insert\s+into|update|delete\s+from)\s+(public\.)?(' || (select string_agg(t, '|') from rls2_tables) || ')\M') loop
    raise exception 'security definer function writable by anon/authenticated: %', r.fn;
  end loop;
end $$;

-- 3) service_role keeps full write access (server routes / webhooks)
set role service_role;
do $$
declare r record; n integer;
  a constant uuid := 'a6000000-0000-4000-8000-0000000000a1';
  a2 constant uuid := 'a6000000-0000-4000-8000-0000000000a2';
begin
  for r in select t, insert_sql from rls2_tables order by ord loop
    execute r.insert_sql;
    get diagnostics n = row_count; if n <> 1 then raise exception 'service_role % insert: %', r.t, n; end if;
    execute format('update public.%I set org_id = org_id where org_id = %L', r.t, a);
    get diagnostics n = row_count; if n < 1 then raise exception 'service_role % update: %', r.t, n; end if;
  end loop;
  for r in select t from rls2_tables order by ord desc loop
    execute format('delete from public.%I where org_id = %L', r.t, a2)
      || case when r.t = 'employees' then ' and display_name = ''forged''' else '' end;
    get diagnostics n = row_count; if n < 1 then raise exception 'service_role % delete: %', r.t, n; end if;
  end loop;
end $$;
reset role;

-- cleanup (org cascade removes members, employees and every fixture row)
delete from public.orgs where id::text like 'a6000000-%';
do $$
declare r record; n bigint;
begin
  for r in select t from rls2_tables loop
    execute format($f$select count(*) from public.%I where org_id::text like 'a6000000-%%'$f$, r.t) into n;
    if n <> 0 then raise exception 'fixture cleanup incomplete: %', r.t; end if;
  end loop;
  if exists (select 1 from public.org_members where org_id::text like 'a6000000-%') then
    raise exception 'fixture cleanup incomplete: org_members';
  end if;
end $$;
drop table rls2_before;
drop table rls2_tables;
drop table rls_write_violations;
