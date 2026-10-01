/**
 * P1 Decision Workflow — Result Recording
 *
 * Record decision results and generate minutes output.
 * Results are returned to requester but NOT to Connect shared channels.
 */

import type { DecisionTier } from "@/lib/approval-kind-routes/types";
import type { DecisionVote, DecisionProgressState } from "./progress";
import { isDecisionWorkflowEnabled } from "@/lib/feature-flags";

/**
 * Decision result status.
 */
export type DecisionResultStatus = "approved" | "rejected" | "expired" | "withdrawn";

/**
 * Decision result record.
 */
export interface DecisionResult {
  approvalId: string;
  orgId: string;
  requesterId: string;
  tier: DecisionTier;
  status: DecisionResultStatus;
  title: string;
  summary: string;
  amountJpy?: number;
  taxExcludedAmountJpy?: number;
  category?: string;
  fiscalYear: string;
  votes: DecisionVote[];
  approvedCount: number;
  rejectedCount: number;
  totalVoters: number;
  quorumRequired: number | "all" | { type: "weight"; min: number };
  createdAt: Date;
  resolvedAt: Date;
  deadline?: Date | null;
  expirationReason?: string;
  minutes?: DecisionMinutes;
  /** Weighted vote totals (present when voterWeights are configured) */
  weighted?: {
    approvedWeight: number;
    rejectedWeight: number;
    totalWeight: number;
  };
}

/**
 * Vote detail entry with optional weight.
 */
export interface VoteDetailEntry {
  name: string;
  weight?: number;
}

/**
 * Minutes (議事録) output format.
 */
export interface DecisionMinutes {
  documentId: string;
  title: string;
  meetingDate: string;
  tier: DecisionTier;
  tierLabel: string;
  matter: string;
  description: string;
  resolution: string;
  voteDetails: {
    approved: string[] | VoteDetailEntry[];
    rejected: string[] | VoteDetailEntry[];
    abstained: string[] | VoteDetailEntry[];
    notVoted: string[] | VoteDetailEntry[];
  };
  remarks?: string[];
  generatedAt: string;
  /** Present when weighted voting was used */
  weightedSummary?: {
    approvedWeight: number;
    rejectedWeight: number;
    totalWeight: number;
    requiredWeight?: number;
  };
}

/**
 * Return notification configuration.
 */
export interface ReturnNotificationConfig {
  channelId?: string;
  userId?: string;
  surface: "slack" | "telegram" | "line" | "email";
  excludeConnectSharedChannels: boolean;
}

const TIER_LABELS: Record<DecisionTier, string> = {
  T1: "専決",
  T2: "理事過半数",
  T3: "社員総会",
};

const STATUS_LABELS: Record<DecisionResultStatus, string> = {
  approved: "承認",
  rejected: "却下",
  expired: "期限切れ",
  withdrawn: "取り下げ",
};

/**
 * Record decision result from progress state.
 */
export function recordDecisionResult(
  state: DecisionProgressState,
  metadata: Record<string, unknown>
): DecisionResult {
  const status: DecisionResultStatus =
    state.status === "approved"
      ? "approved"
      : state.status === "rejected"
        ? "rejected"
        : state.status === "expired"
          ? "expired"
          : "withdrawn";

  const result: DecisionResult = {
    approvalId: state.approvalId,
    orgId: (metadata.orgId as string) || "",
    requesterId: (metadata.requesterId as string) || "",
    tier: state.tier,
    status,
    title: (metadata.title as string) || "",
    summary: (metadata.summary as string) || "",
    amountJpy: (metadata.amountJpy as number) || undefined,
    taxExcludedAmountJpy: (metadata.taxExcludedAmountJpy as number) || undefined,
    category: (metadata.category as string) || undefined,
    fiscalYear: (metadata.fiscalYear as string) || "",
    votes: state.votes,
    approvedCount: state.approvedCount,
    rejectedCount: state.rejectedCount,
    totalVoters: state.totalVoters,
    quorumRequired: state.quorumRequired,
    createdAt: state.createdAt,
    resolvedAt: new Date(),
    deadline: state.deadlineAt,
    expirationReason: state.status === "expired" ? "deadline_exceeded" : undefined,
  };

  if (state.weighted) {
    result.weighted = {
      approvedWeight: state.weighted.approvedWeight,
      rejectedWeight: state.weighted.rejectedWeight,
      totalWeight: state.weighted.totalWeight,
    };
  }

  return result;
}

/**
 * Generate minutes (議事録) from decision result.
 */
