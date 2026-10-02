# P1 Channel Scope: rollout runbook (2026-10-02)

Source: P1 Channel Scope design (2026-10-02) and the reviewer notes in PRs CS1 #189, CS2 #191, CS3 #192, CS4 #193, CS5 #195 and CS6.
Related: [`../tenant-slack-kickoff-rail.md`](../tenant-slack-kickoff-rail.md) step 3.5, [`../staffpass-slack-bot-install.md`](../staffpass-slack-bot-install.md).

**Every item here is a production change and needs its own GO** (DB, Slack app settings, Vercel env). The PRs themselves make no production writes, and every flag defaults to OFF.

---

## 0. Before you start
- [ ] Merge the stacked PRs in order: #189 → #191 → #192 → #193 → #195 → CS6. Merging only part of the stack is fine, because each layer is a no-op while its flag is OFF.
- [ ] Check that the deployment's `vercel.json` has the cron `/api/cron/channel-scope-reconcile` (`17 */6 * * *`). With the flag OFF it only returns `200 {skipped:"flag_off"}`.
- [ ] Check that `CRON_SECRET` is set in Vercel. It already exists for the other crons. Without it the route returns 503 `cron_not_configured`, and with a bad header it returns 401.
- [ ] Owner decisions so far:
  - Legacy `org_channels` rows are `source=manual`.
  - Human-created rows stay registered even after `channel_shared`.
  - Keep the cron in `vercel.json`.
  - Accept the `registered_only` narrowing for stuck-watch auto rows.

## 1. Migration order (prod; Supabase SQL editor / CLI)
Apply in this order. None of them is in prod yet.
1. [ ] `supabase/migrations/20260930000100_approval_kind_routes.sql` (unchanged)
2. [ ] `supabase/migrations/20260930000200_decision_workflow.sql`
   - Fixed in CS1: `members` → `org_members`.
   - The decision RLS hardening backlog must be decided before `P1_DECISION_WORKFLOW_ENABLED`, not before channel scope.
3. [ ] `supabase/migrations/20261002000000_channel_scope.sql`
   - Can be re-run.
   - Depends only on `orgs`, `employees` and `org_channels`, not on the decision tables.
   - PGlite has verified "schema.sql + all migrations" and "schema.sql + these 3". If you apply only this one on its own, run the PGlite check first.

Timing: **apply 3 right before the flag goes ON.** Rows created between the migration and flag ON become `source=manual` (the column default) and are treated as human-registered (CS4/CS5 notes).

Post-apply checks (read-only SQL):
- [ ] `orgs.channel_scope_policy` and `employees.channel_scope_override` exist and are null.
- [ ] `org_channels.source` defaults to `manual` and has the CHECK constraint.
- [ ] `org_channels.human_confirmed_at` exists.
- [ ] `employee_channel_memberships`:
  - RLS is ON, with a restrictive `false` policy;
  - no grants to anon/authenticated;
  - service_role has DML;
  - the composite FK `(employee_id, org_id)` exists.
- [ ] The trigger blocks `authenticated` from updating `channel_scope_policy` / `channel_scope_override`, while other columns can still be updated.

## 2. Slack app configuration (once on the Staffpass Slack app; before flag ON)
- [ ] **Bot Token Scopes**: add `channels:read`, `groups:read`, `users:read`.
  - Uses: `users.conversations` (reconcile and setup probe), `conversations.info` (shared state), `users.info` (Connect inviter team).
  - With these missing, reconcile is incomplete (no leaves are applied) and `inviter_team_id` stays null.
