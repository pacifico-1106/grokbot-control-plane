/**
 * P1 Decision Workflow — Voting Card Builder
 *
 * Builds voting cards for decision requests.
 * Cards are delivered via Telegram/LINE/Slack notification channels.
 */

import type { DecisionTier } from "@/lib/approval-kind-routes/types";
import type { ApprovalRequest } from "@/lib/types";

/**
 * Decision voting card content.
 */
export interface DecisionVotingCard {
  title: string;
  tier: DecisionTier;
  tierLabel: string;
  summary: string;
  requesterId: string;
  requesterName?: string;
  amountJpy?: number;
  taxExcludedAmountJpy?: number;
  category?: string;
  fiscalYear?: string;
  deputyUserId?: string | null;
  attachmentCount?: number;
  deadline?: Date | null;
  progress: DecisionProgress;
  actions: DecisionCardAction[];
}

/**
 * Decision approval progress.
 */
export interface DecisionProgress {
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  totalVoters: number;
  quorumRequired: number | "all" | { type: "weight"; min: number };
  quorumMet: boolean;
  deadlineAt?: Date | null;
  isExpired?: boolean;
  /** Weighted totals (present when voterWeights are configured) */
  weighted?: {
    approvedWeight: number;
    rejectedWeight: number;
    pendingWeight: number;
    totalWeight: number;
  };
}

/**
 * Card action buttons.
 */
export interface DecisionCardAction {
  type: "approve" | "reject" | "view_details" | "add_comment";
  label: string;
  callbackData: string;
}

const TIER_LABELS: Record<DecisionTier, string> = {
  T1: "専決",
  T2: "理事過半数",
  T3: "社員総会",
};

/**
 * Build voting card from approval request.
 */
export function buildDecisionVotingCard(
  approval: ApprovalRequest,
  metadata: Record<string, unknown>
): DecisionVotingCard {
  const tier = (metadata.tier as DecisionTier) || "T1";
  const tierLabel = TIER_LABELS[tier] || tier;

  const progress = extractProgress(approval, metadata);
  const deadline = extractDeadline(approval, metadata);

  const actions: DecisionCardAction[] = [
    {
      type: "approve",
      label: "承認",
      callbackData: `decision:approve:${approval.id}`,
    },
    {
      type: "reject",
      label: "却下",
      callbackData: `decision:reject:${approval.id}`,
    },
    {
      type: "view_details",
      label: "詳細を見る",
      callbackData: `decision:view:${approval.id}`,
    },
  ];

  if (tier !== "T1") {
    actions.push({
      type: "add_comment",
      label: "コメント追加",
      callbackData: `decision:comment:${approval.id}`,
    });
  }

  return {
    title: approval.title,
    tier,
    tierLabel,
    summary: approval.summary,
    requesterId: approval.employeeId,
    requesterName: (metadata.requesterName as string) || undefined,
    amountJpy: (metadata.amountJpy as number) || undefined,
    taxExcludedAmountJpy: (metadata.taxExcludedAmountJpy as number) || undefined,
    category: (metadata.category as string) || undefined,
    fiscalYear: (metadata.fiscalYear as string) || undefined,
    deputyUserId: (metadata.deputyUserId as string) || null,
    attachmentCount: Array.isArray(metadata.attachments) ? metadata.attachments.length : 0,
    deadline,
    progress,
    actions,
  };
}

/**
 * Extract progress from approval metadata.
 */
function extractProgress(
  approval: ApprovalRequest,
  metadata: Record<string, unknown>
): DecisionProgress {
  const votes = (metadata.votes as Record<string, string>) || {};
  const approverUserIds = (metadata.approverUserIds as string[]) || [];
  const voterWeights = (metadata.voterWeights as Record<string, number>) || {};
  const hasWeights = Object.keys(voterWeights).length > 0;

  let approvedCount = 0;
  let rejectedCount = 0;
  let pendingCount = 0;

  let approvedWeight = 0;
  let rejectedWeight = 0;
  let pendingWeight = 0;
  let totalWeight = 0;

  for (const voterId of approverUserIds) {
    const vote = votes[voterId];
    const weight = voterWeights[voterId] ?? 1;
    totalWeight += weight;

    if (vote === "approve") {
      approvedCount++;
      approvedWeight += weight;
    } else if (vote === "reject") {
      rejectedCount++;
      rejectedWeight += weight;
    } else {
      pendingCount++;
      pendingWeight += weight;
    }
  }

  const totalVoters = approverUserIds.length;
  const quorum = metadata.quorum as { type: string; n?: number; min?: number } | undefined;
  let quorumRequired: number | "all" | { type: "weight"; min: number } = 1;
  let quorumMet: boolean;

  if (quorum) {
    if (quorum.type === "weight" && typeof quorum.min === "number") {
      quorumRequired = { type: "weight", min: quorum.min };
      quorumMet = approvedWeight >= quorum.min;
    } else if (quorum.type === "all") {
      quorumRequired = "all";
      quorumMet = approvedCount === totalVoters && totalVoters > 0;
    } else if (quorum.type === "count" && typeof quorum.n === "number") {
      quorumRequired = quorum.n;
      quorumMet = approvedCount >= quorumRequired;
    } else {
      quorumMet = approvedCount >= 1;
    }
  } else {
    quorumMet = approvedCount >= 1;
  }

  const deadline = extractDeadline(approval, metadata);
  const isExpired = deadline ? deadline < new Date() : false;

  const result: DecisionProgress = {
    approvedCount,
    rejectedCount,
    pendingCount,
    totalVoters,
    quorumRequired,
    quorumMet,
    deadlineAt: deadline,
    isExpired,
  };

  if (hasWeights) {
    result.weighted = {
      approvedWeight,
      rejectedWeight,
      pendingWeight,
      totalWeight,
    };
  }

  return result;
}

