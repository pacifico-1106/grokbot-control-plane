# Security Audit Report: Approval Routing P0 (Items 1-7)

**Date:** 2026-09-27  
**Auditor:** Cloud Agent  
**Scope:** PRs #122, #123, #124, #125, #126, #127, #128 (merged to main)  
**Mode:** READ-ONLY audit (no code changes except optional failing tests)

---

## Executive Summary

This audit covers the approval routing P0 implementation across 6 phases. The implementation demonstrates strong security fundamentals with proper tenant isolation, metadata-driven classification, and fail-closed semantics. Several findings require attention before enabling enforcement in production.

### Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 2 |
| Medium | 4 |
| Low | 3 |
| Info | 2 |

**Recommendation:** Fix Critical and High severity issues before enabling `admin_approver_enforcement=true` in production.

---

## Phase 1: Threat Model & Trust Boundaries

### Architecture Review

The system correctly identifies the following trust boundaries:
- **Tenant (Org) isolation:** Enforced via `org_id` foreign keys and RLS policies
- **Slack workspace/app isolation:** Bounded candidate resolution by `api_app_id` + `team_id`
- **Telegram:** Global webhook with `TELEGRAM_ALLOWED_USER_IDS` allowlist
- **Voter bindings:** Member-to-external-identity mappings with verification flow
- **Admin MCP:** Separate audit class with explicit admin route requirement

### Trust Boundary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Platform (Staffpass)                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Org A (Tenant)                            │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │ │
│  │  │ Slack App A  │  │ Telegram     │  │ LINE         │      │ │
│  │  │ (team_id=X)  │  │ (global)     │  │ (channel)    │      │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘      │ │
│  │  ┌──────────────┐  ┌──────────────┐                        │ │
│  │  │ Voter        │  │ Admin        │                        │ │
│  │  │ Bindings     │  │ Route        │                        │ │
│  │  └──────────────┘  └──────────────┘                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Org B (Tenant)                            │ │
│  │  ┌──────────────┐  ...                                      │ │
│  │  │ Slack App B  │                                           │ │
│  │  │ (team_id=Y)  │                                           │ │
│  │  └──────────────┘                                           │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 2: AuthN/AuthZ

### Finding 1: Verification Code Brute-Force Not Rate Limited

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File:Line** | `lib/approval-workflow/voter-binding.ts:330` |
| **Exploit Scenario** | Attacker with pending binding can brute-force 6-digit verification code (1M combinations) without rate limiting. 15-minute expiry window allows ~1000 requests/sec to enumerate all codes. |
| **Recommended Fix** | Add rate limiting (e.g., 5 attempts per binding, then lock for 1 hour). Track failed attempts in `approval_workflow_voter_bindings` table. |

```typescript
// voter-binding.ts:330 - No attempt tracking
if (expectedHash !== actualHash) {
  return { ok: false, reason: "invalid_verification_code", messageJa: "検証コードが一致しません。" };
}
```

### Finding 2: `verified_at` Check Added but Missing in One Code Path

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File:Line** | `lib/approval-workflow/data.ts:77-87` |
| **Exploit Scenario** | The `getMemberIdFromVoterBinding` function correctly checks `verified_at IS NOT NULL`, but the demo mode path (`getDemoWorkflowVoterBinding`) also checks this. This is correct. |
| **Status** | **PASS** - Both production and demo paths enforce `verified_at` check. |

```typescript
// data.ts:77-87 - Correct implementation
if (row.revoked_at) return null;
if (!row.verified_at) return null;  // ✓ Enforced
if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
```

### Finding 3: Self-Approval Correctly Denied

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | `lib/admin-mcp/self-approval.ts:42-55` |
| **Status** | **PASS** - Self-approval is correctly checked by comparing `grokBotAgentId` and `actorId` between requester and resolver. |

### Finding 4: Cross-Org Isolation on Vote Paths

| Path | Status | Notes |
|------|--------|-------|
| Slack interactivity (new) | ✓ PASS | `findChannelCandidatesByAppAndTeam` bounds by `api_app_id` + `team_id` |
| Slack interactivity (legacy [ref]) | ✓ PASS | `getNotificationChannelByWebhookRef` validates `org_id` |
| Telegram | ✓ PASS | `TELEGRAM_ALLOWED_USER_IDS` allowlist + `shouldUseGlobalTelegramFallback` org check |
| Dashboard | ✓ PASS | `requireCapability("approve_actions")` + `getCurrentOrgId()` |
| Admin MCP | ✓ PASS | Session org validation + `getSuperAdminAccess()` |