export function generateDecisionMinutes(
  result: DecisionResult,
  approverNames: Record<string, string> = {},
  voterWeights?: Record<string, number>
): DecisionMinutes {
  const documentId = `MIN-${result.approvalId.slice(0, 8)}-${Date.now().toString(36)}`;

  const hasWeights = voterWeights && Object.keys(voterWeights).length > 0;

  const resolveNames = (userIds: string[]): string[] | VoteDetailEntry[] => {
    if (hasWeights) {
      return userIds.map((id) => ({
        name: approverNames[id] || id,
        weight: voterWeights[id],
      }));
    }
    return userIds.map((id) => approverNames[id] || id);
  };

  const approvedUserIds = result.votes.filter((v) => v.vote === "approve").map((v) => v.voterId);
  const rejectedUserIds = result.votes.filter((v) => v.vote === "reject").map((v) => v.voterId);
  const abstainedUserIds = result.votes.filter((v) => v.vote === "abstain").map((v) => v.voterId);
  const votedUserIds = new Set(result.votes.map((v) => v.voterId));
  const notVotedUserIds: string[] = [];

  const resolution = generateResolutionText(result);
  const remarks: string[] = [];

  if (result.status === "expired") {
    remarks.push(`期限切れにより${result.tier === "T2" ? "自動却下" : "未決"}となりました。`);
  }

  if (result.category) {
    remarks.push(`分類: ${result.category}`);
  }

  if (result.amountJpy) {
    remarks.push(`金額: ${result.amountJpy.toLocaleString()}円`);
    if (result.taxExcludedAmountJpy) {
      remarks.push(`税抜金額: ${result.taxExcludedAmountJpy.toLocaleString()}円`);
    }
  }

  const minutes: DecisionMinutes = {
    documentId,
    title: `決裁議事録: ${result.title}`,
    meetingDate: result.resolvedAt.toISOString().split("T")[0],
    tier: result.tier,
    tierLabel: TIER_LABELS[result.tier],
    matter: result.title,
    description: result.summary,
    resolution,
    voteDetails: {
      approved: resolveNames(approvedUserIds),
      rejected: resolveNames(rejectedUserIds),
      abstained: resolveNames(abstainedUserIds),
      notVoted: resolveNames(notVotedUserIds),
    },
    remarks: remarks.length > 0 ? remarks : undefined,
    generatedAt: new Date().toISOString(),
  };

  if (result.weighted) {
    const requiredWeight =
      typeof result.quorumRequired === "object" && result.quorumRequired.type === "weight"
        ? result.quorumRequired.min
        : undefined;

    minutes.weightedSummary = {
      approvedWeight: result.weighted.approvedWeight,
      rejectedWeight: result.weighted.rejectedWeight,
      totalWeight: result.weighted.totalWeight,
      requiredWeight,
    };
  }

  return minutes;
}

/**
 * Generate resolution text.
 */
function generateResolutionText(result: DecisionResult): string {
  const statusLabel = STATUS_LABELS[result.status];
  const tierLabel = TIER_LABELS[result.tier];

  let quorumText: string;
  if (typeof result.quorumRequired === "object" && result.quorumRequired.type === "weight") {
    quorumText = `${result.quorumRequired.min}pt以上の承認`;
  } else if (result.quorumRequired === "all") {
    quorumText = "全員の承認";
  } else {
    quorumText = `${result.quorumRequired}名以上の承認`;
  }

  if (result.status === "approved") {
    if (result.weighted) {
      return `本議案は${tierLabel}決裁により${statusLabel}されました。` +
        `（${result.weighted.approvedWeight}pt承認 / ${result.weighted.totalWeight}pt中、${quorumText}を達成）`;
    }
    return `本議案は${tierLabel}決裁により${statusLabel}されました。` +
      `（${result.approvedCount}名承認 / ${result.totalVoters}名中、${quorumText}を達成）`;
  }

  if (result.status === "rejected") {
    if (result.weighted) {
      return `本議案は${tierLabel}決裁により${statusLabel}されました。` +
        `（${result.weighted.rejectedWeight}pt却下 / ${result.weighted.totalWeight}pt中）`;
    }
    return `本議案は${tierLabel}決裁により${statusLabel}されました。` +
      `（${result.rejectedCount}名却下 / ${result.totalVoters}名中）`;
  }

  if (result.status === "expired") {
    if (result.tier === "T2") {
      if (result.weighted) {
        return `本議案は期限切れにより自動却下されました。` +
          `（${result.weighted.approvedWeight}pt承認 / ${result.weighted.totalWeight}pt中、${quorumText}未達成）`;
      }
      return `本議案は期限切れにより自動却下されました。` +
        `（${result.approvedCount}名承認 / ${result.totalVoters}名中、${quorumText}未達成）`;
    }
    return `本議案は期限切れとなりました。再申請が必要です。`;
  }

  return `本議案は取り下げられました。`;
}

