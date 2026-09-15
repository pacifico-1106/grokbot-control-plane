/**
 * F8 Approval Workflow Engine Tests
 *
 * AC W1: Default OR/single-approver stays when no workflow policy
 * AC W2: Quorum evaluation (any, count, ratio, majority)
 * AC W3: fail_closed reject behavior
 * AC W4: Stage advancement
 * AC W5: finalGo after stages
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  evaluateQuorum,
  evaluateStageAdvance,
  evaluateFinalGo,
  buildWorkflowProgress,
  shouldCreateWorkflowInstance,
  isVoterInCurrentStage,
  canVoterResolve,
  formatQuorumDisplay,
} from "./engine";
import type {
  ApprovalLane,
  ApprovalWorkflowBallot,
  ApprovalWorkflowInstance,
  OrgApprovalWorkflowPolicy,
  QuorumRule,
} from "@/lib/types";

function makeBallot(
  vote: "approve" | "reject" | null,
  voterUserId: string,
  stageId = "stage_0",
  stageIndex = 0,
  isFinalGo = false
): ApprovalWorkflowBallot {
  return {
    id: `ballot_${Math.random().toString(36).slice(2, 8)}`,
    instanceId: "inst_1",
    orgId: "org_demo",
    stageId,
    stageIndex,
    voterUserId,
    vote,
    votedAt: vote ? new Date().toISOString() : null,
    isFinalGo,
    createdAt: new Date().toISOString(),
  };
}

function makePolicy(
  stages: ApprovalLane[],
  finalGoUserId?: string
): OrgApprovalWorkflowPolicy {
  return {
    version: 1,
    policyId: "awp_test",
    policyName: "テストポリシー",
    stages,
    finalGoUserId,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

function makeInstance(
  policy: OrgApprovalWorkflowPolicy,
  currentStageIndex = 0,
  status: "active" | "approved" | "rejected" = "active",
  finalGoPending = false
): ApprovalWorkflowInstance {
  return {
    id: "inst_1",
    approvalId: "apr_1",
    orgId: "org_demo",
    policyId: policy.policyId,
    policySnapshot: policy,
    currentStageIndex,
    status,
    finalGoPending,
    finalGoUserId: policy.finalGoUserId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("AC W2: evaluateQuorum", () => {
  test("quorum type 'any' requires 1 approve", () => {
    const rule: QuorumRule = { type: "any" };
    const ballots = [
      makeBallot(null, "user_1"),
      makeBallot(null, "user_2"),
      makeBallot(null, "user_3"),
    ];

    let result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(false);
    expect(result.required).toBe(1);
    expect(result.approved).toBe(0);

    ballots[0] = makeBallot("approve", "user_1");
    result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(true);
    expect(result.approved).toBe(1);
  });

  test("quorum type 'count' requires exactly n approves", () => {
    const rule: QuorumRule = { type: "count", n: 2 };
    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot(null, "user_2"),
      makeBallot(null, "user_3"),
    ];

    let result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(false);
    expect(result.required).toBe(2);

    ballots[1] = makeBallot("approve", "user_2");
    result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(true);
    expect(result.approved).toBe(2);
  });

  test("quorum type 'ratio' calculates from numerator/denominator", () => {
    const rule: QuorumRule = { type: "ratio", numerator: 2, denominator: 3 };
    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot(null, "user_2"),
      makeBallot(null, "user_3"),
    ];

    let result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(false);
    expect(result.required).toBe(2);

    ballots[1] = makeBallot("approve", "user_2");
    result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(true);
    expect(result.approved).toBe(2);
  });

  test("quorum type 'majority' requires floor(n/2) + 1", () => {
    const rule: QuorumRule = { type: "majority" };
    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot(null, "user_2"),
      makeBallot(null, "user_3"),
    ];

    let result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(false);
    expect(result.required).toBe(2);

    ballots[1] = makeBallot("approve", "user_2");
    result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(true);
  });

  test("majority with 5 voters requires 3", () => {
    const rule: QuorumRule = { type: "majority" };
    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot("approve", "user_2"),
      makeBallot(null, "user_3"),
      makeBallot(null, "user_4"),
      makeBallot(null, "user_5"),
    ];

    let result = evaluateQuorum(rule, ballots);
    expect(result.required).toBe(3);
    expect(result.met).toBe(false);

    ballots[2] = makeBallot("approve", "user_3");
    result = evaluateQuorum(rule, ballots);
    expect(result.met).toBe(true);
  });

  test("reject votes don't count toward approval", () => {
    const rule: QuorumRule = { type: "count", n: 2 };
    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot("reject", "user_2"),
      makeBallot(null, "user_3"),
    ];

    const result = evaluateQuorum(rule, ballots);
    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.met).toBe(false);
  });
});

describe("AC W3: fail_closed reject", () => {
  test("single reject in fail_closed stage rejects entire workflow", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "管理者承認",
      voterUserIds: ["user_1", "user_2", "user_3"],
      quorum: { type: "count", n: 2 },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot("reject", "user_2"),
      makeBallot(null, "user_3"),
    ];

    const result = evaluateStageAdvance(instance, ballots, stage);
    expect(result.shouldReject).toBe(true);
    expect(result.newStatus).toBe("rejected");
    expect(result.reason).toContain("fail_closed");
  });

  test("reject in count_as_vote stage does not reject workflow", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "管理者承認",
      voterUserIds: ["user_1", "user_2", "user_3"],
      quorum: { type: "count", n: 2 },
      onReject: "count_as_vote",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    const ballots = [
      makeBallot("approve", "user_1"),
      makeBallot("reject", "user_2"),
      makeBallot(null, "user_3"),
    ];

    const result = evaluateStageAdvance(instance, ballots, stage);
    expect(result.shouldReject).toBe(false);
    expect(result.shouldAdvance).toBe(false);
    expect(result.newStatus).toBe("active");
  });
});

describe("AC W4: Stage advancement", () => {
  test("quorum met on first stage advances to second stage", () => {
    const stage0: ApprovalLane = {
      id: "stage_0",
      nameJa: "初期承認",
      voterUserIds: ["user_1", "user_2"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const stage1: ApprovalLane = {
      id: "stage_1",
      nameJa: "管理者承認",
      voterUserIds: ["manager_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage0, stage1]);
    const instance = makeInstance(policy);

    const ballots = [makeBallot("approve", "user_1")];

    const result = evaluateStageAdvance(instance, ballots, stage0);
    expect(result.shouldAdvance).toBe(true);
    expect(result.nextStageIndex).toBe(1);
    expect(result.newStatus).toBe("active");
  });

  test("quorum not met does not advance", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1", "user_2"],
      quorum: { type: "count", n: 2 },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    const ballots = [makeBallot("approve", "user_1"), makeBallot(null, "user_2")];

    const result = evaluateStageAdvance(instance, ballots, stage);
    expect(result.shouldAdvance).toBe(false);
    expect(result.newStatus).toBe("active");
  });

  test("last stage quorum met without finalGo completes workflow", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "最終承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    const ballots = [makeBallot("approve", "user_1")];

    const result = evaluateStageAdvance(instance, ballots, stage);
    expect(result.shouldAdvance).toBe(true);
    expect(result.finalGoPending).toBe(false);
    expect(result.newStatus).toBe("approved");
  });
});

describe("AC W5: finalGo after stages", () => {
  test("last stage quorum met with finalGoUserId sets finalGoPending", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage], "ceo@example.com");
    const instance = makeInstance(policy);

    const ballots = [makeBallot("approve", "user_1")];

    const result = evaluateStageAdvance(instance, ballots, stage);
    expect(result.shouldAdvance).toBe(true);
    expect(result.finalGoPending).toBe(true);
    expect(result.newStatus).toBe("active");
  });

  test("finalGo approve completes workflow", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage], "ceo@example.com");
    const instance = makeInstance(policy, 0, "active", true);

    const finalGoBallot = makeBallot("approve", "ceo@example.com", "final_go", -1, true);

    const result = evaluateFinalGo(instance, finalGoBallot);
    expect(result.complete).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.rejected).toBe(false);
  });

  test("finalGo reject rejects workflow", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage], "ceo@example.com");
    const instance = makeInstance(policy, 0, "active", true);

    const finalGoBallot = makeBallot("reject", "ceo@example.com", "final_go", -1, true);

    const result = evaluateFinalGo(instance, finalGoBallot);
    expect(result.complete).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.rejected).toBe(true);
  });

  test("finalGo not pending returns incomplete", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage], "ceo@example.com");
    const instance = makeInstance(policy, 0, "active", false);

    const finalGoBallot = makeBallot("approve", "ceo@example.com", "final_go", -1, true);

    const result = evaluateFinalGo(instance, finalGoBallot);
    expect(result.complete).toBe(false);
  });
});

describe("AC W1: shouldCreateWorkflowInstance", () => {
  test("returns false when policy is null (current OR stays)", () => {
    expect(shouldCreateWorkflowInstance(null, "mail.send", "sales.outreach")).toBe(false);
  });

  test("returns false when policy has no stages", () => {
    const emptyPolicy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_empty",
      policyName: "空ポリシー",
      stages: [],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    expect(shouldCreateWorkflowInstance(emptyPolicy, "mail.send", "sales.outreach")).toBe(
      false
    );
  });

  test("returns true when policy has stages and no match filter", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    expect(shouldCreateWorkflowInstance(policy, "mail.send", "sales.outreach")).toBe(true);
  });

  test("returns false when tool does not match filter", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy: OrgApprovalWorkflowPolicy = {
      ...makePolicy([stage]),
      match: { tools: ["commerce.order"] },
    };
    expect(shouldCreateWorkflowInstance(policy, "mail.send", "sales.outreach")).toBe(false);
    expect(shouldCreateWorkflowInstance(policy, "commerce.order", "ops.admin")).toBe(true);
  });

  test("returns false when purpose does not match filter", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy: OrgApprovalWorkflowPolicy = {
      ...makePolicy([stage]),
      match: { purposes: ["sales.outreach"] },
    };
    expect(shouldCreateWorkflowInstance(policy, "mail.send", "ops.admin")).toBe(false);
    expect(shouldCreateWorkflowInstance(policy, "mail.send", "sales.outreach")).toBe(true);
  });
});

describe("isVoterInCurrentStage", () => {
  test("returns true for voter in current stage", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1", "user_2"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    expect(isVoterInCurrentStage(instance, "user_1")).toBe(true);
    expect(isVoterInCurrentStage(instance, "user_2")).toBe(true);
    expect(isVoterInCurrentStage(instance, "user_3")).toBe(false);
  });

  test("returns true for finalGo user when finalGoPending", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage], "ceo@example.com");
    const instance = makeInstance(policy, 0, "active", true);

    expect(isVoterInCurrentStage(instance, "ceo@example.com")).toBe(true);
    expect(isVoterInCurrentStage(instance, "user_1")).toBe(false);
  });
});

describe("canVoterResolve", () => {
  test("allows voter in current stage with no existing vote", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);
    const pendingBallot = makeBallot(null, "user_1");

    const result = canVoterResolve(instance, "user_1", pendingBallot);
    expect(result.allowed).toBe(true);
  });

  test("allows voter in current stage with null ballot (ballot not yet created)", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    const result = canVoterResolve(instance, "user_1", null);
    expect(result.allowed).toBe(true);
  });

  test("disallows voter who already voted", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);
    const existingBallot = makeBallot("approve", "user_1");

    const result = canVoterResolve(instance, "user_1", existingBallot);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("already_voted");
  });

  test("disallows voter not in current stage", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy);

    const result = canVoterResolve(instance, "user_2", null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("not_in_current_stage");
  });

  test("disallows voting on non-active workflow", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage]);
    const instance = makeInstance(policy, 0, "approved");
    const pendingBallot = makeBallot(null, "user_1");

    const result = canVoterResolve(instance, "user_1", pendingBallot);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("workflow_not_active");
  });
});

describe("formatQuorumDisplay", () => {
  test("formats 'any' quorum", () => {
    const rule: QuorumRule = { type: "any" };
    expect(formatQuorumDisplay(rule, 1, 3)).toBe("1/1");
    expect(formatQuorumDisplay(rule, 0, 3)).toBe("0/1");
  });

  test("formats 'count' quorum", () => {
    const rule: QuorumRule = { type: "count", n: 2 };
    expect(formatQuorumDisplay(rule, 2, 5)).toBe("2/2");
    expect(formatQuorumDisplay(rule, 1, 5)).toBe("1/2");
  });

  test("formats 'ratio' quorum", () => {
    const rule: QuorumRule = { type: "ratio", numerator: 2, denominator: 3 };
    expect(formatQuorumDisplay(rule, 2, 3)).toBe("2/2 (2/3)");
    expect(formatQuorumDisplay(rule, 1, 3)).toBe("1/2 (2/3)");
  });

  test("formats 'majority' quorum", () => {
    const rule: QuorumRule = { type: "majority" };
    expect(formatQuorumDisplay(rule, 2, 3)).toBe("2/2 (majority)");
    expect(formatQuorumDisplay(rule, 3, 5)).toBe("3/3 (majority)");
  });
});

describe("buildWorkflowProgress", () => {
  test("builds progress for active workflow", () => {
    const stage0: ApprovalLane = {
      id: "stage_0",
      nameJa: "初期承認",
      voterUserIds: ["user_1", "user_2"],
      quorum: { type: "count", n: 2 },
      onReject: "fail_closed",
    };
    const stage1: ApprovalLane = {
      id: "stage_1",
      nameJa: "管理者承認",
      voterUserIds: ["manager_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage0, stage1], "ceo@example.com");
    const instance = makeInstance(policy);

    const ballots = [
      makeBallot("approve", "user_1", "stage_0", 0),
      makeBallot(null, "user_2", "stage_0", 0),
    ];

    const progress = buildWorkflowProgress(instance, ballots);

    expect(progress.instanceId).toBe("inst_1");
    expect(progress.status).toBe("active");
    expect(progress.currentStageIndex).toBe(0);
    expect(progress.stages).toHaveLength(2);
    expect(progress.stages[0].approved).toBe(1);
    expect(progress.stages[0].pending).toBe(1);
    expect(progress.stages[0].quorumMet).toBe(false);
    expect(progress.finalGoPending).toBe(false);
    expect(progress.finalGoUserId).toBe("ceo@example.com");
    expect(progress.finalGoVoted).toBe(false);
  });

  test("shows finalGoVoted when final go ballot exists", () => {
    const stage: ApprovalLane = {
      id: "stage_0",
      nameJa: "承認",
      voterUserIds: ["user_1"],
      quorum: { type: "any" },
      onReject: "fail_closed",
    };
    const policy = makePolicy([stage], "ceo@example.com");
    const instance = makeInstance(policy, 0, "active", true);

    const ballots = [
      makeBallot("approve", "user_1", "stage_0", 0),
      makeBallot("approve", "ceo@example.com", "final_go", -1, true),
    ];

    const progress = buildWorkflowProgress(instance, ballots);
    expect(progress.finalGoPending).toBe(true);
    expect(progress.finalGoVoted).toBe(true);
  });
});