### Finding 5: Admin-Class Approver Enforcement

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | `supabase/migrations/20260927000300_admin_approver_enforcement.sql` |
| **Status** | **PASS** - SQL trigger `guard_admin_class_approval` correctly rejects: (1) approved admin tickets with null `resolved_by`, (2) business-route voters on admin tickets, (3) non-owner/non-admin-route resolvers. |

### Finding 6: `always_human` Bypass Check

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File:Line** | Multiple locations |
| **Concern** | The `always_human` flag in tool metadata is not explicitly validated in the admin-class classification. However, `isAdminMcpTool: true` metadata marker is checked. |
| **Status** | **PASS** - Admin tools using `always_human` pattern set `isAdminMcpTool: true` which is correctly classified as admin-class. |

---

## Phase 3: Input/Webhook Security

### Finding 7: Slack Signature Verification Includes Timestamp Replay Protection

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | `lib/notify/slack.ts:50-70` |
| **Status** | **PASS** - Timestamp replay protection correctly implemented with 5-minute window. |

```typescript
// slack.ts:64 - Correct implementation
const nowSec = (input.nowMs ?? Date.now()) / 1000;
if (Math.abs(nowSec - ts) > 5 * 60) return false;  // ✓ 5-minute window
```

### Finding 8: Multi-App Candidate Resolution Cross-Tenant Risk

| Field | Value |
|-------|-------|
| **Severity** | Critical |
| **File:Line** | `lib/slack/interactivity-channel-resolver.ts:70-85` |
| **Exploit Scenario** | When multiple tenants configure the same Slack app (same `api_app_id`), the `findChannelCandidatesByAppAndTeam` function tries ALL candidates' signing secrets. If Tenant A and Tenant B both use the same Slack app but have different signing secrets configured, and Tenant B's secret is tried first and FAILS, the loop continues to Tenant A's secret. However, if Tenant B's secret MATCHES (compromised or reused), Tenant B's interactivity handler could process Tenant A's approval. |
| **Recommended Fix** | After signature verification succeeds, add explicit check that the matched channel's `org_id` matches the approval's `org_id` before processing. Currently, the code does check `approval.orgId` matches `channel.orgId` in the lookup, but this happens AFTER the vote action. Add this check BEFORE any state mutation. |

```typescript
// interactivity-channel-resolver.ts:70-85
// ISSUE: If two orgs share the same api_app_id, signing secret iteration
// could match the wrong org's secret
for (const candidate of candidates) {
  const signingSecret = candidate.signingSecret?.trim() || "";
  if (!signingSecret) continue;
  if (verifySlackSignature({ signingSecret, timestamp, rawBody, signature })) {
    return { ok: true, channel: candidate };  // Returns first match
  }
}
```

**Mitigation:** The code in `app/api/webhooks/slack/interactivity/route.ts:222-232` does check that the looked-up approval belongs to `channel.orgId`, which prevents cross-tenant vote execution. However, the signature verification still iterates all candidates.

### Finding 9: Telegram Webhook Auth

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File:Line** | `app/api/webhooks/telegram/route.ts:264-275` |
| **Status** | **PASS** - Uses `x-telegram-bot-api-secret-token` header validation. Returns 503 if secret not configured (fail-closed). |

### Finding 10: SSRF/Injection

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File:Line** | Multiple |
| **Status** | **PASS** - No user-controlled URLs passed to `fetch()` without validation. Slack/Telegram API URLs are hardcoded. `response_url` is only used to send ephemeral messages (no secrets). |

---

## Phase 4: Data Layer

### Finding 11: Migration RLS Review (20260927*)

| Migration | RLS Status | Notes |
|-----------|------------|-------|
| `20260927000300_admin_approver_enforcement.sql` | ✓ PASS | Functions use `SECURITY DEFINER` with `SET search_path=pg_catalog,public`. Grants only to `service_role`. |
| `20260927100000_voter_binding_verification.sql` | ⚠️ REVIEW | No RLS policies added for new columns. Table-level RLS should be verified. |
| `20260927200000_delivery_per_recipient.sql` | ✓ PASS | Adds partial unique index for recipient uniqueness. |