- [ ] **User Token Scopes**: `channels:read`, `groups:read`, `users:read` are already in `SLACK_USER_SCOPES`. Check that the app config also has them.
- [ ] **Event Subscriptions → Subscribe to bot events**: `member_joined_channel`, `member_left_channel`, `channel_left`, `group_left`, `channel_shared`, `channel_unshared`.
- [ ] **Event Subscriptions → Subscribe to events on behalf of users**: `member_joined_channel`, `member_left_channel`.
- [ ] Request URL unchanged: `https://staffpass.sealith.com/api/webhooks/slack/events`.
- [ ] (Optional, only for the user-token channel mention path) `P0_USER_CHANNEL_MENTION_INGRESS=1` needs `channels:history` and `groups:history`, plus the existing user message events. It is independent of channel scope.
- Note: the bot-install OAuth URL asks for the 3 new bot scopes **only while `P1_CHANNEL_SCOPE_ENABLED` is ON** (CS6). The order is therefore: add the scopes in the Slack app → flag ON → tenants reinstall. Reversing it may make install fail; check this in staging.
- Note: Slack has no API for reading event subscriptions. `setup.slackStatus.channelScope.eventsObserved` is only an estimate of whether a membership event has been received.

## 3. Flag ON order (staging first, then prod; Vercel env)
1. [ ] Steps 1 and 2 are done.
2. [ ] `P1_CHANNEL_SCOPE_ENABLED=1`
   - Every tenant stays at `registered_only` (`policy=null`). That is legacy-equivalent, with these flag-ON-only differences:
     - membership events and the reconcile cron start recording;
     - new automatic rows (`egress_inspect`/`auto_join`) are not "registered";
     - sends to a channel the bot or employee was **removed** from are denied (`channel_membership_removed`, also when already approved; fail-closed on lookup error);
     - unconfirmed automatic Connect channels get needs_approval on send;
     - `setup.slackStatus.channelScope` appears, as does the dashboard card;
     - bot install asks for the new scopes.
3. [ ] Tenants: **Reinstall the bot** (`/api/slack/bot-install/start`) and register the new xoxb. Linked employees whose tokens are old **re-Authorize** (see `setup.slackStatus.channelScope.userTokens`).
4. [ ] Per tenant, choose the mode with `channelScope.patch` (or the `/app/settings` → チャンネル範囲 card): `registered_only` / `all_joined`, tenant default or per employee.
   - These are always_human, kind=account, **owner approves**. Self-approval is not possible, so a single-owner tenant needs a platform proxy approval.
   - Then run `channelScope.reconcile {employeeId, dryRun:true}`, review, then `dryRun:false` (always_human).
5. [ ] `P1_CHANNEL_SCOPE_CONNECT_ENABLED=1` **last**, after the Connect staging checks pass. Then do a per-tenant `channelScope.patch {mode:"all_joined", includeSlackConnect:true}`. Space Tree / 稲盛 is all_joined + includeSlackConnect, as 八坂 requested.
6. [ ] Confirm every auto-joined Connect channel with `channels.classify` (shared_external, mixed). That sets `human_confirmed_at` and ends the needs_approval gate.

Kill switch:
- `P1_CHANNEL_SCOPE_CONNECT_ENABLED` OFF removes Connect only (`includeSlackConnect` is ignored).
- `P1_CHANNEL_SCOPE_ENABLED` OFF restores legacy behavior byte-for-byte. The data stays, and so does the 200 skip from the cron.

## 4. Staging checks (collected from the CS3–CS6 notes)
### E2E (design §10)
- [ ] **Internal invite**: invite the employee or bot to an internal channel. A membership is created and the channel is auto-classified internal. With all_joined, a mention wakes the employee and sends go through the normal matrix; with registered_only it does not wake.
- [ ] **Connect invite**: the channel is classified shared_external.
  - With the Connect flag OFF (or without includeSlackConnect) it is out of scope.
  - With it ON it wakes, and sends are **needs_approval until `channels.classify` confirms**. After that they follow the matrix.
  - The approver gets an info card.
  - `inviter_team_id` comes from `users.info` (needs `users:read`).
