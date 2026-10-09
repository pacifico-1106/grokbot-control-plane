# Thread single-flight (木村 2026-10-09 A / triage #2)

Flag: `THREAD_SINGLE_FLIGHT_ENABLED` (default **OFF**). Migrations:
`supabase/migrations/20261009100000_thread_single_flight.sql` and the
pre-flag-ON follow-up `20261009150000_thread_single_flight_preflag.sql`
(木村 #286 review: both before the flag goes ON). With the flag OFF
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
   TTL: `THREAD_SINGLE_FLIGHT_LEASE_TTL_SECONDS` (default 60, kept per decision 5; clamped 15–300) —
   bounds how long a crashed holder can block. Released in `finally` on every
   path (posted, provider error, timeout, dedup stop, egress refusal, throw);
   only the holder (org + key + lease id) can release.
2. **thread_moved_on.** After a successful post the AI employee's post time
   (Slack ts in µs; server time for caller-delivered surfaces) is recorded per
   org × employee × thread (forward-only). Before the next post, if **any AI
   employee of the same org** (this one or another; 木村 decision 4) already
   posted in the thread **after the read point** → **409 `thread_moved_on`**
   (`retryable: false`, `nextAction: reread_thread`, `readThroughTs`,
   `aiPostedTs`, `postedBy: self | other_ai_employee` — never the other
   employee's id). Human posts are never recorded, so they do not count;
   another org's posts are never read (BOLA). Read point: explicit `readThroughTs`
   (top level, `conversation.readThroughTs` or payload) wins; otherwise the
   inbound message ts. The read point is judged against the **receive time**
   (invoke: now; fulfil: when the approval was created, never the fulfil-time
   clock): a value more than 5 s past it is ignored, and one inside those 5 s
   is capped at the receive time — nobody read past the moment the request
   arrived (pre-flag item 1; was a 120 s window that let a stale approved send
   skip the check). The caller's own newer post from the **same jobId** does
   not count (one job posting several parts) — but only within **10 minutes of
   that job's first post** in the thread (`job_first_micros`), so reusing a
   jobId cannot switch the check off (pre-flag item 2). Rows written before
   20261009150000 have no first-post time and are never exempt.
   `readThroughTs` stays optional (decision 1). With **no read point at all**
   the send is serialized by the lease only and audited as
   `thread_guard.read_point_unknown` (`readPoint: "unknown"`) so the weekly
   report can count it; every stop's audit row carries `readPoint` too.
3. **Fulfil-time recheck.** For sends that go through approval the explicit
   read point is stored in the approval snapshot, and the lease + moved_on
   check run again at fulfil (webhook auto-fulfil and the approved re-run) —
   for Slack and for approved LINE / Telegram / mail replies (pre-flag item 4;
   those have no gateway delivery today and stop at `slack_channel_required`,
   so a stale one is now closed as superseded and any future delivery is
   already behind the lease). A
   `thread_busy` / `thread_guard_unavailable` stop is persisted as the
   fulfilment result, audited with `phase: "fulfil"`, and is re-runnable.
   **`thread_moved_on` closes the approval** (decision 2): status
   `superseded`, `closedWithoutSend.reason = "thread_moved_on"`, nothing sent,
   terminal. A re-run with that approvalId returns 409 `thread_moved_on`
   (`approvalStatus: "superseded"`) without sending or opening a new approval;
   the nextStep tells the AI to re-read the thread and file a new request if a
   reply is still needed. The approver sees "送信していません: …スレッドが先に進みました"
   on the Web result page, and the status API / employee MCP status return
   `closedWithoutSend {reason, messageJa, nextStep}` with `pollHint: abort_job`.
   Audited as `approval.superseded` (`reason: thread_moved_on`). If the close
   loses a race, the stop is recorded and the next run re-checks. The close
   writes status, `resolved_at` and `closedWithoutSend` in **one** statement
   (`close_approval_without_send`, pre-flag item 5); before that migration the
   app uses one PostgREST UPDATE carrying both, never two writes.

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
| invoke.caller_delivered (LINE / Telegram / mail / phone) | leased (recorded at server time when allowed; the lease is **held until its TTL** because the caller's delivery is not observable — pre-flag item 3) |
| fulfill.slack_post (approved sends) | leased + recheck at fulfil |
| fulfill.caller_delivered (approved LINE / Telegram / mail replies) | leased + recheck at fulfil (no gateway delivery today: dedup inventory says no_live_send) |
| invoke.file_upload, rerun.attachment_upload | same reply (only after that reply passed the guard; no separate lease, decision 3) |
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

## Production steps (木村, after 八坂 GO)

1. Merge with the flag OFF (nothing changes).
2. Apply `20261009100000_thread_single_flight.sql`, then
   `20261009150000_thread_single_flight_preflag.sql` (both additive; re-applicable).
   The thread key uses `NOTIFICATION_CONFIG_ENCRYPTION_KEY` (confirmed present
   in prod) unless `COMM_REPLY_DEDUP_HMAC_KEY` is set.
3. Set `THREAD_SINGLE_FLIGHT_ENABLED=true` (TTL default 60 s), redeploy.
4. Watch `thread_guard.*` audit events (`thread_guard.unavailable` ~0;
   `thread_guard.read_point_unknown` is the weekly-report count) and
   `approval.superseded` with `reason: thread_moved_on`.

Rollback: set the flag OFF (immediate), then optionally run
`supabase/verification/20261009150000_thread_single_flight_preflag_rollback.sql`
and then `supabase/verification/20261009100000_thread_single_flight_rollback.sql`.
Never roll back the migration with the flag ON (every guarded post would fail
closed).
