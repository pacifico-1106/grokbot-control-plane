-- READ ONLY. Run by an authorized operator before AND after applying
-- 20261004600000_tenant_config_tables_server_only_writes.sql. Selects no row data.
-- Covers the 14 tenant config / credential tables + the formerly-LOW 5
-- (gateway_links, agentmail_inboxes, lp_handoffs, lp_wake_webhook_configs,
-- lp_wake_webhook_events) + the credentials read lockdown.
-- (0) pre-flight: all 19 tables must exist (expect 19 rows, none null);
--     the migration fails atomically otherwise.
-- Before: expect 19 rows in (1) (the 16 write policies + the 3
-- lp_*_service_all), the anon/authenticated write grants and credentials
-- SELECT in (2), 16 SELECT policies incl. credentials_select in (4), true in (5)
-- (keep this output — it is the exact state the documented rollback restores;
-- adapt the rollback grant lines if it differs).
-- After: (1) exactly 3 rows, the lp_*_service_all policies with
-- qual (auth.role() = 'service_role'::text) (admit no user session; kept);
-- (2) anon / authenticated: only SELECT (plus REFERENCES / TRIGGER if present),
-- and for credentials no SELECT either (REFERENCES / TRIGGER only, if present);
-- service_role unchanged;
-- (3) 0 rows; (4) 15 SELECT policies, none on credentials; (5) all false.
begin read only;
-- (0) the 19 tables exist
select t as table_name, to_regclass('public.' || t) as regclass
from unnest(array['credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events','gateway_links','agentmail_inboxes','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events']) t
order by 1;
-- (1) non-SELECT policies on the 19 tables
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events','gateway_links','agentmail_inboxes','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events') and cmd <> 'SELECT'
order by 1, 2;
-- (2) table privileges of anon / authenticated / service_role
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events','gateway_links','agentmail_inboxes','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events')
  and grantee in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;
-- (3) column-level grants to anon / authenticated that survive a table-level
--     revoke: INSERT / UPDATE on any of the 19, and SELECT on credentials
--     (would expose secret_hash)
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events','gateway_links','agentmail_inboxes','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events')
  and grantee in ('anon','authenticated')
  and (privilege_type in ('INSERT','UPDATE') or (table_name = 'credentials' and privilege_type = 'SELECT'))
  and not exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = column_privileges.table_name
      and g.grantee = column_privileges.grantee and g.privilege_type = column_privileges.privilege_type)
order by 1, 2, 3, 4;
-- (4) SELECT policies (all kept except credentials_select)
select tablename, policyname from pg_policies
where schemaname = 'public' and tablename in ('credentials','org_admin_agents','employees','employee_bindings','org_parties','org_channels','information_assets','org_notification_channels','org_conversation_adapters','org_sns_adapters','employee_slack_identities','org_external_contract_payment_methods','org_projects','audit_external_contract_card_events','gateway_links','agentmail_inboxes','lp_handoffs','lp_wake_webhook_configs','lp_wake_webhook_events') and cmd = 'SELECT'
order by 1, 2;
-- (5) can a user session read credentials / secret_hash? (after: all false)
select r as role,
  has_table_privilege(r, 'public.credentials', 'SELECT') as credentials_select,
  has_column_privilege(r, 'public.credentials', 'secret_hash', 'SELECT') as secret_hash_select
from unnest(array['anon','authenticated']) r
order by 1;
commit;
