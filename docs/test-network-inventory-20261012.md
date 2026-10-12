# Test files that tried real network (2026-10-12)

Measured on main `6ba9d83` with a diagnostic preload. It refused every network call and recorded the host, but did NOT scrub env, so it shows what each file tries when the variable is present. Each of the 499 `*.test.ts` files (lib, app, tests) ran as its own direct `bun test <file>`. Values were always fake, so nothing could leave.

- **Run A: box env.** Fake values for the variable names actually set in the box env (`LP_HANDOFF_NOTIFY_SLACK_WEBHOOK`, `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SLACK_SHARED_APPROVAL_*`, `TOMORI_WAKE_WEBHOOK_*`, `OPENAI_API_KEY`, `TURNSTILE_SECRET_KEY`, `GOOGLE_OAUTH_*`, `TWOCAPTCHA_API_KEY`, `VERCEL_TOKEN`). This is what a direct `bun test` on the box did before this PR.
- **Run B: everything.** Run A plus fake `RESEND_API_KEY`, the notify emails, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_APPROVAL_CHAT_ID`, Slack secrets, Upstash/KV, Sealith, the approval demo store, and GitHub tokens.

Legend: **SLACK** = could post to Slack, **EMAIL** = could send email (Resend), **TELEGRAM** = could send a Telegram message, other = data-store or DNS only.

## Run A (box env)

| file | host × calls | could notify? |
|---|---|---|
| `lib/mcp-oauth/__tests__/cimd-ssrf.test.ts` | rebind.attacker.example ×1 | no: a raw socket to the test's own 127.0.0.1 server, through a pinned lookup (no DNS); now explicitly allowed (loopback only) |

No file reached `hooks.slack.com` or any mail host from the box env on main. The Slack posts seen on 10/12 came from `lib/safety/hold-actions.test.ts` on #349's branch (not on main), run as a direct `bun test` (#349's own note: 22 posts per run on its old code).

## Run B (every notify / credential variable present)

| file | host × calls | could notify? |
|---|---|---|
| `lib/admin-mcp/allowed-accounts-tools.test.ts` | api.resend.com ×19, api.telegram.org ×17, redis.example.invalid ×154 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/channel-ledger-tools.test.ts` | api.resend.com ×5, api.telegram.org ×3, redis.example.invalid ×13 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/credential-reissue-tool.test.ts` | api.resend.com ×13, api.telegram.org ×11, redis.example.invalid ×107 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/directory-remove-tools.test.ts` | api.resend.com ×27, api.telegram.org ×25, redis.example.invalid ×203 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/orgs-create.test.ts` | api.resend.com ×7, api.telegram.org ×5, redis.example.invalid ×46 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/orgs-issue-admin-credential.test.ts` | api.resend.com ×7, api.telegram.org ×5, redis.example.invalid ×49 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/policy-patch-cas-merge.test.ts` | api.resend.com ×13, api.telegram.org ×11, redis.example.invalid ×127 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/policy-patch-hardening.test.ts` | api.resend.com ×24, api.telegram.org ×22, redis.example.invalid ×353 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/promote-owner.test.ts` | api.resend.com ×17, redis.example.invalid ×108 | **EMAIL** |
| `lib/admin-mcp/queue-secret-gate.test.ts` | api.resend.com ×6, api.telegram.org ×4, redis.example.invalid ×8 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/security-integration.test.ts` | api.resend.com ×5, api.telegram.org ×3, redis.example.invalid ×25 | **EMAIL**, **TELEGRAM** |
| `lib/admin-mcp/self-approval.test.ts` | redis.example.invalid ×7 | no (data store / DNS only) |
| `lib/admin/proxy-approve.test.ts` | api.resend.com ×8, redis.example.invalid ×70 | **EMAIL** |
| `lib/approval-workflow/admin.test.ts` | api.resend.com ×4, api.telegram.org ×1, redis.example.invalid ×54 | **EMAIL**, **TELEGRAM** |
| `lib/approval-workflow/resolve.test.ts` | redis.example.invalid ×125 | no (data store / DNS only) |
| `lib/approvals/approval-card-attachment.test.ts` | api.resend.com ×13, api.telegram.org ×11, redis.example.invalid ×37 | **EMAIL**, **TELEGRAM** |
| `lib/approvals/approval-web-attachment.test.ts` | api.resend.com ×9, api.telegram.org ×7, redis.example.invalid ×23 | **EMAIL**, **TELEGRAM** |
| `lib/approvals/attachment-retry-cap-reset.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×2 | **EMAIL**, **TELEGRAM** |
| `lib/approvals/fulfill.test.ts` | api.resend.com ×23, api.telegram.org ×21, redis.example.invalid ×63 | **EMAIL**, **TELEGRAM** |
| `lib/approvals/mail-approval-card-cc-bcc.test.ts` | api.resend.com ×8, api.telegram.org ×6, redis.example.invalid ×18 | **EMAIL**, **TELEGRAM** |
| `lib/approvals/notify.test.ts` | redis.example.invalid ×12 | no (data store / DNS only) |
| `lib/approver-authority/context-cas.test.ts` | redis.example.invalid ×157 | no (data store / DNS only) |
| `lib/approver-authority/filing-context.test.ts` | redis.example.invalid ×83 | no (data store / DNS only) |
| `lib/approver-authority/flow.test.ts` | api.resend.com ×2, redis.example.invalid ×163 | **EMAIL** |
| `lib/approver-authority/operator-only-tools.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×18 | **EMAIL**, **TELEGRAM** |
| `lib/approver-authority/policy-money-limits.test.ts` | redis.example.invalid ×30 | no (data store / DNS only) |
| `lib/approver-authority/policy-patch-omitted-limits.test.ts` | redis.example.invalid ×49 | no (data store / DNS only) |
| `lib/approver-authority/review-20261009.test.ts` | redis.example.invalid ×54 | no (data store / DNS only) |
| `lib/auth/p0-unauth-401.test.ts` | redis.example.invalid ×1 | no (data store / DNS only) |
| `lib/channel-classify/backfill.test.ts` | redis.example.invalid ×5 | no (data store / DNS only) |
| `lib/channel-classify/hardening-h1-caps.test.ts` | redis.example.invalid ×24 | no (data store / DNS only) |
| `lib/channel-classify/hardening-n3-no-approver.test.ts` | redis.example.invalid ×3 | no (data store / DNS only) |
| `lib/channel-classify/hardening-n4-backfill-pacing.test.ts` | redis.example.invalid ×21 | no (data store / DNS only) |
| `lib/channel-classify/hardening-security.test.ts` | redis.example.invalid ×7 | no (data store / DNS only) |
| `lib/channel-classify/ingress-wiring.test.ts` | redis.example.invalid ×17 | no (data store / DNS only) |
| `lib/channel-classify/join-flow.test.ts` | redis.example.invalid ×60 | no (data store / DNS only) |
| `lib/channel-classify/preflag-280-binding-unverified.test.ts` | redis.example.invalid ×6 | no (data store / DNS only) |
| `lib/channel-classify/preflag-280-member-active-n3-cap.test.ts` | redis.example.invalid ×6 | no (data store / DNS only) |
| `lib/channel-classify/stuck-notify.test.ts` | redis.example.invalid ×9 | no (data store / DNS only) |
| `lib/config-change-request/channel-remove-audience.test.ts` | redis.example.invalid ×22 | no (data store / DNS only) |
| `lib/config-change-request/config-change-request.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×62 | **EMAIL**, **TELEGRAM** |
| `lib/data/p0-auth-idor.test.ts` | redis.example.invalid ×13 | no (data store / DNS only) |
| `lib/employees/approval-notify-email.test.ts` | api.telegram.org ×1, redis.example.invalid ×5 | **TELEGRAM** |
| `lib/employees/credential-reissue-atomic.test.ts` | api.resend.com ×6, api.telegram.org ×4, redis.example.invalid ×58 | **EMAIL**, **TELEGRAM** |
| `lib/employees/credential-ttl-flows.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×21 | **EMAIL**, **TELEGRAM** |
| `lib/employees/issue-refusals-both.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×8 | **EMAIL**, **TELEGRAM** |
| `lib/employees/project-access-org.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×20 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/conversation-org-binding.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×6 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-comm-reply-always-human.test.ts` | api.resend.com ×12, api.telegram.org ×12, redis.example.invalid ×68 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-egress.test.ts` | api.resend.com ×11, api.telegram.org ×9, redis.example.invalid ×30 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-mail-approved-pin.test.ts` | api.resend.com ×24, api.telegram.org ×22, redis.example.invalid ×165 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-mail-policy-followup.test.ts` | api.resend.com ×25, api.telegram.org ×23, redis.example.invalid ×126 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-mail-policy.test.ts` | api.resend.com ×6, api.telegram.org ×4, redis.example.invalid ×8 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-project-scope.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×2 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/invoke-sod.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×4 | **EMAIL**, **TELEGRAM** |
| `lib/gateway/session-badge-org.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×3 | **EMAIL**, **TELEGRAM** |
| `lib/mcp-events/resilience.test.ts` | redis.example.invalid ×105 | no (data store / DNS only) |
| `lib/mcp-events/service.test.ts` | redis.example.invalid ×105 | no (data store / DNS only) |
| `lib/mcp-oauth/__tests__/cimd-ssrf.test.ts` | rebind.attacker.example ×1 | no (data store / DNS only) |
| `lib/mcp/admin-tools.test.ts` | api.resend.com ×17, api.telegram.org ×15, redis.example.invalid ×32 | **EMAIL**, **TELEGRAM** |
| `lib/mcp/endpoint-handoff.issue-link.test.ts` | redis.example.invalid ×9 | no (data store / DNS only) |
| `lib/mcp/tools.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×18 | **EMAIL**, **TELEGRAM** |
| `lib/safety/hold-comm-delete.test.ts` | redis.example.invalid ×3 | no (data store / DNS only) |
| `lib/safety/hold-not-installed.test.ts` | api.resend.com ×1 | **EMAIL** |
| `lib/safety/hold-reinvoke.test.ts` | api.resend.com ×6, api.telegram.org ×4, redis.example.invalid ×37 | **EMAIL**, **TELEGRAM** |
| `lib/safety/hold.test.ts` | redis.example.invalid ×2 | no (data store / DNS only) |
| `lib/security/cron-secret-routes.test.ts` | redis.example.invalid ×1 | no (data store / DNS only) |
| `lib/security/secret-detection-paths.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×18 | **EMAIL**, **TELEGRAM** |
| `lib/security/secret-detector-date-prefix.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×10 | **EMAIL**, **TELEGRAM** |
| `lib/security/secret-detector-decode-followup.test.ts` | api.resend.com ×4, api.telegram.org ×2, redis.example.invalid ×10 | **EMAIL**, **TELEGRAM** |
| `lib/security/secret-detector-redos-caps.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×13 | **EMAIL**, **TELEGRAM** |
| `lib/stuck-watch/admin-stuck-watch.test.ts` | redis.example.invalid ×9 | no (data store / DNS only) |
| `lib/stuck-watch/audience-ledger.test.ts` | api.resend.com ×3, api.telegram.org ×1, redis.example.invalid ×2 | **EMAIL**, **TELEGRAM** |
| `lib/stuck-watch/employee-stuck-watch.test.ts` | redis.example.invalid ×9 | no (data store / DNS only) |
| `tests/security/p0-id-in-rp.test.ts` | api.resend.com ×1 | **EMAIL** |
| `tests/security/p0-known-gaps.test.ts` | redis.example.invalid ×16 | no (data store / DNS only) |

