/**
 * B2 Reply Policy — Slack/LINE conversation reply behavior.
 *
 * Controls how AI employees respond on conversation surfaces:
 * - After-hours behavior (drafts only when outside business hours)
 * - Emoji/short-reply allow/deny
 * - Channel/thread rules (1 topic = 1 thread)
 *
 * Connects to F1 mouth-routing for mouth choice/priority (does not reinvent).
 * Conversation mouths ≠ approval notification channels (never mix).
 *
 * Fail-closed: unknown/invalid config → draft only / hold for approval.
 */

import type {
  BusinessHoursWindow,
  ConversationSurface,
  OrgReplyPolicy,
  ReplyPolicyAuditLabel,
  ReplyPolicyDecision,
  ReplyPolicyRule,
} from "@/lib/types";
import { defaultReplyPolicy } from "@/lib/gateway/reply-policy-validate";

const DEFAULT_BUSINESS_HOURS: BusinessHoursWindow = {
  dayOfWeek: [1, 2, 3, 4, 5],
  startTime: "09:00",
  endTime: "18:00",
  timezone: "Asia/Tokyo",
};

const DEFAULT_SHORT_REPLY_MIN_CHARS = 10;

const EMOJI_PATTERN = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2B50}]|[\u{1FA00}-\u{1FAFF}]/gu;

export interface EvaluateReplyPolicyInput {
  policy?: OrgReplyPolicy | null;
  surface: ConversationSurface;
  currentTime?: Date;
  timezone?: string;
  messageText: string;
  existingThreadTs?: string;
  parentThreadTs?: string;
  channelId: string;
  topicSimilarity?: number;
}

function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return { hours: hours || 0, minutes: minutes || 0 };
}

function isWithinBusinessHours(
  currentTime: Date,
  businessHours: BusinessHoursWindow,
  timezone?: string
): boolean {
  const tz = timezone || businessHours.timezone || "Asia/Tokyo";

  let localDate: Date;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(currentTime);
    const getValue = (type: string) =>
      parts.find((p) => p.type === type)?.value || "0";
    localDate = new Date(
      parseInt(getValue("year")),
      parseInt(getValue("month")) - 1,
      parseInt(getValue("day")),
      parseInt(getValue("hour")),
      parseInt(getValue("minute"))
    );
  } catch {
    localDate = currentTime;
  }

  const dayOfWeek = localDate.getDay();
  if (!businessHours.dayOfWeek.includes(dayOfWeek)) {
    return false;
  }

  const currentMinutes = localDate.getHours() * 60 + localDate.getMinutes();
  const start = parseTime(businessHours.startTime);
  const end = parseTime(businessHours.endTime);
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function stripEmojis(text: string): string {
  return text.replace(EMOJI_PATTERN, "").trim();
}

function filterAllowedEmojis(text: string, allowedEmojis: string[]): string {
  return text.replace(EMOJI_PATTERN, (match) => {
    if (allowedEmojis.includes(match)) {
      return match;
    }
    return "";
  });
}

function extractEmojis(text: string): string[] {
  return text.match(EMOJI_PATTERN) || [];
}

function isShortReply(text: string, minChars: number): boolean {
  const stripped = stripEmojis(text);
  return stripped.length < minChars;
}

function selectRule(
  policy: OrgReplyPolicy,
  surface: ConversationSurface
): ReplyPolicyRule {
  const sortedRules = [...policy.rules].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );

  for (const rule of sortedRules) {
    if (!rule.surface || rule.surface === surface) {
      return rule;
    }
  }

  return policy.rules[0] ?? {
    id: "fallback",
    afterHoursMode: "draft_only",
    shortReplyMode: "allow",
    emojiMode: "limited",
    threadAffinity: "prefer_thread",
  };
}

