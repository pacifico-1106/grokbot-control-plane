# Duplicate-reply prevention for conversation tools (`COMM_REPLY_DEDUP_ENABLED`)

Follow-up to the 2026-10-04 incident. An AI employee queued `comm.send` approvals
to two Slack DMs, twice each (the second one re-written). Next it sent `comm.reply`
to the same DMs (auto-allowed, internal summary). About 18 minutes later all
four held approvals were approved and fulfilled, so each recipient got 3 messages
instead of 1. No single approval was executed twice: the duplicates came from
near-duplicate approvals plus a direct reply in the same conversation.

## Behaviour (flag ON)

Scope: audience-gated conversation tools (`comm.reply`, `comm.send`,
`slack.post`, `slack.post_external`). They share one ledger, so a `slack.post`
and a `comm.reply` with the same body to the same conversation are duplicates.

| Situation | Result |
|---|---|
| Same body (after normalization) to the same conversation within the window | not sent, `409 duplicate_reply_suppressed` (`match: "exact"`), audit `comm_reply.duplicate_suppressed` |
| Re-written body, keyed MinHash similarity ≥ threshold (similar mode) | the same, with `match: "similar"` and `similarity` |
| Two identical sends at the same time | an atomic claim lets only one post |
| Post failed (provider error) | claim released, so a retry is not a duplicate |
| Post threw (outcome unknown) | claim kept (`uncertain`), so it is never re-sent blindly |
| New approval requested for a conversation | older **pending** approvals of the same employee + conversation **whose body is the same or similar** become `superseded` (`newer_approval_requested`, audit `match` / `similarity`) |
| Reply sent to a conversation (direct or via approval) | pending approvals of the same employee + conversation **whose body is the same or similar** become `superseded` (`newer_reply_sent`) |
| Reply / new approval about **another matter** in the same conversation | older pending approvals stay pending and are sent normally when approved |
| Approved approval fulfilled after a reply **with the same / a similar body** already went to that conversation (W2 / re-run; not limited to the window) | not sent; closed as `superseded` (`replied_after_approval`), error `approval_superseded`. A later reply about another matter does not stop it (the duplicate window check still applies) |
| Pending / approved conversation approval older than the TTL | not sent; closed as `expired` (sweep on invoke + W2 cron; re-checked at fulfill), error `approval_expired` |
| Flag ON but no HMAC key, or the ledger is unavailable | **fail closed**: `503 duplicate_check_unavailable` on invoke, `fulfill_blocked_dedup_unavailable` on fulfill, audit `comm_reply.dedup_unavailable` |

`superseded` / `expired` are terminal. The status poll and MCP
`staffpass_get_approval_status` return `pollHint: "abort_job"` and
`closedWithoutSend.reason`. Pressing an old approval card does nothing, because
only pending tickets resolve.

### Conversation key (channel-independent)

The key is an HMAC (org-scoped) of surface + destination + thread:

- Slack channel: channel + thread. Another thread is another conversation.
- Slack DM (`D…`), LINE user (`U…`), Telegram private chat (positive id), phone:
  1:1, so **the thread is ignored**. The recipient sees the main flow and the
  thread alike.
- LINE group / Telegram group: chat + thread.
- No destination: no key, so dedup is skipped (never guessed).

Telegram has no gateway conversation surface yet. The key reads
`conversation.telegramChatId` / `args.chatId` (+ thread id), so it already works
once a Telegram post exists.

### Body fingerprint (no body is stored or logged)

- Normalization: NFKC (width), lower case, Slack `<url|label>` → url, then
  whitespace / punctuation / symbols / control characters removed.
- `body_hash`: HMAC-SHA256 of the normalized body.
- `sketch`: keyed MinHash of character 3-grams (128 × int32). Bodies shorter
  than 20 normalized characters have no sketch (exact match only).
- Key: `COMM_REPLY_DEDUP_HMAC_KEY` (≥ 32 chars) or, if not set, derived from
  `NOTIFICATION_CONFIG_ENCRYPTION_KEY` (domain-separated). Demo mode uses a fixed
  dev key. Without either, production fails closed.
