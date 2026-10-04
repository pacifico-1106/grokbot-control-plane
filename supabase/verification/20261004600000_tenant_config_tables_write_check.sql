-- READ ONLY. Run by an authorized operator before AND after applying
-- 20261004600000_tenant_config_tables_server_only_writes.sql. Selects no row data.
-- (0) pre-flight: all 14 tables must exist (expect 14 rows, none null);
--     the migration fails atomically otherwise.
-- Before: expect the 14 write policies in (1) and the anon/authenticated write
-- grants in (2) (keep this output — it is the exact state the documented
-- rollback restores; adapt the rollback grant line if it differs).
-- After: expect 0 rows from (1) and (3), and (2) to show only SELECT (plus
-- REFERENCES / TRIGGER if present) for anon / authenticated; (4) 14 rows.
begin read only;
-- (0) the 14 tables exist
select t as table_name, to_regclass('public.' || t) as regclass
from unnest(array['credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events']) t
order by 1;
-- (1) non-SELECT policies on the 14 tables
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events') and cmd <> 'SELECT'
order by 1, 2;
-- (2) table privileges of anon / authenticated / service_role
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events')
  and grantee in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;
-- (3) column-level INSERT / UPDATE grants to anon / authenticated (survive a table-level revoke)
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events')
  and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
  and not exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = column_privileges.table_name
      and g.grantee = column_privileges.grantee and g.privilege_type = column_privileges.privilege_type)
order by 1, 2, 3, 4;
-- (4) SELECT policies are kept
select tablename, policyname from pg_policies
where schemaname = 'public' and tablename in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events') and cmd = 'SELECT'
order by 1, 2;
commit;
