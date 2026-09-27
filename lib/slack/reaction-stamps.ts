/**
 * Slack reaction stamps for AI employee wake/reply feedback.
 *
 * Provides visual feedback on Slack messages when an AI employee:
 * - Accepts a wake (`:eyes:` - "Taking a look")
 * - Posts a reply (`:white_check_mark:` - "Completed")
 * - Escalates to approval (`:hourglass_flowing_sand:` - "Waiting for approval")
 *
 * Flag-gated by SLACK_REACTION_STAMPS (default OFF).
 * Required scope: reactions:write. Degrades silently if missing (logs once).
 * Idempotent: adding same reaction twice is a no-op (Slack returns `already_reacted`).
 *
 * Security:
 * - No reactions in channels where bot is not a member.
 * - No reactions on Slack Connect external messages if posting is disallowed.
 * - Uses the posting identity already configured for the workspace.
 */

import { isSlackReactionStampsEnabled } from "@/lib/feature-flags";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import type { PostingAs } from "@/lib/types";

const SLACK_TIMEOUT_MS = 5_000;
const SLACK_API = "https://slack.com/api";

export type ReactionType = "looking" | "completed" | "waiting_approval";

export const REACTION_EMOJI: Record<ReactionType, string> = {
  looking: "eyes",
  completed: "white_check_mark",
  waiting_approval: "hourglass_flowing_sand",
};

type SlackReactionResponse = {
  ok: boolean;
  error?: string;
};

const scopeMissingLoggedOnce = new Set<string>();

function logScopeMissingOnce(orgId: string, error: string): void {
  const key = `${orgId}:${error}`;
  if (!scopeMissingLoggedOnce.has(key)) {
    scopeMissingLoggedOnce.add(key);
    console.warn("slack_reaction_scope_missing", { orgId, error });
  }
}

export function resetScopeMissingLog(): void {
  scopeMissingLoggedOnce.clear();
}

async function resolveReactionToken(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
}): Promise<string | null> {
  const requestedPostingAs = normalizePostingAs(input.postingAs);

  if (requestedPostingAs === "user") {
    const employeeId = input.employeeId?.trim() || "";
    if (!employeeId) return null;
    const userToken = await getLinkedSlackUserToken(employeeId);
    if (userToken) return userToken;
  }
  return resolveOrgSlackBotToken(input.orgId);
}

export type AddReactionResult =
  | { ok: true; added: boolean; alreadyReacted?: boolean; degraded?: boolean }
  | { ok: false; error: string; degraded?: boolean };

export async function addReaction(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  timestamp: string;
  reaction: ReactionType;
}): Promise<AddReactionResult> {
  if (!isSlackReactionStampsEnabled()) {
    return { ok: true, added: false };
  }

  const { orgId, channel, timestamp, reaction } = input;
  if (!channel?.trim() || !timestamp?.trim()) {
    return { ok: false, error: "missing_channel_or_timestamp" };
  }

  const token = await resolveReactionToken({
    orgId,
    employeeId: input.employeeId,
    postingAs: input.postingAs,
  });

  if (!token) {
    return { ok: true, added: false };
  }

  const emoji = REACTION_EMOJI[reaction];

  try {
    const response = await fetch(`${SLACK_API}/reactions.add`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channel.trim(),
        timestamp: timestamp.trim(),
        name: emoji,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as SlackReactionResponse;

    if (body.ok) {
      return { ok: true, added: true };
    }

    if (body.error === "already_reacted") {
      return { ok: true, added: false, alreadyReacted: true };
    }

    if (
      body.error === "missing_scope" ||
      body.error === "not_allowed_token_type"
    ) {
      logScopeMissingOnce(orgId, body.error);
      return { ok: true, added: false, degraded: true };
    }

    if (
      body.error === "channel_not_found" ||
      body.error === "not_in_channel" ||
      body.error === "message_not_found" ||
      body.error === "restricted_action"
    ) {
      return { ok: true, added: false };
    }

    return { ok: false, error: body.error || "reaction_add_failed" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "reaction_fetch_failed",
    };
  }
}

export type RemoveReactionResult =
  | { ok: true; removed: boolean; notReacted?: boolean; degraded?: boolean }
  | { ok: false; error: string; degraded?: boolean };

export async function removeReaction(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  timestamp: string;
  reaction: ReactionType;
}): Promise<RemoveReactionResult> {
  if (!isSlackReactionStampsEnabled()) {
    return { ok: true, removed: false };
  }

  const { orgId, channel, timestamp, reaction } = input;
  if (!channel?.trim() || !timestamp?.trim()) {
    return { ok: false, error: "missing_channel_or_timestamp" };
  }

  const token = await resolveReactionToken({
    orgId,
    employeeId: input.employeeId,
    postingAs: input.postingAs,
  });

  if (!token) {
    return { ok: true, removed: false };
  }

  const emoji = REACTION_EMOJI[reaction];

  try {
    const response = await fetch(`${SLACK_API}/reactions.remove`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channel.trim(),
        timestamp: timestamp.trim(),
        name: emoji,
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as SlackReactionResponse;

    if (body.ok) {
      return { ok: true, removed: true };
    }

    if (body.error === "no_reaction") {
      return { ok: true, removed: false, notReacted: true };
    }

    if (
      body.error === "missing_scope" ||
      body.error === "not_allowed_token_type"
    ) {
      logScopeMissingOnce(orgId, body.error);
      return { ok: true, removed: false, degraded: true };
    }

    if (
      body.error === "channel_not_found" ||
      body.error === "not_in_channel" ||
      body.error === "message_not_found" ||
      body.error === "restricted_action"
    ) {
      return { ok: true, removed: false };
    }

    return { ok: false, error: body.error || "reaction_remove_failed" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "reaction_fetch_failed",
    };
  }
}

export async function transitionReaction(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  timestamp: string;
  from: ReactionType;
  to: ReactionType;
}): Promise<{ removeResult: RemoveReactionResult; addResult: AddReactionResult }> {
  const removeResult = await removeReaction({
    orgId: input.orgId,
    employeeId: input.employeeId,
    postingAs: input.postingAs,
    channel: input.channel,
    timestamp: input.timestamp,
    reaction: input.from,
  });

  const addResult = await addReaction({
    orgId: input.orgId,
    employeeId: input.employeeId,
    postingAs: input.postingAs,
    channel: input.channel,
    timestamp: input.timestamp,
    reaction: input.to,
  });

  return { removeResult, addResult };
}

export async function addLookingReaction(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  timestamp: string;
}): Promise<AddReactionResult> {
  return addReaction({ ...input, reaction: "looking" });
}

export async function addCompletedReaction(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  timestamp: string;
}): Promise<{ removeResult: RemoveReactionResult; addResult: AddReactionResult }> {
  return transitionReaction({ ...input, from: "looking", to: "completed" });
}

export async function addWaitingApprovalReaction(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  timestamp: string;
}): Promise<{ removeResult: RemoveReactionResult; addResult: AddReactionResult }> {
  return transitionReaction({ ...input, from: "looking", to: "waiting_approval" });
}
