/**
 * P1 Decision Workflow — Result Recording Tests
 */

import { describe, expect, test, mock } from "bun:test";
import {
  recordDecisionResult,
  generateDecisionMinutes,
  formatMinutesAsMarkdown,
  isConnectSharedChannel,
  validateReturnTarget,
  buildReturnNotification,
  type DecisionResult,
} from "./result";
import type { DecisionProgressState, DecisionVote } from "./progress";

mock.module("@/lib/feature-flags", () => ({
  isDecisionWorkflowEnabled: () => true,
}));

const baseVotes: DecisionVote[] = [
  { voterId: "user-1", vote: "approve", votedAt: new Date() },
  { voterId: "user-2", vote: "approve", votedAt: new Date() },
  { voterId: "user-3", vote: "reject", votedAt: new Date() },
];

const baseProgressState: DecisionProgressState = {
  approvalId: "approval-1",
  tier: "T2",
  status: "approved",
  votes: baseVotes,
  approvedCount: 2,
  rejectedCount: 1,
  pendingCount: 0,
  totalVoters: 3,
  quorumRequired: 2,
  quorumMet: true,
  deadlineAt: null,
  createdAt: new Date("2024-04-01T10:00:00Z"),
  updatedAt: new Date("2024-04-02T14:00:00Z"),
};

const baseMetadata = {
  orgId: "org-1",
  requesterId: "emp-1",
  title: "サーバー購入稟議",
  summary: "開発環境用サーバーの購入",
  amountJpy: 550000,
  taxExcludedAmountJpy: 500000,
  category: "備品",
  fiscalYear: "FY2024",
};

describe("recordDecisionResult", () => {
  test("records approved result", () => {
    const result = recordDecisionResult(baseProgressState, baseMetadata);

    expect(result.status).toBe("approved");
    expect(result.approvalId).toBe("approval-1");
    expect(result.tier).toBe("T2");
    expect(result.title).toBe("サーバー購入稟議");
    expect(result.amountJpy).toBe(550000);
    expect(result.fiscalYear).toBe("FY2024");
    expect(result.approvedCount).toBe(2);
    expect(result.rejectedCount).toBe(1);
  });

  test("records rejected result", () => {
    const state: DecisionProgressState = {
      ...baseProgressState,
      status: "rejected",
      approvedCount: 1,
      rejectedCount: 2,
      quorumMet: false,
    };

    const result = recordDecisionResult(state, baseMetadata);

    expect(result.status).toBe("rejected");
    expect(result.rejectedCount).toBe(2);
  });

  test("records expired result", () => {
    const state: DecisionProgressState = {
      ...baseProgressState,
      status: "expired",
      deadlineAt: new Date("2024-04-02T10:00:00Z"),
    };

    const result = recordDecisionResult(state, baseMetadata);

    expect(result.status).toBe("expired");
    expect(result.expirationReason).toBe("deadline_exceeded");
  });
});

describe("generateDecisionMinutes", () => {
  test("generates minutes with vote details", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T2",
      status: "approved",
      votes: baseVotes,
      approvedCount: 2,
      rejectedCount: 1,
      totalVoters: 3,
      quorumRequired: 2,
      createdAt: new Date("2024-04-01T10:00:00Z"),
      resolvedAt: new Date("2024-04-02T14:00:00Z"),
    };

    const approverNames = {
      "user-1": "田中太郎",
      "user-2": "鈴木花子",
      "user-3": "佐藤次郎",
    };

    const minutes = generateDecisionMinutes(result, approverNames);

    expect(minutes.documentId).toMatch(/^MIN-/);
    expect(minutes.title).toContain("サーバー購入稟議");
    expect(minutes.tier).toBe("T2");
    expect(minutes.tierLabel).toBe("理事過半数");
    expect(minutes.voteDetails.approved).toContain("田中太郎");
    expect(minutes.voteDetails.approved).toContain("鈴木花子");
    expect(minutes.voteDetails.rejected).toContain("佐藤次郎");
  });

  test("includes resolution text for approval", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T1",
      status: "approved",
      votes: [{ voterId: "user-1", vote: "approve", votedAt: new Date() }],
      approvedCount: 1,
      rejectedCount: 0,
      totalVoters: 1,
      quorumRequired: 1,
      createdAt: new Date(),
      resolvedAt: new Date(),
    };

    const minutes = generateDecisionMinutes(result);

    expect(minutes.resolution).toContain("承認されました");
    expect(minutes.resolution).toContain("専決");
  });

  test("includes expiration remarks for expired T2", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T2",
      status: "expired",
      votes: baseVotes,
      approvedCount: 1,
      rejectedCount: 0,
      totalVoters: 3,
      quorumRequired: 2,
      createdAt: new Date(),
      resolvedAt: new Date(),
      deadline: new Date(),
    };

    const minutes = generateDecisionMinutes(result);

    expect(minutes.resolution).toContain("期限切れ");
    expect(minutes.resolution).toContain("自動却下");
  });

  test("includes amount remarks", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T2",
      status: "approved",
      votes: baseVotes,
      approvedCount: 2,
      rejectedCount: 1,
      totalVoters: 3,
      quorumRequired: 2,
      createdAt: new Date(),
      resolvedAt: new Date(),
    };

    const minutes = generateDecisionMinutes(result);

    expect(minutes.remarks).toBeDefined();
    expect(minutes.remarks?.some((r) => r.includes("550,000円"))).toBe(true);
  });
});

