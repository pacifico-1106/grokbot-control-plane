/**
 * P1 Decision Workflow — Topic-Gated Posting
 *
 * Gate posts based on topic sensitivity.
 * Sensitive topics require human approval even for routine posts.
 * P1_TOPIC_GATED_POSTING_ENABLED must be ON.
 */

import { isTopicGatedPostingEnabled } from "@/lib/feature-flags";
import type { TopicGateConfig } from "@/lib/approval-kind-routes/types";

/**
 * Topic gate check result.
 */
export interface TopicGateCheckResult {
  allowed: boolean;
  requiresApproval: boolean;
  matchedTopics: string[];
  reason: string;
}

/**
 * Default sensitive topics.
 * Re-exported from presets for backward compatibility.
 * Note: These are used ONLY when generating a new default config.
 * An explicit empty sensitiveTopics array in config means "no topics".
 */
import { DEFAULT_SENSITIVE_TOPICS as PRESET_DEFAULT_SENSITIVE_TOPICS } from "@/lib/approval-kind-routes/presets";
export const DEFAULT_SENSITIVE_TOPICS: readonly string[] = PRESET_DEFAULT_SENSITIVE_TOPICS;

/**
 * Check if content contains sensitive topics.
 */
export function containsSensitiveTopic(
  content: string,
  sensitiveTopics: readonly string[]
): string[] {
  const normalizedContent = content.toLowerCase();
  const matched: string[] = [];

  for (const topic of sensitiveTopics) {
    if (normalizedContent.includes(topic.toLowerCase())) {
      matched.push(topic);
    }
  }

  return matched;
}

/**
 * Check if channel is a main board channel.
 * Main board channels have stricter topic gates.
 */
export function isMainBoardChannel(
  channelId: string,
  mainBoardChannelIds: string[]
): boolean {
  return mainBoardChannelIds.includes(channelId);
}

/**
 * Check topic gate for a post.
 *
 * Returns whether the post is allowed without approval.
 * If requiresApproval is true, the post must go through approval workflow.
 */
export function checkTopicGate(
  content: string,
  channelId: string | null,
  config: TopicGateConfig | null
): TopicGateCheckResult {
  if (!isTopicGatedPostingEnabled()) {
    return {
      allowed: true,
      requiresApproval: false,
      matchedTopics: [],
      reason: "topic_gate_disabled",
    };
  }

  if (!config || !config.enabled) {
    return {
      allowed: true,
      requiresApproval: false,
      matchedTopics: [],
      reason: "topic_gate_not_configured",
    };
  }

  // Use config's sensitiveTopics directly.
  // Empty array = org explicitly wants no sensitive topics.
  // No fallback to default - that only happens when generating new config.
  const sensitiveTopics = config.sensitiveTopics;

  const matchedTopics = containsSensitiveTopic(content, sensitiveTopics);

  if (matchedTopics.length === 0) {
    return {
      allowed: true,
      requiresApproval: false,
      matchedTopics: [],
      reason: "no_sensitive_topic",
    };
  }

  const isMainBoard = channelId
    ? isMainBoardChannel(channelId, config.mainBoardChannelIds)
    : false;

  if (isMainBoard) {
    return {
      allowed: false,
      requiresApproval: true,
      matchedTopics,
      reason: "main_board_sensitive_topic",
    };
  }

  return {
    allowed: false,
    requiresApproval: true,
    matchedTopics,
    reason: "sensitive_topic_requires_approval",
  };
}

/**
 * Build topic gate approval request metadata.
 */
export function buildTopicGateApprovalMetadata(
  content: string,
  channelId: string | null,
  matchedTopics: string[],
  employeeId: string
): Record<string, unknown> {
  return {
    type: "topic_gated_post",
    employeeId,
    channelId,
    contentPreview: content.slice(0, 200) + (content.length > 200 ? "..." : ""),
    matchedTopics,
    gatedAt: new Date().toISOString(),
  };
}

/**
 * Format topic gate approval card.
 */
export function formatTopicGateCard(
  content: string,
  matchedTopics: string[],
  channelId: string | null
): {
  title: string;
  summary: string;
  risk: string;
} {
  const topicsStr = matchedTopics.join(", ");

  return {
    title: `機密話題を含む投稿の承認依頼`,
    summary: `${channelId ? `チャネル: ${channelId}\n` : ""}` +
      `検出された話題: ${topicsStr}\n\n` +
      `内容:\n${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`,
    risk: "high",
  };
}

/**
 * Validate topic gate config.
 */
export function validateTopicGateConfig(
  config: unknown
): { ok: true; config: TopicGateConfig } | { ok: false; errors: string[] } {
  if (!config || typeof config !== "object") {
    return { ok: false, errors: ["config_required"] };
  }

  const c = config as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof c.enabled !== "boolean") {
    errors.push("enabled_must_be_boolean");
  }

  if (!Array.isArray(c.sensitiveTopics)) {
    errors.push("sensitiveTopics_must_be_array");
  } else {
    for (let i = 0; i < c.sensitiveTopics.length; i++) {
      if (typeof c.sensitiveTopics[i] !== "string" || c.sensitiveTopics[i].trim().length === 0) {
        errors.push(`sensitiveTopics[${i}]_must_be_non_empty_string`);
      }
    }
  }

  if (!Array.isArray(c.mainBoardChannelIds)) {
    errors.push("mainBoardChannelIds_must_be_array");
  } else {
    for (let i = 0; i < c.mainBoardChannelIds.length; i++) {
      if (typeof c.mainBoardChannelIds[i] !== "string") {
        errors.push(`mainBoardChannelIds[${i}]_must_be_string`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      enabled: c.enabled as boolean,
      sensitiveTopics: (c.sensitiveTopics as string[]).map((t) => t.trim()),
      mainBoardChannelIds: c.mainBoardChannelIds as string[],
    },
  };
}

/**
 * Create default topic gate config.
 */
export function createDefaultTopicGateConfig(): TopicGateConfig {
  return {
    enabled: false,
    sensitiveTopics: [...DEFAULT_SENSITIVE_TOPICS],
    mainBoardChannelIds: [],
  };
}
