-- LP tables server-only (migration 20261004800000). Fixture data only.
-- lp_inquiries / notification_outbox: no anon / authenticated write privilege
-- (table- or column-level). lp_handoffs / lp_wake_webhook_configs /
-- lp_wake_webhook_events: the redundant *_service_all policies are gone, RLS
-- stays enabled, and anon / authenticated hold no SELECT (table- or
-- column-level; 木村 2026-10-04: every reader is service-role). As `authenticated` (member / admin / owner style JWTs; the LP
-- tables are not org-scoped, so the role is what matters) and as `anon`, every
-- INSERT / UPDATE / DELETE on all 5 tables must fail (permission denied or RLS
-- leaving 0 rows) and no row may be readable; `service_role` (BYPASSRLS) must
-- still read / write all 5 without any policy. Surface findings and session
-- holes are both reported as cases (the harness counts them before / after /
-- rollback / reapply). Cleans up its own fixtures. Fixture ids: a8000000-…
\set ON_ERROR_STOP 1
reset role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claims', '', false);

create temporary table rls_write_violations (who text, label text, detail text);
grant all on rls_write_violations to public;

-- Same helpers as tests/security/db-rls-write-holes-phase2.sql (create or replace).
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
create or replace function security_test.read_blocked(label text, command text, strict boolean) returns void
language plpgsql as $$
declare n bigint;
begin
  begin
    execute command into n;
    if strict or n > 0 then
      insert into rls_write_violations values (current_user || ':' || coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '-'), label, 'READABLE ' || n || ' row(s)');
    end if;
  exception
    when insufficient_privilege then
      return;
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

-- t, ord, target (fixture row), ins_target (row insert_sql would create), insert_sql
create temporary table lp3_tables (t text primary key, ord int not null, target text not null, ins_target text not null, insert_sql text not null);
grant select on lp3_tables to public;
insert into lp3_tables values
 ('lp_inquiries', 1, $q$id = 'a8000000-0000-4000-8000-0000000000a1'$q$, $q$id = 'a8000000-0000-4000-8000-0000000000a2'$q$,
  $q$insert into public.lp_inquiries (id, source, plan, company, contact_name, email, use_case) values ('a8000000-0000-4000-8000-0000000000a2', 'form', 'custom', 'forged', 'forged', 'forged@fixture.invalid', 'forged')$q$),
 ('notification_outbox', 2, $q$id = 'a8000000-0000-4000-8000-0000000000b1'$q$, $q$id = 'a8000000-0000-4000-8000-0000000000b2'$q$,
  $q$insert into public.notification_outbox (id, business_key, notification_type, recipient, subject, template) values ('a8000000-0000-4000-8000-0000000000b2', 'lp3-forged', 'inquiry_received', 'forged@fixture.invalid', 'forged', 'forged')$q$),
 ('lp_handoffs', 3, $q$id = 'a8000000-0000-4000-8000-0000000000c1'$q$, $q$id = 'a8000000-0000-4000-8000-0000000000c2'$q$,
  $q$insert into public.lp_handoffs (id, journey_id, reason, summary_draft) values ('a8000000-0000-4000-8000-0000000000c2', gen_random_uuid(), 'forged', 'forged')$q$),
 ('lp_wake_webhook_configs', 4, $q$id = 'a8000000-0000-4000-8000-0000000000d1'$q$, $q$id = 'a8000000-0000-4000-8000-0000000000d2'$q$,
  $q$insert into public.lp_wake_webhook_configs (id, name, endpoint_path, secret_hash) values ('a8000000-0000-4000-8000-0000000000d2', 'forged', 'lp3-forged', 'forged-hash')$q$),
 ('lp_wake_webhook_events', 5, $q$id = 'a8000000-0000-4000-8000-0000000000e1'$q$, $q$id = 'a8000000-0000-4000-8000-0000000000e2'$q$,
  $q$insert into public.lp_wake_webhook_events (id, webhook_config_id, event_type) values ('a8000000-0000-4000-8000-0000000000e2', 'a8000000-0000-4000-8000-0000000000d1', 'forged')$q$);

-- 0) invariants (not counted as cases): the tables exist with RLS on, and
--    service_role bypasses RLS (otherwise dropping the policies would lock it out)
do $$
declare r record;
begin
  for r in select t from lp3_tables loop
    if to_regclass('public.' || r.t) is null then raise exception 'table missing: %', r.t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || r.t)::regclass) then
      raise exception 'RLS disabled on %', r.t;
    end if;
  end loop;
  if not (select rolbypassrls from pg_roles where rolname = 'service_role') then
    raise exception 'service_role does not bypass RLS';
  end if;
  -- nothing depends on the service-role policies (safe to drop)
  if exists (select 1 from pg_depend d join pg_policy p on d.refclassid = 'pg_policy'::regclass and d.refobjid = p.oid
             where p.polname in ('lp_handoffs_service_all', 'lp_wake_configs_service_all', 'lp_wake_events_service_all')) then
    raise exception 'an object depends on an lp_*_service_all policy';
  end if;
end $$;

-- fixtures (one row per table)
insert into public.lp_inquiries (id, source, plan, company, contact_name, email, use_case)
  values ('a8000000-0000-4000-8000-0000000000a1', 'form', 'undecided', 'lp3-fixture', 'fixture', 'lp3@fixture.invalid', 'fixture');
