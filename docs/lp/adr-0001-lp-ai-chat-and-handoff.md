# ADR LP-0001: LP AI consultation chat and human handoff

- Status: Accepted / implemented behind flags, all OFF by default
- Decision date: 2026-10-01 JST
- Owners: Staffpass by Sealith
- Scope: `/lp/ai-employee` chat launcher, `/api/journeys`, `/api/chat/turn`, `/api/lp/handoff`, `/lp/ai-employee/handoff/confirm`
- Stack: #168 (0a) → #172 (0b) → #177 (1a) → #182 (1b) → #183 (1c) → PR-1d (this UI)

## Context

Visitors to the AI-employee LP ask the same questions (what can it do, which plan, price, start date). We want an AI consultation window that answers from approved material and can pass a visitor to a human, without letting a chat conversation become a purchase, a contract, or an unreviewed disclosure of what the visitor typed.

## Decision

1. **The visitor is told it is AI before anything else.** The launcher opens to a consent step (AI disclosure + privacy policy, plus Cloudflare Turnstile when configured). A guest journey is created only after consent (`POST /api/journeys`).
2. **Guest session = signed HttpOnly cookie + double-submit CSRF.** `lp_guest` is HttpOnly and signed with `GUEST_SIGNING_KEY`; `lp_csrf` is readable and must be echoed as `x-csrf-token` on every state-changing call. Handoff endpoints are bound to the caller's journey; another guest's handoff id returns 404.
3. **The chat can only propose.** Tools are a fixed allowlist (knowledge search, catalog, plan recommendation, proposal card, handoff offer, order status). A proposal card links to the existing checkout confirm page (GET shows the confirm page; POST creates the Stripe session). The chat cannot call checkout.
4. **Handoff needs the visitor's explicit approval on a separate page.** The chat creates a *pending* handoff (`POST /api/lp/handoff`) and sends the visitor to `/lp/ai-employee/handoff/confirm`, where they edit the summary, give an email or phone, and press confirm (`PUT`). Only a confirmed handoff is queued for the human notification outbox. They can also cancel (`DELETE`). The page is `noindex` and 404s when `LP_HANDOFF_ENABLED` is OFF.
5. **The client trusts no link from the model.** Card data from `/api/chat/turn` is re-parsed on the client; only relative `/lp/ai-employee/...` paths are followed, and no HTML from the model is rendered.

## Flags and rollout

| Flag | Effect when ON |
| --- | --- |
| `LP_CHAT_ENABLED` | Launcher renders on the LP; `/api/journeys` and `/api/chat/turn` open |
| `LP_JOURNEYS_ENABLED` | Journeys persisted |
| `LP_CHAT_TOOLS_ENABLED` | Tool calling in chat |
| `LP_HANDOFF_ENABLED` | Handoff API, confirm page, handoff cards in the launcher |
| `LP_INQUIRY_BOT_PROTECTION_ENABLED` | Rate limit + Turnstile on journey creation |

Before any flag goes ON: apply the five LP migrations (`20261001000000`–`20261001400000`) with a separate GO, and set `GUEST_SIGNING_KEY`, `OPENAI_API_KEY`, `IP_HASH_KEY`, `CRON_SECRET`, `TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, and the handoff notification target. The LP page reads `LP_CHAT_ENABLED` at build time, so a redeploy is needed after changing it.

## Consequences

- With flags OFF the LP is visually unchanged except for the checkout confirm step from 0b; `e2e/lp-chat.spec.ts` asserts the launcher is absent and the endpoints are closed.
- Raising `LP_PRIVACY_VERSION` in `lib/lp/client-session.ts` is required whenever `/legal/privacy` changes, so recorded consent matches the text shown.
- Out of scope: purchase from chat (`capabilities.purchase` stays false), live human chat, and order lookup beyond "not found".
