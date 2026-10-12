-- H5 follow-up (#352, 木村 10/12) — READ-ONLY inventory.
-- Which org passed which secret-bearing argument through admin MCP, and when.
-- Output: org, tool, arg name, timestamp, ticket id. NO values: the query reads
-- only key presence ("…Present" flags / "…Ciphertext" keys), never the ciphertext
-- itself, and never summary / title text.
--
-- Sources:
--   approval_requests.metadata.adminMutation — the queued args of every admin MCP
--     ticket (queueAdminTool). Before #352 (merged 2026-10-12 09:27 JST, cd803bd):
--       setup.slackAdapter.setBotToken  botTokenPresent / botTokenCiphertext
--       setup.lineApproval.upsert       channelAccessTokenPresent / channelSecretPresent / secretsCiphertext
--     Still accepted (kept on purpose, always_human, encrypted at rest):
--       orgs.create                     ownerPasswordPresent / ownerPasswordCiphertext
--   audit_events — the "承認待ち" row written when the ticket was queued
--     (metadata.approvalId, metadata.tool), and secret_detection.blocked rows
--     (a secret-looking value that was refused; metadata never holds the value).
--
-- Run as a read-only role (or inside BEGIN READ ONLY; … ROLLBACK;).
BEGIN READ ONLY;

WITH arg_rows AS (
  SELECT r.org_id, r.tool, r.id AS ticket_id, r.created_at, r.status, a.arg_name
  FROM approval_requests r
  CROSS JOIN LATERAL (
    VALUES
      ('botToken',           r.tool = 'setup.slackAdapter.setBotToken'
                               AND ((r.metadata->'adminMutation'->>'botTokenPresent') = 'true'
                                    OR r.metadata->'adminMutation' ? 'botTokenCiphertext')),
      ('channelAccessToken', r.tool = 'setup.lineApproval.upsert'
                               AND (r.metadata->'adminMutation'->>'channelAccessTokenPresent') = 'true'),
      ('channelSecret',      r.tool = 'setup.lineApproval.upsert'
                               AND (r.metadata->'adminMutation'->>'channelSecretPresent') = 'true'),
      -- a LINE ticket with ciphertext but no per-field flags (defensive)
      ('lineSecrets(unflagged)', r.tool = 'setup.lineApproval.upsert'
                               AND r.metadata->'adminMutation' ? 'secretsCiphertext'
                               AND coalesce(r.metadata->'adminMutation'->>'channelAccessTokenPresent', 'false') <> 'true'
                               AND coalesce(r.metadata->'adminMutation'->>'channelSecretPresent', 'false') <> 'true'),
      ('ownerPassword',      r.tool = 'orgs.create'
                               AND ((r.metadata->'adminMutation'->>'ownerPasswordPresent') = 'true'
                                    OR r.metadata->'adminMutation' ? 'ownerPasswordCiphertext'))
  ) AS a(arg_name, hit)
  WHERE (r.metadata->>'isAdminMcpTool') = 'true'
    AND r.tool IN ('setup.slackAdapter.setBotToken', 'setup.lineApproval.upsert', 'orgs.create')
    AND a.hit
)
SELECT
  o.org_id,
  o.tool,
  o.arg_name,
  coalesce(q.queued_at, o.created_at) AS passed_at,   -- when the arg reached admin MCP
  o.ticket_id,
  o.status AS ticket_status
FROM arg_rows o
LEFT JOIN LATERAL (
  SELECT min(e.created_at) AS queued_at
  FROM audit_events e
  WHERE e.org_id = o.org_id
    AND e.metadata->>'approvalId' = o.ticket_id::text
    AND e.metadata->>'tool' = o.tool
) q ON true
ORDER BY passed_at, o.org_id, o.tool, o.arg_name;

-- Secret-looking values the queue refused (the value was never stored).
SELECT e.org_id,
       e.metadata->>'tool'      AS tool,
       e.metadata->>'fieldPath' AS arg_name,
       e.created_at             AS passed_at,
       e.metadata->>'jobId'     AS job_id,       -- no ticket was created
       e.action
FROM audit_events e
WHERE e.action IN ('secret_detection.blocked', 'secret_detection.suspected')
  AND e.metadata->>'surface' = 'admin_queue'
ORDER BY e.created_at;

ROLLBACK;
