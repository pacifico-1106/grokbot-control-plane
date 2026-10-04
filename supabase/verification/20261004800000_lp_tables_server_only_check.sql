-- READ ONLY. Run by an authorized operator before AND after applying
-- 20261004800000_lp_tables_server_only.sql. Selects no row data.
-- Before: (0) 5 tables non-null and service_role rolbypassrls = t (STOP if f:
-- the migration drops the only policies service_role could use); (1) the 3
-- lp_*_service_all policies; (2) keep as the grant snapshot (decides whether
-- the rollback grant line is needed); (5) 0 rows (nothing depends on the
-- policies).
-- After: (0) unchanged; (1) 0 rows; (2) anon / authenticated have no
-- INSERT / UPDATE / DELETE / TRUNCATE on lp_inquiries / notification_outbox
-- (other tables / SELECT unchanged); (3) 0 rows; (4) all t; (5) 0 rows.
begin read only;
-- (0) tables exist; service_role bypasses RLS
select t as table_name, to_regclass('public.' || t) as regclass
from unnest(array['lp_inquiries','notification_outbox','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events']) t
order by 1;
select rolname, rolbypassrls from pg_roles where rolname = 'service_role';
-- (1) policies on the 5 tables
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('lp_inquiries','notification_outbox','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events')
order by 1, 2;
-- (2) table privileges of anon / authenticated / service_role
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('lp_inquiries','notification_outbox','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events')
  and grantee in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;
-- (3) column-level INSERT / UPDATE grants to anon / authenticated on lp_inquiries / notification_outbox
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('lp_inquiries','notification_outbox')
  and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
  and not exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = column_privileges.table_name
      and g.grantee = column_privileges.grantee and g.privilege_type = column_privileges.privilege_type)
order by 1, 2, 3, 4;
-- (4) RLS still enabled on all 5
select relname, relrowsecurity
from pg_class
where oid in (select to_regclass('public.' || t) from unnest(array['lp_inquiries','notification_outbox','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events']) t)
order by 1;
-- (5) objects depending on the lp_*_service_all policies (expect 0 rows)
select d.classid::regclass, d.objid, p.polname
from pg_depend d join pg_policy p on d.refclassid = 'pg_policy'::regclass and d.refobjid = p.oid
where p.polname in ('lp_handoffs_service_all','lp_wake_configs_service_all','lp_wake_events_service_all');
commit;
