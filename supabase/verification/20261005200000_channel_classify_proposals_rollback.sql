-- Rollback for 20261005200000_channel_classify_proposals.sql (same statements
-- as the migration's ROLLBACK block). Turn CHANNEL_CLASSIFY_PROPOSALS_ENABLED
-- and CHANNEL_STUCK_NOTIFY_ENABLED off first.
begin;
drop function if exists public.claim_channel_classify_proposal(uuid, text, text, integer);
drop function if exists public.attach_channel_classify_proposal(uuid, text, uuid);
drop function if exists public.release_channel_classify_proposal(uuid, text);
drop function if exists public.take_channel_stuck_notice(uuid, text, integer);
drop table if exists public.channel_classify_proposals;
drop table if exists public.channel_stuck_notice_windows;
delete from public.org_channels where surface = 'telegram';
alter table public.org_channels drop constraint if exists org_channels_surface_check;
alter table public.org_channels add constraint org_channels_surface_check
  check (surface in ('slack','line','mail','phone','web'));
commit;
