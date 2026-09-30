-- Fix: Telegram callback_data exceeds 64-byte limit (BUTTON_DATA_INVALID)
--
-- Problem: The previous implementation base64-encoded the full binding info
-- (orgId, telegramUserId, verificationCode, channelKey, timestamp) into callback_data,
-- which resulted in ~190 bytes — far exceeding Telegram's 64-byte limit.
--
-- Solution: Store a short random nonce (12 bytes = 16 chars base64url) in the database
-- and use only the nonce in callback_data. The callback handler looks up the binding by nonce.
--
-- Security: The nonce is cryptographically random (96 bits), indexed and unique.
-- Presser-only enforcement, channel/org checks, single-use, and expiry are preserved
-- by looking up the full binding record by nonce.
--
-- IMPORTANT: This migration must be applied to prod BEFORE the code is deployed.
-- The code depends on verification_nonce and resend rate-limit columns existing.
begin;
set local lock_timeout = '5s';

alter table public.approval_workflow_voter_bindings
  add column if not exists verification_nonce text;

alter table public.approval_workflow_voter_bindings
  add column if not exists last_resend_at timestamptz;

alter table public.approval_workflow_voter_bindings
  add column if not exists resend_count_24h int not null default 0;

create unique index if not exists voter_binding_nonce_idx
  on public.approval_workflow_voter_bindings(verification_nonce)
  where verification_nonce is not null;

comment on column public.approval_workflow_voter_bindings.verification_nonce is
  'Random 96-bit nonce (base64url) for Telegram callback_data. Stays within 64-byte limit.';

comment on column public.approval_workflow_voter_bindings.last_resend_at is
  'Timestamp of last verification resend. Used for 2-minute rate limiting.';

comment on column public.approval_workflow_voter_bindings.resend_count_24h is
  'Resend count in the last 24 hours. Reset when last_resend_at is older than 24h.';

commit;