/**
 * Format vote detail entries as text.
 */
function formatVoteEntries(entries: string[] | VoteDetailEntry[]): string {
  if (entries.length === 0) return "";

  if (typeof entries[0] === "string") {
    return (entries as string[]).join(", ");
  }

  return (entries as VoteDetailEntry[])
    .map((e) => (e.weight !== undefined ? `${e.name} (${e.weight}pt)` : e.name))
    .join(", ");
}

/**
 * Format minutes as Markdown.
 */
export function formatMinutesAsMarkdown(minutes: DecisionMinutes): string {
  const lines: string[] = [
    `# ${minutes.title}`,
    "",
    `**文書ID:** ${minutes.documentId}`,
    `**日付:** ${minutes.meetingDate}`,
    `**決裁区分:** ${minutes.tier} (${minutes.tierLabel})`,
    "",
    "## 議案",
    "",
    minutes.matter,
    "",
    "## 内容",
    "",
    minutes.description,
    "",
    "## 決議",
    "",
    minutes.resolution,
    "",
    "## 投票詳細",
    "",
  ];

  if (minutes.weightedSummary) {
    lines.push(`**投票ポイント集計:** 承認 ${minutes.weightedSummary.approvedWeight}pt / 却下 ${minutes.weightedSummary.rejectedWeight}pt / 合計 ${minutes.weightedSummary.totalWeight}pt`);
    if (minutes.weightedSummary.requiredWeight !== undefined) {
      lines.push(`**必要ポイント:** ${minutes.weightedSummary.requiredWeight}pt`);
    }
    lines.push("");
  }

  if (minutes.voteDetails.approved.length > 0) {
    lines.push(`**承認:** ${formatVoteEntries(minutes.voteDetails.approved)}`);
  }
  if (minutes.voteDetails.rejected.length > 0) {
    lines.push(`**却下:** ${formatVoteEntries(minutes.voteDetails.rejected)}`);
  }
  if (minutes.voteDetails.abstained.length > 0) {
    lines.push(`**棄権:** ${formatVoteEntries(minutes.voteDetails.abstained)}`);
  }
  if (minutes.voteDetails.notVoted.length > 0) {
    lines.push(`**未投票:** ${formatVoteEntries(minutes.voteDetails.notVoted)}`);
  }

  if (minutes.remarks && minutes.remarks.length > 0) {
    lines.push("", "## 備考", "");
    for (const remark of minutes.remarks) {
      lines.push(`- ${remark}`);
    }
  }

  lines.push("", "---", `*生成日時: ${minutes.generatedAt}*`);

  return lines.join("\n");
}

/**
 * Format minutes as JSON for storage.
 */
export function formatMinutesAsJson(minutes: DecisionMinutes): string {
  return JSON.stringify(minutes, null, 2);
}

/**
 * Check if channel is a Connect shared channel.
 * Connect shared channels should NOT receive decision results.
 */
export function isConnectSharedChannel(channelId: string): boolean {
  return channelId.startsWith("C") && channelId.includes("-");
}

/**
 * Validate return notification target.
 * Returns error if target is a Connect shared channel.
 */
export function validateReturnTarget(
  config: ReturnNotificationConfig
): { ok: true } | { ok: false; error: string } {
  if (!isDecisionWorkflowEnabled()) {
    return { ok: false, error: "decision_workflow_disabled" };
  }

  if (config.excludeConnectSharedChannels && config.channelId) {
    if (isConnectSharedChannel(config.channelId)) {
      return {
        ok: false,
        error: "connect_shared_channel_forbidden",
      };
    }
  }

  return { ok: true };
}

/**
 * Build return notification message.
 */
export function buildReturnNotification(result: DecisionResult): {
  text: string;
  blocks?: unknown[];
} {
  const statusLabel = STATUS_LABELS[result.status];
  const tierLabel = TIER_LABELS[result.tier];
  const emoji = result.status === "approved" ? "✅" : result.status === "rejected" ? "❌" : "⚠️";

  const text = `${emoji} 【${tierLabel}決裁結果】${result.title}: ${statusLabel}`;

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} 【${tierLabel}決裁結果】${statusLabel}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${result.title}*\n${result.summary}`,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Tier:*\n${result.tier} (${tierLabel})`,
        },
        {
          type: "mrkdwn",
          text: `*結果:*\n${statusLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*投票:*\n${result.approvedCount}名承認 / ${result.totalVoters}名`,
        },
        {
          type: "mrkdwn",
          text: `*会計年度:*\n${result.fiscalYear}`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `決裁ID: ${result.approvalId} | 完了日時: ${result.resolvedAt.toLocaleString("ja-JP")}`,
        },
      ],
    },
  ];

  return { text, blocks };
}
