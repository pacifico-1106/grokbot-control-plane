/**
 * D1 Decision Stalled — Stuck Watch Integration Tests
 *
 * Tests for decision stalled item detection in stuck watch.
 * Key invariant: when P1_DECISION_WORKFLOW_ENABLED is OFF,
 * no D1 items are ever generated.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ApprovalRequest } from "@/lib/types";

const originalEnv = { ...process.env };

function makeDecisionApproval(
  overrides: Partial<ApprovalRequest> = {},
  metadataOverrides: Record<string, unknown> = {}
): ApprovalRequest {
  const now = new Date();
  return {
    id: "apr_decision_1",
    orgId: DEMO_ORG.id,
    employeeId: "emp_requester",
    credentialId: "cred_requester",
    title: "サーバー増設費用決裁",
    purpose: "decision.request",
    summary: "【T2】サーバー増設費用決裁\n金額: 1,000,000円(税込)",
    risk: "medium" as const,
    status: "pending" as const,
    tool: "decision.request",
    jobId: "job_decision_1",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    telegramRef: null,
    telegramMessageId: null,
    metadata: {
      type: "decision_request",
      tier: "T2",
      approvedCount: 0,
      rejectedCount: 0,
      totalVoters: 3,
      quorumRequired: 2,
      votes: [],
      ...metadataOverrides,
    },
    statusToken: "token_decision_1",
    pollPath: "/api/approvals/status?id=apr_decision_1&token=token_decision_1",
    createdAt: new Date(now.getTime() - 48 * 60 * 60_000).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe("D1 decision stalled — flag OFF behavior", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.P1_DECISION_WORKFLOW_ENABLED = "false";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("checkDecisionStalled returns null when flag is OFF", async () => {
    const { checkDecisionStalled } = await import(
      "@/lib/decision-workflow/progress"
    );

    const state = {
      approvalId: "apr_decision_1",
      tier: "T2" as const,
      status: "pending" as const,
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 3,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: null,
      createdAt: new Date(Date.now() - 48 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = checkDecisionStalled(state, new Date());
    expect(result).toBeNull();
  });

  test("handleT2Expiry returns unchanged when flag is OFF", async () => {
    const { handleT2Expiry } = await import(
      "@/lib/decision-workflow/progress"
    );

    const state = {
      approvalId: "apr_decision_1",
      tier: "T2" as const,
      status: "pending" as const,
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 3,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(Date.now() - 1000),
      createdAt: new Date(Date.now() - 72 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = handleT2Expiry(state, new Date());
    expect(result.expired).toBe(false);
    expect(result.status).toBe("unchanged");
    expect(result.reason).toBe("decision_workflow_disabled");
  });

  test("isDecisionRequest returns false when flag is OFF", async () => {
    const { isDecisionRequest } = await import("@/lib/decision-workflow/notify");

    const approval = makeDecisionApproval();
    const result = isDecisionRequest(approval);
    expect(result).toBe(false);
  });

  test("sendDecisionVotingCard returns empty when flag is OFF", async () => {
    const { sendDecisionVotingCard } = await import(
      "@/lib/decision-workflow/notify"
    );

    const approval = makeDecisionApproval();
    const results = await sendDecisionVotingCard(approval);
    expect(results).toEqual([]);
  });
});

describe("D1 decision stalled — flag ON behavior", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.P1_DECISION_WORKFLOW_ENABLED = "true";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("checkDecisionStalled detects no_votes after 1 day", async () => {
    const { checkDecisionStalled } = await import(
      "@/lib/decision-workflow/progress"
    );

    const state = {
      approvalId: "apr_decision_1",
      tier: "T2" as const,
      status: "pending" as const,
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 3,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: null,
      createdAt: new Date(Date.now() - 48 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = checkDecisionStalled(state, new Date());
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("no_votes");
    expect(result?.kind).toBe("decision_stalled");
  });

  test("checkDecisionStalled detects deadline_approaching", async () => {
    const { checkDecisionStalled } = await import(
      "@/lib/decision-workflow/progress"
    );

    const now = new Date();
    const state = {
      approvalId: "apr_decision_1",
      tier: "T2" as const,
      status: "pending" as const,
      votes: [
        { voterId: "user_1", vote: "approve" as const, votedAt: new Date() },
      ],
      approvedCount: 1,
      rejectedCount: 0,
      pendingCount: 2,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(now.getTime() + 12 * 60 * 60_000),
      createdAt: new Date(now.getTime() - 60 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = checkDecisionStalled(state, now);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("deadline_approaching");
  });

  test("checkDecisionStalled detects quorum_unreachable", async () => {
    const { checkDecisionStalled } = await import(
      "@/lib/decision-workflow/progress"
    );

    const state = {
      approvalId: "apr_decision_1",
      tier: "T2" as const,
      status: "pending" as const,
      votes: [
        { voterId: "user_1", vote: "reject" as const, votedAt: new Date() },
        { voterId: "user_2", vote: "reject" as const, votedAt: new Date() },
      ],
      approvedCount: 0,
      rejectedCount: 2,
      pendingCount: 1,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: null,
      createdAt: new Date(Date.now() - 48 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = checkDecisionStalled(state, new Date());
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("quorum_unreachable");
  });

  test("shouldAutoExpire returns true for T2 past deadline", async () => {
    const { shouldAutoExpire } = await import(
      "@/lib/decision-workflow/progress"
    );

    const now = new Date();
    const state = {
      approvalId: "apr_decision_1",
      tier: "T2" as const,
      status: "pending" as const,
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 3,
      totalVoters: 3,
      quorumRequired: 2,
      quorumMet: false,
      deadlineAt: new Date(now.getTime() - 1000),
      createdAt: new Date(now.getTime() - 72 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = shouldAutoExpire(state, now);
    expect(result).toBe(true);
  });

  test("shouldAutoExpire returns false for T1 past deadline", async () => {
    const { shouldAutoExpire } = await import(
      "@/lib/decision-workflow/progress"
    );

    const now = new Date();
    const state = {
      approvalId: "apr_decision_1",
      tier: "T1" as const,
      status: "pending" as const,
      votes: [],
      approvedCount: 0,
      rejectedCount: 0,
      pendingCount: 1,
      totalVoters: 1,
      quorumRequired: 1,
      quorumMet: false,
      deadlineAt: new Date(now.getTime() - 1000),
      createdAt: new Date(now.getTime() - 72 * 60 * 60_000),
      updatedAt: new Date(),
    };

    const result = shouldAutoExpire(state, now);
    expect(result).toBe(false);
  });

  test("isDecisionRequest returns true for decision approval", async () => {
    const { isDecisionRequest } = await import("@/lib/decision-workflow/notify");

    const approval = makeDecisionApproval();
    const result = isDecisionRequest(approval);
    expect(result).toBe(true);
  });

  test("isDecisionRequest returns false for non-decision approval", async () => {
    const { isDecisionRequest } = await import("@/lib/decision-workflow/notify");

    const approval = makeDecisionApproval({}, { type: "regular", tier: undefined });
    const result = isDecisionRequest(approval);
    expect(result).toBe(false);
  });
});

describe("D1 item ID", () => {
  test("stuckWatchKindFromItemId recognizes d1 prefix", async () => {
    const { stuckWatchKindFromItemId } = await import("@/lib/stuck-watch/items");

    expect(stuckWatchKindFromItemId("d1:apr_decision_1")).toBe(
      "d1_decision_stalled"
    );
  });

  test("stuckWatchKindFromItemId returns null for unknown prefix", async () => {
    const { stuckWatchKindFromItemId } = await import("@/lib/stuck-watch/items");

    expect(stuckWatchKindFromItemId("x1:something")).toBeNull();
  });
});