### Finding 12: Race Condition in Concurrent Verification

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File:Line** | `lib/approval-workflow/voter-binding.ts:343-363` |
| **Exploit Scenario** | Two concurrent verification requests with the same valid code could both succeed before the first one clears `verification_hash`. This could result in duplicate `verified_at` updates (benign) but indicates lack of atomic claim. |
| **Recommended Fix** | Use `UPDATE ... WHERE verification_hash = $expected AND verified_at IS NULL` to atomically claim the verification. |

```typescript
// Current implementation does SELECT then UPDATE, not atomic
const { data: existing } = await admin.from("approval_workflow_voter_bindings")
  .select("*").eq(...).maybeSingle();  // SELECT
// ... validation ...
const { data: updated } = await admin.from("approval_workflow_voter_bindings")
  .update({ verified_at: now, ... }).eq(...);  // UPDATE (not conditional)
```

### Finding 13: Double Vote Prevention

| Field | Value |
|-------|-------|
| **Severity** | Low |
| **File:Line** | `lib/approval-workflow/data.ts:595-605` |
| **Status** | **PASS** - `castBallot` uses conditional update `.is("vote", null)` to prevent double voting. |

### Finding 14: Unique Constraint Known Gap

| Field | Value |
|-------|-------|
| **Severity** | High |
| **File:Line** | `supabase/migrations/20260927200000_delivery_per_recipient.sql:33-34` |
| **Status** | **ACKNOWLEDGED** - Per the brief, the `(approval_id, channel_id)` unique constraint is kept for backward compatibility. The new partial index `approval_notification_deliveries_recipient_unique_idx` handles uniqueness for recipient-based deliveries. |

---

## Phase 5: Feature Flags

### Flag Defaults Review

| Flag | Default | Fail-Closed | Notes |
|------|---------|-------------|-------|
| `ADMIN_APPROVER_POLICY_REQUIRED` | OFF | ✓ YES | When ON, missing admin route fails closed |
| `SLACK_APPROVAL_STRICT` | OFF | ✓ YES | When ON, missing `expectedTeamId` fails closed |
| `APPROVAL_RECIPIENT_ROUTING` | OFF | ✓ YES | When ON, admin-class falls back to default channel |
| `EXTERNAL_CONTRACT_CARD_SETUP` | OFF | N/A | **VERIFIED UNTOUCHED** - No changes in P0 PRs |

### Finding 15: Flag OFF Behavior Legacy-Safe

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | `lib/feature-flags.ts` |
| **Status** | **PASS** - All P0 flags default OFF. Legacy W1 behavior (any single approver) preserved when flags are OFF. |

### Finding 16: Missing Config Fail-Closed

| Field | Value |
|-------|-------|
| **Severity** | Medium |
| **File:Line** | `app/api/webhooks/slack/[ref]/route.ts:137-149` |
| **Status** | **PASS** - When strict mode is ON and `expectedTeamId` is missing, the check fails closed with reason `expected_team_id_not_configured`. |

---

## Phase 6: Delivery/Routing

### Finding 17: Recipient Routing Never Falls Back to Shared Channel

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | `lib/notify/recipient-routing.ts:136-140` |
| **Status** | **PASS** - `isSharedChannel()` check prevents delivery to Slack Connect channels. |

### Finding 18: Admin-Class Never Routes to Business Voters

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | `lib/notify/recipient-routing.ts:68-76` |
| **Status** | **PASS** - `isAdminClassApproval()` check routes admin-class to default channel, never to DM. |

### Finding 19: Secrets/Tokens Never Logged or Put in Cards

| Field | Value |
|-------|-------|
| **Severity** | Info |
| **File:Line** | Multiple |
| **Status** | **PASS** - Grep search for `console.log.*secret|token|password|key` shows no credential logging. Test files explicitly verify `jsonHasNoToken()` and `jsonHasNoSecret()`. |

---

## Findings Table

