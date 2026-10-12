-- H5 follow-up (#352, 木村 10/12) — READ-ONLY count.
-- Admin MCP tickets created before the H5 fix that still hold an encrypted
-- secret (setup.slackAdapter.setBotToken botTokenCiphertext,
-- setup.lineApproval.upsert secretsCiphertext). Key presence only; the
-- ciphertext is never selected.
--
-- "Before the fix": created before #352 reached production. The merge was
-- 2026-10-12 09:27:15 JST (cd803bd); set :h5_fix_at to the production deploy
-- time if it differs. After the fix no new ticket can carry these keys, so the
-- second query (no cutoff) must give the same totals; a difference means a
-- ticket was created after the cutoff with a secret, so investigate before applying
-- the expiry script.
--
--   psql -v h5_fix_at="'2026-10-12 09:27:15+09'" -f h5-queued-secret-tickets-count-20261012.sql
\if :{?h5_fix_at}
\else
  \set h5_fix_at '''2026-10-12 09:27:15+09'''
\endif

BEGIN READ ONLY;

-- 1) by state: "queued" = still actionable (pending, or approved but never run);
--    "at_rest" = terminal rows that still keep the ciphertext.
SELECT
  r.tool,
  CASE
    WHEN r.status = 'pending' THEN 'queued:pending'
    WHEN r.status = 'approved' AND r.metadata->'adminFulfillment' IS NULL THEN 'queued:approved_not_run'
    WHEN r.status = 'approved' AND (r.metadata->'adminFulfillment'->>'ok') = 'false' THEN 'queued:approved_failed_rerunnable'
    ELSE 'at_rest:' || r.status
  END AS state,
  count(*)                       AS tickets,
  count(DISTINCT r.org_id)       AS orgs,
  min(r.created_at)              AS oldest,
  max(r.created_at)              AS newest
FROM approval_requests r
WHERE (r.metadata->>'isAdminMcpTool') = 'true'
  AND (
    (r.tool = 'setup.slackAdapter.setBotToken' AND r.metadata->'adminMutation' ? 'botTokenCiphertext')
    OR (r.tool = 'setup.lineApproval.upsert'   AND r.metadata->'adminMutation' ? 'secretsCiphertext')
  )
  AND r.created_at < :h5_fix_at::timestamptz
GROUP BY 1, 2
ORDER BY 1, 2;

-- 2) sanity: same filter without the cutoff (expected identical totals).
SELECT r.tool, count(*) AS tickets_any_time
FROM approval_requests r
WHERE (r.metadata->>'isAdminMcpTool') = 'true'
  AND (
    (r.tool = 'setup.slackAdapter.setBotToken' AND r.metadata->'adminMutation' ? 'botTokenCiphertext')
    OR (r.tool = 'setup.lineApproval.upsert'   AND r.metadata->'adminMutation' ? 'secretsCiphertext')
  )
GROUP BY 1 ORDER BY 1;

-- 3) per org / ticket (ids only) for the queued ones.
SELECT r.org_id, r.tool, r.id AS ticket_id, r.status, r.created_at
FROM approval_requests r
WHERE (r.metadata->>'isAdminMcpTool') = 'true'
  AND r.status IN ('pending', 'approved')
  AND coalesce(r.metadata->'adminFulfillment'->>'ok', 'none') <> 'true'
  AND (
    (r.tool = 'setup.slackAdapter.setBotToken' AND r.metadata->'adminMutation' ? 'botTokenCiphertext')
    OR (r.tool = 'setup.lineApproval.upsert'   AND r.metadata->'adminMutation' ? 'secretsCiphertext')
  )
  AND r.created_at < :h5_fix_at::timestamptz
ORDER BY r.created_at;

ROLLBACK;
