-- ============================================================================
-- PREPARED — DO NOT RUN without 八坂さん's approval (H5 follow-up, 木村 10/12).
-- Nobody has run this. Run the read-only count first
-- (h5-queued-secret-tickets-count-20261012.sql) and attach its output to the approval.
-- ============================================================================
-- What it does (one transaction):
--   1. Backs up the affected rows (id, status, resolved_at, metadata) to
--      h5_secret_ticket_backup_20261012, so the change can be rolled back.
--   2. Queued tickets (pending, or approved but never successfully run) of
--      setup.slackAdapter.setBotToken / setup.lineApproval.upsert that still
--      hold botTokenCiphertext / secretsCiphertext, created before :h5_fix_at:
--        status → 'expired', resolved_at → now(), the ciphertext key removed,
--        metadata.h5SecretsPurgedAt / h5SecretsPurgeReason added.
--      After this, the ticket can no longer be fulfilled; the tenant enters the
--      token on /app/settings (「承認を受け取る」→ 承認用LINE /「チャンネルに書き込む（Bot トークン）」).
--   3. Terminal tickets (rejected / expired / revision_requested / fulfilled)
--      keep their status; only the ciphertext key is removed (the value, if it
--      was ever applied, lives in the encrypted channel / adapter store, which this does not touch).
--   Values already stored in org_notification_channels / conversation adapters
--   are NOT touched.
--   orgs.create ownerPasswordCiphertext is NOT touched (the arg is still accepted
--   on purpose until invite=true mail is confirmed; separate PR).
--
-- Usage:
--   psql -v h5_fix_at="'2026-10-12 09:27:15+09'" -v ON_ERROR_STOP=1 -f <this file>
--   Check the three counts it prints; COMMIT is at the end. Change it to
--   ROLLBACK for a dry run.
--
-- ROLLBACK NOTE (restores status, resolved_at and metadata exactly, including the
-- ciphertext; run only if a purge must be undone, again with approval):
--   BEGIN;
--   UPDATE approval_requests r
--      SET status = b.status, resolved_at = b.resolved_at, metadata = b.metadata
--     FROM h5_secret_ticket_backup_20261012 b
--    WHERE r.id = b.id
--      AND r.metadata ? 'h5SecretsPurgedAt';      -- only rows this script changed
--   -- expect the same row count as the backup table
--   COMMIT;
-- (The admin.policy audit rows written by the purge stay as a record that it ran.)
-- Verified on a scratch local Postgres with synthetic rows (10/12): dry run
-- (COMMIT→ROLLBACK) changes nothing; real run expires queued tickets, purges
-- terminal ones, leaves 0 ciphertext and leaves orgs.create alone; this rollback
-- restores every row byte-for-byte.
-- The backup table holds the same ciphertext as before (encrypted with
-- NOTIFICATION_CONFIG_ENCRYPTION_KEY, service-role only). Drop it once the purge
-- is confirmed (proposed: 7 days):  DROP TABLE h5_secret_ticket_backup_20261012;
-- ============================================================================
\if :{?h5_fix_at}
\else
  \set h5_fix_at '''2026-10-12 09:27:15+09'''
\endif
\set ON_ERROR_STOP 1

BEGIN;

CREATE TABLE h5_secret_ticket_backup_20261012 AS
SELECT r.id, r.org_id, r.tool, r.status, r.resolved_at, r.metadata, now() AS backed_up_at
FROM approval_requests r
WHERE (r.metadata->>'isAdminMcpTool') = 'true'
  AND (
    (r.tool = 'setup.slackAdapter.setBotToken' AND r.metadata->'adminMutation' ? 'botTokenCiphertext')
    OR (r.tool = 'setup.lineApproval.upsert'   AND r.metadata->'adminMutation' ? 'secretsCiphertext')
  )
  AND r.created_at < :h5_fix_at::timestamptz;
REVOKE ALL ON h5_secret_ticket_backup_20261012 FROM PUBLIC, anon, authenticated;
ALTER TABLE h5_secret_ticket_backup_20261012 ENABLE ROW LEVEL SECURITY;  -- no policy: service role only

SELECT count(*) AS backed_up FROM h5_secret_ticket_backup_20261012;

-- 2. queued → expired + ciphertext removed
WITH done AS (
  UPDATE approval_requests r
     SET status = 'expired',
         resolved_at = now(),
         metadata = jsonb_set(
           r.metadata,
           '{adminMutation}',
           (r.metadata->'adminMutation') - 'botTokenCiphertext' - 'secretsCiphertext'
         ) || jsonb_build_object('h5SecretsPurgedAt', now(), 'h5SecretsPurgeReason', 'h5_queued_secret_expired')
    FROM h5_secret_ticket_backup_20261012 b
   WHERE r.id = b.id
     AND r.status IN ('pending', 'approved')
     AND coalesce(r.metadata->'adminFulfillment'->>'ok', 'none') <> 'true'
  RETURNING r.id
)
SELECT count(*) AS expired_and_purged FROM done;

-- 3. terminal rows → ciphertext removed, status kept
WITH done AS (
  UPDATE approval_requests r
     SET metadata = jsonb_set(
           r.metadata,
           '{adminMutation}',
           (r.metadata->'adminMutation') - 'botTokenCiphertext' - 'secretsCiphertext'
         ) || jsonb_build_object('h5SecretsPurgedAt', now(), 'h5SecretsPurgeReason', 'h5_terminal_secret_purged')
    FROM h5_secret_ticket_backup_20261012 b
   WHERE r.id = b.id
     AND NOT (r.metadata ? 'h5SecretsPurgedAt')
  RETURNING r.id
)
SELECT count(*) AS purged_terminal FROM done;

-- one audit row per org (ids and counts only)
INSERT INTO audit_events (org_id, action, purpose, summary, metadata)
SELECT b.org_id, 'admin.policy', 'h5.secret_purge',
       'H5: 秘密を保持したままの管理チケットを失効・秘密を削除（値は記録しません）',
       jsonb_build_object('code', 'h5_queued_secret_purge', 'tickets', count(*), 'ticketIds', jsonb_agg(b.id))
FROM h5_secret_ticket_backup_20261012 b
GROUP BY b.org_id;

-- must be 0
SELECT count(*) AS remaining_with_ciphertext
FROM approval_requests r
WHERE (r.metadata->>'isAdminMcpTool') = 'true'
  AND (r.metadata->'adminMutation' ? 'botTokenCiphertext' OR r.metadata->'adminMutation' ? 'secretsCiphertext')
  AND r.tool IN ('setup.slackAdapter.setBotToken', 'setup.lineApproval.upsert')
  AND r.created_at < :h5_fix_at::timestamptz;

COMMIT;
