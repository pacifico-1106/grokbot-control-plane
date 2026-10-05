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
  are not deduplicated against each other (v1). v2 below detects it: warning +
  audit under v1, blocked by default under `DUPLICATE_GUARD_V2_ENABLED`.

# Duplicate post guard v2 (`DUPLICATE_GUARD_V2_ENABLED`, default OFF)

Yasaka / 木村 2026-10-05 (PR-A). Same ledger, one mechanism for every AI posting
path. Turning v2 ON also turns the ledger ON (`COMM_REPLY_DEDUP_ENABLED` is
implied). Apply `supabase/migrations/20261005200000_duplicate_post_guard_v2.sql`
first. While v2 is OFF the app never calls it.

| Hole (v1) | v2 rule |
|---|---|
| (1) After 30 min the same post goes out again | Default window **6 h** (`COMM_REPLY_DEDUP_WINDOW_MINUTES`, 1–1440). **Same jobId + same / similar body + same channel** → once, regardless of time (job key = HMAC of org + employee + jobId; kept `COMM_REPLY_DEDUP_JOB_RETENTION_DAYS`, default 30, max 30). The same job may still post another message. At fulfil the window also reaches back from the approval's creation. |
| (2) Top-level vs thread are different keys | **Channel key** = HMAC of org + surface + destination without the thread. Long bodies compare across the channel (`scope: "cross_thread"`). Short bodies stay per thread. |
| (3) Per employee only | Another employee's same / similar long body to the same channel: **blocked** (`scope: "cross_employee"`), or with `COMM_REPLY_DEDUP_CROSS_EMPLOYEE=warn` posted with `duplicateWarning`. Audit `comm_reply.cross_employee_duplicate` (`decision: warn \| block`). Under v1 (no v2) the same detection is a warning only. The other employee's row id is never returned. |
| (4) Short bodies (< 20 normalized chars): exact only | v2 normalization adds: Slack mention / channel / broadcast markup keeps only the id (`<@U1\|野木>` = `<@U1>`), emoji shortcodes (`:+1:`, `:skin-tone-2:`) and pictographic emoji (incl. skin tones, ZWJ, VS16, keycaps) are dropped, on top of v1's width / case / whitespace / punctuation. **Short tier**: exact v2 hash only, **same thread only, 2 min window** (`COMM_REPLY_DEDUP_SHORT_WINDOW_MINUTES`, 1–60), never across employees. |
| (5) A failed send deletes the fingerprint | Adapters return `sendState: "not_sent" \| "unknown"`. Only `not_sent` (nothing submitted, DNS / connection refused, or a documented Slack pre-post error; SNS 4xx except 408 / 429) releases the row. Anything else is kept as `uncertain`: `502 post_outcome_unknown` with `uncertainRef`, and a later matching post gets `409 duplicate_post_uncertain`. After the AI verifies the message is absent it resends once with `duplicateGuard: { confirmedNotDelivered: uncertainRef }` (MCP: inside `payload`), which releases only that employee's own uncertain row (audit `comm_reply.uncertain_released`). |
| (6) Only 4 tools | Also `sns.publish` (invoke + fulfil) and Slack file uploads with a message. Inventory: `lib/comm-reply-dedup/inventory.ts` (a test fails if an outbound-send tool has no decision). |

### Why the short-body rule

An identical "OK" / "了解です" to the same thread within 2 minutes is a retry or
a loop. A few minutes later it is a new reply to a new message, and in another
thread or from another employee it is never a duplicate. v1 blocked a second
"OK" for 30 minutes (a false positive) while `了解です 👍` vs `了解です` (or a
mention label) slipped through. The addressee is kept, so `<@A> 了解です` and
`<@B> 了解です` are different messages. The jobId rule still applies to short
bodies (the same job never sends the same "OK" twice).

### Response fields (every stop)

`code` = `reasonCode`, `nextAction` (`none` \| `retry_later` \|
`verify_then_confirm`), `nextStep` (instruction for the AI), `retryable`, and for
duplicates `scope`, `match`, `similarity`, `matchedAt`, `windowMinutes`. These
fields are additive and also returned under v1.

| Code | HTTP | Meaning |
|---|---|---|
| `duplicate_reply_suppressed` | 409 | already posted; do not resend |
| `duplicate_post_uncertain` | 409 | an earlier matching post has an unknown outcome; verify first |
| `post_outcome_unknown` | 502 | this post's outcome is unknown; row kept; verify first |
| `duplicate_check_unavailable` | 503 | store / key unavailable; nothing posted; `retryable: true` |

At fulfil: `approval_superseded` (closed, nothing sent), `duplicate_post_uncertain`
(approval stays approved, re-runnable), `post_outcome_unknown` (execution claim
uncertain, not re-run), `fulfill_blocked_dedup_unavailable`.

### Settings (v2)

| Env | Default with v2 | Bounds |
|---|---|---|
| `DUPLICATE_GUARD_V2_ENABLED` | OFF | `true` / `1` / `on` |
| `COMM_REPLY_DEDUP_WINDOW_MINUTES` | 360 | 1–1440 |
| `COMM_REPLY_DEDUP_SHORT_WINDOW_MINUTES` | 2 | 1–60 |
| `COMM_REPLY_DEDUP_CROSS_EMPLOYEE` | `block` | `warn` (anything else → block) |
| `COMM_REPLY_DEDUP_JOB_RETENTION_DAYS` | 30 | 1–30 |

### Database (migration `20261005200000_duplicate_post_guard_v2.sql`)

Additive: nullable `channel_key` / `job_key` (64-hex checks), tool check +
`sns.publish`, two partial indexes, `claim_outbound_send_v2` (advisory lock per
org + channel, dry-run mode for the read-only pre-check) and
`release_uncertain_outbound_send`, both service_role only. Rollback:
`supabase/verification/20261005200000_duplicate_post_guard_v2_rollback.sql`
(v1 keeps working). Tested by `scripts/test-db-local.py`.

### Production steps (v2)

1. Apply the migration (no effect while the flag is OFF).
2. Optional: `COMM_REPLY_DEDUP_CROSS_EMPLOYEE=warn` for a first observation period.
3. Set `DUPLICATE_GUARD_V2_ENABLED=true`. Rows written by v1 have no channel /
   job key, and v2 normalizes emoji / mentions differently, so for the first
   window a v1 row is only matched on the same conversation key with the same
   v1-normal body.
4. Watch `comm_reply.duplicate_suppressed` (by `scope`),
   `comm_reply.cross_employee_duplicate`, `comm_reply.post_outcome_unknown`,
   `comm_reply.uncertain_released` and `comm_reply.dedup_unavailable`.

Rollback: flag OFF (immediate). SQL rollback only if the schema must go.
