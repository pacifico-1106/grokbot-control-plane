# Multi-Tenant Org Boundary Audit

**Audit Date:** 2026-09-05
**Scope:** Staffpass multi-tenant control plane - cross-org isolation review
**Status:** Complete

---

## Executive Summary

Staffpass implements reasonable org isolation through RLS policies, session-based org scoping, and credential fingerprinting. However, several gaps exist that should be addressed before onboarding a second production tenant.

**Critical:** 0
**High:** 1 (H1 Slack wake cross-org leak FIXED 2026-09-05)
**Medium:** 3
**Low:** 2

---

## 1. org_id Establishment (Signup / Issue)

### Hypothesis
org_id could be omitted or swapped during signup or employee issue.

### Findings

| Check | Status | Evidence |
|-------|--------|----------|
| Signup creates new org bound to auth user | **PASS** | `createOrgWithOwner` in `lib/auth/session.ts:360-416` creates org + member atomically |
| org_id cannot be injected via request body | **PASS** | `issueEmployee` in `app/api/employees/issue/route.ts:88` gets orgId from `getCurrentOrgId()` (session-based) |
| Session org derived from auth.uid() | **PASS** | `getSessionContext` queries `org_members` by `user_id = auth.uid()` |

**Verdict: PASS** - No path to omit or swap org during signup/issue.

---

## 2. Admin MCP and Employee MCP Auth

### Hypothesis
Tokens/sessions could allow cross-org queries by id.

### Findings

| Check | Status | Evidence |
|-------|--------|----------|
| Employee credential returns orgId from binding | **PASS** | `resolveEmployeeCredential` returns `orgId` from credential/binding lookup (`lib/auth/employee-credential.ts:100-110`) |
| Admin credential returns orgId from agent record | **PASS** | `resolveAdminCredential` returns `orgId` from `findAdminAgentByFingerprint` (`lib/auth/admin-credential.ts:92-102`) |
| Fingerprints are globally unique | **PASS** | SHA-256 hash of full secret ensures uniqueness |
| MCP tools use credential.orgId | **PASS** | `callStaffpassMcpTool` passes `cred.orgId` to downstream queries |

**Verdict: PASS** - Credentials are org-bound via fingerprint lookup.

---

## 3. API Routes / Gateway / Slack Event Handlers

### 3.1 Gateway Invoke

| Check | Status | Evidence |
|-------|--------|----------|
| orgId from session or binding | **PASS** | `runGatewayInvoke` gets orgId from `getCurrentOrgId() \|\| binding.orgId` (`lib/gateway/invoke.ts:396-398`) |
| Employee lookup requires orgId | **PASS** | `getEmployee(employeeId, orgId)` requires both params |

**Verdict: PASS**

### 3.2 Approval Lookups

| Check | Status | Evidence |
|-------|--------|----------|
| `getApprovalByTelegramRef` filters by org | **PASS** | Optional org_id filter added; callers pass channel.orgId (`lib/data/approvals.ts`) |
| `getApprovalByTelegramMessageId` filters by org | **PASS** | Optional org_id filter added (`lib/data/approvals.ts`) |
| Webhooks validate org match after lookup | **PASS** | Slack/Line/Telegram channel webhooks pass orgId to lookup |

**Verdict: PASS** - Approval lookups now filter by org_id when provided (defense in depth).

### 3.3 Slack Mention Wake

| Check | Status | Evidence |
|-------|--------|----------|
| `getEmployeesBySlackUserIds` filters by team | **PASS** | Filter by `slack_team_id` at query time when `teamId` is present (H1 fix, 2026-09-05) |
| Missing teamId returns empty | **PASS** | Fail-closed: returns `[]` when `teamId` is missing/empty (H1 fix, 2026-09-05) |
| Slack channel collision across orgs | **OK** | Same external channel_id can exist in multiple orgs, but `slack_team_id` discriminates at wake time |

**Verdict: FIXED** - H1 fix applied 2026-09-05. `getEmployeesBySlackUserIds` now filters by `slack_team_id` at DB level and fails closed when teamId is absent. IM wake path uses `slack_im_employee_routes` (org-scoped via route).

