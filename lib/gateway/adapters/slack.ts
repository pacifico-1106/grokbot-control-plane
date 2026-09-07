import { getLinkedSlackUserToken } from "@/lib/data/slack-identities";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { normalizePostingAs } from "@/lib/employees/posting-as";
import type { MouthRoutingDecision, OrgReplyPolicy, PostingAs, ReplyPolicyDecision } from "@/lib/types";
import {
  evaluateReplyPolicy,
  applyEmojiPolicy,
  shouldDraftOnly,
  shouldHoldForApproval,
  summarizeReplyPolicyDecision,
  defaultReplyPolicy,
} from "@/lib/gateway/reply-policy";

const SLACK_TIMEOUT_MS = 5_000;

export type SlackConversationPostResult =
  | { ok: true; delivery: "stub" }
  | { ok: true; delivery: "slack"; channel: string; ts: string }
  | { ok: false; error: string };

export function looksLikeSlackTs(value: string | undefined | null): boolean {
  return Boolean(value && /^\d+\.\d+$/.test(value.trim()));
}

export function isSlackDmChannel(channelId: string | undefined | null): boolean {
  return Boolean(channelId && channelId.startsWith("D"));
}

export async function resolveConversationToken(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
}): Promise<{ token: string; effectivePostingAs: PostingAs } | { error: "slack_identity_unbound" }> {
  const requestedPostingAs = normalizePostingAs(input.postingAs);

  if (requestedPostingAs === "user") {
    const employeeId = input.employeeId?.trim() || "";
    if (!employeeId) return { error: "slack_identity_unbound" };
    const userToken = await getLinkedSlackUserToken(employeeId);
    if (!userToken) return { error: "slack_identity_unbound" };
    return { token: userToken, effectivePostingAs: requestedPostingAs };
  }
  const botToken = await resolveOrgSlackBotToken(input.orgId);
  return { token: botToken, effectivePostingAs: requestedPostingAs };
}

function mapSlackApiError(error: string | undefined, httpStatus: number): string {
  if (error === "not_in_channel") return "slack_not_in_channel";
  return error || `slack_http_${httpStatus}`;
}

async function openSlackConversation(
  token: string,
  userId: string
): Promise<{ ok: true; channelId: string } | { ok: false; error: string }> {
  try {
    const response = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ users: userId }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channel?: { id?: string };
    };
    if (!body.ok || !body.channel?.id) {
      return { ok: false, error: body.error || "conversations_open_failed" };
    }
    return { ok: true, channelId: body.channel.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "conversations_open_failed",
    };
  }
}

async function postSlackMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string
): Promise<
  | { ok: true; channel: string; ts: string }
  | { ok: false; error: string; rawError?: string }
> {
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text,
        ...(looksLikeSlackTs(threadTs) ? { thread_ts: threadTs } : {}),
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
      return {
        ok: false,
        error: mapSlackApiError(body.error, response.status),
        rawError: body.error,
      };
    }
    if (!body.channel || !body.ts) {
      return { ok: false, error: "slack_message_missing" };
    }
    return { ok: true, channel: body.channel, ts: body.ts };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "slack_fetch_failed",
    };
  }
}

