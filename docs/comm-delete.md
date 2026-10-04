# comm.delete — an AI employee deletes its own recorded posts

Status: behind `COMM_DELETE_ENABLED` (default **OFF**). Code: `lib/comm-delete/`.

## What it does

An AI employee (any agent runtime that holds a Staffpass employee credential)
can delete a message **it posted itself through Staffpass** — for example to
clean up a duplicate send. Nothing else can be deleted.

Call (gateway `POST /api/gateway/invoke` or MCP `staffpass_invoke`):

```json
{ "tool": "comm.delete", "purpose": "<allowed purpose>", "jobId": "<job>",
  "args": { "surface": "slack", "channel": "C0123ABCD", "ts": "1787911800.000100" } }
```

`messageId` is accepted instead of `ts`; `channelId` / `slackChannelId` instead of
`channel`. The target is read from `args` only — `conversation{}` is ignored.

## Who may delete what

A delete runs only when **all** of these hold:

1. `COMM_DELETE_ENABLED` is on.
2. The employee passes the normal gateway checks (credential, scopes
   `tools:invoke` + `slack:post`, purpose, plan, action limits). The per-tool
   setting `deny` rejects immediately (403).
3. Staffpass has a **post record** for exactly this surface + channel + message
   id, written for **this employee in this org**, within
   `COMM_DELETE_MAX_AGE_HOURS` (default 72 h):
   - auto posts: `tool.invoke` audit row with `metadata.postRecord`
   - approved posts: `slack.posted` audit row with `metadata.postRecord`
   - approved posts made before this change: `slack.posted` row whose approval
     belongs to the same org + employee and whose stored fulfillment posted the
     same channel + ts (posting identity read from the approval snapshot).
   Anything else (someone else's post, another employee's, another org's,
   unrecorded, too old) gets the same `404 post_not_found_or_not_owned`.
4. It was not already deleted (`200 already_deleted`, no provider call).

Post records hold ids only: `{v:1, surface, channel, messageId, postedVia}`.

## Which token deletes

The token that made the post, from the record (not the current setting):
`postedVia: "user"` → the employee's linked Slack user token (no bot fallback;
unlinked → `409 slack_identity_unbound`); `postedVia: "bot"` → the org's
conversation bot token (never the shared approval app).

Slack `chat.delete` needs `chat:write` for both bot and user tokens — already
required for posting, so no new scope or reinstall
(<https://docs.slack.dev/reference/methods/chat.delete>).

## Surfaces

| Surface | Status | Reason |
| --- | --- | --- |
| Slack | supported | `chat.delete` |
| LINE | `422 not_supported` (`provider_has_no_delete_api`) | The Messaging API has no endpoint to delete / unsend a message the bot sent (only the `unsend` webhook for user unsends). <https://developers.line.biz/en/reference/messaging-api/> |
| Telegram | `422 not_supported` (`no_gateway_post_path`) | Staffpass has no gateway conversation posting path for Telegram (Telegram is an approval-notification channel only). `deleteMessage` exists but only for messages < 48 h old. <https://core.telegram.org/bots/api#deletemessage> |

## Approval

`risk_based` by default (preset), risk **low**. A human approval is required when
the employee is `always_human`, the per-tool setting is `always_human`, or an
action limit asks for one. Ownership is checked **before** the approval card is
created and again at execution time. An approved re-invoke replays the stored
result (no second delete).

## Responses

| HTTP | code | status |
| --- | --- | --- |
| 200 | `deleted` | `deleted` |
| 200 | `already_deleted` | `already_deleted` (repeat, or Slack `message_not_found`) |
| 400 | `invalid_delete_target` | `refused` |
| 402 | `needs_approval` | approval card created (risk low) |
| 403 | `comm_delete_disabled` / `tool_denied_by_tool_setting` | `refused` |
| 404 | `post_not_found_or_not_owned` | `refused` |
| 409 | `slack_identity_unbound` | `failed` |
| 422 | `not_supported` (+ `reason`) | `not_supported` |
| 502 | provider code (e.g. `cant_delete_message`) | `failed` |
| 503 | `comm_delete_unavailable` / `slack_token_missing` | `refused` / `failed` |

## Audit

Every attempt writes one of `comm.delete.succeeded`, `comm.delete.already_deleted`,
`comm.delete.refused`, `comm.delete.failed`, `comm.delete.approval_requested`
with ids and a hash only: tool, jobId, approvalId, phase, surface, channel,
messageId, `targetHash` = sha256(`org\nsurface\nchannel\nmessageId`), code,
postedVia / deletedVia, record source + audit id. Never the message body.

Production dependency: audit rows are server-only since migration
`20261004500000` (agents cannot insert a fake post record). Apply it before
turning the flag on.
