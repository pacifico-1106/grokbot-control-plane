-- トランザクションの外で単独で実行すること。
-- 失敗したときは INVALID なインデックスが残るので、確認してから DROP して再実行すること。
--
-- Optional supporting index for /app/audit action + created_at cursor (PR-5).
-- AUDIT_PAGE_FILTER_PAGE_ENABLED stays OFF until Kimura turns it on.
-- CREATE INDEX CONCURRENTLY cannot run inside BEGIN/COMMIT.
-- Rollback: supabase/verification/20261022100000_audit_events_org_action_created_idx_rollback.sql
create index concurrently if not exists audit_events_org_action_created_idx
  on public.audit_events (org_id, action, created_at desc);