export async function postConversationMessage(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  text: string;
  threadTs?: string;
  summarize?: boolean;
  slackUserId?: string;
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

  const posted = await postSlackMessage(token, dest, text, input.threadTs);

  if (posted.ok) {
    return { ok: true, delivery: "slack", channel: posted.channel, ts: posted.ts };
  }

  // Path A app DM retry: When user token gets channel_not_found on a DM channel,
  // fall back to bot token with conversations.open. User tokens cannot see
  // bot↔human app DMs (Staffpass app DM), but bot tokens can open/post to them.
  // Path B human↔human DMs succeed with user token directly (no retry needed).
  const isUserTokenAttempt = resolved.effectivePostingAs === "user";
  const canRetryWithBotForAppDm =
    posted.rawError === "channel_not_found" &&
    isSlackDmChannel(dest) &&
    isUserTokenAttempt &&
    input.slackUserId?.trim();

  if (!canRetryWithBotForAppDm) {
    // For bot token channel_not_found on DM, still try conversations.open with bot
    const canRetryBotWithOpen =
      posted.rawError === "channel_not_found" &&
      isSlackDmChannel(dest) &&
      !isUserTokenAttempt &&
      input.slackUserId?.trim();

    if (canRetryBotWithOpen) {
      const openResult = await openSlackConversation(token, input.slackUserId!.trim());
      if (!openResult.ok) {
        return { ok: false, error: posted.error };
      }
      const retried = await postSlackMessage(token, openResult.channelId, text, input.threadTs);
      if (retried.ok) {
        return { ok: true, delivery: "slack", channel: retried.channel, ts: retried.ts };
      }
      return { ok: false, error: retried.error };
    }

    return { ok: false, error: posted.error };
  }

  // Fall back to bot token for Path A app DM
  const botToken = await resolveOrgSlackBotToken(input.orgId);
  if (!botToken) {
    return { ok: false, error: posted.error };
  }

  const openResult = await openSlackConversation(botToken, input.slackUserId!.trim());
  if (!openResult.ok) {
    return { ok: false, error: posted.error };
  }

  const retried = await postSlackMessage(botToken, openResult.channelId, text, input.threadTs);
  if (retried.ok) {
    return { ok: true, delivery: "slack", channel: retried.channel, ts: retried.ts };
  }

  return { ok: false, error: retried.error };
}

/**
 * F1: Split routing result for dual-delivery scenarios.
 */
export type SplitRoutingResult = {
  channelDelivery: SlackConversationPostResult | null;
  dmDelivery: SlackConversationPostResult | null;
  splitDelivery: boolean;
  auditLabels: string[];
};

/**
 * F1: Execute split routing based on mouth routing decision.
 *
 * When dualEgress shows differing decisions:
 * - Channel post uses external-safe content (effectiveDecision)
 * - Internal DM uses full content for internal parties
 *
 * Conversation adapters ≠ approval notification channels (never mix).
 */
export async function executeSlackSplitRouting(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channelId: string;
  threadTs?: string;
  externalSafeText: string;
  internalFullText: string;
  routing: MouthRoutingDecision;
  slackUserId?: string;
}): Promise<SplitRoutingResult> {
  const auditLabels: string[] = [];
  let channelDelivery: SlackConversationPostResult | null = null;
  let dmDelivery: SlackConversationPostResult | null = null;

  const { routing } = input;

  if (routing.channelRoute && routing.channelRoute.path.kind === "channel") {
    const text =
      routing.channelRoute.contentVariant === "summary_only"
        ? `【要約のみ】\n${input.externalSafeText}`
        : input.externalSafeText;

    channelDelivery = await postConversationMessage({
      orgId: input.orgId,
      employeeId: input.employeeId,
      postingAs: input.postingAs,
      channel: input.channelId,
      text,
      threadTs: input.threadTs,
      summarize: routing.channelRoute.contentVariant === "summary_only",
      slackUserId: input.slackUserId,
    });
    auditLabels.push(routing.channelRoute.auditLabel);
  }

  if (routing.internalRoute) {
    const path = routing.internalRoute.path;

    if (path.kind === "dm" && path.targetUserIds.length > 0) {
      for (const userId of path.targetUserIds) {
        const dmResult = await postConversationMessage({
          orgId: input.orgId,
          employeeId: input.employeeId,
          postingAs: input.postingAs,
          channel: userId,
          text: input.internalFullText,
          slackUserId: userId,
        });

        if (!dmDelivery || dmResult.ok) {
          dmDelivery = dmResult;
        }
      }
      auditLabels.push(routing.internalRoute.auditLabel);
    } else if (path.kind === "limited_thread") {
      dmDelivery = await postConversationMessage({
        orgId: input.orgId,
        employeeId: input.employeeId,
        postingAs: input.postingAs,
        channel: input.channelId,
        text: input.internalFullText,
        threadTs: path.parentThreadId,
        slackUserId: input.slackUserId,
      });
      auditLabels.push(routing.internalRoute.auditLabel);
    } else if (path.kind === "hold_approval" || path.kind === "deny") {
      auditLabels.push(routing.internalRoute.auditLabel);
    }
  }

  return {
    channelDelivery,
    dmDelivery,
    splitDelivery: routing.splitDelivery,
    auditLabels,
  };
}

/**
 * F1: Check if a routing decision requires split delivery.
 */
