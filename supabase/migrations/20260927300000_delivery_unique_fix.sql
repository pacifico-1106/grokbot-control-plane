-- Migration: Fix delivery unique constraint gap for recipient routing
-- P0 Fix: Replace full unique constraint with partial index for legacy channel deliveries
--
-- Problem:
-- The old unique constraint (approval_id, channel_id) causes collisions when
-- APPROVAL_RECIPIENT_ROUTING is ON and both DM delivery (recipient not null)
-- and channel delivery (recipient null) share the same channel_id.
--
-- Solution:
-- 1. Replace the full unique constraint with a partial unique index for
--    legacy channel deliveries (recipient IS NULL)
-- 2. Keep the per-recipient partial unique index (recipient IS NOT NULL)
-- 3. Create an upsert RPC function for safe concurrent writes
--
-- Safety:
-- - Check for duplicates before dropping constraint (fail loudly, never delete)
-- - Idempotent: safe to re-run

begin;
set local lock_timeout = '5s';

-- Safety check: fail if there are duplicate (approval_id, channel_id, recipient) combinations
-- that would violate the new partial index once the old constraint is dropped.
-- This should never happen in practice, but we fail loudly rather than silently delete.
do $$
declare
  dup_count integer;
begin
  select count(*) into dup_count from (
    select approval_id, channel_id, recipient
    from public.approval_notification_deliveries
    group by approval_id, channel_id, recipient
    having count(*) > 1
  ) dups;
  
  if dup_count > 0 then
    raise exception 'SAFETY_CHECK_FAILED: Found % duplicate (approval_id, channel_id, recipient) combinations. Manual intervention required.', dup_count;
  end if;
end $$;

-- Drop the old full unique constraint if it exists
-- This constraint was: unique (approval_id, channel_id)
-- Constraint name follows PostgreSQL naming convention: tablename_col1_col2_key
alter table public.approval_notification_deliveries
  drop constraint if exists approval_notification_deliveries_approval_id_channel_id_key;

-- Create partial unique index for legacy channel deliveries (recipient IS NULL)
-- This ensures uniqueness for (approval_id, channel_id) when recipient is null.
create unique index if not exists approval_notification_deliveries_channel_unique_idx
  on public.approval_notification_deliveries (approval_id, channel_id)
  where recipient is null;

-- Note: The per-recipient partial unique index already exists from 20260927200000:
-- approval_notification_deliveries_recipient_unique_idx on (approval_id, channel_id, recipient)
-- where recipient is not null

-- Create upsert function for notification deliveries
-- This handles both legacy (recipient null) and per-recipient rows correctly
-- since Supabase JS onConflict cannot target partial indexes directly.
create or replace function public.upsert_notification_delivery(
  p_approval_id uuid,
  p_org_id uuid,
  p_channel_id uuid,
  p_provider text,
  p_external_message_id text default null,
  p_context jsonb default '{}'::jsonb,
  p_recipient text default null,
  p_recipient_kind text default 'channel'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Validate provider
  if p_provider not in ('telegram', 'line', 'slack') then
    raise exception 'invalid_provider';
  end if;
  
  -- Validate recipient_kind
  if p_recipient_kind not in ('channel', 'dm', 'thread') then
    raise exception 'invalid_recipient_kind';
  end if;
  
  -- For legacy channel deliveries (recipient is null), match on (approval_id, channel_id)
  -- For per-recipient deliveries (recipient is not null), match on (approval_id, channel_id, recipient)
  if p_recipient is null then
    -- Legacy upsert: match on (approval_id, channel_id) where recipient is null
    insert into approval_notification_deliveries (
      approval_id, org_id, channel_id, provider, external_message_id, context,
      recipient, recipient_kind, updated_at
    )
    values (
      p_approval_id, p_org_id, p_channel_id, p_provider, p_external_message_id, p_context,
      null, p_recipient_kind, now()
    )
    on conflict (approval_id, channel_id) where recipient is null
    do update set
      external_message_id = excluded.external_message_id,
      context = excluded.context,
      recipient_kind = excluded.recipient_kind,
      updated_at = now()
    returning id into v_id;
  else
    -- Per-recipient upsert: match on (approval_id, channel_id, recipient)
    insert into approval_notification_deliveries (
      approval_id, org_id, channel_id, provider, external_message_id, context,
      recipient, recipient_kind, updated_at
    )
    values (
      p_approval_id, p_org_id, p_channel_id, p_provider, p_external_message_id, p_context,
      p_recipient, p_recipient_kind, now()
    )
    on conflict (approval_id, channel_id, recipient) where recipient is not null
    do update set
      external_message_id = excluded.external_message_id,
      context = excluded.context,
      recipient_kind = excluded.recipient_kind,
      updated_at = now()
    returning id into v_id;
  end if;
  
  return v_id;
end;
$$;

-- Grant execute to service_role only (server-side use)
revoke all on function public.upsert_notification_delivery(uuid, uuid, uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.upsert_notification_delivery(uuid, uuid, uuid, text, text, jsonb, text, text) to service_role;

comment on function public.upsert_notification_delivery is
  'Upsert notification delivery with proper partial index handling. Legacy rows (recipient null) use (approval_id, channel_id) uniqueness. Per-recipient rows use (approval_id, channel_id, recipient) uniqueness.';

commit;
