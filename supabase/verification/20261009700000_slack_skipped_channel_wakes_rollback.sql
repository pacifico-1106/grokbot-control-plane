-- Rollback for 20261009700000_slack_skipped_channel_wakes.sql (same statements as
-- the migration's ROLLBACK block). Turn PATHC_REWAKE_ON_CLASSIFY_ENABLED off first.
begin;
drop function if exists public.claim_slack_skipped_channel_wakes(uuid, text, uuid, integer);
drop function if exists public.record_slack_skipped_channel_wake(uuid, uuid, text, text, text, text, text, text, text, text);
drop table if exists public.slack_skipped_channel_wakes;
commit;