describe("formatMinutesAsMarkdown", () => {
  test("formats minutes as markdown", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T2",
      status: "approved",
      votes: baseVotes,
      approvedCount: 2,
      rejectedCount: 1,
      totalVoters: 3,
      quorumRequired: 2,
      createdAt: new Date(),
      resolvedAt: new Date(),
    };

    const minutes = generateDecisionMinutes(result, {
      "user-1": "田中太郎",
      "user-2": "鈴木花子",
      "user-3": "佐藤次郎",
    });
    const markdown = formatMinutesAsMarkdown(minutes);

    expect(markdown).toContain("# 決裁議事録:");
    expect(markdown).toContain("## 議案");
    expect(markdown).toContain("## 内容");
    expect(markdown).toContain("## 決議");
    expect(markdown).toContain("## 投票詳細");
    expect(markdown).toContain("**承認:**");
    expect(markdown).toContain("田中太郎");
  });
});

describe("isConnectSharedChannel", () => {
  test("detects Connect shared channel", () => {
    expect(isConnectSharedChannel("C01ABC-DEF")).toBe(true);
  });

  test("does not flag regular channel", () => {
    expect(isConnectSharedChannel("C01ABCDEF")).toBe(false);
  });

  test("does not flag DM", () => {
    expect(isConnectSharedChannel("D01ABCDEF")).toBe(false);
  });
});

describe("validateReturnTarget", () => {
  test("allows regular channel", () => {
    const result = validateReturnTarget({
      channelId: "C01ABCDEF",
      surface: "slack",
      excludeConnectSharedChannels: true,
    });

    expect(result.ok).toBe(true);
  });

  test("rejects Connect shared channel", () => {
    const result = validateReturnTarget({
      channelId: "C01ABC-DEF",
      surface: "slack",
      excludeConnectSharedChannels: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("connect_shared_channel_forbidden");
    }
  });

  test("allows Connect shared channel when not excluded", () => {
    const result = validateReturnTarget({
      channelId: "C01ABC-DEF",
      surface: "slack",
      excludeConnectSharedChannels: false,
    });

    expect(result.ok).toBe(true);
  });

  test("allows telegram", () => {
    const result = validateReturnTarget({
      userId: "user-1",
      surface: "telegram",
      excludeConnectSharedChannels: true,
    });

    expect(result.ok).toBe(true);
  });
});

describe("buildReturnNotification", () => {
  test("builds approved notification", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T2",
      status: "approved",
      votes: baseVotes,
      approvedCount: 2,
      rejectedCount: 1,
      totalVoters: 3,
      quorumRequired: 2,
      createdAt: new Date(),
      resolvedAt: new Date(),
    };

    const notification = buildReturnNotification(result);

    expect(notification.text).toContain("✅");
    expect(notification.text).toContain("承認");
    expect(notification.text).toContain("理事過半数");
    expect(notification.blocks).toBeDefined();
    expect(notification.blocks?.length).toBeGreaterThan(0);
  });

  test("builds rejected notification", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T1",
      status: "rejected",
      votes: [{ voterId: "user-1", vote: "reject", votedAt: new Date() }],
      approvedCount: 0,
      rejectedCount: 1,
      totalVoters: 1,
      quorumRequired: 1,
      createdAt: new Date(),
      resolvedAt: new Date(),
    };

    const notification = buildReturnNotification(result);

    expect(notification.text).toContain("❌");
    expect(notification.text).toContain("却下");
  });

  test("builds expired notification", () => {
    const result: DecisionResult = {
      ...baseMetadata,
      approvalId: "approval-1",
      tier: "T2",
      status: "expired",
      votes: baseVotes,
      approvedCount: 1,
      rejectedCount: 0,
      totalVoters: 3,
      quorumRequired: 2,
      createdAt: new Date(),
      resolvedAt: new Date(),
    };

    const notification = buildReturnNotification(result);

    expect(notification.text).toContain("⚠️");
    expect(notification.text).toContain("期限切れ");
  });
});
