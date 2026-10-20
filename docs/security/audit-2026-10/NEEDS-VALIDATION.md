# Needs validation against production / runtime

Code review cannot close these. **Read-only only.** Do not run migrations, `DELETE`/`UPDATE`, or customer-facing sends. Use the Supabase SQL editor (or `psql`) as a role that can `SELECT` catalogs, and the Vercel / vendor consoles as a viewer.

Each item: why, exact check, pass criteria, related finding IDs.

---

## A. #258 / #259 / LP server-only SQL actually applied

**Why:** PRs #258 and #259 merged the SQL but said it was **not applied**. If the four write policies (and the phase-2 set) still exist, any tenant session JWT + anon key writes those tables via PostgREST.

**Finding:** `SP-A-001`

### A1. Schema migrations recorded

```sql
-- read-only
select version, name, inserted_at
from supabase_migrations.schema_migrations
where version in (
  '20261004500000',
  '20261004600000',
  '20261004800000'
)
order by version;
```

**Pass:** three rows present.  
**Fail:** any missing → treat #258/#259 as **unapplied**. Do not apply from this audit; file an ops change.

If the project was created from current `supabase/schema.sql` and does not use `schema_migrations` for those files, skip A1 and rely on A2–A4.

### A2. Forbidden write policies must be absent

```sql
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and policyname in (
    'approvals_write_member',
    'audit_insert_member',
    'orgs_update_admin',
    'subscriptions_write_admin',
    'credentials_write_admin',
    'org_admin_agents_write_admin',
    'employees_write_admin',
    'bindings_write_admin',
    'org_parties_write_admin',
    'org_channels_write_admin',
    'information_assets_write_admin',
    'notification_channels_write_admin',
    'conversation_adapters_write_admin',
    'sns_adapters_write_admin',
    'employee_slack_identities_write_admin',
    'org_ext_contract_pm_write_admin',
    'org_projects_write_admin',
    'audit_ext_card_insert_member',
    'gateway_write_admin',
    'agentmail_write_admin',
    'lp_handoffs_service_all',
    'lp_wake_webhook_configs_service_all',
    'lp_wake_webhook_events_service_all'
  )
order by tablename, policyname;
```

**Pass:** **0 rows**.  
**Fail:** any row → PostgREST write hole still open for that table.

Repo verification SQL (do not run writes): `supabase/verification/20261004500000_*`, `20261004600000_*`, `20261004800000_*`.

### A3. Write grants revoked on #258/#259 tables

```sql
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'orgs', 'subscriptions', 'audit_events', 'approval_requests',
    'credentials', 'org_admin_agents', 'employees', 'employee_bindings',
    'org_parties', 'org_channels', 'information_assets',
    'org_notification_channels', 'org_conversation_adapters', 'org_sns_adapters',
    'employee_slack_identities', 'org_external_contract_payment_methods',
    'org_projects', 'audit_external_contract_card_events',
    'gateway_links', 'agentmail_inboxes',
    'lp_handoffs', 'lp_wake_webhook_configs', 'lp_wake_webhook_events',
    'lp_inquiries', 'notification_outbox'
  )
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name, grantee, privilege_type;
```

**Pass:** **0 rows**.  
**Fail:** leftover default grants — a future permissive policy would reopen writes.

### A4. `credentials` not session-readable

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'credentials'
  and grantee in ('anon', 'authenticated');
```

**Pass:** no `SELECT` (or any) grant to `anon` / `authenticated`.

### A5. Optional PostgREST probe (no writes)

From a **non-production laptop**, using only the **anon** key and a **test-tenant** user JWT (never service_role):

```http
GET https://<PROJECT>.supabase.co/rest/v1/approval_requests?select=id&limit=1
apikey: <ANON>
Authorization: Bearer <TEST_USER_JWT>
```

**Pass:** `200` with only that user's org rows (SELECT policy), or `401`/`403`.  
Then **do not** send `POST`/`PATCH`/`DELETE` unless a dedicated staging project is used. If staging is available, a single `POST` to `approval_requests` must return `401`/`403`/`42501` (permission denied), not `201`.

---

## B. DEMO mode is not public

**Finding:** `SP-B-013`

```http
GET https://staffpass.sealith.com/api/health
GET https://grokbot-control-plane.vercel.app/api/health
```

**Pass:** `"runtimeMode":"production"` and `"demo":false` on every public hostname.  
**Fail:** `"demo":true` or `"runtimeMode":"demo"` — treat as an open control plane; rotate keys and fix env (see `docs/production-cutover.md`).

Also in Vercel → Project → Settings → Environment Variables (Production): none of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` may match `replace_me*`, `placeholder`, `your_project`, or `example.supabase.co`.

---

## C. Global Telegram pilot

**Finding:** `SP-B-001`

