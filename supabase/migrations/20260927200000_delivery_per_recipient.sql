-- Migration: Per-recipient delivery uniqueness for approval_notification_deliveries
-- P0 Item 4: Support recipient-based routing (DM delivery to bound voters)
--
-- Changes:
-- 1. Add recipient column to track individual delivery targets
-- 2. Change unique constraint from (approval_id, channel_id)
--    to (approval_id, channel_id, recipient)
--
-- This allows:
-- - Same approval delivered to multiple recipients on same channel (channel + DMs)
-- - Tracking individual delivery per voter binding
-- - Thread deliveries tracked separately from channel deliveries
--
-- Backward compatibility:
-- - Existing rows have NULL recipient (channel delivery)
-- - New DM deliveries set recipient to external_user_id

-- Add recipient column
alter table approval_notification_deliveries
  add column if not exists recipient text;

-- Add recipient_kind to distinguish delivery types
alter table approval_notification_deliveries
  add column if not exists recipient_kind text check (recipient_kind in ('channel', 'dm', 'thread'));

-- Drop old unique constraint
alter table approval_notification_deliveries
  drop constraint if exists approval_notification_deliveries_approval_id_channel_id_key;

-- Create new unique constraint including recipient
-- Uses COALESCE to treat NULL as empty string for uniqueness
create unique index if not exists approval_notification_deliveries_unique_per_recipient
  on approval_notification_deliveries (approval_id, channel_id, coalesce(recipient, ''));

-- Index for looking up deliveries by recipient
create index if not exists approval_notification_deliveries_recipient_idx
  on approval_notification_deliveries (channel_id, recipient)
  where recipient is not null;

-- Index for looking up channel deliveries (recipient IS NULL)
create index if not exists approval_notification_deliveries_channel_only_idx
  on approval_notification_deliveries (approval_id, channel_id)
  where recipient is null;

-- Update existing rows to have recipient_kind = 'channel'
update approval_notification_deliveries
  set recipient_kind = 'channel'
  where recipient_kind is null;

comment on column approval_notification_deliveries.recipient is
  'External user ID for DM deliveries, thread_ts for thread deliveries, NULL for channel';

comment on column approval_notification_deliveries.recipient_kind is
  'Type of delivery: channel (default inbox), dm (direct message), thread (conversation reply)';