- Audit rows carry only 12-hex prefixes, match kind, similarity, window and
  normalized length.

## Settings

| Env | Default | Bounds |
|---|---|---|
| `COMM_REPLY_DEDUP_ENABLED` | OFF | `true` / `1` / `on` |
| `COMM_REPLY_DEDUP_WINDOW_MINUTES` | 30 | 1–1440 (invalid → default) |
| `COMM_REPLY_DEDUP_MODE` | `similar` | `exact` \| `similar` (exact hash always applies) |
| `COMM_REPLY_DEDUP_SIMILARITY` | 0.6 | 0.5–1 (lower → default) |
| `COMM_REPLY_APPROVAL_TTL_MINUTES` | 1440 (24 h) | 5–10080 |
| `COMM_REPLY_DEDUP_HMAC_KEY` | derived | ≥ 32 chars |

Ledger retention is max(window, TTL) + 1 h, cleaned up opportunistically on claim.

Why 0.6: in the incident, the same-DM re-written pairs had 3-gram Jaccard
0.71–0.73 (MinHash estimates 0.66–0.84 across random keys). Messages that are
merely related stay well below 0.3.

Supersede criterion (木村, 2026-10-04): the same keyed check as duplicates —
identical keyed body hash, or (similar mode) keyed sketch similarity ≥ the
threshold; bodies under 20 normalized characters compare exactly only. The
pending approval's body is fingerprinted in memory from its own invoke
snapshot (which it already holds to be sent); nothing new is stored. At
fulfill the RPC compares the ledger rows created after the approval the same
way. In exact mode (`COMM_REPLY_DEDUP_MODE=exact`) only identical bodies
supersede, so the incident's re-written messages would no longer be closed.
With 128-value sketches a pair at Jaccard 0.71–0.74 falls under 0.6 for about
0.03–0.25 % of keys (binomial spread), i.e. it would then be sent.

## Database (migration `20261004700000_comm_reply_dedup.sql`)

- `approval_requests_status_check` gains `superseded`.
- `guard_workflow_approval_status()`: pending|approved → superseded|expired
  (and superseded → expired) is allowed even with a workflow instance. Closing
  never approves anything. Every other transition is unchanged.
- `comm_reply_send_fingerprints`: hash-only ledger. RLS on with no policies.
  Revoked from public / anon / authenticated; service_role only.
- `claim_comm_reply_send(...)` and `finish_comm_reply_send(...)`, service_role only:
  - validate input; the employee must belong to the org, and the approval to the
    org and employee
  - per-conversation advisory transaction lock, so 12 concurrent identical
    claims → 1 winner
- Rollback: `supabase/verification/20261004700000_comm_reply_dedup_rollback.sql`
  (superseded → expired, so closed tickets stay closed).
- `scripts/test-db-local.py` exercises apply → re-apply → tests → rollback →
  apply again.

## Production steps

1. Apply `supabase/migrations/20261004700000_comm_reply_dedup.sql`. It is
   additive, and the app does not use it while the flag is OFF.
2. Optional: set `COMM_REPLY_DEDUP_HMAC_KEY` (≥ 32 random chars). Otherwise the
   key is derived from `NOTIFICATION_CONFIG_ENCRYPTION_KEY`, which production
   already requires. Rotating either key resets the dedup history (at most one
   window of missed dedup).
3. Set `COMM_REPLY_DEDUP_ENABLED=true` and redeploy.
4. Watch the audit actions `comm_reply.duplicate_suppressed`,
   `approval.superseded`, `approval.expired` and `comm_reply.dedup_unavailable`.
   The last one should be 0.

Rollback: set the flag OFF first (immediate, no data change). Run the SQL
rollback only if the schema must go.

## Not covered / follow-ups

- Replies sent while the flag was OFF are not in the ledger.
- Slack / Telegram approval cards are not edited when a ticket is superseded.
  Pressing them resolves nothing, but the card still looks open (backlog).
- Superseding is per employee. Two employees replying in the same conversation
  are not deduplicated against each other.
