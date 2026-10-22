-- Optional supporting index for /app/audit action + created_at cursor (PR-5).
-- AUDIT_PAGE_FILTER_PAGE_ENABLED stays OFF until Kimura turns it on.
-- Rollback: supabase/verification/20261022100000_audit_events_org_action_created_idx_rollback.sql
begin;
create index if not exists audit_events_org_action_created_idx
  on public.audit_events (org_id, action, created_at desc);
commit;
