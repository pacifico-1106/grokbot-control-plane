-- Rollback for 20261022100000_audit_events_org_action_created_idx.sql
begin;
drop index if exists public.audit_events_org_action_created_idx;
commit;
