/**
 * P1 Decision Workflow — Progress Tests
 */

import { describe, expect, test, mock } from "bun:test";
import {
  calculateDecisionProgress,
  checkDecisionStalled,
  shouldAutoExpire,
  generateProgressSummary,
  type DecisionProgressState,
  type DecisionVote,
} from "./progress";

mock.module("@/lib/feature-flags", () => ({
  isDecisionWorkflowEnabled: () => true,
}));

describe("calculateDecisionProgress", () => {
  test("counts votes correctly", () => {
    const votes: DecisionVote[] = [
      { voterId: "user-1", vote: "approve", votedAt: new Date() },
      { voterId: "user-2", vote: "reject", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["user-1", "user-2", "user-3"],
      { type: "count", n: 2 },
      "requester-1",
      []
    );

    expect(result.approvedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.pendingCount).toBe(1);
    expect(result.totalVoters).toBe(3);
  });

  test("excludes requester from voters", () => {
    const votes: DecisionVote[] = [
      { voterId: "requester-1", vote: "approve", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["requester-1", "user-1", "user-2"],
      { type: "any" },
      "requester-1",
      []
    );

    expect(result.approvedCount).toBe(0);
    expect(result.totalVoters).toBe(2);
  });

  test("excludes AI users from voters", () => {
    const votes: DecisionVote[] = [
      { voterId: "ai-1", vote: "approve", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["ai-1", "user-1", "user-2"],
      { type: "any" },
      "requester-1",
      ["ai-1"]
    );

    expect(result.approvedCount).toBe(0);
    expect(result.totalVoters).toBe(2);
  });

  test("detects quorum met with any", () => {
    const votes: DecisionVote[] = [
      { voterId: "user-1", vote: "approve", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["user-1", "user-2", "user-3"],
      { type: "any" },
      "requester-1",
      []
    );

    expect(result.quorumMet).toBe(true);
  });

  test("detects quorum met with count", () => {
    const votes: DecisionVote[] = [
      { voterId: "user-1", vote: "approve", votedAt: new Date() },
      { voterId: "user-2", vote: "approve", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["user-1", "user-2", "user-3"],
      { type: "count", n: 2 },
      "requester-1",
      []
    );

    expect(result.quorumMet).toBe(true);
  });

  test("detects quorum met with all", () => {
    const votes: DecisionVote[] = [
      { voterId: "user-1", vote: "approve", votedAt: new Date() },
      { voterId: "user-2", vote: "approve", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["user-1", "user-2"],
      { type: "all" },
      "requester-1",
      []
    );

    expect(result.quorumMet).toBe(true);
  });

  test("detects quorum not met", () => {
    const votes: DecisionVote[] = [
      { voterId: "user-1", vote: "approve", votedAt: new Date() },
    ];

    const result = calculateDecisionProgress(
      votes,
      ["user-1", "user-2", "user-3"],
      { type: "all" },
      "requester-1",
      []
    );

    expect(result.quorumMet).toBe(false);
  });
});

describe("checkDecisionStalled", () => {
  const baseState: DecisionProgressState = {
    approvalId: "approval-1",
    tier: "T2",
    status: "pending",
    votes: [],
    approvedCount: 0,
    rejectedCount: 0,
    pendingCount: 3,
    totalVoters: 3,
    quorumRequired: 2,
    quorumMet: false,
    deadlineAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  test("detects no votes stall after 1 day", () => {
    const state: DecisionProgressState = {
      ...baseState,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    };

    const stalled = checkDecisionStalled(state);

    expect(stalled).not.toBeNull();
    expect(stalled?.reason).toBe("no_votes");
    expect(stalled?.daysSinceCreation).toBeGreaterThanOrEqual(1);
  });

  test("does not flag as stalled with votes", () => {
    const state: DecisionProgressState = {
      ...baseState,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      votes: [{ voterId: "user-1", vote: "approve", votedAt: new Date() }],
      approvedCount: 1,
      pendingCount: 2,
    };

    const stalled = checkDecisionStalled(state);

    expect(stalled).toBeNull();
  });

  test("detects deadline approaching", () => {
    const state: DecisionProgressState = {
      ...baseState,
      deadlineAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      votes: [{ voterId: "user-1", vote: "approve", votedAt: new Date() }],
      approvedCount: 1,
      pendingCount: 2,
    };

    const stalled = checkDecisionStalled(state);

    expect(stalled).not.toBeNull();
    expect(stalled?.reason).toBe("deadline_approaching");
  });

  test("detects quorum unreachable", () => {
    const state: DecisionProgressState = {
      ...baseState,
      votes: [
        { voterId: "user-1", vote: "reject", votedAt: new Date() },
        { voterId: "user-2", vote: "reject", votedAt: new Date() },
      ],
      approvedCount: 0,
      rejectedCount: 2,
      pendingCount: 1,
    };

    const stalled = checkDecisionStalled(state);

    expect(stalled).not.toBeNull();
    expect(stalled?.reason).toBe("quorum_unreachable");
  });

  test("does not flag non-pending status", () => {
    const state: DecisionProgressState = {
      ...baseState,
      status: "approved",
    };

    const stalled = checkDecisionStalled(state);

    expect(stalled).toBeNull();
  });
});

describe("shouldAutoExpire", () => {
  test("returns true for T2 past deadline", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "pending",
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 2,
      totalVoters: 2,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(shouldAutoExpire(state)).toBe(true);
  });

  test("returns false for T2 before deadline", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "pending",
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 2,
      totalVoters: 2,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(shouldAutoExpire(state)).toBe(false);
  });

  test("returns false for T1 past deadline", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T1",
      status: "pending",
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 1,
      totalVoters: 1,
      quorumRequired: 1,
      quorumMet: false,
      deadlineAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(shouldAutoExpire(state)).toBe(false);
  });

  test("returns false for T3 past deadline", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T3",
      status: "pending",
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 4,
      totalVoters: 4,
      quorumRequired: "all",
      quorumMet: false,
      deadlineAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(shouldAutoExpire(state)).toBe(false);
  });

  test("returns false for non-pending status", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "approved",
      votes: [],
      approvedCount: 2,
      rejectedCount: 0,
      pendingCount: 0,
      totalVoters: 2,
      quorumRequired: 2,
      quorumMet: true,
      deadlineAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(shouldAutoExpire(state)).toBe(false);
  });
});

describe("generateProgressSummary", () => {
  test("generates summary with quorum not met", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "pending",
      votes: [{ voterId: "user-1", vote: "approve", votedAt: new Date() }],
      approvedCount: 1,
      rejectedCount: 0,
      pendingCount: 2,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const summary = generateProgressSummary(state);

    expect(summary).toContain("T2");
    expect(summary).toContain("1/3名承認");
    expect(summary).toContain("残り1名の承認が必要");
  });

  test("generates summary with quorum met", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T1",
      status: "pending",
      votes: [{ voterId: "user-1", vote: "approve", votedAt: new Date() }],
      approvedCount: 1,
      rejectedCount: 0,
      pendingCount: 0,
      totalVoters: 1,
      quorumRequired: 1,
      quorumMet: true,
      deadlineAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const summary = generateProgressSummary(state);

    expect(summary).toContain("✓ Quorum達成");
  });

  test("shows rejections in summary", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "pending",
      votes: [
        { voterId: "user-1", vote: "approve", votedAt: new Date() },
        { voterId: "user-2", vote: "reject", votedAt: new Date() },
      ],
      approvedCount: 1,
      rejectedCount: 1,
      pendingCount: 1,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const summary = generateProgressSummary(state);

    expect(summary).toContain("1名却下");
  });

  test("shows deadline info", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "pending",
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 2,
      totalVoters: 2,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const summary = generateProgressSummary(state);

    expect(summary).toContain("期限まで");
    expect(summary).toContain("時間");
  });

  test("shows expired deadline", () => {
    const state: DecisionProgressState = {
      approvalId: "approval-1",
      tier: "T2",
      status: "pending",
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 2,
      totalVoters: 2,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const summary = generateProgressSummary(state);

    expect(summary).toContain("⚠️ 期限切れ");
  });
});
