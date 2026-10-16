-- Rollback for 20261016200000_operator_notices.sql (same statements as the
-- migration's ROLLBACK block). Turn OPERATOR_NOTICES_ENABLED /
-- OPS_FEEDBACK_ENABLED / OPS_WEEKLY_DIGEST_ENABLED off first.
begin;
set local lock_timeout = '5s';
drop trigger if exists ops_feedback_events_same_org on public.ops_feedback_events;
drop trigger if exists operator_notice_receipts_visible on public.operator_notice_receipts;
drop trigger if exists operator_notices_all_targets_guard on public.operator_notices;
drop trigger if exists operator_notice_targets_locked_del on public.operator_notice_targets;
drop trigger if exists operator_notice_targets_same_org on public.operator_notice_targets;
drop table if exists public.ops_feedback_events;
drop table if exists public.ops_feedback_items;
drop table if exists public.operator_notice_receipts;
drop table if exists public.operator_notice_targets;
drop table if exists public.operator_notice_versions;
drop table if exists public.operator_notices;
drop function if exists public.operator_notice_counts_for_employee(uuid, uuid);
drop function if exists public.operator_notices_for_employee(uuid, uuid);
drop function if exists public.operator_notice_audience_matches(public.operator_notices, uuid, uuid);
drop function if exists public.operator_notice_employee_in_org(uuid, uuid);
drop function if exists public.ops_feedback_events_same_org();
drop function if exists public.operator_notice_receipt_visible();
drop function if exists public.operator_notices_all_targets_guard();
drop function if exists public.operator_notices_target_locked_del();
drop function if exists public.operator_notices_target_same_org();
commit;
