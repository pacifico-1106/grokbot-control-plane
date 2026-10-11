/**
 * Slack chat.delete for comm.delete.
 *
 * Token = the one that made the post (post record `postedVia`):
 *   user → the employee's own linked Slack user token (never falls back to the
 *          bot: a bot token cannot delete a user's message anyway)
 *   bot  → the org conversation bot token (never the shared approval app)
 * Scopes (docs.slack.dev/reference/methods/chat.delete): bot token chat:write,
 * user token chat:write — the scopes Staffpass already requires for posting.
 * No token is logged or returned.
 */
import { resolveConversationToken, SLACK_TOKEN_MISSING } from "@/lib/gateway/adapters/slack";
import { isDemoMode } from "@/lib/mode";

const SLACK_TIMEOUT_MS = 5_000;

export type SlackDeleteResult =
  | { ok: true; delivery: "slack" | "stub"; deletedVia: "user" | "bot" }
  | { ok: false; error: string; gone?: boolean; needed?: string; deletedVia: "user" | "bot" };

export async function deleteSlackPost(input: {
  orgId: string;
  employeeId: string;
  postedVia: "user" | "bot";
  channel: string;
  messageId: string;
}): Promise<SlackDeleteResult> {
  const via = input.postedVia;
  const resolved = await resolveConversationToken({
    orgId: input.orgId,
    employeeId: input.employeeId,
    postingAs: via,
  });
  if ("error" in resolved) return { ok: false, error: resolved.error, deletedVia: via };
  // resolveConversationToken never switches identity, but pin it anyway.
  if (resolved.effectivePostingAs !== via) return { ok: false, error: "slack_token_identity_mismatch", deletedVia: via };
  if (!resolved.token) {
    return isDemoMode()
      ? { ok: true, delivery: "stub", deletedVia: via }
      : { ok: false, error: SLACK_TOKEN_MISSING, deletedVia: via };
  }
  try {
    const response = await fetch("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolved.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: input.channel, ts: input.messageId }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; needed?: string };
    if (body.ok) return { ok: true, delivery: "slack", deletedVia: via };
    const error = body.error || `slack_http_${response.status}`;
    return {
      ok: false,
      error,
      deletedVia: via,
      ...(error === "message_not_found" ? { gone: true } : {}),
      ...(error === "missing_scope" && typeof body.needed === "string" ? { needed: body.needed } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.name === "TimeoutError" ? "slack_delete_timeout" : "slack_delete_fetch_failed",
      deletedVia: via,
    };
  }
}