/**
 * Extract deadline from metadata.
 */
function extractDeadline(
  _approval: ApprovalRequest,
  metadata: Record<string, unknown>
): Date | null {
  const deadlineStr = metadata.deadlineAt as string | undefined;
  if (!deadlineStr) return null;

  const deadline = new Date(deadlineStr);
  return isNaN(deadline.getTime()) ? null : deadline;
}

/**
 * Format progress text for display.
 */
function formatProgressText(progress: DecisionProgress): string {
  if (progress.weighted) {
    return `${progress.weighted.approvedWeight}/${progress.weighted.totalWeight}pt`;
  }
  return `${progress.approvedCount}/${progress.totalVoters}名`;
}

/**
 * Format card for Slack.
 */
export function formatDecisionCardForSlack(card: DecisionVotingCard): {
  text: string;
  blocks: unknown[];
} {
  const progressText = formatProgressText(card.progress);

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `【${card.tierLabel}】${card.title}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Tier:*\n${card.tier} (${card.tierLabel})`,
        },
        {
          type: "mrkdwn",
          text: `*進捗:*\n${progressText}`,
        },
      ],
    },
  ];

  if (card.amountJpy) {
    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*金額:*\n${card.amountJpy.toLocaleString()}円`,
        },
        ...(card.taxExcludedAmountJpy
          ? [
              {
                type: "mrkdwn",
                text: `*税抜:*\n${card.taxExcludedAmountJpy.toLocaleString()}円`,
              },
            ]
          : []),
      ],
    });
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: card.summary,
    },
  });

  if (card.deadline) {
    const deadlineText = card.progress.isExpired
      ? `:warning: 期限切れ (${card.deadline.toLocaleString("ja-JP")})`
      : `期限: ${card.deadline.toLocaleString("ja-JP")}`;

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: deadlineText,
        },
      ],
    });
  }

  blocks.push({
    type: "actions",
    elements: card.actions.map((action) => ({
      type: "button",
      text: {
        type: "plain_text",
        text: action.label,
        emoji: true,
      },
      value: action.callbackData,
      style: action.type === "approve" ? "primary" : action.type === "reject" ? "danger" : undefined,
    })),
  });

  return {
    text: `【${card.tierLabel}】${card.title}`,
    blocks,
  };
}

/**
 * Format card for Telegram.
 */
export function formatDecisionCardForTelegram(card: DecisionVotingCard): {
  text: string;
  inlineKeyboard: unknown[][];
} {
  const progressText = formatProgressText(card.progress);

  const lines: string[] = [
    `<b>【${card.tierLabel}】${card.title}</b>`,
    "",
    `<b>Tier:</b> ${card.tier} (${card.tierLabel})`,
    `<b>進捗:</b> ${progressText}`,
  ];

  if (card.amountJpy) {
    lines.push(`<b>金額:</b> ${card.amountJpy.toLocaleString()}円`);
    if (card.taxExcludedAmountJpy) {
      lines.push(`<b>税抜:</b> ${card.taxExcludedAmountJpy.toLocaleString()}円`);
    }
  }

  lines.push("", card.summary);

  if (card.deadline) {
    const deadlineText = card.progress.isExpired
      ? `⚠️ 期限切れ (${card.deadline.toLocaleString("ja-JP")})`
      : `期限: ${card.deadline.toLocaleString("ja-JP")}`;
    lines.push("", deadlineText);
  }

  const keyboard = [
    card.actions
      .filter((a) => a.type === "approve" || a.type === "reject")
      .map((action) => ({
        text: action.label,
        callback_data: action.callbackData,
      })),
    card.actions
      .filter((a) => a.type !== "approve" && a.type !== "reject")
      .map((action) => ({
        text: action.label,
        callback_data: action.callbackData,
      })),
  ].filter((row) => row.length > 0);

  return {
    text: lines.join("\n"),
    inlineKeyboard: keyboard,
  };
}
