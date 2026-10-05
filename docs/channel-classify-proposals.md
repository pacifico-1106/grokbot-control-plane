# Channel classification proposals, stuck notices, ledger read tools

Status: shipped behind flags, **both OFF by default**.

| Flag | Default | Effect when ON |
| --- | --- | --- |
| `CHANNEL_CLASSIFY_PROPOSALS_ENABLED` | OFF | Join events, the backfill and unregistered-channel denies open `channels.classify` tickets (plus `parties.upsert` for mixed Slack channels). |
| `CHANNEL_STUCK_NOTIFY_ENABLED` | OFF | Stuck notices (unregistered-channel deny, ledger / backfill / proposal failure, unset `notifyMouth`). |

Migration `20261005200000_channel_classify_proposals.sql` must be applied
**before** either flag is turned on (rollback:
`supabase/verification/20261005200000_channel_classify_proposals_rollback.sql`).

Not flag-gated (always on, strictly additive or stricter):

- `channels.list` / `parties.list` (read-only admin MCP tools).
- Request-time validation of `channels.classify` / `parties.upsert`.
- The before → after + sharing-state summary on the approval card.
- `nextStep` on a 403 `egress_denied` for an external-treated channel.

## 1. Join → proposal (one mechanism for every surface)

```
Slack / LINE / Telegram event ──► ChannelJoinSignal ──► facts ──► proposal ticket
                                   (per surface)       (shared)    (shared, always_human)
```

| Surface | Event | Org comes from |
| --- | --- | --- |
| Slack | `member_joined_channel` (an employee's bound Slack user, or the org's own bot), `channel_joined` / `group_joined` | the bound employee, or the workspace's single enabled conversation adapter (ambiguous → nothing) |
| LINE | `join` (group / room) on the org's LINE inbox webhook | the inbox whose signature verified |
| Telegram | `my_chat_member` (bot left/kicked → member/administrator) on the per-inbox webhook | the inbox whose secret token verified |
| Backfill | Slack `users.conversations` of the org's own bot (`/api/cron/channel-classify-backfill`, cron secret) | the adapter's org |

The approval group / chat itself is never proposed. Slack IMs are never
proposed (`channels.classify` without `employeeId` would remove the DM route).

