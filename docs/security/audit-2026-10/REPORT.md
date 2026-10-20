# Staffpass security audit — 2026-10

**Scope:** read-only review of the whole `grokbot-control-plane` repository (Staffpass control plane).  
**Out of scope:** production mutation, migrations, data deletion, customer contact, runtime-code changes.  
**Method:** six phases (recon → attack surface → authZ → data layer → secrets/injection/SSRF/rate-limit/email → code-path validation).  
**Base:** `main` at audit start (`7f560bc7` and later local fetch of `origin/main`).  
**Date:** 2026-10-20.

This document is the narrative. Structured records live in [`findings.json`](./findings.json). Checks that require a live database, Vercel env, or DNS live in [`NEEDS-VALIDATION.md`](./NEEDS-VALIDATION.md).

---

## 1. Executive summary

Staffpass is a multi-tenant Next.js 15 control plane: cookie-session dashboard, employee MCP (`gb_emp_`), admin MCP (`gb_adm_`), Slack/LINE/Telegram/Stripe webhooks, Vercel Cron, LP funnels, and a platform super-admin allowlist. Tenant writes go through a **service-role** Supabase client. RLS and table `REVOKE`s are **defense-in-depth** against PostgREST + stolen session JWT.

The application-layer tenant boundary on dashboard APIs is generally sound (`requireOrgSession` / `requireCapability` + `org_id` on lookups). Employee MCP cannot call admin MCP. `POST /api/email` and `POST /api/trial` are gone (404). No `'use server'` actions exist.

The residual risk is concentrated in **three classes**:

1. **Data-plane holes that the repo already closed in SQL but may not be live.** GitHub PRs [#258](https://github.com/pacifico-1106/grokbot-control-plane/pull/258) and [#259](https://github.com/pacifico-1106/grokbot-control-plane/pull/259) drop write policies that let any org member (or admin) rewrite approvals, plans, credentials, and bindings via PostgREST. Both PRs say the migrations were **not applied to production**. If that is still true, a tenant session JWT + the public anon key is enough to bypass every server guard.
2. **Hardening flags that default OFF.** `lib/feature-flags.ts` states this explicitly. When OFF: login and signup Layer-2 rate limits do not run, LP inquiry has no bot/rate shield, webhook SSRF hardening is only a metadata/link-local blocklist, Slack approval is not strict, admin-class approvals do not require an explicit policy, and MCP auth failures are not audited.
3. **Pilot / dual-mode surfaces.** DEMO mode (`replace_me_*` Supabase keys) collapses dashboard auth. The global Telegram webhook looks up approvals **without** `org_id` and treats an **empty** `TELEGRAM_ALLOWED_USER_IDS` as “allow any Telegram user.”

No **Critical** finding is confirmed as currently exploitable from the public internet without a flag, a leaked secret, or an unapplied migration. Several **High** items are `needs_validation` against production.

### Counts

| Severity | Confirmed | Needs validation | Rejected | Total |
|----------|-----------|------------------|----------|-------|
| Critical | 0 | 0 | 0 | 0 |
| High | 0 | 3 | 0 | 3 |
| Medium | 15 | 1 | 0 | 16 |
| Low | 15 | 1 | 0 | 16 |
| Info | 5 | 0 | 2 | 7 |
| **Total** | **35** | **5** | **2** | **42** |

Positive controls (Info / Rejected) are kept so the record shows what was checked and closed.

---

## 2. Architecture and trust boundaries (Phase 1)

```
Public Internet
 ├── LP / legal / catalog          (no login; flags + Turnstile optional)
 ├── Browser dashboard             Supabase cookie → middleware.ts (UI paths only)
 ├── Agents / Grok Bot             Authorization: Bearer gb_emp_ | gb_adm_ | OAuth sp_at_
 ├── Vendor webhooks               Slack / LINE / Telegram / Stripe signatures
 └── Vercel Cron                   Authorization: Bearer CRON_SECRET
              │
              ▼
     Next.js route handlers (app/api/**)  ← /api is NOT in middleware matcher
              │
     createSupabaseAdminClient()  (service_role, bypasses RLS)
              │
     Supabase Postgres + RLS + GRANT/REVOKE (defense-in-depth)
```

| Boundary | Credential | Org resolution | Fail-closed notes |
|----------|------------|----------------|-------------------|
| Dashboard API | Cookie session | First active `org_members` row | Production: no session → 401. DEMO: open. |
| Employee MCP / Gateway | `gb_emp_` (hash lookup) | Credential row | Revoked / expired / hold → 401/403 |
| Admin MCP | `gb_adm_` only; rejects `gb_emp_` | Admin agent row | `lib/auth/admin-credential.ts` |
| Platform super-admin | Cookie + `SUPER_ADMIN_USER_IDS` / `SUPER_ADMIN_EMAILS` | Path `orgId` | UI 404 if not allowlisted |
| Approval poll | `id` + `statusToken` | Token on the ticket | Bearer-equivalent; ~192-bit token |
| Webhooks | HMAC / shared secret | `webhook_ref` → channel → org | Unknown Slack/LINE ref: 401/404 |
| Cron | `CRON_SECRET` | Global jobs | Unset → 503; placeholder → 401 |
| LP guest | Signed cookie + CSRF (when flags ON) | Journey row | Most LP flags default OFF |
| MCP OAuth | `sp_at_` when `MCP_OAUTH_ENABLED` | Grant → employee | Flag OFF → 404 on token/consent |

**Critical design fact:** `middleware.ts` matches `/app`, `/admin`, `/login`, `/signup`, `/onboarding`, `/lp/ai-employee-corp` only. **Every `/api/*` handler must authenticate itself.**

```95:97:middleware.ts
export const config = {
  matcher: ["/app/:path*", "/admin/:path*", "/login", "/signup", "/onboarding", "/lp/ai-employee-corp"],
};
```

**DEMO collapse:** `isDemoMode()` is true when any of URL / anon / service_role looks like a placeholder (`lib/mode.ts`). Then `getSessionContext()` always returns the demo org, and `requireCapability` honors `x-member-id` / `?as=` / body actor (`lib/team/demo-actor.ts:76-78`). A public host left on placeholders is an open control plane.

---

## 3. Attack-surface inventory (Phase 2)

**105** `app/api/**/route.ts` handlers. **Zero** `'use server'` actions; mutations are route handlers only.

### 3.1 Unauthenticated or weakly authenticated (prioritize)

| Path | Methods | Auth | Risk |
|------|---------|------|------|
| `POST /api/employees/interpret` | POST | **None** | Rules engine; DoS / policy-schema recon |
| `GET /api/health` | GET | None | `runtimeMode`, Stripe/Resend configured |
| `GET /api/gateway/health` | GET | Optional cookie | Always leaks `runtimeMode`; org details if logged in |
| `GET /api/catalog` | GET | None | LP SKU metadata |
| `GET /api/approvals/status` | GET | `id` + `statusToken` | Ticket status / fulfillment hints |
| `POST /api/auth/{login,signup,forgot-password}` | POST | Public + optional Turnstile / rate flags | Account creation and stuffing |
| `POST /api/lp/ai-employee/inquiry` | POST | Public; bot/rate **flags default OFF** | Ops-inbox mail |
| `POST /api/lp/ai-employee/checkout` | GET/POST | Public + Origin check on POST | Stripe Checkout session |
| `POST /api/journeys`, `POST /api/chat/turn` | POST | Flag-gated guest | OpenAI cost if LP chat ON |
| `POST /api/oauth/register` | POST | Public DCR (flag OFF → 404) | Client registration |
| MCP `initialize` / `server/discover` | POST | No credential | Server card / capabilities |
| `/api/webhooks/*` | POST | Vendor signatures | Ingress; ref guess + secret |
| `/api/cron/*` | GET (some POST) | `CRON_SECRET` | Global jobs |

### 3.2 Cookie-session tenant APIs

`/api/approvals/**`, `/api/employees/**` (except interpret), `/api/holds/**`, `/api/settings/**`, `/api/team/members`, `/api/billing/portal`, `/api/admin-mcp/**`, `/api/approval-routes`, `/api/gateway/link`, Slack/Google OAuth starts. Pattern: `requireOrgSession` / `requireCapability` / `requireOrgAdminSession` and `getEmployee(id, orgId)` / `getApprovalById(id, orgId)`.

### 3.3 Platform super-admin

`/api/admin/holds/stop`, `/api/admin/org-rename`, `/api/admin/trial-extension`, `/api/admin/organizations/[orgId]/approvals/**` — `getSuperAdminAccess()` only. Tenant owner/admin cannot use these.

### 3.4 MCP

| Path | Auth | Notes |
|------|------|-------|
| `/api/mcp` | `gb_emp_` and/or OAuth | CORS `*`. Primary employee mouth |
| `/api/mcp/admin` | `gb_adm_` only | Rejects employee badge |
| `/api/mcp/employee` | Same as employee; **404 unless** `MCP_EMPLOYEE_BADGE_MCP_ENABLED` | Extra mouth |
| `/api/mcp/employee/credential/claim` | `gb_emp_` + flags | One-time plaintext pickup; 404 when flags OFF |
| `/api/oauth/*` | Flag-gated | Token/consent/DCR/revoke/discovery |

### 3.5 Webhooks

Slack (`[ref]`, `/events`, `/interactivity`, approval-app), LINE (`[ref]`, `/c/[ref]`), Telegram (global + `[ref]`), Stripe, LP wake (`[path]`, flag). Slack/LINE require signing secrets after ref lookup.

### 3.6 Cron (`vercel.json`)

Scheduled: `telegram-digest`, `expire-trials`, `stuck-watch-w1`, `stuck-watch-w2`, `lp-handoff-outbox`, `mcp-events-deliver`, `oauth-purge`.  
Present as routes but **not** in `vercel.json`: `lp-inquiry-cleanup`, `channel-classify-backfill`, `decision-t2-expiry` (invoked from stuck-watch). Still callable if `CRON_SECRET` leaks.

### 3.7 Email / trial relay

**Removed (SEC1).** Tests pin empty handlers:

```165:170:lib/auth/p0-unauth-401.test.ts
  for (const path of ["/api/trial", "/api/email"]) {
    test(`${path} has no handler → 404`, () => {
      const segments = path.split("/").filter(Boolean);
      expect(appRouterHandlersFor(APP_DIR, segments)).toEqual([]);
```

Only three API routes import mail helpers: signup (own address), LP inquiry (fixed `AI_EMP_INQUIRY_NOTIFY_EMAIL`), Stripe webhook (billing customer). No remaining route lets a caller pick an arbitrary `To:`.

---

## 4. AuthN / AuthZ and BOLA (Phase 3)

**Dashboard IDOR:** reviewed employee, approval, hold, team, billing, settings, and OAuth-grant routes. Lookups take session `orgId`. Cross-tenant IDOR via a stolen-but-valid other-org UUID was **not** found on these paths.

**Employee → admin escalation:** **Rejected.** `resolveAdminCredential` returns `employee_badge_rejected` for `gb_emp_`.

**Session pin:** `getSessionContext` loads one membership (`order("created_at").limit(1)`). A user in two orgs always acts as the older membership. There is no org switcher.

**Global Telegram (High if the pilot bot is live):**

```81:85:app/api/webhooks/telegram/route.ts
function isAllowedUser(user: TelegramUser | undefined): boolean {
  if (!Number.isSafeInteger(user?.id)) return false;
  const allowed = allowedUserIds();
  return allowed.size === 0 || allowed.has(user!.id!);
}
```

```207:207:app/api/webhooks/telegram/route.ts
    approval = await getApprovalByTelegramRef(match[2]);
```

`getApprovalByTelegramRef` only adds `.eq("org_id", orgId)` when `orgId` is passed (`lib/data/approvals.ts:593-612`). The global route does not pass it. `telegram_ref` is 48 bits (`lib/approvals/tokens.ts:9-12`). Tenant `[ref]` routes do pass `channel.orgId`.

---

## 5. Data layer — RLS, #258 / #259, SECURITY DEFINER (Phase 4)

### 5.1 Coverage

All **114** public tables in `schema.sql` + `supabase/migrations` have `ENABLE ROW LEVEL SECURITY`. **No** `FORCE ROW LEVEL SECURITY` anywhere. Table owners and `service_role` (BYPASSRLS) are not forced through RLS.

### 5.2 GitHub #258 / #259

| PR | Merged | Migration | Claim |
|----|--------|-----------|-------|
| [#258](https://github.com/pacifico-1106/grokbot-control-plane/pull/258) | 2026-10-04 | `20261004500000_tenant_tables_server_only_writes.sql` | Drop 4 write policies on `orgs`, `subscriptions`, `audit_events`, `approval_requests`; `REVOKE` writes from `anon`/`authenticated` |
| [#259](https://github.com/pacifico-1106/grokbot-control-plane/pull/259) | 2026-10-04 | `20261004600000_tenant_config_tables_server_only_writes.sql` | Drop 17 write policies on credentials/employees/bindings/config + revoke SELECT on `credentials` |
| follow-up | in repo | `20261004800000_lp_tables_server_only.sql` | LP PII tables server-only |

**In the repository end-state the SQL is present** (`schema.sql` mirrors the drops/revokes; `lib/security/tenant-*-write-paths.test.ts` pins “no user-session writers”).

**Effectiveness in production is not proven by this review.** Both migration headers say:

> NOT APPLIED BY THE PR. Apply in production as a separate, reviewed step…

PR titles also say「未適用」. If production was bootstrapped from an **older** `schema.sql` and these three files were never run, the dangerous `{public}` write policies are still live.

What a live #258 hole allows (from the migration header, `20261004500000:8-22`): any org member with a session JWT + anon key can self-approve / insert pre-approved tickets / forge `audit_events` / (as admin) rewrite `plan_key`, `billing_status`, `stripe_customer_id`.

What a live #259 hole allows: org admins can mint/un-revoke credentials, re-bind employees to attacker agents, rewrite approval policy, flip gateway status, reclassify audience assets.

### 5.3 Broken `members` table in decision-workflow RLS

`20260930000200_decision_workflow.sql:176-244` policies use `from members m`. There is **no** `members` table (only `org_members`). No `GRANT`/`REVOKE` in that file. App code does not `.from('decision_*')` (feature flag `P1_DECISION_WORKFLOW_ENABLED` default OFF). At query time the policy errors (fail-closed for `authenticated`) unless a `members` table is later created. Still a landmine.

### 5.4 SECURITY DEFINER

Sensitive RPCs generally `REVOKE ALL` from `public, anon, authenticated` and `GRANT EXECUTE` to `service_role`. Exceptions / notes:

- `is_org_member` / `is_org_admin` (`20260823_production_ready.sql:59-90`): `search_path = public` only — used by remaining SELECT policies.
- `oauth_rate_limit_hit`: later pinned to `pg_catalog, public`.
- LP cleanup / catalog RPCs: `search_path = ''`, service_role only.

### 5.5 `org_members` writes

Write policy dropped (`20261004200000`, `schema.sql:639-645`) but **no** table-level `REVOKE INSERT/UPDATE/DELETE`. Defense is RLS default-deny only. Weaker than the #258 pattern.

---

## 6. Secrets, injection, SSRF, rate limits, email (Phase 5)

### 6.1 Secrets

No production hardcoded API keys found (test fixtures only). Notification / wake / LINE secrets: AES-GCM via `NOTIFICATION_CONFIG_ENCRYPTION_KEY`. Employee badges stored as `secret_hash`. `NEXT_PUBLIC_*` limited to anon key, Turnstile site key, Stripe publishable, app URL.

### 6.2 Injection

No app-layer string-concat SQL and no `child_process` on user input. Prompt injection is the real AI risk: Slack/LINE/Telegram text is forwarded to the **external** employee model; LP chat (`lib/lp/chat-prompt.ts`) documents user text as untrusted. Mitigations are approvals, secret detector, optional topic gate (`P1_TOPIC_GATED_POSTING_ENABLED` default OFF).

### 6.3 SSRF

`WEBHOOK_HARDENING_ENABLED` ON (`#270` `postHardenedWebhook`): HTTPS:443, no IP literals, public DNS only, pinned connect, no redirects.

**Default OFF.** Legacy callback / wake `fetch` only applies the link-local/metadata blocklist:

```7:10:lib/webhooks/link-local-guard.ts
 * NO FLAG: applies while WEBHOOK_HARDENING_ENABLED is OFF ...
 * Nothing else changes for the flag-OFF path: other private ranges, loopback,
 * http, any port and redirects stay exactly as today.
```

`http://169.254.169.254` is blocked. `http://127.0.0.1`, `http://10.0.0.1`, and arbitrary HTTP ports are not. `updateWakeWebhook` trims the URL and saves it (`lib/data/bindings.ts:536-538`) with no `validateCallbackUrl()`.

### 6.4 Rate-limit flags — GitHub #211 and successors

PR [#211](https://github.com/pacifico-1106/grokbot-control-plane/pull/211): signup Layer 2. **All default OFF.**

| Flag | Default | When OFF |
|------|---------|----------|
| `SIGNUP_ATTEMPT_LOG_ENABLED` | OFF | No `signup_attempts` rows |
| `SIGNUP_RATE_LIMIT_ENABLED` | OFF | No DB caps (5/10m IP, 20/24h IP, 5/24h mailbox, 30 creates/h). Fail-open on DB errors even when ON |
| `SIGNUP_DOMAIN_CHECK_ENABLED` | OFF | Disposable / dotted / Gmail-normalize duplicates allowed |
| `SIGNUP_RATE_LIMIT_REQUIRED_ENABLED` | OFF | Welcome/trial mail not blocked if Layer 2 store fails |
| `LOGIN_RATE_LIMIT_ENABLED` | OFF | No app 20/IP/15m or 10/IP+account/15m; Supabase Auth only |
| `LP_INQUIRY_RATE_LIMIT_ENABLED` | OFF | No IP-hash 5/min or global 100/min on inquiry/journeys |
| `LP_INQUIRY_BOT_PROTECTION_ENABLED` | OFF | No Turnstile on inquiry |
| `PASSWORD_RESET_TURNSTILE_ENABLED` | OFF | In-process quotas only |
| `AUTH_ENUMERATION_HARDENING_ENABLED` | OFF | Forgot-password consume-before-send; signup **409 `email_exists` stays even if this flag is later ON** |
| `WEBHOOK_HARDENING_ENABLED` | OFF | Legacy SSRF posture (above) |
| `SLACK_APPROVAL_STRICT` | OFF | Slack buttons do not require allowlist or voter binding |
| `ADMIN_APPROVER_POLICY_REQUIRED` | OFF | Admin-class tickets accept any single approver |
| `P0_REPLY_POLICY_ENHANCED` | OFF | No audience recipient validation on replies |
| `MCP_AUTH_FAILURE_AUDIT_ENABLED` | OFF | `/api/mcp` 401/403 not written to `mcp_auth_failures` |
| `HOLD_DENIAL_AUDIT_ENABLED` | OFF | Self-approve / MCP hold 403 not audited |

**Still on without #211:** signup Turnstile + honeypot (`lib/auth/signup-guard.ts`, fail-closed outside DEMO). Forgot-password always has IP 5/15m and email 3/h. OAuth rate limits apply only when OAuth is ON (`IP_HASH_KEY` missing → 503).

### 6.5 Email relay

Confirmed removed. Remaining mail: signup → submitted address; LP inquiry → fixed ops inbox; Stripe → customer on file; internal approval/hold/oauth mail uses org-scoped or validated recipients (`approvalNotifyEmail` checked against org members in `lib/approvals/resolve-side-effects.ts`).

---

## 7. Severity table

| ID | Title | Sev | Status | Flag dependency |
|----|-------|-----|--------|-----------------|
| SP-A-001 | #258/#259 write policies may still be live in production | High | needs_validation | None (SQL apply) |
| SP-B-001 | Global Telegram: unscoped lookup + empty allowlist = any TG user | High | needs_validation | Pilot bot / `TELEGRAM_*` env |
| SP-B-013 | DEMO mode on a public host collapses dashboard auth | High | needs_validation | Placeholder Supabase keys |
| SP-A-002 | Decision-workflow RLS references missing `members` table | Medium | confirmed | `P1_DECISION_WORKFLOW_ENABLED` (OFF) |
| SP-A-003 | `org_members` write policy dropped but no table REVOKE | Medium | confirmed | None |
| SP-A-004 | Many server-only tables: RLS ON, no policy, no REVOKE | Medium | confirmed | None |
| SP-B-002 | `getApprovalByTelegramRef` orgId optional | Medium | confirmed | Callers |
| SP-B-003 | Multi-org user pinned to first `org_members` row | Medium | confirmed | None |
| SP-B-006 | Approval `statusToken` is a cross-tenant bearer | Medium | confirmed | None (design) |
| SP-B-014 | `SLACK_APPROVAL_STRICT` default OFF | Medium | confirmed | Flag OFF |
| SP-B-015 | `ADMIN_APPROVER_POLICY_REQUIRED` default OFF | Medium | confirmed | Flag OFF |
| SP-C-001 | Legacy webhook SSRF (RFC1918 / loopback / HTTP) | Medium | confirmed | `WEBHOOK_HARDENING_ENABLED` OFF |
| SP-C-003 | Signup Layer 2 (#211) rate limits default OFF | Medium | confirmed | #211 flags OFF |
| SP-C-004 | Login stuffing: app limiter default OFF | Medium | confirmed | `LOGIN_RATE_LIMIT_ENABLED` OFF |
| SP-C-005 | LP inquiry spam to ops inbox | Medium | confirmed | LP bot/rate flags OFF |
| SP-C-009 | `MCP_OAUTH_ORG_ALLOWLIST_REQUIRED=false` opens all orgs | Medium | needs_validation | OAuth env |
| SP-C-011 | LP chat prompt-injection / token cost when chat ON | Medium | confirmed | `LP_CHAT_*` ON |
| SP-C-012 | Reply audience not enforced | Medium | confirmed | `P0_REPLY_POLICY_ENHANCED` OFF |
| SP-C-015 | External employee prompt injection via channel text | Medium | confirmed | None (product) |
| SP-A-005 | `is_org_member` / `is_org_admin` `search_path = public` | Low | confirmed | None |
| SP-B-004 | Unauthenticated `POST /api/employees/interpret` | Low | confirmed | None |
| SP-B-005 | Public `/api/health` leaks integration posture | Low | confirmed | None |
| SP-B-007 | Notification `webhook_ref` / `telegram_ref` 48-bit | Low | confirmed | None |
| SP-B-008 | `oauth-purge` cron: non-timing-safe secret compare | Low | confirmed | None |
| SP-B-009 | Telegram webhook secret: string equality | Low | confirmed | None |
| SP-B-010 | Login CSRF only when OAuth ON | Low | confirmed | `MCP_OAUTH_ENABLED` |
| SP-B-011 | MCP CORS `*` + unauth `initialize` | Low | confirmed | Design; OAuth changes 401 |
| SP-B-012 | `repair-org` auto-provisions a trial org | Low | confirmed | None |
| SP-C-002 | Wake/callback URL not validated at save | Low | confirmed | Chains to SP-C-001 |
| SP-C-006 | LP bot flag ON but Turnstile keys missing → fail-open | Low | confirmed | `LP_INQUIRY_BOT_PROTECTION_ENABLED` |
| SP-C-007 | Signup 409 `email_exists` enumerates mailboxes | Low | confirmed | Unchanged even if enum flag ON |
| SP-C-008 | Auth enumeration hardening default OFF | Low | confirmed | Flag OFF |
| SP-C-013 | MCP auth-failure audit default OFF | Low | confirmed | Flag OFF |
| SP-C-014 | Extra cron routes callable if `CRON_SECRET` leaks | Low | confirmed | Secret leak |
| SP-O-001 | OAuth grant store revoke/touch by id only | Low | needs_validation | No HTTP skip found |
| SP-A-006 | No `FORCE ROW LEVEL SECURITY` | Info | confirmed | None |
| SP-A-007 | Service role is the write path | Info | confirmed | Key protection |
| SP-C-010 | `/api/email` and `/api/trial` removed (404) | Info | confirmed | Positive |
| SP-D-001 | `/api` not in middleware matcher | Info | confirmed | By design |
| SP-D-002 | No `'use server'` actions | Info | confirmed | Positive |
| SP-D-003 | Hardcoded production secrets | Info | rejected | Tests only |
| SP-D-004 | Employee MCP → admin MCP escalation | Info | rejected | Badge rejected |

---

## 8. Per-finding detail

Each item: code path, exploitability, fix. Line numbers are from the audited tree.

### SP-A-001 — #258/#259 write policies may still be live (High, needs_validation)

**Path:** Stolen or legitimate tenant session JWT + `NEXT_PUBLIC_SUPABASE_ANON_KEY` → PostgREST `PATCH/POST/DELETE` on `approval_requests` / `orgs` / `credentials` / `employees` / … if the old `{public}` write policies still exist.

**Evidence:** Migration headers `supabase/migrations/20261004500000_tenant_tables_server_only_writes.sql:3-5` and `20261004600000:4-8` (“NOT APPLIED BY THE PR”). PR #258/#259 titles and bodies repeat 未適用. Repo `schema.sql` **does** include the drops — a **new** project created from current `schema.sql` is fine. An **existing** production DB that never ran these files is not.

**Exploitability:** High **if unapplied** (any member can self-approve; admin can rewrite plan and credentials). Zero **if applied**. Cannot be closed from git alone.

**Fix:** Run the read-only queries in `NEEDS-VALIDATION.md` §A. If policies remain, apply `20261004500000` → `20261004600000` → `20261004800000` as a reviewed change window. Do not use the ROLLBACK blocks in those files except as a documented revert.

### SP-B-001 — Global Telegram empty allowlist + unscoped lookup (High, needs_validation)

**Path:** `POST /api/webhooks/telegram` (`TELEGRAM_WEBHOOK_SECRET` required, `route.ts:351-364`) → `handleCallback` → `getApprovalByTelegramRef(match[2])` without org → `isAllowedUser` true when allowlist empty → approve/reject.

**Exploitability:** Requires (1) global bot still registered, (2) empty or missing `TELEGRAM_ALLOWED_USER_IDS`, (3) a valid `telegram_ref` (48-bit; leak from a message or brute). Tenant `[ref]` routes are scoped.

**Fix:** Fail closed if allowlist empty in production. Always pass `orgId` (bind the global chat to one org). Prefer per-tenant Telegram channels only (`docs/multi-tenant-org-boundary-audit.md` M1/M2, `docs/production-cutover.md`).

### SP-B-013 — DEMO mode on a public host (High, needs_validation)

**Path:** Placeholder Supabase keys → `isDemoMode()` (`lib/mode.ts:24-32`) → middleware pass-through (`middleware.ts`) → `requireCapability` impersonation (`lib/team/demo-actor.ts:76-78`).

**Exploitability:** Anyone who can reach the host is effectively owner of the demo org.

**Fix:** `GET /api/health` must return `runtimeMode: "production"` and `demo: false` on every public hostname (`docs/production-cutover.md`). Alert if any of the three Supabase keys matches `replace_me` / placeholder.

### SP-C-001 — Legacy webhook SSRF (Medium, confirmed) — flag OFF

**Path:** Org admin sets `wakeWebhookUrl` / `callbackUrl` → Staffpass `fetch`s it on wake / `approval.resolved` with `withLinkLocalGuard` only. Metadata IPs blocked; `http://127.0.0.1:8200` and RFC1918 are not.

**Exploitability:** Requires a tenant admin (or stolen dashboard session). Scans internal HTTP from the Vercel/runtime egress path.

**Fix:** Set `WEBHOOK_HARDENING_ENABLED=1` (runbook `docs/runbooks/webhook-hardening-d9-rollout-20261005.md`). Validate URLs at save time with the same rules as `validateCallbackUrl`.

### SP-C-003 / SP-C-004 / SP-C-005 — Rate-limit flags default OFF (Medium, confirmed)

**Paths:**

- Signup: Turnstile remains; Layer 2 DB limits and disposable-domain checks do not (`lib/feature-flags.ts:468-527`, `lib/signup/attempts.ts`).
- Login: `app/api/auth/login/route.ts:107-138` skips app buckets unless `LOGIN_RATE_LIMIT_ENABLED`.
- LP inquiry: `app/api/lp/ai-employee/inquiry/route.ts:77-107` skips rate/Turnstile when both LP flags are unset; mail still goes to `AI_EMP_INQUIRY_NOTIFY_EMAIL`.

**Exploitability:** Credential stuffing and signup/LP spam at scale. Not a data-exfil bug.

**Fix:** Enable `LOGIN_RATE_LIMIT_ENABLED`, the #211 trio (after `signup_attempts` migration), `LP_INQUIRY_BOT_PROTECTION_ENABLED` + `LP_INQUIRY_RATE_LIMIT_ENABLED` + `IP_HASH_KEY`. Consider `SIGNUP_RATE_LIMIT_REQUIRED_ENABLED` if welcome-mail cost is a concern.

### SP-A-002 — Decision RLS uses `members` (Medium, confirmed)

**Path:** `20260930000200_decision_workflow.sql:176-244`. No `members` table. Feature flag default OFF; no app `.from('decision_*')`.

**Exploitability:** Low today (policy errors fail closed). High if someone creates a `members` table or enables the feature against PostgREST.

**Fix:** Point policies at `org_members`, or drop them and apply the server-only revoke pattern. Do not enable `P1_DECISION_WORKFLOW_ENABLED` until this is fixed.

### SP-B-006 — statusToken bearer (Medium, confirmed)

**Path:** `GET /api/approvals/status?id=&token=` → `getApprovalStatusByToken` (`lib/data/approvals.ts:181-205`) loads by id (service role, no org filter) then timing-safe hash compare. Token is `st_` + 24 bytes (`lib/approvals/tokens.ts:5-7`).

**Exploitability:** Leak of `pollUrl` (MCP/gateway `needs_approval`) reads that ticket across tenants. Entropy is adequate if URLs are not logged.

**Fix:** Never log poll URLs (already in `docs/security-release-20260916.md`). Optional org claim inside the token. Short TTL.

### SP-B-014 / SP-B-015 — Slack / admin-class approval flags OFF (Medium, confirmed)

When `SLACK_APPROVAL_STRICT` is OFF, Slack button presses do not require `allowedUserIds` or a voter-binding row (`lib/feature-flags.ts:29-42`). When `ADMIN_APPROVER_POLICY_REQUIRED` is OFF, admin-class tickets accept any single approver (`lib/feature-flags.ts:12-27`).

**Fix:** Enable both in production after the existing rollout docs; keep fail-closed if policy missing.

### SP-C-012 / SP-C-015 — Reply / prompt injection (Medium, confirmed)

`P0_REPLY_POLICY_ENHANCED` OFF → existing reply policy, **no** audience recipient validation (`lib/feature-flags.ts:121-135`). Channel text is untrusted input to the external model. Approvals and the secret detector are the real control.

**Fix:** Enable enhanced reply policy for tenants that post/mail externally. Treat wake payloads as untrusted in employee instructions (`docs/guides/instructions-design.md`).

### Remaining Low / Info

See the table in §7 and `findings.json`. Highlights:

- **SP-B-004:** `POST /api/employees/interpret` (`app/api/employees/interpret/route.ts:12-26`) — no auth, 1500-char cap, secret-shaped input rejected. Bind to session or rate-limit.
- **SP-B-005:** `GET /api/health` (`app/api/health/route.ts:11-20`) — cutover probe by design; accept or hide Stripe/Resend booleans.
- **SP-B-008:** `app/api/cron/oauth-purge/route.ts:18-21` uses `!==` instead of `rejectUnauthorizedCron` (`lib/security/cron-secret.ts`).
- **SP-C-007:** Signup 409 `email_exists` (`app/api/auth/signup/route.ts:392-406`) is **intentionally unchanged** even when `AUTH_ENUMERATION_HARDENING_ENABLED` is ON (`lib/feature-flags.ts:1071-1075`).
- **SP-C-010:** Email/trial 404 — **positive**, keep the test.
- **SP-D-003 / SP-D-004:** Rejected (no hardcoded prod secrets; no employee→admin MCP path).

---

## 9. What looks OK (brief)

- Dashboard employee/approval/hold/team/billing routes scope by session `orgId`.
- Gateway invoke binds org from the badge; `session_org_mismatch` fail-closed (`lib/gateway/invoke.ts`).
- Admin MCP rejects `gb_emp_`.
- Cron helper is timing-safe and rejects `replace_me` placeholders (except `oauth-purge`).
- Slack wake H1 (`slack_team_id` filter) documented fixed (`docs/multi-tenant-org-boundary-audit.md`).
- Login `next` sanitized (`lib/auth/safe-next.ts`).
- Hold routes: same-origin + JSON Content-Type (`lib/safety/hold-route.ts`).
- Notification channel secrets decrypted only after `id AND org_id`.
- Tests: `lib/data/p0-auth-idor.test.ts`, `lib/auth/p0-unauth-401.test.ts`, `tests/security/*flags-off*`, `lib/security/tenant-*-write-paths.test.ts`.

---

## 10. Recommended production hardening order

1. Prove #258 / #259 / #048 SQL is applied (or apply it).  
2. `GET /api/health` → `production` on every public host.  
3. `WEBHOOK_HARDENING_ENABLED=1`.  
4. Non-empty `TELEGRAM_ALLOWED_USER_IDS` or disable the global bot.  
5. `LOGIN_RATE_LIMIT_ENABLED` + #211 signup flags + LP bot/rate + `IP_HASH_KEY`.  
6. `SLACK_APPROVAL_STRICT` + `ADMIN_APPROVER_POLICY_REQUIRED`.  
7. `MCP_AUTH_FAILURE_AUDIT_ENABLED` + `HOLD_DENIAL_AUDIT_ENABLED`.  
8. `P0_REPLY_POLICY_ENHANCED` for tenants that send externally.

Do not enable `P1_DECISION_WORKFLOW_ENABLED` until SP-A-002 is fixed.

---

## 11. Limitations

- No live PostgREST, Vercel env, or DNS queries were executed (read-only repo).  
- Service-role key compromise is a total database compromise; not separately ticketed.  
- Storage bucket ACLs and signed-URL TTL were not re-tested (open item in `docs/security-review-20260916.md` §未解決 4).  
- External employee runtimes (Grok Bot) are outside this repo.  
- Checklist source notes for the 250-item list were thin; see `QUARTERLY-OPS-CHECKLIST.md`.
