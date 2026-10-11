-- LP tables: server-only (2026-10-04, 木村 follow-up decisions #2 / #3).
-- After 20261004600000 (#259, merged); 20261004700000 is taken by #260.
--
-- NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step,
-- after the app deploy. Every app access to these tables already uses the
-- service-role client in server code (pinned by
-- lib/security/lp-tables-server-only.test.ts), so order does not matter.
-- Existing rows are not modified. Re-runnable. Stricter only: removes
-- privileges / policies, adds none. service_role grants are not touched.
--
-- Requires all 5 tables (20261001000000_lp_inquiries.sql,
-- 20261001400000_lp_handoffs.sql); if one is missing the whole migration fails
-- atomically: everything runs in one explicit transaction (begin; ... commit;),
-- so a failing statement leaves no partial revoke / drop behind. Only
-- transactional statements (revoke / drop policy if exists); nothing like
-- CREATE INDEX CONCURRENTLY or VACUUM. Run the verification SQL first:
-- service_role must have BYPASSRLS (Supabase default) — otherwise dropping the
-- policies below would lock the server out of the lp_* tables.
--
-- 1) lp_inquiries / notification_outbox (PII: inquiry contact data, outbound
--    notification recipients): RLS on, no policy, so sessions already get no
--    rows. 20261001000000 did REVOKE ALL from anon / authenticated, but an
--    environment that re-granted Supabase's default table grants would still
--    hand sessions INSERT / UPDATE / DELETE / TRUNCATE. Revoke them again
--    (defence in depth; a future permissive policy cannot silently re-open
--    the tables). SELECT is not touched here (already revoked by 20261001000000
--    where that migration ran as written).
-- 2) lp_handoffs / lp_wake_webhook_configs / lp_wake_webhook_events: drop the
--    `*_service_all` policies (FOR ALL using auth.role() = 'service_role').
--    They admit no user session, and service_role bypasses RLS, so they never
--    grant anything; dropping them leaves RLS enabled with no policy (sessions
--    see / write nothing, as before). No object depends on them (checked by
--    tests/security/db-lp-tables-server-only.sql and the verification SQL).
-- 3) lp_handoffs / lp_wake_webhook_configs / lp_wake_webhook_events: revoke
--    SELECT from anon / authenticated (木村 2026-10-04). No user-session or
--    anon client reads them: the only readers are lib/lp/handoffs.ts and
--    lib/lp/wake-webhook.ts on createSupabaseAdminClient(), reached from
--    app/api/lp/handoff (guest journey + ownership check),
--    app/api/webhooks/lp-wake/[path] (per-endpoint secret) and the
--    lp-handoff-outbox cron (CRON_SECRET) — pinned by
--    lib/security/lp-tables-server-only.test.ts. With RLS on and no policy,
--    sessions already saw 0 rows; without the grant a session query is
--    "permission denied" (rows and columns, e.g. secret_hash /
--    summary_draft), and a future permissive policy cannot expose them.

begin;

-- 1) write privileges
revoke insert, update, delete, truncate on public.lp_inquiries, public.notification_outbox from anon, authenticated;

-- 2) redundant service-role-only policies
drop policy if exists lp_handoffs_service_all on public.lp_handoffs;
drop policy if exists lp_wake_configs_service_all on public.lp_wake_webhook_configs;
drop policy if exists lp_wake_events_service_all on public.lp_wake_webhook_events;

-- 3) no session SELECT on the 3 lp_* tables (service_role keeps its grants)
revoke select on public.lp_handoffs, public.lp_wake_webhook_configs, public.lp_wake_webhook_events from anon, authenticated;

commit;

-- ROLLBACK (down) — restores the pre-migration state: the 3 policies exactly as
-- created by 20261001400000_lp_handoffs.sql, Supabase's default write grants
-- on lp_inquiries / notification_outbox, and Supabase's default SELECT on the
-- 3 lp_* tables. Compare with the verification SQL snapshot taken before
-- apply: if (2) showed NO anon/authenticated write grant on lp_inquiries /
-- notification_outbox (the expected state after 20261001000000), skip the
-- first grant line; if (2) / (6) showed NO anon/authenticated SELECT on an
-- lp_* table, drop that table from the second grant line (skip it if none).
-- Run as one transaction:
--   begin;
--   grant insert, update, delete, truncate on public.lp_inquiries, public.notification_outbox to anon, authenticated;
--   grant select on public.lp_handoffs, public.lp_wake_webhook_configs, public.lp_wake_webhook_events to anon, authenticated;
--   create policy lp_handoffs_service_all on public.lp_handoffs for all using (auth.role() = 'service_role');
--   create policy lp_wake_configs_service_all on public.lp_wake_webhook_configs for all using (auth.role() = 'service_role');
--   create policy lp_wake_events_service_all on public.lp_wake_webhook_events for all using (auth.role() = 'service_role');
--   commit;
-- END ROLLBACK