1. Vercel Production env (view only):
   - `TELEGRAM_BOT_TOKEN` set?  
   - `TELEGRAM_WEBHOOK_SECRET` set and not `replace_me*`?  
   - `TELEGRAM_ALLOWED_USER_IDS` **non-empty** (comma-separated numeric IDs)?  
   - `TELEGRAM_APPROVAL_CHAT_ID` set?
2. Telegram Bot API (read): `getWebhookInfo` for that bot — URL should be the tenant `[ref]` path if the global route is retired, or `/api/webhooks/telegram` only for the documented TOKYO307 pilot (`docs/production-cutover.md`, `docs/guides/telegram-approval.md`).
3. SQL (read-only):

```sql
select count(*) as pending_with_telegram_ref
from approval_requests
where status = 'pending'
  and telegram_ref is not null;
```

**Pass:** allowlist non-empty **or** global webhook unused (`getWebhookInfo.url` empty / tenant URL only).  
**Fail:** secret set + empty allowlist + pending `telegram_ref` rows → High finding is live.

---

## D. Feature-flag matrix (Production)

**Findings:** `SP-C-001`, `SP-C-003`–`SP-C-009`, `SP-C-012`, `SP-C-013`, `SP-B-014`, `SP-B-015`

In Vercel Production, record ON/OFF for:

| Variable | Safer production value (this audit) |
|----------|-------------------------------------|
| `WEBHOOK_HARDENING_ENABLED` | ON |
| `LOGIN_RATE_LIMIT_ENABLED` | ON |
| `SIGNUP_ATTEMPT_LOG_ENABLED` | ON (needs `signup_attempts` migration) |
| `SIGNUP_RATE_LIMIT_ENABLED` | ON |
| `SIGNUP_DOMAIN_CHECK_ENABLED` | ON |
| `SIGNUP_RATE_LIMIT_REQUIRED_ENABLED` | ON if welcome-mail abuse is a concern |
| `LP_INQUIRY_BOT_PROTECTION_ENABLED` | ON |
| `LP_INQUIRY_RATE_LIMIT_ENABLED` | ON |
| `IP_HASH_KEY` | set, ≥32 chars, not `replace_me` |
| `PASSWORD_RESET_TURNSTILE_ENABLED` | ON |
| `AUTH_ENUMERATION_HARDENING_ENABLED` | ON (does **not** hide signup 409) |
| `SLACK_APPROVAL_STRICT` | ON |
| `ADMIN_APPROVER_POLICY_REQUIRED` | ON |
| `P0_REPLY_POLICY_ENHANCED` | ON for sending tenants |
| `MCP_AUTH_FAILURE_AUDIT_ENABLED` | ON |
| `HOLD_DENIAL_AUDIT_ENABLED` | ON |
| `MCP_OAUTH_ENABLED` | match intended rollout |
| `MCP_OAUTH_ORG_ALLOWLIST_REQUIRED` | **must stay true** unless allowlist is non-empty |
| `MCP_OAUTH_ORG_ALLOWLIST` | non-empty if OAuth is ON |
| `MCP_OAUTH_DCR_ENABLED` | OFF unless DCR is intended |
| `P1_DECISION_WORKFLOW_ENABLED` | **OFF** until SP-A-002 is fixed |
| `LP_CHAT_ENABLED` / `LP_HANDOFF_ENABLED` / `LP_WAKE_WEBHOOK_ENABLED` | OFF unless launched |

**Pass:** recorded screenshot or CSV of Production env names (values redacted) attached to the quarterly ticket.  
**Fail:** `MCP_OAUTH_ORG_ALLOWLIST_REQUIRED=false` with empty allowlist (`SP-C-009`).

---

## E. Decision-workflow landmine

**Finding:** `SP-A-002`

```sql
select to_regclass('public.members') as members_table;
select tablename, policyname, qual, with_check
from pg_policies
where tablename like 'decision_%'
order by tablename, policyname;
```

**Pass:** `members_table` is `null` **and** `P1_DECISION_WORKFLOW_ENABLED` is OFF.  
**Fail:** a `members` table exists, or the flag is ON while policies still say `from members m`.

---

## F. `org_members` grants

**Finding:** `SP-A-003`

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name = 'org_members'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
```

**Pass (current design):** may be non-empty (RLS default-deny only). Record the result.  
**Hardening pass (recommended):** 0 rows after a future revoke migration.

Also:

```sql
select policyname, cmd
from pg_policies
where tablename = 'org_members';
```

**Pass:** SELECT-only policies; no `org_members_write_admin`.

---

## G. Cron secret and extra cron routes

**Finding:** `SP-C-014`, `SP-B-008`

1. Vercel Production: `CRON_SECRET` set, not `replace_me*`, length ≥ 32.  
2. Vercel → Crons: only the paths in `vercel.json`.  
3. Do **not** invoke cron routes from this audit. If a staging probe is required later, `Authorization: Bearer <wrong>` must return 401; missing secret on the server must return 503.

---

## H. Cookie flags (Supabase Auth)

**Why:** Route handlers do not override cookie `HttpOnly` / `Secure` / `SameSite`.

**Check:** Browser DevTools on `https://staffpass.sealith.com/login` after a test login (staging user): `sb-*-auth-token` (or current SSR cookie name) is `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`.

