-- Tenant config / credential tables: RLS write holes, phase 2
-- (2026-10-04, review by 木村, item (c)). Stacked on 20261004500000 (#258).
--
-- NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step,
-- after 20261004500000 and after the app deploy of this PR (the app has no
-- user-session writer to these tables, so either order is safe; deploy first
-- is the documented order). Existing rows are not modified. Re-runnable.
--
-- Requires all 14 tables to exist (org_external_contract_payment_methods and
-- audit_external_contract_card_events come from
-- 20260923_external_contract_card_setup.sql); if one is missing the whole
-- migration fails atomically instead of silently skipping it.
--
-- These policies (roles {public}) let a tenant session JWT + the public anon
-- key write the tables directly through PostgREST, bypassing every server
-- guard (requireCapability / requireCredentialAdmin, secret hashing, approval
-- gating, audit logging, Stripe webhook verification):
--   HIGH
--   credentials.credentials_write_admin            ALL  using is_org_admin(org_id)
--       → org admins could widen scopes / un-revoke / mint credential rows
--   org_admin_agents.org_admin_agents_write_admin  ALL  using/check is_org_admin(org_id)
--       → re-link the admin MCP agent to an arbitrary agent id
--   employees.employees_write_admin                ALL  using is_org_admin(org_id)
--       → rewrite approval_policy / tool defaults / allowed accounts / status
--         without the approval-gated policy flow
--   employee_bindings.bindings_write_admin         ALL  using is_org_admin(org_id)
--       → re-link an employee to an attacker agent / un-revoke a binding
--   MED-HIGH
--   org_parties / org_channels / information_assets  *_write_admin  ALL
--       → reclassify external parties / shared channels / confidential assets
--         as internal (audience egress control)
--   MEDIUM
--   org_notification_channels.notification_channels_write_admin   ALL
--   org_conversation_adapters.conversation_adapters_write_admin    ALL
--   org_sns_adapters.sns_adapters_write_admin                      ALL
--   employee_slack_identities.employee_slack_identities_write_admin ALL
--   org_external_contract_payment_methods.org_ext_contract_pm_write_admin ALL
--   org_projects.org_projects_write_admin                          ALL
--   audit_external_contract_card_events.audit_ext_card_insert_member INSERT
--       check is_org_member(org_id) → any member could forge card audit rows
--
-- All app writes use the service-role client in server code (bypasses RLS and
-- keeps its table grants), so app behaviour is unchanged. Every SELECT policy
-- (*_select, is_org_member) is kept. LOW tables (agentmail_inboxes,
-- gateway_links, lp_*) are deliberately not touched here.
-- Same pattern as 20261004500000_tenant_tables_server_only_writes.sql.

-- 1) Remove the direct PostgREST write policies.
drop policy if exists credentials_write_admin on public.credentials;
drop policy if exists org_admin_agents_write_admin on public.org_admin_agents;
drop policy if exists employees_write_admin on public.employees;
drop policy if exists bindings_write_admin on public.employee_bindings;
drop policy if exists org_parties_write_admin on public.org_parties;
drop policy if exists org_channels_write_admin on public.org_channels;
drop policy if exists information_assets_write_admin on public.information_assets;
drop policy if exists notification_channels_write_admin on public.org_notification_channels;
drop policy if exists conversation_adapters_write_admin on public.org_conversation_adapters;
drop policy if exists sns_adapters_write_admin on public.org_sns_adapters;
drop policy if exists employee_slack_identities_write_admin on public.employee_slack_identities;
drop policy if exists org_ext_contract_pm_write_admin on public.org_external_contract_payment_methods;
drop policy if exists org_projects_write_admin on public.org_projects;
drop policy if exists audit_ext_card_insert_member on public.audit_external_contract_card_events;

-- 2) Defence in depth: no table-level write privilege for anon / authenticated,
--    so a future permissive policy cannot silently re-open these tables
--    (writes then fail with "permission denied" instead of RLS filtering).
--    SELECT and service_role grants are untouched.
revoke insert, update, delete, truncate on public.credentials, public.org_admin_agents, public.employees, public.employee_bindings, public.org_parties, public.org_channels, public.information_assets, public.org_notification_channels, public.org_conversation_adapters, public.org_sns_adapters, public.employee_slack_identities, public.org_external_contract_payment_methods, public.org_projects, public.audit_external_contract_card_events from anon, authenticated;

-- ROLLBACK (down) — re-opens the holes above; restores the pre-migration state
-- (Supabase default grants + the 14 policies exactly as last defined in
-- schema.sql / 20260823_production_ready.sql / 20260827_tenant_notification_channels.sql /
-- 20260828_* / 20260831_sns_publish.sql / 20260903_admin_mcp.sql /
-- 20260923_external_contract_card_setup.sql). If production grants differed
-- before apply (snapshot first), adapt the grant line. Run as one transaction:
--   begin;
--   grant insert, update, delete, truncate on public.credentials, public.org_admin_agents, public.employees, public.employee_bindings, public.org_parties, public.org_channels, public.information_assets, public.org_notification_channels, public.org_conversation_adapters, public.org_sns_adapters, public.employee_slack_identities, public.org_external_contract_payment_methods, public.org_projects, public.audit_external_contract_card_events to anon, authenticated;
--   create policy credentials_write_admin on public.credentials for all using (public.is_org_admin(org_id));
--   create policy org_admin_agents_write_admin on public.org_admin_agents for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy employees_write_admin on public.employees for all using (public.is_org_admin(org_id));
--   create policy bindings_write_admin on public.employee_bindings for all using (public.is_org_admin(org_id));
--   create policy org_parties_write_admin on public.org_parties for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy org_channels_write_admin on public.org_channels for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy information_assets_write_admin on public.information_assets for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy notification_channels_write_admin on public.org_notification_channels for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy conversation_adapters_write_admin on public.org_conversation_adapters for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy sns_adapters_write_admin on public.org_sns_adapters for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy employee_slack_identities_write_admin on public.employee_slack_identities for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy org_ext_contract_pm_write_admin on public.org_external_contract_payment_methods for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy org_projects_write_admin on public.org_projects for all using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
--   create policy audit_ext_card_insert_member on public.audit_external_contract_card_events for insert with check (public.is_org_member(org_id));
--   commit;
-- END ROLLBACK
