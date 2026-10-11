-- Rollback for 20261013100000_operator_notices.sql. Set OPERATOR_NOTICES_ENABLED and
-- OPS_FEEDBACK_ENABLED off first. Drops every notice, receipt and feedback item.
begin;
drop table if exists public.operator_notice_receipts;
drop table if exists public.operator_notice_targets;
drop table if exists public.operator_notice_versions;
drop table if exists public.ops_feedback_events;
drop table if exists public.ops_feedback_items;
drop function if exists public.list_visible_operator_notices(uuid, uuid, timestamptz);
drop function if exists public.operator_notice_visible(text, uuid, uuid, timestamptz);
drop table if exists public.operator_notices;
drop function if exists public.operator_notice_targets_guard();
drop function if exists public.operator_notices_guard();
drop function if exists public.operator_notice_receipts_guard();
drop function if exists public.ops_feedback_events_guard();
drop function if exists public.operator_notices_append_only();
drop function if exists public.operator_notices_no_direct_delete();
commit;