**Pass:** all three.  
**Fail:** readable from JS or missing `Secure` on HTTPS.

---

## I. Storage buckets and signed URLs

Open item from `docs/security-review-20260916.md` §未解決 4.

Supabase Dashboard → Storage (read):

```sql
select id, name, public
from storage.buckets
order by name;
```

**Pass:** no unexpected `public = true`. Approval-attachment buckets private. Signed URL TTL documented and ≤ 1 hour unless a written exception exists.

Do not list object contents of customer buckets in tickets.

---

## J. Email authentication for sealith.com

**Checklist:** `QUARTERLY-OPS-CHECKLIST.md` Q-07.

```text
dig TXT sealith.com +short
dig TXT resend._domainkey.sealith.com +short
dig TXT _dmarc.sealith.com +short
```

**Pass:** SPF includes Resend (or the current sending include); DKIM TXT present; DMARC `p=quarantine` or `p=reject` (not `p=none` without a written exception).  
Resend Dashboard → Domains: `sealith.com` verified.

---

## K. Spend / billing alerts exist

**Checklist:** Q-03. Viewer-only:

| Vendor | What to open | Pass |
|--------|--------------|------|
| Vercel | Team → Usage / Spend Management | Hard or soft cap + notify email |
| Supabase | Org → Billing | Budget alert |
| Resend | Usage | Daily/monthly cap or alert |
| Stripe | Billing / Radar / usage | Webhook endpoint healthy; no unbounded test-mode keys on prod |
| Twilio | Console usage triggers | Alert if voice is live; N/A if unused |
| xAI | Console usage / spend | Alert if used; N/A if unused |

Record “not in use” with a date rather than skipping the row.

---

## L. Audit tables receiving rows

**Findings:** `SP-C-013`; checklist Q-09.

```sql
select count(*) as audit_7d
from audit_events
where created_at > now() - interval '7 days';

select count(*) as mcp_fail_7d
from mcp_auth_failures
where created_at > now() - interval '7 days';
```

(Column names: confirm with `\d audit_events` / `\d mcp_auth_failures` if they differ.)

**Pass:** `audit_7d > 0` on a live tenant org. `mcp_fail_7d` may be 0; if `MCP_AUTH_FAILURE_AUDIT_ENABLED` is ON, a single staging 401 to `/api/mcp` should insert a row (do this only on staging).

**Do not** dump `metadata` JSON into tickets (may contain poll paths or PII). Count and action names only:

```sql
select action, count(*)
from audit_events
where created_at > now() - interval '7 days'
group by 1
order by 2 desc
limit 30;
```

---

## M. TLS / domain expiry

```text
echo | openssl s_client -servername staffpass.sealith.com -connect staffpass.sealith.com:443 2>/dev/null | openssl x509 -noout -dates -issuer
echo | openssl s_client -servername sealith.com -connect sealith.com:443 2>/dev/null | openssl x509 -noout -dates
```

**Pass:** `notAfter` ≥ 30 days out. Registrar + Cloudflare/Vercel domain expiry ≥ 30 days.

---

## N. Super-admin allowlist

Vercel Production (view): `SUPER_ADMIN_USER_IDS` / `SUPER_ADMIN_EMAILS` — compare to the current human list. `PLATFORM_OPS_ORG_ID` matches the intended platform org.

```sql
-- read-only: memberships of allowlisted auth users (fill UUIDs)
select om.org_id, om.role, om.status, om.email
from org_members om
where om.user_id in ('<uuid>', '<uuid>')
order by om.email, om.org_id;
```

**Pass:** every allowlisted person still employed; no leftover contractors.

---

## O. OAuth grant store (low)

**Finding:** `SP-O-001`

No HTTP route that calls `revokeGrant(id)` without `revokeEmployeeGrant` was found. Confirm in production logs that admin MCP / dashboard revoke always goes through `lib/mcp-oauth/grant-admin.ts`. No SQL change required for this check.

---

## What this audit will not do

- Apply #258/#259 or any other migration.  
- `DELETE` / `UPDATE` tenant rows.  
- Send mail, Slack, Telegram, or Stripe events.  
- Use `SUPABASE_SERVICE_ROLE_KEY` from this agent.  
- Contact customers.