**File References:**
- `lib/data/slack-identities.ts:273-322` (getEmployeesBySlackUserIds)
- `lib/slack/mention-ingress.ts:248-249` (passes teamId from envelope)

---

## 4. Approval Tickets / Notify - Org Scoped?

| Check | Status | Evidence |
|-------|--------|----------|
| `createApproval` sets org_id | **PASS** | Insert includes `org_id: input.orgId` (`lib/data/approvals.ts:190`) |
| Notification channels org-scoped | **PASS** | `listNotificationChannels` filters by orgId (`lib/data/notification-channels.ts:120-137`) |
| Delivery records include org_id | **PASS** | `recordNotificationDelivery` sets `org_id` (`lib/data/notification-channels.ts:508-520`) |
| Telegram channel webhook validates org | **PASS** | `approval.orgId === channel.orgId` check (`lib/notify/telegram-channel-webhook.ts:82-84`) |

**Verdict: PASS** - Approval notifications are properly org-scoped.

---

## 5. RLS Policies - Service-Role Tables

### Tables with RLS Enabled (org-scoped via `is_org_member`)

All major tables have RLS enabled:
- `orgs`, `org_members`, `employees`, `credentials`, `action_counters`
- `approval_requests`, `org_notification_channels`, `approval_notification_deliveries`
- `org_conversation_adapters`, `org_sns_adapters`, `employee_slack_identities`
- `audit_events`, `subscriptions`, `gateway_links`, `employee_bindings`
- `org_parties`, `org_channels`, `information_assets`, `org_projects`, `org_admin_agents`

### Tables Intentionally Service-Role Only (No Browser RLS)

| Table | Intentional | Comment |
|-------|-------------|---------|
| `org_notification_channel_secrets` | **YES** | Comment in schema: "service-role-only" |
| `org_conversation_adapter_secrets` | **YES** | Same pattern |
| `employee_slack_identity_secrets` | **YES** | Comment: "Intentionally inaccessible via browser RLS" |
| `employee_binding_secrets` | **YES** | Comment: "Service-role-only encrypted" |
| `slack_mention_events` | **YES** | Idempotency table, service-role only |

**Verdict: PASS** - RLS is properly configured. Secrets tables are intentionally service-role only.

**File Reference:** `supabase/schema.sql:570-800`

---

## 6. Hardcoded Tenant-Specific Values

| Pattern | Location | Severity | Notes |
|---------|----------|----------|-------|
| `isTokyo307PilotOrg` | `lib/data/notification-channels.ts:433-446` | **MEDIUM** | Special handling for pilot org |
| `isTokyo307PilotEmail` | `lib/data/notification-channels.ts:448-450` | **MEDIUM** | Hardcoded email check |
| `shouldUseGlobalTelegramFallback` | `lib/data/notification-channels.ts:452-458` | **MEDIUM** | Only for TOKYO307 pilot |
| `八坂` in demo data | `lib/demo-data.ts:125` | **LOW** | Demo/test only |
| `DEMO_ADMIN_SECRET` | `lib/data/admin-agents.ts:13` | **LOW** | Demo mode only |

**Verdict: MEDIUM** - Pilot org special cases should be removed or made configurable before multi-tenant.

---

## Summary Table

| Check | Status | Severity | Backlog Item |
|-------|--------|----------|--------------|
| 1. org_id signup/issue | **PASS** | - | - |
| 2. MCP auth org binding | **PASS** | - | - |
| 3.1 Gateway invoke | **PASS** | - | - |
| 3.2 Approval lookup by ref/msgId | **PASS** | - | FIXED 2026-09-05: org_id filter added |
| 3.3 Slack mention cross-org wake | **FIXED** | ~~High~~ | FIXED 2026-09-05: Filter by `slack_team_id` in `getEmployeesBySlackUserIds` |
| 4. Approval/notify org-scoped | **PASS** | - | - |
| 5. RLS policies | **PASS** | - | - |
| 6.1 TOKYO307 pilot hardcodes | **WARN** | Medium | Remove or make configurable |
| 6.2 Global Telegram fallback | **WARN** | Medium | Should be per-org only |
| 6.3 Demo data names | **PASS** | Low | Acceptable (demo only) |