Totals for Run B: 76 files. 44 could send email (approval / admin / gateway notification mail through Resend) and 40 could send a Telegram approval message. None posts to Slack. The rest are Upstash rate-limit calls or the cimd DNS case.

## Why these tests are not changed to mock

Every Run B call is made only because a key or destination variable is present: `RESEND_API_KEY` → Resend instead of the `[resend:stub]` log; `TELEGRAM_BOT_TOKEN` → Telegram; `UPSTASH_*` → Upstash instead of the in-memory limiter. The preload now deletes those variables before any test module loads, so these code paths take their stub or demo branches, the same ones `npm test` has always used. A test that needs a key sets a fake one and mocks `fetch`.

Proof, after this PR: all 499 files run as a direct `bun test <file>` (bunfig preload, no `--preload` flag) with FAKE values for every variable above → **0 network attempts**, 0 refusals. The full `npm test` run → 0 refusals.

## Box runs before this PR (did anything real go out?)

- `npm test` (`scripts/test-local.mjs`) passes only PATH/TMPDIR plus the demo flags, and always preloaded the guard. Nothing from it.
- A direct `bun test` on main with the box env: no Slack / email / Telegram host in Run A. The only real traffic was DNS-free loopback.
- `RESEND_API_KEY` and `TELEGRAM_BOT_TOKEN` are not set in the box env, so no real email or Telegram message could have been sent from the box.
