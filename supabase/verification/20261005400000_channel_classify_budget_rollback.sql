-- Rollback for 20261005400000_channel_classify_budget.sql (same statements as
-- the migration's ROLLBACK block). Turn CHANNEL_CLASSIFY_PROPOSALS_ENABLED and
-- CHANNEL_STUCK_NOTIFY_ENABLED off first. PR-B tables (20261005200000) stay.
begin;
drop function if exists public.take_channel_classify_budget(uuid, text, integer, integer);
drop table if exists public.channel_classify_budget_windows;
commit;
