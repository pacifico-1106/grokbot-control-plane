-- PR-A P0 Item 2: Voter binding registration with identity verification
-- This migration adds verification columns to support pending state and Slack DM confirmation.
-- Apply BEFORE the matching application code. Does not modify existing bindings.
-- Production verification: check verification_hash / verification_expiry columns exist after apply.
begin;
set local lock_timeout = '5s';

-- Add team_id column to track Slack workspace for external user rejection
alter table public.approval_workflow_voter_bindings
  add column if not exists team_id text;

-- Add verification columns for pending state
alter table public.approval_workflow_voter_bindings
  add column if not exists verification_hash text,
  add column if not exists verification_expiry timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists updated_at timestamptz default now();

-- Index for listing by member
create index if not exists voter_binding_member_idx
  on public.approval_workflow_voter_bindings(member_id, org_id);

-- Index for listing by status (pending vs active)
create index if not exists voter_binding_verified_idx
  on public.approval_workflow_voter_bindings(org_id, verified_at)
  where revoked_at is null;

comment on column public.approval_workflow_voter_bindings.team_id is
  'Slack team_id captured at verification. Used to reject Slack Connect external users.';
comment on column public.approval_workflow_voter_bindings.verification_hash is
  'HMAC-SHA256 hash of the verification code. Cleared after verification.';
comment on column public.approval_workflow_voter_bindings.verification_expiry is
  'Expiry timestamp for the verification code. Cleared after verification.';
comment on column public.approval_workflow_voter_bindings.verified_at is
  'Timestamp when identity verification completed. NULL = pending state.';
comment on column public.approval_workflow_voter_bindings.updated_at is
  'Last update timestamp for audit trail.';

commit;