---

## Fix Backlog

### HIGH Priority

#### H1: Slack Mention Wake Cross-Org Leak — **FIXED 2026-09-05**

**Problem:** `getEmployeesBySlackUserIds` queried all orgs. A Slack user bound to employees in multiple orgs could trigger wakes across tenants.

**Files:**
- `lib/data/slack-identities.ts:273-322`
- `lib/slack/mention-ingress.ts:248-249`

**Fix Applied:**
1. `getEmployeesBySlackUserIds` now filters by `slack_team_id` at DB level when `teamId` is present
2. `preferTeam` fails closed: returns only rows matching the team, never falls back to other teams
3. Removed the fallback that scanned ALL linked rows when some IDs were missing
4. When `teamId` is missing/empty, returns `[]` (fail-closed) instead of cross-org fan-out
5. IM wake path (`slack_im_employee_routes`) is org-scoped via route and unaffected

**Tests Added:**
- Same slack_user_id in different teams → only matching team returned
- Wrong team → no results (fail-closed)
- Missing teamId → empty results (no cross-org fan-out)
- Case-insensitive team_id matching

**Complexity:** Low - no schema migration required. Soft enforcement via query filters.

---

#### H2: Approval Lookup Without Org Filter — FIXED 2026-09-05

**Problem:** `getApprovalByTelegramRef` and `getApprovalByTelegramMessageId` could return approvals from any org.

**Files:**
- `lib/data/approvals.ts`

**Resolution:** Added optional `orgId` parameter to both functions. When provided, the query filters by `org_id` at the database level. All channel-based webhook callers (Slack, Line, Telegram tenant channels) now pass `channel.orgId` to these lookups. The global Telegram env fallback path continues without org filter for backward compatibility with pilot flows.

**Tests:** Cross-org lookup tests added to `lib/data/p0-auth-idor.test.ts`.

---

### MEDIUM Priority

#### M1: Remove TOKYO307 Pilot Hardcodes

**Problem:** Special handling for `info@tokyo307inc.com` pilot org.

**Files:**
- `lib/data/notification-channels.ts:433-480`

**Fix:** Remove `isTokyo307PilotOrg`, `isTokyo307PilotEmail`, `shouldUseGlobalTelegramFallback`, `findPilotTelegramChannelByChatId`, `getTokyo307PilotOrgId`. Replace with proper per-org configuration.

---

#### M2: Global Telegram Env Fallback

**Problem:** `shouldUseGlobalTelegramFallback` allows env-based Telegram config to be shared.

**Files:**
- `lib/data/notification-channels.ts:452-458`
- `app/api/webhooks/telegram/route.ts` (uses `TELEGRAM_ALLOWED_USER_IDS` env)

**Fix:** Require all tenants to configure their own Telegram channels. Remove global fallback.

---

#### M3: Slack Channel ID Collision Potential

**Problem:** `org_channels` allows same `external_id` across orgs. If Org A and Org B employees join `#industry-chat`, their audience resolution is independent but mentions could cross-wake.

**Files:**
- `supabase/schema.sql:486-499`
- `lib/gateway/audience.ts:192-200`

**Fix:** Accept this as intended (orgs can have different classifications for shared channels). Document the behavior. The Slack team_id should be the discriminator for wake targets.

---

### LOW Priority

#### L1: Demo Data Display Names

Japanese names like `八坂` in demo data are acceptable for demo/test mode. No action required.

---

## Conclusion

Staffpass has solid multi-tenant foundations:
- RLS policies properly scope browser queries
- MCP credentials embed org_id from fingerprint lookup
- Gateway invoke uses session org_id
- Webhook handlers pass org_id to approval lookups (defense in depth)

**Before onboarding Tenant B:**
1. ~~Fix H1 (Slack wake cross-org)~~ - **FIXED 2026-09-05**
2. Remove M1 (TOKYO307 hardcodes)
3. Remove M2 (Global Telegram fallback)
4. ~~Review H2 (approval lookup)~~ - **FIXED 2026-09-05**
