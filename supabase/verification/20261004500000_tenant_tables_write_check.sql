-- READ ONLY. Run by an authorized operator before AND after applying
-- 20261004500000_tenant_tables_server_only_writes.sql. Selects no row data.
-- Before: expect the 4 write policies and the anon/authenticated write grants
-- (keep this output — it is the exact state the documented rollback restores).
-- After: expect 0 rows from (1) and (3), and (2) to show only SELECT (plus
-- REFERENCES / TRIGGER if present) for anon / authenticated.
begin read only;
-- (1) non-SELECT policies on the four tables
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('orgs','subscriptions','audit_events','approval_requests') and cmd <> 'SELECT'
order by 1, 2;
-- (2) table privileges of anon / authenticated / service_role
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('orgs','subscriptions','audit_events','approval_requests')
  and grantee in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;
-- (3) column-level INSERT / UPDATE grants to anon / authenticated (survive a table-level revoke)
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('orgs','subscriptions','audit_events','approval_requests')
  and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
  and not exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = column_privileges.table_name
      and g.grantee = column_privileges.grantee and g.privilege_type = column_privileges.privilege_type)
order by 1, 2, 3, 4;
-- (4) SELECT policies are kept
select tablename, policyname from pg_policies
where schemaname = 'public' and tablename in ('orgs','subscriptions','audit_events','approval_requests') and cmd = 'SELECT'
order by 1, 2;
commit;
