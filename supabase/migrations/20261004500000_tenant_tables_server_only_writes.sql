-- Tenant-table RLS write holes (2026-10-04, review by 木村).
--
-- NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step,
-- after the app deploy of this PR (the app has no user-session writer to
-- these tables, so either order is safe; deploy first is the documented order).
-- Existing rows are not modified. Re-runnable.
--
-- These four policies (roles {public}) let any tenant session JWT + the public
-- anon key write the tables directly through PostgREST, bypassing every server
-- guard (requireCapability, plan rails, approval workflow, Stripe webhook):
--   approval_requests.approvals_write_member  ALL     using is_org_member(org_id)
--       → any member could self-approve / edit metadata / insert pre-approved
--         tickets / delete tickets of their org
--   audit_events.audit_insert_member          INSERT  with check is_org_member(org_id)
--       → any member could forge audit rows (e.g. setup.tool_succeeded; #255
--         stops reading member-inserted rows as a signal, this closes the source)
--   orgs.orgs_update_admin                    UPDATE  using is_org_admin(id)
--       → tenant admins could rewrite plan_key / billing_status /
--         scheduled_plan_key / stripe_customer_id / trial_ends_at and the
--         approval-gated org policies (mail_policy, reply_policy, ...)
--   subscriptions.subscriptions_write_admin   ALL     using is_org_admin(org_id)
--       → tenant admins could rewrite / insert / delete their own plan row
--
-- All app writes use the service-role client in server code (bypasses RLS and
-- keeps its table grants), so app behaviour is unchanged. SELECT policies
-- (orgs_select_member, approvals_select, audit_select, subscriptions_select)
-- are kept. Same pattern as 20261004200000_org_members_capability_guard.sql.

-- 1) Remove the direct PostgREST write policies.
drop policy if exists approvals_write_member on public.approval_requests;
drop policy if exists audit_insert_member on public.audit_events;
drop policy if exists orgs_update_admin on public.orgs;
drop policy if exists subscriptions_write_admin on public.subscriptions;

-- 2) Defence in depth: no table-level write privilege for anon / authenticated,
--    so a future permissive policy cannot silently re-open these tables
--    (writes then fail with "permission denied" instead of RLS filtering).
--    service_role grants are untouched.
revoke insert, update, delete, truncate on public.orgs, public.subscriptions, public.audit_events, public.approval_requests from anon, authenticated;

-- ROLLBACK (down) — re-opens the holes above; restores the exact pre-migration
-- state (Supabase default grants + the four policies as last defined in
-- 20260823_production_ready.sql / schema.sql). Run as one transaction:
--   begin;
--   grant insert, update, delete, truncate on public.orgs, public.subscriptions, public.audit_events, public.approval_requests to anon, authenticated;
--   create policy approvals_write_member on public.approval_requests for all using (public.is_org_member(org_id));
--   create policy audit_insert_member on public.audit_events for insert with check (public.is_org_member(org_id));
--   create policy orgs_update_admin on public.orgs for update using (public.is_org_admin(id));
--   create policy subscriptions_write_admin on public.subscriptions for all using (public.is_org_admin(org_id));
--   commit;
-- END ROLLBACK
