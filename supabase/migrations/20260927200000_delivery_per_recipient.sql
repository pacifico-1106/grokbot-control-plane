-- Migration: Per-recipient delivery uniqueness for approval_notification_deliveries
-- P0 Item 4: Support recipient-based routing (DM delivery to bound voters)
--
-- Changes:
-- 1. Add recipient column to track individual delivery targets
-- 2. Add partial unique index for DM/thread deliveries (recipient IS NOT NULL)
-- 3. KEEP the old unique constraint for channel deliveries (recipient IS NULL)
--
-- Backward compatibility:
-- - Old code uses `onConflict: "approval_id,channel_id"` which requires the original
--   constraint to exist. We KEEP this constraint for channel deliveries.
-- - New DM deliveries have recipient IS NOT NULL and use a separate partial index.
-- - Existing rows have NULL recipient (channel delivery) and are unaffected.
--
-- Note: The UPDATE backfill for recipient_kind is safe for small tables.

begin;
set local lock_timeout = '5s';

-- Add recipient column
alter table public.approval_notification_deliveries
  add column if not exists recipient text;

-- Add recipient_kind to distinguish delivery types
alter table public.approval_notification_deliveries
  add column if not exists recipient_kind text check (recipient_kind in ('channel', 'dm', 'thread'));

-- DO NOT drop the old unique constraint!
-- Old code depends on: onConflict: "approval_id,channel_id"
-- The constraint approval_notification_deliveries_approval_id_channel_id_key remains.

-- Add partial unique index for DM/thread deliveries (recipient IS NOT NULL)
-- This ensures uniqueness for (approval_id, channel_id, recipient) when recipient is set.
create unique index if not exists approval_notification_deliveries_recipient_unique_idx
  on public.approval_notification_deliveries (approval_id, channel_id, recipient)
  where recipient is not null;

-- Index for looking up deliveries by recipient
create index if not exists approval_notification_deliveries_recipient_idx
  on public.approval_notification_deliveries (channel_id, recipient)
  where recipient is not null;

-- Update existing rows to have recipient_kind = 'channel'
-- Safe backfill: table is typically small (one row per approval per channel)
update public.approval_notification_deliveries
  set recipient_kind = 'channel'
  where recipient_kind is null;

comment on column public.approval_notification_deliveries.recipient is
  'External user ID for DM deliveries, thread_ts for thread deliveries, NULL for channel';

comment on column public.approval_notification_deliveries.recipient_kind is
  'Type of delivery: channel (default inbox), dm (direct message), thread (conversation reply)';

commit;
