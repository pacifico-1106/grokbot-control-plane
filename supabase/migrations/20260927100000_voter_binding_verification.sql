-- PR-A P0 Item 2: Voter binding registration with identity verification
-- This migration adds verification columns to support pending state and Slack DM confirmation.
-- Apply BEFORE the matching application code.
--
-- BACKFILL: Existing bindings (pre-verification-flow) are marked as verified to preserve
-- prod behavior. New pending bindings will have verification_hash set until verified.
--
-- Production verification: check verification_hash / verification_expiry / created_at columns exist.
begin;
set local lock_timeout = '5s';

-- Add team_id column to track Slack workspace for external user rejection
alter table public.approval_workflow_voter_bindings
  add column if not exists team_id text;

-- Add created_at for audit trail (needed for backfill reference)
alter table public.approval_workflow_voter_bindings
  add column if not exists created_at timestamptz default now();

-- Add verification columns for pending state
alter table public.approval_workflow_voter_bindings
  add column if not exists verification_hash text,
  add column if not exists verification_expiry timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists updated_at timestamptz default now();

-- BACKFILL: Mark existing bindings as verified to preserve prod behavior.
-- Only backfill rows that:
-- 1. Have verified_at IS NULL (not already verified)
-- 2. Have revoked_at IS NULL (not revoked)
-- 3. Have verification_hash IS NULL (not a pending new-flow binding)
-- These are pre-existing operator-inserted bindings that should continue working.
update public.approval_workflow_voter_bindings
  set verified_at = coalesce(created_at, now()),
      updated_at = now()
  where verified_at is null
    and revoked_at is null
    and verification_hash is null;

-- Index for listing by member
create index if not exists voter_binding_member_idx
  on public.approval_workflow_voter_bindings(member_id, org_id);

-- Index for listing by status (pending vs active)
create index if not exists voter_binding_verified_idx
  on public.approval_workflow_voter_bindings(org_id, verified_at)
  where revoked_at is null;

comment on column public.approval_workflow_voter_bindings.team_id is
  'Slack team_id captured at verification. Used to reject Slack Connect external users.';
comment on column public.approval_workflow_voter_bindings.created_at is
  'Timestamp when binding was created. Used for backfill reference.';
comment on column public.approval_workflow_voter_bindings.verification_hash is
  'HMAC-SHA256 hash of the verification code. Cleared after verification.';
comment on column public.approval_workflow_voter_bindings.verification_expiry is
  'Expiry timestamp for the verification code. Cleared after verification.';
comment on column public.approval_workflow_voter_bindings.verified_at is
  'Timestamp when identity verification completed. NULL = pending state.';
comment on column public.approval_workflow_voter_bindings.updated_at is
  'Last update timestamp for audit trail.';

commit;