- [ ] **Shared later**: share an internal channel with Connect. `channel_shared` makes it shared_external, and it never goes back to internal (sticky). Human rows stay registered (owner decision).
- [ ] **Leave / removal**:
  - Voluntary `member_left_channel` → state `left`, no wake, sends are not blocked by this gate (known gap).
  - Kicking the bot (`channel_left`/`group_left`) or removing the employee → `removed`.
  - `slack.post` → 403 `channel_membership_removed`. An approval executed after the removal fails with fulfillment `channel_membership_removed`.
  - Rejoining clears it.

### CS3 (events)
- [ ] Production Supabase paths of `upsertAutoClassifiedChannel`: insert with `ignoreDuplicates` and the compare-and-set update. Tests ran in demo mode only.
- [ ] Idempotency: replaying the same `event_id` does not apply twice.
- [ ] Joins by other users are ignored.
- [ ] Slack sends one `authorizations` entry per event. Check that our employee's join is recorded; otherwise reconcile fills the gap.
- [ ] Claim-before-process: a processing failure leaves an `channel_scope.event_failed` audit, and the next reconcile repairs it.

### CS4 (sends / approvals)
- [ ] Production path of `markChannelHumanConfirmed`, and the `isSharedChannel` Slack call on the info card.
- [ ] Topic gate: `mainBoardChannelIds` is not auto-included.
- [ ] Legacy `source=manual` rows are not gated (by design).

### CS5 (reconcile)
- [ ] Production path of `upsertOrgChannelFromAutomaticPath`. Existing rows keep `source`/`human_confirmed_at`; new rows are inserted as `source=egress_inspect`.
- [ ] Stuck-watch auto rows are now `registered_only`-narrowed (accepted).
- [ ] Production paths of `listAllEmployeeChannelMemberships` (range paging) and the reconcile CAS.
- [ ] Cron: 401 without the secret; `{skipped:"flag_off"}` when OFF; when ON it stops within the 45 s budget and rotates orgs.
- [ ] Rate limiting: 3 s spacing, 18 requests per org per run; a 429 backs off with Retry-After.
- [ ] `missing_scope` makes the listing incomplete and **applies no leaves**.
- [ ] `channelScope.reconcile`: `dryRun:true` writes nothing. `dryRun:false` files a ticket, and approval applies only the approved keys.

### CS6 (setup / dashboard / removed deny)
- [ ] `setup.slackStatus`:
  - `channelScope` is present only when the flag is ON;
  - bot probes report `missing_scope` correctly before the reinstall;
  - `nextStepJa` shows mode selection before `channels.classify`.
- [ ] `/app/settings` → チャンネル範囲 card:
  - GET for the tenant default and per employee;
  - PATCH files an approval ticket (not applied directly);
  - a stale hash gives `before_state_mismatch`;
  - the owner's own request cannot be self-approved.
- [ ] The bot-install URL includes `channels:read,groups:read,users:read` only when the flag is ON.
- [ ] Removed deny: see E2E "Leave / removal". Audit `channel_scope.removed_channel_denied`.

## 5. Known gaps / backlog
- Voluntary `left` does not deny sends; only `removed` does (§11.5 is limited to removal).
- Reconcile does not send the approver info card; only the event path does.
- CS2: single-owner tenants need proxy approval.
- CS2 (seen in the reference, not fixed):
  - `approvalRoutes.patch` fulfill reads `metadata.argsSnapshot`;
  - `/api/approval-routes` POST lacks admin metadata;
  - there is a TOCTOU window between the hash re-check and the write.
- Decision workflow RLS hardening (separate backlog; must be decided before `P1_DECISION_WORKFLOW_ENABLED`).
- Pre-existing test failures, unrelated to this work: `lib/mcp/admin-tools.test.ts` and `lib/approval-workflow/fail-closed.test.ts`.
- Tenant-specific docs (rollout procedure B9, Space Tree playbook §3, ops staff manual) are maintained outside this repo; add the mode-selection step there as well.