insert into public.notification_outbox (id, business_key, notification_type, recipient, subject, template)
  values ('a8000000-0000-4000-8000-0000000000b1', 'lp3-fixture', 'inquiry_received', 'lp3@fixture.invalid', 'fixture', 'fixture');
insert into public.lp_handoffs (id, journey_id, reason, summary_draft)
  values ('a8000000-0000-4000-8000-0000000000c1', gen_random_uuid(), 'fixture', 'fixture');
insert into public.lp_wake_webhook_configs (id, name, endpoint_path, secret_hash)
  values ('a8000000-0000-4000-8000-0000000000d1', 'lp3-fixture', 'lp3-fixture', 'fixture-hash');
insert into public.lp_wake_webhook_events (id, webhook_config_id, event_type)
  values ('a8000000-0000-4000-8000-0000000000e1', 'a8000000-0000-4000-8000-0000000000d1', 'fixture');
create temporary table lp3_before (t text primary key, h text not null);
grant select on lp3_before to public;
do $$
declare r record; h text;
begin
  for r in select * from lp3_tables loop
    execute format($f$select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.%I x where id::text like 'a8000000-%%'$f$, r.t) into h;
    if h = md5('') then raise exception 'fixture missing for %', r.t; end if;
    insert into lp3_before values (r.t, h);
  end loop;
end $$;

-- 1) surface: write privileges on lp_inquiries / notification_outbox, SELECT
--    on the 3 lp_* tables, and any policy left on the 5 tables (the 3
--    service-role ones are expected gone)
insert into rls_write_violations
select role || ':grant', t || ' ' || lower(p), 'GRANTED'
from unnest(array['anon','authenticated']) role, unnest(array['lp_inquiries','notification_outbox']) t,
     unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
where has_table_privilege(role, 'public.' || t, p)
   or (p in ('INSERT','UPDATE') and has_any_column_privilege(role, 'public.' || t, p));
insert into rls_write_violations
select role || ':grant', t || ' select', 'GRANTED'
from unnest(array['anon','authenticated']) role, unnest(array['lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events']) t
where has_table_privilege(role, 'public.' || t, 'SELECT')
   or has_any_column_privilege(role, 'public.' || t, 'SELECT');
insert into rls_write_violations
select 'policy:' || tablename, policyname, 'PRESENT ' || cmd
from pg_policies where schemaname = 'public' and tablename in (select t from lp3_tables);

-- 2) sessions: 3 authenticated JWTs + anon
do $$
declare sub text; r record;
begin
  foreach sub in array array['a8100000-0000-4000-8000-000000000003', 'a8100000-0000-4000-8000-000000000002', 'a8100000-0000-4000-8000-000000000001', null] loop
    perform security_test.as_user(sub);
    if sub is null then set local role anon; else set local role authenticated; end if;
    for r in select * from lp3_tables order by ord loop
      perform security_test.read_blocked(r.t || ' read', format($f$select count(*) from public.%I where id::text like 'a8000000-%%'$f$, r.t), false);
      perform security_test.write_blocked(r.t || ' insert', r.insert_sql);
      perform security_test.write_blocked(r.t || ' update', format('update public.%I set id = id where %s', r.t, r.target));
      perform security_test.write_blocked(r.t || ' delete', format('delete from public.%I where %s', r.t, r.target));
    end loop;
    reset role;
  end loop;
end $$;
reset role;
select security_test.as_user(null);
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claims', '', false);

do $$
declare r record; now_h text;
begin
  for r in select * from lp3_before loop
    execute format($f$select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) from public.%I x where id::text like 'a8000000-%%'$f$, r.t) into now_h;
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

-- 3) service_role keeps full access without any policy (BYPASSRLS)
set role service_role;
select set_config('request.jwt.claim.role', 'service_role', false);
do $$
declare r record; n integer;
begin
  for r in select * from lp3_tables order by ord loop
    execute format($f$select count(*) from public.%I where id::text like 'a8000000-%%'$f$, r.t) into n;
    if n <> 1 then raise exception 'service_role % read: %', r.t, n; end if;
    execute r.insert_sql;
    get diagnostics n = row_count; if n <> 1 then raise exception 'service_role % insert: %', r.t, n; end if;
    execute format('update public.%I set id = id where %s', r.t, r.target);
    get diagnostics n = row_count; if n <> 1 then raise exception 'service_role % update: %', r.t, n; end if;
  end loop;
  for r in select * from lp3_tables order by ord desc loop
    execute format('delete from public.%I where %s', r.t, r.ins_target);
    get diagnostics n = row_count; if n <> 1 then raise exception 'service_role % delete: %', r.t, n; end if;
  end loop;
end $$;
reset role;
select set_config('request.jwt.claim.role', '', false);

-- cleanup
delete from public.lp_wake_webhook_events where id::text like 'a8000000-%';
delete from public.lp_wake_webhook_configs where id::text like 'a8000000-%';
delete from public.lp_handoffs where id::text like 'a8000000-%';
delete from public.notification_outbox where id::text like 'a8000000-%';
delete from public.lp_inquiries where id::text like 'a8000000-%';
drop table lp3_before;
drop table lp3_tables;
drop table rls_write_violations;