export function evaluateReplyPolicy(
  input: EvaluateReplyPolicyInput
): ReplyPolicyDecision {
  const {
    surface,
    currentTime = new Date(),
    timezone,
    messageText,
    existingThreadTs,
    parentThreadTs,
    topicSimilarity,
  } = input;

  const effectivePolicy = input.policy ?? defaultReplyPolicy();
  const rule = selectRule(effectivePolicy, surface);

  const auditLabels: string[] = [];
  const appliedRules: string[] = [rule.id];

  let allowed = true;
  let draftOnly = false;
  let holdApproval = false;
  let holdReason: string | undefined;
  let emojiStripped = false;
  let shortReplyWarning = false;
  let threadTs: string | undefined = existingThreadTs || parentThreadTs;
  let newThread = false;

  const businessHours = rule.businessHours ?? DEFAULT_BUSINESS_HOURS;
  const isWithinHours = isWithinBusinessHours(currentTime, businessHours, timezone);

  if (!isWithinHours) {
    auditLabels.push("after_hours");
    switch (rule.afterHoursMode) {
      case "draft_only":
        draftOnly = true;
        auditLabels.push("after_hours_draft_only");
        break;
      case "hold_approval":
        holdApproval = true;
        holdReason = "after_hours_requires_approval";
        auditLabels.push("after_hours_hold");
        break;
      case "allow_send":
        auditLabels.push("after_hours_allowed");
        break;
    }
  }

  const emojisInText = extractEmojis(messageText);
  if (emojisInText.length > 0) {
    switch (rule.emojiMode) {
      case "deny":
        emojiStripped = true;
        auditLabels.push("emoji_stripped_all");
        break;
      case "limited":
        if (rule.allowedEmojis && rule.allowedEmojis.length > 0) {
          const disallowed = emojisInText.filter(
            (e) => !rule.allowedEmojis!.includes(e)
          );
          if (disallowed.length > 0) {
            emojiStripped = true;
            auditLabels.push("emoji_stripped_limited");
          }
        }
        break;
      case "allow":
        break;
    }
  }

  const minChars = rule.shortReplyMinChars ?? DEFAULT_SHORT_REPLY_MIN_CHARS;
  if (isShortReply(messageText, minChars)) {
    switch (rule.shortReplyMode) {
      case "deny":
        allowed = false;
        holdApproval = true;
        holdReason = "short_reply_denied";
        auditLabels.push("short_reply_denied");
        break;
      case "warn":
        shortReplyWarning = true;
        auditLabels.push("short_reply_warning");
        break;
      case "allow":
        break;
    }
  }

  switch (rule.threadAffinity) {
    case "prefer_thread":
      if (parentThreadTs && !existingThreadTs) {
        threadTs = parentThreadTs;
        auditLabels.push("thread_affinity_parent");
      } else if (existingThreadTs) {
        threadTs = existingThreadTs;
        auditLabels.push("thread_affinity_existing");
      }
      break;

    case "new_thread_per_topic":
      const threshold = rule.topicChangeThreshold ?? 0.5;
      if (topicSimilarity !== undefined && topicSimilarity < threshold) {
        threadTs = undefined;
        newThread = true;
        auditLabels.push("thread_new_topic");
      } else if (parentThreadTs) {
        threadTs = parentThreadTs;
        auditLabels.push("thread_same_topic");
      }
      break;

    case "channel_root":
      threadTs = undefined;
      auditLabels.push("thread_channel_root");
      break;
  }

  return {
    allowed,
    draftOnly,
    holdApproval,
    holdReason,
    emojiStripped,
    shortReplyWarning,
    threadTs,
    newThread,
    auditLabels,
    appliedRules,
  };
}

export function applyEmojiPolicy(
  text: string,
  rule: ReplyPolicyRule
): { text: string; stripped: boolean } {
  if (rule.emojiMode === "allow") {
    return { text, stripped: false };
  }

  if (rule.emojiMode === "deny") {
    const stripped = stripEmojis(text);
    return { text: stripped, stripped: stripped !== text };
  }

  if (rule.allowedEmojis && rule.allowedEmojis.length > 0) {
    const filtered = filterAllowedEmojis(text, rule.allowedEmojis);
    return { text: filtered, stripped: filtered !== text };
  }

  return { text, stripped: false };
}

export function buildReplyPolicyAuditLabel(
  decision: ReplyPolicyDecision,
  surface: ConversationSurface,
  rule: ReplyPolicyRule
): ReplyPolicyAuditLabel {
  return {
    replyId: `reply_${Date.now()}`,
    surface,
    afterHoursApplied: decision.draftOnly || decision.holdApproval,
    draftOnly: decision.draftOnly,
    emojiMode: rule.emojiMode,
    threadAffinity: rule.threadAffinity,
    appliedRules: decision.appliedRules,
    reason: decision.holdReason,
  };
}

export function shouldDraftOnly(decision: ReplyPolicyDecision): boolean {
  return decision.draftOnly && !decision.holdApproval;
}

export function shouldHoldForApproval(decision: ReplyPolicyDecision): boolean {
  return decision.holdApproval;
}

export function summarizeReplyPolicyDecision(
  decision: ReplyPolicyDecision
): string {
  const parts: string[] = [];

  if (decision.draftOnly) {
    parts.push("draft_only");
  }

  if (decision.holdApproval) {
    parts.push(`hold:${decision.holdReason}`);
  }

  if (decision.emojiStripped) {
    parts.push("emoji_stripped");
  }

  if (decision.shortReplyWarning) {
    parts.push("short_warning");
  }

  if (decision.newThread) {
    parts.push("new_thread");
  } else if (decision.threadTs) {
    parts.push("in_thread");
  }

  return parts.join("|") || "allowed";
}

export function isAfterBusinessHours(
  currentTime: Date,
  policy?: OrgReplyPolicy | null,
  surface: ConversationSurface = "slack",
  timezone?: string
): boolean {
  const effectivePolicy = policy ?? defaultReplyPolicy();
  const rule = selectRule(effectivePolicy, surface);
  const businessHours = rule.businessHours ?? DEFAULT_BUSINESS_HOURS;
  return !isWithinBusinessHours(currentTime, businessHours, timezone);
}

export { defaultReplyPolicy } from "@/lib/gateway/reply-policy-validate";
