# Thread single-flight (木村 2026-10-09 A / triage #2)

Flag: `THREAD_SINGLE_FLIGHT_ENABLED` (default **OFF**). Migration:
`supabase/migrations/20261009100000_thread_single_flight.sql`. With the flag OFF
nothing here runs and behaviour is byte-for-byte the pre-change behaviour.

## What it does

Two AI replies racing into the same conversation thread, or a reply written
against a stale read of the thread, are stopped **before** the provider call.

1. **Lease (single-flight).** Before a conversation post, the gateway takes a
   per-thread lease keyed by org × `thread_key`
   (`thread_key = HMAC(dedup key, "thread:v1:" + conversation key)`; no channel
   id, thread id or text is stored). The lease is across employees: one reply
   per thread at a time. If it is held → **409 `thread_busy`**
   (`retryable: true`, `nextAction: retry_later`, `retryAfterSeconds`).
   TTL: `THREAD_SINGLE_FLIGHT_LEASE_TTL_SECONDS` (default 60, clamped 15–300) —
   bounds how long a crashed holder can block. Released in `finally` on every
   path (posted, provider error, timeout, dedup stop, egress refusal, throw);
   only the holder (org + key + lease id) can release.
2. **thread_moved_on.** After a successful post the employee's own post time
   (Slack ts in µs; server time for caller-delivered surfaces) is recorded per
   org × employee × thread (forward-only). Before the next post, if this
   employee already posted in the thread **after the read point** → **409
   `thread_moved_on`** (`retryable: false`, `nextAction: reread_thread`,
   `readThroughTs`, `selfPostedTs`). Read point: explicit `readThroughTs`
   (top level, `conversation.readThroughTs` or payload) wins; otherwise the
   inbound message ts. A value more than 120 s in the future is ignored (it
   could otherwise switch the check off). A newer self post from the **same
   jobId** does not count (one job posting several parts).
3. **Fulfil-time recheck.** For sends that go through approval the explicit
   read point is stored in the approval snapshot, and the lease + moved_on
   check run again at fulfil (webhook auto-fulfil and the approved re-run). A
   stop is persisted as the fulfilment result (`error: thread_busy |
   thread_moved_on | thread_guard_unavailable`), audited with
   `phase: "fulfil"`, and is re-runnable (these codes are in the execution
   claim's retryable set); the re-run is checked again and can never move the
   read point (it comes from the approved snapshot, not the re-run request).

Order: the thread guard runs **before** the #260 / #278 dedup claim at invoke
and at fulfil, so a thread stop never leaves a dedup ledger row, and a dedup
stop still releases the lease. Both dedup flags are independent of this flag
(tested with both dedup guards OFF and with v1 + v2 ON).

## Lease-store errors: fail **closed**

Lease-store / self-post read errors, a `denied` answer, or no HMAC key →
**503 `thread_guard_unavailable`** (`retryable: true`, `nextAction:
retry_later`), audited as `thread_guard.unavailable`. Why: a post cannot be
taken back, while a refused post can be retried a few seconds later; failing
open would re-open exactly the double-reply this fixes, during the moments the
system is already degraded. This matches the #260 / #278 guards (also
fail-closed). The availability cost is bounded: the flag is a one-switch
kill, and the TTL bounds any stuck lease. A failure to *record* a self post
(logged) or to *release* does not fail the already-sent post (the TTL cleans
up a lease that was not released).

An outcome-unknown post (timeout after the request was sent) records no self
post (it would otherwise risk a permanent false `thread_moved_on`); the dedup
guards keep their own uncertain handling.

## Paths

Every id in `lib/comm-reply-dedup/inventory.ts` has a decision in
`lib/thread-guard/inventory.ts` (test-enforced):

| path | coverage |
|---|---|
| invoke.slack_post (comm.reply / comm.send / slack.post / slack.post_external, bot and posting_as=user) | leased |
| invoke.caller_delivered (LINE / Telegram / mail / phone) | leased (recorded at server time when allowed) |
| fulfill.slack_post (approved sends) | leased + recheck at fulfil |
| invoke.file_upload, rerun.attachment_upload | same reply (only after that reply passed the guard) |
| sns.publish | no thread (dedup v2 applies) |
| mail send / drive share | no live send |
| notifications | not AI posting |

## Audit

`thread_guard.busy`, `thread_guard.moved_on`, `thread_guard.unavailable` with
`{tool, jobId, approvalId?, phase: invoke|fulfil, code, threadKeyRef (12 hex),
readThroughSource, …}` — hash prefixes only, no text / channel / thread id.

## Security

- Tables `thread_send_leases`, `thread_self_posts`: RLS on, no policy, no
  grants to anon / authenticated; RPCs are security invoker with a fixed
  search_path and EXECUTE for service_role only.
- Org isolation: every key includes org_id; the RPCs refuse an employee that is
  not in the org; another org's lease on the same hash never blocks.
- No new endpoint, no new approval or override path; the request cannot skip
  the guard (unknown fields are ignored).

## Production steps (operator)

1. Apply `20261009100000_thread_single_flight.sql` (additive; re-applicable).
2. Confirm `COMM_REPLY_DEDUP_HMAC_KEY` (≥ 32 chars) or
   `NOTIFICATION_CONFIG_ENCRYPTION_KEY` is set (otherwise every guarded post
   fails closed).
3. Set `THREAD_SINGLE_FLIGHT_ENABLED=true` (optionally
   `THREAD_SINGLE_FLIGHT_LEASE_TTL_SECONDS`), redeploy.
4. Watch `thread_guard.*` audit events; `thread_guard.unavailable` should be ~0.

Rollback: set the flag OFF (immediate), then optionally run
`supabase/verification/20261009100000_thread_single_flight_rollback.sql`.
Never roll back the migration with the flag ON (every guarded post would fail
closed).