| # | Severity | File:Line | Issue | Exploit Scenario | Recommended Fix |
|---|----------|-----------|-------|------------------|-----------------|
| 1 | **Critical** | `lib/slack/interactivity-channel-resolver.ts:70-85` | Multi-app signing secret iteration | Tenant B's compromised secret could validate Tenant A's request | Add org_id validation BEFORE processing |
| 2 | **High** | `lib/approval-workflow/voter-binding.ts:330` | No rate limit on verification codes | Brute-force 6-digit code in 15-minute window | Add attempt tracking and lockout |
| 3 | **High** | (Known gap) | Delivery unique constraint | Per brief - acknowledged limitation | N/A |
| 4 | **Medium** | `lib/approval-workflow/voter-binding.ts:343-363` | Race condition in concurrent verification | Duplicate verified_at updates | Use atomic UPDATE with WHERE conditions |
| 5 | **Medium** | `20260927100000_voter_binding_verification.sql` | New columns lack explicit RLS | Potential data leakage | Verify table-level RLS covers new columns |
| 6 | **Medium** | Multiple | Verification code single-use | Code can be reused until expiry | Clear hash immediately after first successful use |
| 7 | **Medium** | (Design) | Verification code org+user+team binding | Code embedded in callback value includes all bindings | ✓ PASS - Callback value is HMAC-signed |
| 8 | **Low** | `app/api/webhooks/telegram/route.ts` | Telegram global fallback | External users could potentially vote | Mitigated by `TELEGRAM_ALLOWED_USER_IDS` |
| 9 | **Low** | Multiple | Timing attack on signature verification | Slight timing difference on secret match | Uses `timingSafeEqual` - PASS |
| 10 | **Low** | Multiple | SSRF potential | User-controlled URLs | No user-controlled fetch URLs found |
| 11 | **Info** | `lib/admin-mcp/self-approval.ts` | Self-approval check | N/A | ✓ Correctly implemented |
| 12 | **Info** | `lib/feature-flags.ts` | Flag defaults | N/A | ✓ All default OFF, legacy-safe |

---

## Conclusion

### Is Enforcement ON Safe After Fixes?

**Conditional YES** - Enforcement (`admin_approver_enforcement=true`) is safe AFTER:

1. **MUST FIX (Critical):** Add explicit `org_id` match check in Slack interactivity before any state mutation (currently mitigated by downstream check but defense-in-depth recommended).

2. **MUST FIX (High):** Implement rate limiting on verification code attempts (5 attempts then 1-hour lockout).

3. **SHOULD FIX (Medium):** 
   - Make verification atomic with conditional UPDATE
   - Verify voter binding table RLS covers new columns

4. **Known Gap (Acknowledged):** The `(approval_id, channel_id)` unique constraint limitation is understood and documented.

### Verification Checklist Before Production Enable

- [ ] Critical finding #1 addressed
- [ ] High finding #2 addressed  
- [ ] Run full test suite with enforcement ON
- [ ] Verify at least one org owner exists before enabling per-org
- [ ] Verify Slack channels have `expectedTeamId` configured
- [ ] Test Slack Connect user rejection
- [ ] Test cross-org voter isolation (Org B voter cannot vote on Org A ticket)

---

## Appendix: Files Reviewed

### Migrations
- `supabase/migrations/20260927000300_admin_approver_enforcement.sql`
- `supabase/migrations/20260927100000_voter_binding_verification.sql`
- `supabase/migrations/20260927200000_delivery_per_recipient.sql`
- `supabase/migrations/20260923_external_contract_card_setup.sql` (verified untouched)

### Webhook Routes
- `app/api/webhooks/slack/interactivity/route.ts`
- `app/api/webhooks/slack/[ref]/route.ts`
- `app/api/webhooks/telegram/route.ts`

### Approval Workflow
- `lib/approval-workflow/admin-policy.ts`
- `lib/approval-workflow/voter-binding.ts`
- `lib/approval-workflow/voter-binding-verification.ts`
- `lib/approval-workflow/data.ts`
- `lib/approval-workflow/slack-voter.ts`

### Security
- `lib/admin-mcp/self-approval.ts`
- `lib/admin-mcp/audit-class.ts`
- `lib/notify/slack.ts` (signature verification)
- `lib/slack/interactivity-channel-resolver.ts`
- `lib/slack/channel-validation.ts`
- `lib/feature-flags.ts`

### Tests
- `lib/approval-workflow/admin-policy.test.ts`
- `app/api/approvals/workflow-routes.test.ts`

---

*Report generated: 2026-09-27T01:45:00Z*
