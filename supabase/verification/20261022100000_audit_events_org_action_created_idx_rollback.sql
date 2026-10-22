-- トランザクションの外で単独で実行すること。
-- 失敗したときは INVALID なインデックスが残るので、確認してから DROP して再実行すること。
--
-- Rollback for 20261022100000_audit_events_org_action_created_idx.sql
-- DROP INDEX CONCURRENTLY cannot run inside BEGIN/COMMIT.
drop index concurrently if exists public.audit_events_org_action_created_idx;