export function requiresSplitDelivery(routing: MouthRoutingDecision): boolean {
  return (
    routing.splitDelivery &&
    routing.channelRoute !== null &&
    routing.internalRoute !== null &&
    routing.internalRoute.path.kind !== "hold_approval" &&
    routing.internalRoute.path.kind !== "deny"
  );
}

/**
 * B2: Reply policy-aware message posting result.
 */
export type ReplyPolicyAwarePostResult =
  | { ok: true; delivery: "slack"; channel: string; ts: string; replyDecision: ReplyPolicyDecision }
  | { ok: true; delivery: "draft"; replyDecision: ReplyPolicyDecision; draftText: string }
  | { ok: true; delivery: "stub"; replyDecision: ReplyPolicyDecision }
  | { ok: false; error: string; replyDecision?: ReplyPolicyDecision }
  | { ok: false; error: "reply_policy_hold"; holdReason: string; replyDecision: ReplyPolicyDecision };

/**
 * B2: Post a Slack message with reply policy enforcement.
 *
 * Applies B2 reply policy before sending:
 * - After-hours: draft_only or hold_approval
 * - Emoji stripping based on policy
 * - Thread affinity enforcement
 *
 * Connects to F1 mouth-routing for surface selection (does not reinvent).
 * Conversation adapters ≠ approval notification channels (never mix).
 */
export async function postConversationMessageWithReplyPolicy(input: {
  orgId: string;
  employeeId?: string;
  postingAs?: PostingAs | string | null;
  channel: string;
  text: string;
  threadTs?: string;
  parentThreadTs?: string;
  summarize?: boolean;
  slackUserId?: string;
  replyPolicy?: OrgReplyPolicy | null;
  currentTime?: Date;
  timezone?: string;
  topicSimilarity?: number;
}): Promise<ReplyPolicyAwarePostResult> {
  const replyDecision = evaluateReplyPolicy({
    policy: input.replyPolicy,
    surface: "slack",
    currentTime: input.currentTime,
    timezone: input.timezone,
    messageText: input.text,
    existingThreadTs: input.threadTs,
    parentThreadTs: input.parentThreadTs,
    channelId: input.channel,
    topicSimilarity: input.topicSimilarity,
  });

  if (shouldHoldForApproval(replyDecision)) {
    return {
      ok: false,
      error: "reply_policy_hold",
      holdReason: replyDecision.holdReason || "policy_requires_approval",
      replyDecision,
    };
  }

  let processedText = input.text;
  if (replyDecision.emojiStripped && input.replyPolicy?.rules[0]) {
    const emojiResult = applyEmojiPolicy(input.text, input.replyPolicy.rules[0]);
    processedText = emojiResult.text;
  }

  if (shouldDraftOnly(replyDecision)) {
    return {
      ok: true,
      delivery: "draft",
      replyDecision,
      draftText: processedText,
    };
  }

  const effectiveThreadTs = replyDecision.threadTs || input.threadTs;

  const postResult = await postConversationMessage({
    orgId: input.orgId,
    employeeId: input.employeeId,
    postingAs: input.postingAs,
    channel: input.channel,
    text: processedText,
    threadTs: effectiveThreadTs,
    summarize: input.summarize,
    slackUserId: input.slackUserId,
  });

  if (!postResult.ok) {
    return { ...postResult, replyDecision };
  }

  if (postResult.delivery === "stub") {
    return { ok: true, delivery: "stub", replyDecision };
  }

  return {
    ok: true,
    delivery: "slack",
    channel: postResult.channel,
    ts: postResult.ts,
    replyDecision,
  };
}

/**
 * B2: Check if a message should be held due to reply policy.
 */
export function shouldHoldDueToReplyPolicy(
  text: string,
  replyPolicy?: OrgReplyPolicy | null,
  currentTime?: Date,
  timezone?: string
): { hold: boolean; reason?: string } {
  const decision = evaluateReplyPolicy({
    policy: replyPolicy,
    surface: "slack",
    currentTime,
    timezone,
    messageText: text,
    channelId: "",
  });

  if (shouldHoldForApproval(decision)) {
    return { hold: true, reason: decision.holdReason };
  }

  return { hold: false };
}

/**
 * B2: Summarize reply policy decision for logging (no tokens/secrets).
 */
export { summarizeReplyPolicyDecision } from "@/lib/gateway/reply-policy";
