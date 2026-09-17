# Spec: Staffpass Slack Bot-install dedicated callback

**GO:** 2026-09-17 八坂  
**Repo:** pacifico-1106/grokbot-control-plane  
**Skill:** staffpass-slack-bot-install-callback  
**Security:** guidance mode (tenant isolation, secret handling, always_human for adapter write)

## Problem
Public Distribution / Add-to-Slack uses the same `redirect_uri` as employee Identity OAuth. Without signed employee state, callback → `/app/employees?slack=error` before `oauth.v2.access`, so bot `xoxb` is never captured. Tenant admins cannot be Collaborators on the 307-owned app without joining 307 Slack (billing/boundary).

## Goal
Tenant admin (logged into Staffpass for their org) completes Slack Install for **their** workspace and gets conversation-adapter bot token registered (or one-time copy), without 307 Collaborators.

## Requirements
1. **Separate routes** from employee Identity OAuth (`/api/slack/oauth/start` + existing callback that binds `employee_slack_identities`).
   - e.g. `/api/slack/bot-install/start` and `/api/slack/bot-install/callback`
2. **Start** (org session required, owner/admin):
   - Signed state: `{ orgId, nonce, purpose: "bot_install" }` + httpOnly cookie
   - Redirect to Slack authorize with **bot scopes** matching production app (see `docs/staffpass-slack-distribute.md`):  
     `im:write,app_mentions:read,channels:history,groups:history,im:history,chat:write`  
   - Prefer bot-only install; do not require user_scope for this flow (or document if Slack app forces both).
3. **Callback**:
   - Verify state/cookie (fail → dedicated error page, not employee list).
   - `oauth.v2.access` with same client_id/secret; require `access_token` bot (`xoxb-`).
   - `auth.test` → team_id / team name.
   - **Persist:** register/update org conversation adapter (enabled) with encrypted bot token — same store as dashboard / `setup.slackAdapter.setBotToken`. Prefer **always_human approval** if that matches existing adapter write policy; otherwise match current dashboard security model and document.
   - Never log or return full token in HTML after first display; if one-time display, clear after copy.
4. **Success UI** (Staffpass, org-scoped): team name, adapter enabled, next steps (invite bot to channels; classify). Japanese copy.
5. **Dashboard entry:** Settings 「つながり → チャンネルに書き込む」に「Slack ワークスペースにインストール」ボタン → start URL. getting-started / docs/mcp or slack distribute doc update: Install ≠ employee Authorize; write=user / listen=app.
6. **Slack app config note** (ops): redirect_uri allowlist must include new callback URL alongside existing identity callback.
7. **Tests:** state missing → error page; happy path exchanges code and upserts adapter (demo or mocked Slack); employee Identity flow unchanged (regression).
8. **Security guidance:** tenant isolation (orgId from state only); no cross-org token write; secrets encrypted at rest as today; SSRF N/A; fail-closed on bad state.

## Out of scope
- Connect guest identity mapping (separate gap).
- Changing posting_as model.
- Marketplace approval.

## Done when
- Draft PR: new bot-install start/callback + UI entry + docs; employee OAuth regression green; tests pass; handoff for Slack redirect_uri allowlist + Miraishachu e2e after merge.
