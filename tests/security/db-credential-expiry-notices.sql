-- 社員証 pre-expiry notice dedup table (migration 20261012100000,
-- CREDENTIAL_EXPIRY_NOTICE_ENABLED). Synthetic fixtures only (ids ce000000-…);
-- cleans up after itself. Runs in scripts/test-db-local.py and after every
-- migration in scripts/test-db-all-migrations.py.
--  (1) RLS on, no policy; anon / authenticated hold no privilege
--  (2) service_role inserts; (credential, threshold) is unique → a second
--      claim fails with unique_violation (the app treats it as "already sent")
--  (3) tenant isolation: org / employee must be the credential's own
--      (credential_expiry_notice_cross_org), on insert and on update
--  (4) threshold limited to 7d / 1d; deleting the credential cascades
\set ON_ERROR_STOP 1
reset role;

create or replace function security_test.cen_denied(command text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then return;
  end;
  raise exception 'credential expiry notices: session access not denied: %', command;
end $$;
create or replace function security_test.cen_rejects(command text, expected text) returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if position(expected in sqlerrm) > 0 or sqlstate = expected then return; end if;
    raise exception 'credential expiry notices: % failed with "%" / % (expected "%")', command, sqlerrm, sqlstate, expected;
  end;
  raise exception 'credential expiry notices: not rejected: %', command;
end $$;
grant execute on function security_test.cen_denied(text), security_test.cen_rejects(text, text) to anon, authenticated, service_role;

-- (1) RLS on, no policy, no session privilege
do $$
declare r text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.credential_expiry_notices'::regclass) then
    raise exception 'credential expiry notices: RLS off';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'credential_expiry_notices') then
    raise exception 'credential expiry notices: unexpected policy';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r, 'public.credential_expiry_notices', 'SELECT') or has_table_privilege(r, 'public.credential_expiry_notices', 'INSERT')
       or has_table_privilege(r, 'public.credential_expiry_notices', 'UPDATE') or has_table_privilege(r, 'public.credential_expiry_notices', 'DELETE') then
      raise exception 'credential expiry notices: % holds a privilege', r;
    end if;
  end loop;
end $$;

insert into public.orgs(id, name) values
 ('ce000000-0000-4000-8000-0000000000a1', 'cred-expiry-fixture-a'),
 ('ce000000-0000-4000-8000-0000000000a2', 'cred-expiry-fixture-b');
insert into public.employees(id, org_id, display_name, role_label) values
 ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-0000000000a1', 'Expiry A1', 'fixture'),
 ('ce100000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-0000000000a2', 'Expiry B1', 'fixture');
insert into public.credentials(id, org_id, employee_id, secret_hash, expires_at) values
 ('ce200000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-0000000000a1', 'ce100000-0000-4000-8000-000000000001', repeat('c', 64), now() + interval '6 days'),
 ('ce200000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-0000000000a2', 'ce100000-0000-4000-8000-000000000002', repeat('d', 64), now() + interval '6 days');

set role service_role;
-- (2) claim once per credential × threshold
insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
values ('ce200000-0000-4000-8000-000000000001', '7d', 'ce000000-0000-4000-8000-0000000000a1', 'ce100000-0000-4000-8000-000000000001', now() + interval '6 days');
select security_test.cen_rejects($q$insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
  values ('ce200000-0000-4000-8000-000000000001', '7d', 'ce000000-0000-4000-8000-0000000000a1', 'ce100000-0000-4000-8000-000000000001', now())$q$, '23505');
insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
values ('ce200000-0000-4000-8000-000000000001', '1d', 'ce000000-0000-4000-8000-0000000000a1', 'ce100000-0000-4000-8000-000000000001', now() + interval '6 days');
-- (4) threshold check
select security_test.cen_rejects($q$insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
  values ('ce200000-0000-4000-8000-000000000001', '30d', 'ce000000-0000-4000-8000-0000000000a1', 'ce100000-0000-4000-8000-000000000001', now())$q$, '23514');
-- (3) cross-org: org B's credential filed under org A, org A's credential with org B's employee, update moving the org
select security_test.cen_rejects($q$insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
  values ('ce200000-0000-4000-8000-000000000002', '7d', 'ce000000-0000-4000-8000-0000000000a1', 'ce100000-0000-4000-8000-000000000002', now())$q$, 'credential_expiry_notice_cross_org');
select security_test.cen_rejects($q$insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
  values ('ce200000-0000-4000-8000-000000000001', '7d', 'ce000000-0000-4000-8000-0000000000a2', 'ce100000-0000-4000-8000-000000000002', now())$q$, 'credential_expiry_notice_cross_org');
select security_test.cen_rejects($q$update public.credential_expiry_notices set org_id = 'ce000000-0000-4000-8000-0000000000a2'
  where credential_id = 'ce200000-0000-4000-8000-000000000001' and threshold = '7d'$q$, 'credential_expiry_notice_cross_org');
select security_test.cen_rejects($q$update public.credential_expiry_notices set employee_id = 'ce100000-0000-4000-8000-000000000002'
  where credential_id = 'ce200000-0000-4000-8000-000000000001' and threshold = '7d'$q$, 'credential_expiry_notice_cross_org');
-- release (send failed) = delete by key
delete from public.credential_expiry_notices where credential_id = 'ce200000-0000-4000-8000-000000000001' and threshold = '1d';
do $$
begin
  if (select count(*) from public.credential_expiry_notices where org_id = 'ce000000-0000-4000-8000-0000000000a1') <> 1 then
    raise exception 'credential expiry notices: release did not delete exactly one row';
  end if;
end $$;
reset role;

-- (1) sessions denied
set role authenticated;
select security_test.cen_denied('select * from public.credential_expiry_notices');
select security_test.cen_denied($q$insert into public.credential_expiry_notices (credential_id, threshold, org_id, employee_id, expires_at)
  values ('ce200000-0000-4000-8000-000000000002', '7d', 'ce000000-0000-4000-8000-0000000000a2', 'ce100000-0000-4000-8000-000000000002', now())$q$);
select security_test.cen_denied('delete from public.credential_expiry_notices');
set role anon;
select security_test.cen_denied('select * from public.credential_expiry_notices');
reset role;

-- (4) cascade on credential delete
delete from public.credentials where id = 'ce200000-0000-4000-8000-000000000001';
do $$
begin
  if exists (select 1 from public.credential_expiry_notices where credential_id = 'ce200000-0000-4000-8000-000000000001') then
    raise exception 'credential expiry notices: credential delete did not cascade';
  end if;
end $$;

-- cleanup
delete from public.credentials where id::text like 'ce2%';
delete from public.employees where id::text like 'ce1%';
delete from public.orgs where id::text like 'ce0%';
drop function security_test.cen_denied(text);
drop function security_test.cen_rejects(text, text);