**Facts** (Slack only, with the org's own bot token): `conversations.info`,
`conversations.members`, `users.info` (≤ 50 members): private, Slack Connect
(`is_ext_shared`), guests (`is_restricted` / `is_ultra_restricted`), members of
other workspaces. LINE / Telegram (and a Slack channel the bot cannot read) are
**unverified**: proposed on the safe side (`shared_external`, mixed) with a
warning on the card.

**Ticket**: the same admin approval machinery as the admin MCP queue —
`approvalClass: admin`, `always_human`, `metadata.adminMutation` applied only by
the normal fulfillment after a human approves. Requester is `system`, so no
agent can approve its own proposal. Delivered to the org's approval channel
(one tap). Mixed Slack channels also get up to 5 `parties.upsert` tickets for
unregistered internal members.

**Dedupe**: one ticket per org × channel (`channel_classify_proposals`,
`claim_channel_classify_proposal`). No new ticket while one is pending or after
a decision (approved or rejected) unless the material facts change (private /
Connect / guests / external members). If the dedupe store is unavailable, no
ticket is created (fail-closed) and a `proposal_failed` notice is sent.

## 2. Stuck notices

| Kind | When |
| --- | --- |
| `unregistered_channel_denied` | a post was denied with `external_confidential_denied` in a channel the ledger does not know |
| `ledger_write_failed` | the Slack Connect ledger write failed (audience stays external) |
| `ledger_read_failed` | the stuck-watch ledger retry could not read the ledger (deny kept) |
| `backfill_failed` | the backfill could not list channels or create proposals |
| `proposal_failed` | a proposal ticket could not be created |
| `stuck_watch_mouth_fallback` | a stuck-watch alert whose `notifyMouth` is unset or no longer exists |

Routing (same org only): the employee's approval channel → the org's default
(else first) enabled approval channel → ops (`PLATFORM_OPS_ORG_ID` audit mirror
with ids only + `APPROVAL_ALERT_OPS_EMAILS`) → `undelivered`. A tenant audit
row (`channel_stuck.notice`) is always written. Rate limit: one notice per
org × kind × channel per 6 h (deny) / 30 min (others), stored in
`channel_stuck_notice_windows` (per-instance fallback when the store is down).
Notices carry the channel id, the reason code, the approval id and the one-tap
fix — never a message body, token or secret.

## 3. Deny `nextStep`

A 403 `egress_denied` with `external_confidential_denied`,
`external_internal_source_denied` or `external_verbatim_denied` for a channel
(not a Slack DM) carries:

```json
{
  "nextStep": {
    "tool": "channels.classify",
    "surface": "slack",
    "externalId": "C0123456789",
    "reason": "external_confidential_denied",
    "example": { "name": "channels.classify", "arguments": { "surface": "slack", "externalId": "C0123456789", "classification": "internal", "mixed": false } },
    "messageJa": "…"
  },
  "nextStepJa": "…"
}
```

The deny itself is unchanged; `channels.classify` still needs a human approval.

## 4. Admin MCP

### `channels.list` (read-only, no approval)

| Arg | Type | Notes |
| --- | --- | --- |
| `surface` | `slack \| line \| mail \| phone \| web \| telegram` | optional filter |
| `classification` | `internal \| shared_external \| unknown` | optional filter |
| `limit` | integer 1–200 | default 50 |
| `cursor` | string | `nextCursor` of the previous page (opaque) |

Returns `{ ok, items: [{ surface, externalId, classification, mixed, createdAt, updatedAt }], nextCursor, limit }`.

### `parties.list` (read-only, no approval)

| Arg | Type | Notes |
| --- | --- | --- |
| `kind` | `email_domain \| slack_channel \| slack_user \| phone \| line \| mail_address` | optional filter |
| `audience` | `internal \| external` | optional filter |
| `limit` | integer 1–200 | default 50 |
| `cursor` | string | opaque |

Returns `{ ok, items: [{ kind, identifier, audience, createdAt, updatedAt }], nextCursor, limit }`.

Both: org from the credential only; any other argument (including `orgId`)
→ `unknown_argument`; `invalid_cursor`, `invalid_limit`, `invalid_surface`,
`invalid_classification`, `invalid_kind`, `invalid_audience`;
`store_unavailable` on a store error (never an empty list). Not plan-gated.

### `channels.classify` / `parties.upsert` (always_human)

Validated when the request comes in: `surface`, `classification`, `mixed`
(`channels.classify`), `kind`, `audience` (`parties.upsert`), plus unknown
arguments (`orgId` is refused — the org comes from the credential). An
invalid value returns `isError` with `{ code: "invalid_*", field, allowed,
received, message, messageJa, nextStep, nextStepJa }` and **no ticket is
created**. Fulfillment validates again and refuses (instead of writing
`unknown`).

The approval card always shows before → after (`未登録（社外扱い）` when the
channel is not registered) and the channel's sharing state (Slack Connect /
private / guests / members of other workspaces) — no message content, no tokens.

## 5. Enabling

1. Apply migration `20261005200000`.
2. Slack app: subscribe to `member_joined_channel` (and `channel_joined` /
   `group_joined` for user-token apps); scopes `channels:read`, `groups:read`,
   `users:read` (plus `mpim:read` / `im:read` for the backfill listing).
3. Telegram: re-register each inbox webhook after enabling (`setWebhook` then
   includes `my_chat_member` in `allowed_updates`).
4. Turn on `CHANNEL_STUCK_NOTIFY_ENABLED`, then `CHANNEL_CLASSIFY_PROPOSALS_ENABLED`.
5. Optional: schedule `/api/cron/channel-classify-backfill`.
