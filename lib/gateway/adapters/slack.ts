import { getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import type { PostingAs } from "@/lib/types";

const SLACK_TIMEOUT_MS = 5_000;

export type SlackConversationPostResult =
  | { ok: true; delivery: "stub" }
  | { ok: true; delivery: "slack"; channel: string; ts: string }
  | { ok: false; error: string };

export function looksLikeSlackTs(value: string | undefined | null): boolean {
  return Boolean(value && /^\d+\.\d+$/.test(value.trim()));
}

export async function resolveConversationToken(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
}): Promise<{ token: string } | { error: "slack_identity_unbound" }> {
  const postingAs = normalizePostingAs(input.postingAs);
  if (postingAs === "user") {
    const employeeId = input.employeeId?.trim() || "";
    if (!employeeId) return { error: "slack_identity_unbound" };
    const userToken = await getLinkedSlackUserToken(employeeId);
    if (!userToken) return { error: "slack_identity_unbound" };
    return { token: userToken };
  }
  const botToken = await resolveOrgSlackBotToken(input.orgId);
  return { token: botToken };
}

function mapSlackApiError(error: string | undefined, httpStatus: number): string {
  if (error === "not_in_channel") return "slack_not_in_channel";
  return error || `slack_http_${httpStatus}`;
}

export async function postConversationMessage(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  text: string;
  threadTs?: string;
  summarize?: boolean;
}): Promise<SlackConversationPostResult> {
  const dest = input.channel.trim();
  if (!dest) return { ok: false, error: "slack_channel_required" };
  const resolved = await resolveConversationToken({
    orgId: input.orgId,
    employeeId: input.employeeId,
    postingAs: input.postingAs,
  });
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const token = resolved.token;
  if (!token) return { ok: true, delivery: "stub" };

  const text = input.summarize
    ? `【要約のみ】\n${input.text || ""}`
    : input.text || "";
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: dest,
        text,
        ...(looksLikeSlackTs(input.threadTs) ? { thread_ts: input.threadTs } : {}),
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };
    if (!body.ok) {
      return { ok: false, error: mapSlackApiError(body.error, response.status) };
    }
    if (!body.channel || !body.ts) {
      return { ok: false, error: "slack_message_missing" };
    }
    return { ok: true, delivery: "slack", channel: body.channel, ts: body.ts };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "slack_fetch_failed",
    };
  }
}
