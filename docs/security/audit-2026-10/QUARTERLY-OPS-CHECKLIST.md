# Quarterly operational security checklist

**Cadence:** every calendar quarter (plus after a Sev-1).  
**Owner column:** fill a name/team; placeholders are intentional.  
**This document does not change runtime code.**

## Source of the item list

Attached notes (`uploads/source-250.md`) are **thin**: they cite [X/ghumare64 250-item SaaS/AI checklist](https://x.com/ghumare64/status/2111332908657148356) by number only (items 19, 35, 70–72, 116–117, 150–151, 155–158, 199–200, 201, 232–241, 243, 248, 249) and point at a 2026-10-20 Yasaka message for the full Japanese translation. The full 250 lines were **not** in the repo.

Items below are those numbers plus the usual operational controls a **code review cannot verify**, using general knowledge of that class of SaaS/AI checklist (identity, cloud, email auth, DR, IR, spend, model governance, compliance). Where Staffpass already has a runbook, the path is linked.

Related audit docs: [REPORT.md](./REPORT.md), [NEEDS-VALIDATION.md](./NEEDS-VALIDATION.md).

---

## How to use

1. Copy the table for the quarter (`YYYY-QN`).  
2. Each row: owner executes **How to check**, stores **Evidence**, marks **Pass/Fail**.  
3. Failures become tickets; do not “pass with comment” on backup restore, DMARC `p=none`, or missing spend caps.  
4. Keep evidence in the ops drive (redact secrets). Retention: 8 quarters.

---

## Q-01 — Backup restore test (checklist ~70–72)

| Field | Content |
|-------|---------|
| **Owner** | _Platform / DBA_ |
| **How to check** | In **staging** (never customer prod): pick a Supabase PITR timestamp ≥ 24h old **or** a logical backup. Restore to a throwaway project. `SELECT count(*) FROM orgs; SELECT count(*) FROM approval_requests;` and log in as one staging user. Confirm RLS still enabled (`SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r' AND NOT relrowsecurity;`). Document time-to-restore. |
| **Evidence** | Restore project URL (staging), start/end timestamps, row-count screenshot, “RLS still on” query result, operator name. |
| **Pass** | Restore completed; app can log in against the copy; **zero** tables with RLS off; measured restore time ≤ agreed RTO (Q-02). |
| **Repo map** | Placeholders only: `docs/legal/data-handling-summary.md` §5 (`{{BACKUP_RETENTION}}`). **No** DR runbook — this row *is* the procedure until one exists. Cutover SQL order: `docs/production-cutover.md`. |

## Q-02 — RTO / RPO (checklist ~150–151)

| Field | Content |
|-------|---------|
| **Owner** | _Engineering lead + Yasaka_ |
| **How to check** | Write (or reconfirm) numeric targets: RPO (e.g. Supabase PITR window, currently typically ≤ 7 days on Pro — **confirm plan**), RTO (hours to serving `/api/health` `production` after region loss). Compare to last Q-01 measured restore. Confirm Vercel redeploy from `main` works (`docs/production-cutover.md` step 6). |
| **Evidence** | Signed one-pager: RPO minutes/hours, RTO hours, last restore measurement, hosting plan (Supabase PITR yes/no). |
| **Pass** | Targets written and last restore ≤ RTO; PITR or daily backups cover RPO; if on a plan without PITR, a dated exception exists. |
| **Repo map** | `docs/production-cutover.md`, `docs/legal/data-handling-summary.md`. Gap: no RTO/RPO doc in repo. |

## Q-03 — Billing / spend alerts (checklist ~201)

| Vendor | Owner | How to check | Evidence | Pass |
|--------|-------|--------------|----------|------|
| **Vercel** | _Platform_ | Team → Usage / Spend Management. Confirm hard or soft cap and notify emails. Include Pro/Enterprise seat and function-GB-hours. | Screenshot of cap + recipients (redact amounts if needed). | Cap set; at least one human mailbox. |
| **Supabase** | _Platform_ | Org Billing + usage (DB size, egress, MAU). Budget alert on. | Screenshot. | Alert on; project not on a forgotten free-tier surprise. |
| **Resend** | _Comms_ | Usage + domain. Daily send cap or alert. Compare to `docs/mail-policy.md` live-send flags. | Screenshot + last 30d send volume. | Cap or alert; no unexplained spike. |
| **Twilio** | _Voice (if live)_ | Console usage triggers. If voice is **not** shipped, mark N/A with date (`docs/design/voice-realtime-20261015.md`). | Screenshot or N/A note. | Alert if live; N/A documented if unused. |
| **xAI** | _AI spend_ | Console spend / `docs/design/ai-employee-roi-20261019.md` (Vercel AI Gateway / xAI). | Screenshot or N/A. | Alert if keys exist in Production. |
| **Stripe** | _Billing_ | Dashboard: webhook `https://…/api/webhooks/stripe` healthy; no prod charges from test keys; Radar/alerts as used. Walk `docs/stripe-billing-notes.md` and `docs/audits/card-setup-2026-09-28.md`. | Webhook delivery log (last 7d) + mode screenshot. | Endpoint `enabled`; signing secret not `replace_me`; test-mode secret absent from Production env. |

Product-level employee spend gates (`maxPerOrderJpy`, `docs/spend-delegation.md`) are **not** a substitute for vendor caps.

## Q-04 — API key / secret rotation (checklist ~19)

| Field | Content |
|-------|---------|
| **Owner** | _Security + Platform_ |
| **How to check** | Inventory Production secrets vs `.env.example`. Rotate any secret older than the policy (suggested: 90 days for `CRON_SECRET`, Stripe webhook secret, `TELEGRAM_WEBHOOK_SECRET`, Slack signing secrets, `MCP_OAUTH_STATE_SECRET`; 180 days for `NOTIFICATION_CONFIG_ENCRYPTION_KEY` with dual-key overlap). Employee badges: use product rotate (`docs/agent-credential-guide.md`, `docs/binding-lifeline.md` `POST …/rotate`), not a shared static `gb_emp_`. Confirm `CREDENTIAL_EXPIRY_NOTICE_ENABLED` intent. Slack token rotation notes: `docs/p0-user-mention-ingress-design-20260919.md`. OAuth revoke on rotate: `docs/runbooks/mcp-oauth-rollout-20261003.md`. |
| **Evidence** | Dated inventory (name, last-rotated, next-due). No secret values. |
| **Pass** | Every Production secret has a last-rotated date; none past due without a ticket; service_role was rotated or explicitly deferred with dual-key plan. |
| **Repo map** | Above plus `docs/production-cutover.md` (keys last), `docs/security-release-20260916.md` (no new signing keys in that release). **Gap:** no platform-secret calendar in repo — this row is it. |

## Q-05 — TLS and domain expiry (checklist ~35, ~116–117)

| Field | Content |
|-------|---------|
| **Owner** | _Platform_ |
| **How to check** | `openssl` dates for `staffpass.sealith.com`, `sealith.com`, and any `*.sealith.com` on Vercel/Cloudflare (`NEEDS-VALIDATION.md` §M). Registrar expiry. DNS: apex and `staffpass` A/CNAME still point at Vercel (`docs/production-cutover.md`, `docs/README.md`). |
| **Evidence** | `notAfter` dates, registrar expiry, DNS screenshot. |
| **Pass** | All certs and domains ≥ 30 days; auto-renew on; no leftover preview hostnames serving Production cookies. |
| **Repo map** | TLS/DNS for **outbound** webhooks: `docs/runbooks/webhook-hardening-d9-rollout-20261005.md`, `docs/mcp-events-approval-wake-20261005.md`. **Gap:** no inbound cert calendar. |

## Q-06 — DNS hygiene (checklist ~116–117)

| Field | Content |
|-------|---------|
| **Owner** | _Platform_ |
| **How to check** | Zone export. Remove stale TXT/MX/CNAME (old Vercel, old verification). Confirm no wildcard HTTPS to an unused host. CAA if used. |
| **Evidence** | Zone export (dated). |
| **Pass** | No records the team cannot explain; MX/SPF still match Q-07. |

## Q-07 — SPF / DKIM / DMARC for sealith.com (checklist ~240–241)

| Field | Content |
|-------|---------|
| **Owner** | _Comms + Platform_ |
| **How to check** | `dig TXT` on apex, `resend._domainkey` (or current selector), `_dmarc` (`NEEDS-VALIDATION.md` §J). Resend → Domains verified. Bounce/complaint: Resend webhooks or suppression list reviewed. Sending flags: `docs/mail-policy.md` (`MAIL_UNVERIFIED_FROM_ENABLED` should stay OFF unless a written exception). From-address alignment with `EMAIL_FROM`. |
| **Evidence** | dig output, Resend domain screenshot, bounce rate 30d. |
| **Pass** | SPF includes current sender only; DKIM valid; DMARC `p=quarantine` or `p=reject`; alignment on `sealith.com` (or documented subdomain). `p=none` is a **fail** unless a dated exception exists. |
| **Repo map** | `docs/mail-policy.md`, `docs/production-cutover.md` (Resend ドメイン). **Gap:** no SPF/DKIM/DMARC runbook. |

## Q-08 — Incident response runbook (checklist ~155–158)

| Field | Content |
|-------|---------|
| **Owner** | _Yasaka + on-call rotation_ |
| **How to check** | Tabletop 60–90 min: (a) leaked `gb_emp_`, (b) leaked service_role, (c) approval sent to the wrong Slack workspace, (d) Resend domain disabled. Confirm: severity defs, commander, customer-notice path (`docs/legal/data-handling-summary.md` §6 placeholder), rollback (`docs/security-release-20260916.md`), hold/stop (`docs/qa/org-hold-retest-tokyo307-20261016.md`). Postmortem template used for any Sev-1/2 this quarter (`docs/comm-reply-dedup.md` is the example incident write-up). |
| **Evidence** | Dated tabletop notes, attendance, one filled postmortem or “no Sev-1/2 this quarter.” |
| **Pass** | Named on-call; runbook reachable without the repo being up; last tabletop ≤ 100 days; customer-notice SLA written. |
| **Repo map** | Feature runbooks: `docs/guides/approval-loop-runbook.md`, `docs/approval-delivery-failure-alert.md`, `docs/runbooks/*`. **Gap:** no central IR / on-call / postmortem program doc. |

## Q-09 — Audit log review (checklist ~232–238)

| Field | Content |
|-------|---------|
| **Owner** | _Security_ |
| **How to check** | Read-only SQL in `NEEDS-VALIDATION.md` §L. Sample 10 `audit_events` admin-class actions (`docs/design/ai-employee-roi-20261019.md` inventory). Review `mcp_auth_failures` for spraying (same IP hash / fingerprint). UI: `/app/audit` for one tenant (own org only). Tokyo307 backfill playbook: `docs/ops/tokyo307-retire-audit-backfill.md`. SQL helpers: `docs/sql/verify-audit-sql.sh`, `docs/sql/h5-admin-mcp-secret-arg-inventory-20261012.sql`. Confirm `MCP_AUTH_FAILURE_AUDIT_ENABLED` (this audit: prefer ON). |
| **Evidence** | Query result counts (no raw metadata), list of sampled `action` values, tickets for anomalies. |
| **Pass** | `audit_events` receiving rows; admin-class sample explained; MCP 401 spray investigated or absent; flag state recorded. |
| **Repo map** | Above + `docs/architecture.md`, `docs/multi-tenant-org-boundary-audit.md`. |

## Q-10 — Model version pinning (checklist ~249)

| Field | Content |
|-------|---------|
| **Owner** | _AI + LP_ |
| **How to check** | Production env: `OPENAI_*` / gateway model IDs actually used by `lib/lp/chat-turn.ts` and any employee runtime. Confirm they are **pinned** (no `gpt-4o-latest` floating aliases unless a dated exception). External Grok Bot / Cursor model is outside this repo — record the pin in the employee instructions or host config. ADR: `docs/lp/adr-0001-lp-ai-chat-and-handoff.md`. ROI notes: `docs/design/ai-employee-roi-20261019.md`. |
| **Evidence** | Env names + model IDs (no API keys), date pinned. |
| **Pass** | Every production LLM call has an explicit model ID; change requires a ticket. |
| **Repo map** | ADR + ROI doc. **Gap:** no production model-pin runbook. |

## Q-11 — Evals (checklist ~248)

| Field | Content |
|-------|---------|
| **Owner** | _AI + LP_ |
| **How to check** | Run `scripts/lp-chat-eval.ts` against **staging** (real OpenAI, no prod writes — follow the script header). Compare transcripts to last quarter. If `LP_CHAT_ENABLED` is OFF in production, still run evals before any ON. Employee-tool evals: existing `*.test.ts` under `lib/mcp`, `lib/gateway` (CI). |
| **Evidence** | Eval command, model IDs, pass/fail summary, transcript path (no customer PII). |
| **Pass** | Eval ran this quarter; no new high-severity policy-bypass in transcripts; CI security tests green on `main`. |
| **Repo map** | `scripts/lp-chat-eval.ts`, `docs/lp/adr-0001-lp-ai-chat-and-handoff.md`. **Gap:** no CI job doc for evals. |

## Q-12 — Public buckets / signed URLs (checklist ~199–200)

| Field | Content |
|-------|---------|
| **Owner** | _Platform_ |
| **How to check** | `NEEDS-VALIDATION.md` §I. Re-read `docs/security-release-20260916.md` Storage preflight and `docs/slack-file-upload-egress.md`. Mail must not fetch arbitrary `fileRef` HTTPS (`docs/mail-policy.md`). |
| **Evidence** | `storage.buckets` query (name + public flag only). |
| **Pass** | No unexpected public buckets; signed URL TTL ≤ policy. |

## Q-13 — Bot protection (checklist ~243)

| Field | Content |
|-------|---------|
| **Owner** | _Platform + LP_ |
| **How to check** | Production flags: `LP_INQUIRY_BOT_PROTECTION_ENABLED`, `LP_INQUIRY_RATE_LIMIT_ENABLED`, `PASSWORD_RESET_TURNSTILE_ENABLED`, `SUPABASE_AUTH_CAPTCHA_ENABLED`, signup Turnstile (unflagged, fail-closed). Turnstile site/secret present. Review 30d signup and `/api/lp/ai-employee/inquiry` 429/turnstile_failed rates. ADR: `docs/lp/adr-0001-lp-ai-chat-and-handoff.md`. |
| **Evidence** | Flag matrix (Q + `NEEDS-VALIDATION.md` §D), Turnstile dashboard screenshot. |
| **Pass** | Inquiry and signup cannot be submitted without Turnstile on Production; rate-limit flags ON or a dated exception. |

## Q-14 — GDPR / PII / residency / SOC2 / cookies / licenses (checklist ~232–239)

| Field | Content |
|-------|---------|
| **Owner** | _Legal + Yasaka_ |
| **How to check** | Walk `docs/legal/data-handling-summary.md` and `docs/legal/README.md` template vars (`{{INFRASTRUCTURE_REGION_NOTE}}`, `{{BACKUP_RETENTION}}`). Confirm subprocessors (Vercel, Supabase, Resend, Stripe, Slack, OpenAI/xAI as used) still match the customer-facing list (`docs/internal-share/04-sales-security-faq.md`). Cookie banner / auth cookies: Q cookie check in `NEEDS-VALIDATION.md` §H. License: `package.json` / lockfile audit (`npm/pnpm audit` or equivalent) — no surprise copyleft in the browser bundle. SOC2: record “not attested” or current report date. |
| **Evidence** | Updated subprocessor list, region note, license scan summary. |
| **Pass** | Templates no longer contain unfilled `{{ }}` in any **customer-facing** publication; subprocessors current; license scan clean or waived. |
| **Repo map** | Legal templates + sales FAQ. **Gap:** no DPIA / DSR / SOC2 control map. |

## Q-15 — Super-admin and platform-ops allowlist

| Field | Content |
|-------|---------|
| **Owner** | _Yasaka_ |
| **How to check** | `NEEDS-VALIDATION.md` §N. `docs/admin-orgs-create-20260915.md` / `docs/admin-proxy-approve-20260915.md` still match who may proxy-approve. |
| **Evidence** | Allowlist names (no tokens). |
| **Pass** | Every ID/email is a current operator; contractors removed within 7 days of exit. |

## Q-16 — #258 / #259 RLS still applied

| Field | Content |
|-------|---------|
| **Owner** | _Platform_ |
| **How to check** | Repeat `NEEDS-VALIDATION.md` §A each quarter (policies can be re-created by a well-meant SQL snippet). |
| **Evidence** | `pg_policies` empty-set screenshot for the forbidden names. |
| **Pass** | A2 and A3 still 0 rows. |

## Q-17 — Webhook hardening and outbound SSRF

| Field | Content |
|-------|---------|
| **Owner** | _Platform_ |
| **How to check** | Production `WEBHOOK_HARDENING_ENABLED=1`. Follow `docs/runbooks/webhook-hardening-d9-rollout-20261005.md`. Spot-check one employee `callbackUrl` / wake URL is `https` + public. |
| **Evidence** | Flag value + runbook step sign-off. |
| **Pass** | Flag ON, or a dated exception with compensating control (no tenant-set URLs). |

---

## Quarter sign-off

| Field | Value |
|-------|-------|
| Quarter | _YYYY-QN_ |
| Completed on | |
| Completed by | |
| Fails opened (ticket IDs) | |
| Next due | |

Attach this table plus evidence links to the ops ticket. Do not commit secrets or customer PII into the repo.
