/**
 * F8 Approval Workflow Resolution Tests
 *
 * Integration tests covering the full workflow lifecycle:
 * - AC W1: Default OR/single-approver when no workflow policy
 * - AC W2: Quorum evaluation in full workflow
 * - AC W3: fail_closed reject in full workflow
 * - AC W4: Multi-stage advancement
 * - AC W5: finalGo completion
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, upsertRuntimeMember } from "@/lib/demo-data";
import { createApproval, getApprovalById } from "@/lib/data";
import {
  setOrgApprovalWorkflowPolicy,
  resetDemoWorkflowData,
  getWorkflowInstanceByApprovalId,
  getBallotsByInstanceId,
  setDemoWorkflowVoterBinding,
} from "./data";
import {
  initializeWorkflowForApproval,
  handleWorkflowVote,
  getApprovalWorkflowProgress,
  isWorkflowApprovalComplete,
} from "./resolve";
import type { ApprovalLane, OrgApprovalWorkflowPolicy } from "@/lib/types";
import {
  resolveApprovalWithWorkflow,
  canFulfillApproval,
  maybeInitializeWorkflow,
} from "@/lib/approvals/workflow-integration";

afterEach(() => {
  resetDemoWorkflowData();
});

test("admin self-resolution cannot write intermediate, final, or rejecting ballots", async () => {
  for (const status of ["approved", "rejected"] as const) {
    for (const quorum of [1, 2]) {
      resetDemoWorkflowData();
      await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, makePolicy([
        makeStage("admin", "管理者承認", ["requester", "reviewer"], "count", quorum),
      ]));
      const { approval } = await createApproval({
        orgId: DEMO_ORG.id, employeeId: "", credentialId: "",
        title: "Admin self-approval regression", purpose: "admin.policy", summary: "fixture",
        risk: "high", tool: "policy.patch", jobId: crypto.randomUUID(),
        metadata: { auditClass: "admin", adminRequester: {
          kind: "admin_agent", actorId: "requester", grokBotAgentId: "requester-agent",
        } },
      });
      await initializeWorkflowForApproval(approval, null);
      const instance = (await getWorkflowInstanceByApprovalId(approval.id))!;
      const before = await getBallotsByInstanceId(instance.id);
      setDemoWorkflowVoterBinding({ orgId: DEMO_ORG.id, provider: "slack", channelKey: "fixture", userId: "U_SELF", memberId: "requester" });
      await expect(resolveApprovalWithWorkflow(approval.id, status, "slack:U_SELF", DEMO_ORG.id, {
        decisionId: "fixture-self-vote", externalVoter: { provider: "slack", channelKey: "fixture", userId: "U_SELF" },
      })).rejects.toThrow("self_approval_denied");
      await expect(resolveApprovalWithWorkflow(approval.id, status, "requester@example.com", DEMO_ORG.id,
        { actorId: "requester", voterUserId: "requester" })).rejects.toThrow("self_approval_denied");
      await expect(resolveApprovalWithWorkflow(approval.id, status, "reviewer@example.com", DEMO_ORG.id,
        { actorId: "reviewer", voterUserId: "reviewer", grokBotAgentId: "requester-agent" })).rejects.toThrow("self_approval_denied");
      expect(await getBallotsByInstanceId(instance.id)).toEqual(before);
      expect((await getWorkflowInstanceByApprovalId(approval.id))?.status).toBe("active");
      expect((await getApprovalById(approval.id, DEMO_ORG.id))?.status).toBe("pending");
      const independent = await resolveApprovalWithWorkflow(approval.id, status, "reviewer@example.com", DEMO_ORG.id,
        { actorId: "reviewer", voterUserId: "reviewer" });
      expect(independent.ok).toBe(true);
      expect((await getBallotsByInstanceId(instance.id)).find(b => b.voterUserId === "reviewer")?.vote)
        .toBe(status === "approved" ? "approve" : "reject");
    }
  }
});

function makeStage(
  id: string,
  nameJa: string,
  voterUserIds: string[],
  quorumType: "any" | "count" | "ratio" | "majority" = "any",
  quorumN = 1
): ApprovalLane {
  const quorum =
    quorumType === "any"
      ? { type: "any" as const }
      : quorumType === "count"
        ? { type: "count" as const, n: quorumN }
        : quorumType === "majority"
          ? { type: "majority" as const }
          : { type: "ratio" as const, numerator: quorumN, denominator: voterUserIds.length };
  return {
    id,
    nameJa,
    voterUserIds,
    quorum,
    onReject: "fail_closed",
  };
}

function makePolicy(
  stages: ApprovalLane[],
  finalGoUserId?: string
): OrgApprovalWorkflowPolicy {
  for (const id of new Set([...stages.flatMap(s => s.voterUserIds), ...(finalGoUserId ? [finalGoUserId] : [])])) {
    upsertRuntimeMember({ id, orgId: DEMO_ORG.id, email: `${id}@example.invalid`, displayName: id,
      role: "member", status: "active", capabilities: ["approve_actions"] });
  }
  return {
    version: 1,
    policyId: `awp_test_${Date.now()}`,
    policyName: "テストワークフロー",
    stages,
    finalGoUserId,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

describe("AC W1: Default OR/single-approver when no workflow", () => {
  test("approval without workflow policy resolves immediately", async () => {
    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "テスト承認",
      purpose: "sales.outreach",
      summary: "ワークフローなしテスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_nowf_${Date.now()}`,
      metadata: {},
    });

    expect(approval.approval.status).toBe("pending");

    const initResult = await maybeInitializeWorkflow(
      approval.approval,
      "emp_sales"
    );
    expect(initResult.initialized).toBe(false);
    expect(initResult.progress).toBeNull();

    const result = await resolveApprovalWithWorkflow(
      approval.approval.id,
      "approved",
      "owner@example.com",
      DEMO_ORG.id
    );

    expect(result.ok).toBe(true);
    expect(result.workflowApplied).toBe(false);
    expect(result.workflowComplete).toBe(true);
    expect(result.approval?.status).toBe("approved");
  });

  test("rejection without workflow policy resolves immediately", async () => {
    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "テスト却下",
      purpose: "sales.outreach",
      summary: "ワークフローなし却下テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_nowf_rej_${Date.now()}`,
      metadata: {},
    });

    const result = await resolveApprovalWithWorkflow(
      approval.approval.id,
      "rejected",
      "owner@example.com",
      DEMO_ORG.id
    );

    expect(result.ok).toBe(true);
    expect(result.workflowApplied).toBe(false);
    expect(result.workflowRejected).toBe(true);
    expect(result.approval?.status).toBe("rejected");
  });
});

describe("AC W2: Quorum evaluation in workflow", () => {
  test("single-stage workflow with 'any' quorum completes on first vote", async () => {
    const stage = makeStage("stage_0", "管理者承認", ["user_1", "user_2"], "any");
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "any quorum test",
      purpose: "sales.outreach",
      summary: "any定足数テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_any_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    const result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.voted).toBe(true);
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
  });

  test("single-stage workflow with 'count' quorum requires n approvals", async () => {
    const stage = makeStage("stage_0", "合議承認", ["user_1", "user_2", "user_3"], "count", 2);
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "count quorum test",
      purpose: "sales.outreach",
      summary: "count定足数テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_count_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.voted).toBe(true);
    expect(result.workflowComplete).toBe(false);
    expect(result.progress?.stages[0].approved).toBe(1);
    expect(result.progress?.stages[0].quorumMet).toBe(false);

    result = await handleWorkflowVote(approval.approval.id, "user_2", "approve");
    expect(result.voted).toBe(true);
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
  });

  test("single-stage workflow with 'majority' quorum", async () => {
    const stage = makeStage("stage_0", "過半数承認", ["user_1", "user_2", "user_3"], "majority");
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "majority quorum test",
      purpose: "sales.outreach",
      summary: "majority定足数テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_majority_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.workflowComplete).toBe(false);

    result = await handleWorkflowVote(approval.approval.id, "user_2", "approve");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
  });
});

describe("AC W3: fail_closed reject in workflow", () => {
  test("reject in fail_closed stage rejects entire workflow", async () => {
    const stage = makeStage("stage_0", "管理者承認", ["user_1", "user_2", "user_3"], "count", 2);
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "fail_closed test",
      purpose: "sales.outreach",
      summary: "fail_closed却下テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_fc_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    const result = await handleWorkflowVote(approval.approval.id, "user_1", "reject");
    expect(result.voted).toBe(true);
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowRejected).toBe(true);
    expect(result.workflowApproved).toBe(false);
    expect(result.instance?.status).toBe("rejected");
  });

  test("reject after some approves still rejects workflow", async () => {
    const stage = makeStage("stage_0", "管理者承認", ["user_1", "user_2", "user_3"], "count", 2);
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "fail_closed after approve test",
      purpose: "sales.outreach",
      summary: "承認後の却下テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_fc2_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.workflowComplete).toBe(false);

    result = await handleWorkflowVote(approval.approval.id, "user_2", "reject");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowRejected).toBe(true);
  });
});

describe("AC W4: Multi-stage advancement", () => {
  test("two-stage workflow advances from first to second stage", async () => {
    const stage0 = makeStage("stage_0", "初期承認", ["user_1"], "any");
    const stage1 = makeStage("stage_1", "管理者承認", ["manager_1"], "any");
    const policy = makePolicy([stage0, stage1]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "two-stage test",
      purpose: "sales.outreach",
      summary: "2ステージテスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_2stage_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.voted).toBe(true);
    expect(result.workflowComplete).toBe(false);
    expect(result.instance?.currentStageIndex).toBe(1);
    expect(result.progress?.currentStageIndex).toBe(1);

    result = await handleWorkflowVote(approval.approval.id, "manager_1", "approve");
    expect(result.voted).toBe(true);
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
  });

  test("three-stage workflow completes all stages sequentially", async () => {
    const stage0 = makeStage("stage_0", "担当者承認", ["user_1"], "any");
    const stage1 = makeStage("stage_1", "管理者承認", ["manager_1"], "any");
    const stage2 = makeStage("stage_2", "部長承認", ["director_1"], "any");
    const policy = makePolicy([stage0, stage1, stage2]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "three-stage test",
      purpose: "sales.outreach",
      summary: "3ステージテスト",
      risk: "high",
      tool: "mail.send",
      jobId: `job_3stage_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.instance?.currentStageIndex).toBe(1);

    result = await handleWorkflowVote(approval.approval.id, "manager_1", "approve");
    expect(result.instance?.currentStageIndex).toBe(2);

    result = await handleWorkflowVote(approval.approval.id, "director_1", "approve");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
  });

  test("reject in second stage rejects entire workflow", async () => {
    const stage0 = makeStage("stage_0", "初期承認", ["user_1"], "any");
    const stage1 = makeStage("stage_1", "管理者承認", ["manager_1"], "any");
    const policy = makePolicy([stage0, stage1]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "reject in stage 2 test",
      purpose: "sales.outreach",
      summary: "ステージ2却下テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_rej_s2_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    await handleWorkflowVote(approval.approval.id, "user_1", "approve");

    const result = await handleWorkflowVote(approval.approval.id, "manager_1", "reject");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowRejected).toBe(true);
  });
});

describe("AC W5: finalGo completion", () => {
  test("workflow with finalGo requires final approval after stages", async () => {
    const stage = makeStage("stage_0", "管理者承認", ["user_1"], "any");
    const policy = makePolicy([stage], "ceo@example.com");
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "finalGo test",
      purpose: "sales.outreach",
      summary: "最終Goテスト",
      risk: "high",
      tool: "mail.send",
      jobId: `job_fgo_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.workflowComplete).toBe(false);
    expect(result.instance?.finalGoPending).toBe(true);
    expect(result.progress?.finalGoPending).toBe(true);

    result = await handleWorkflowVote(approval.approval.id, "ceo@example.com", "approve");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
    expect(result.instance?.status).toBe("approved");
  });

  test("finalGo reject rejects entire workflow", async () => {
    const stage = makeStage("stage_0", "管理者承認", ["user_1"], "any");
    const policy = makePolicy([stage], "ceo@example.com");
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "finalGo reject test",
      purpose: "sales.outreach",
      summary: "最終Go却下テスト",
      risk: "high",
      tool: "mail.send",
      jobId: `job_fgo_rej_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    await handleWorkflowVote(approval.approval.id, "user_1", "approve");

    const result = await handleWorkflowVote(approval.approval.id, "ceo@example.com", "reject");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowRejected).toBe(true);
    expect(result.instance?.status).toBe("rejected");
  });

  test("multi-stage workflow with finalGo completes all stages then finalGo", async () => {
    const stage0 = makeStage("stage_0", "担当者承認", ["user_1"], "any");
    const stage1 = makeStage("stage_1", "管理者承認", ["manager_1"], "any");
    const policy = makePolicy([stage0, stage1], "ceo@example.com");
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "multi-stage finalGo test",
      purpose: "sales.outreach",
      summary: "複数ステージ+最終Goテスト",
      risk: "high",
      tool: "mail.send",
      jobId: `job_ms_fgo_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    await handleWorkflowVote(approval.approval.id, "manager_1", "approve");

    const progress = await getApprovalWorkflowProgress(approval.approval.id);
    expect(progress?.finalGoPending).toBe(true);

    const result = await handleWorkflowVote(approval.approval.id, "ceo@example.com", "approve");
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
  });
});

describe("workflow-integrated resolution", () => {
  test("resolveApprovalWithWorkflow handles full workflow lifecycle", async () => {
    const stage = makeStage("stage_0", "承認", ["user_1", "user_2"], "count", 2);
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "integration test",
      purpose: "sales.outreach",
      summary: "統合テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_integ_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    let result = await resolveApprovalWithWorkflow(
      approval.approval.id,
      "approved",
      "user_1",
      DEMO_ORG.id,
      { voterUserId: "user_1" }
    );
    expect(result.workflowApplied).toBe(true);
    expect(result.workflowComplete).toBe(false);
    expect(result.progress?.stages[0].approved).toBe(1);

    result = await resolveApprovalWithWorkflow(
      approval.approval.id,
      "approved",
      "user_2",
      DEMO_ORG.id,
      { voterUserId: "user_2" }
    );
    expect(result.workflowComplete).toBe(true);
    expect(result.workflowApproved).toBe(true);
    expect(result.approval?.status).toBe("approved");
  });

  test("canFulfillApproval returns false while workflow is pending", async () => {
    const stage = makeStage("stage_0", "承認", ["user_1", "user_2"], "count", 2);
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "fulfill guard test",
      purpose: "sales.outreach",
      summary: "実行ガードテスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_guard_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");
    await handleWorkflowVote(approval.approval.id, "user_1", "approve");

    const freshApproval = await getApprovalById(approval.approval.id, DEMO_ORG.id);
    expect(freshApproval).toBeTruthy();

    const canFulfill = await canFulfillApproval(freshApproval!);
    expect(canFulfill.canFulfill).toBe(false);
    expect(canFulfill.reason).toBe("not_approved");
  });

  test("voter cannot vote twice", async () => {
    const stage = makeStage("stage_0", "承認", ["user_1", "user_2"], "count", 2);
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "double vote test",
      purpose: "sales.outreach",
      summary: "二重投票テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_dv_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    await handleWorkflowVote(approval.approval.id, "user_1", "approve");

    const result = await handleWorkflowVote(approval.approval.id, "user_1", "approve");
    expect(result.voted).toBe(false);
    expect(result.reason).toBe("already_voted");
  });

  test("non-voter cannot vote in current stage", async () => {
    const stage = makeStage("stage_0", "承認", ["user_1"], "any");
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "unauthorized voter test",
      purpose: "sales.outreach",
      summary: "非投票者テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_uv_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");

    const result = await handleWorkflowVote(approval.approval.id, "random_user", "approve");
    expect(result.voted).toBe(false);
    expect(result.reason).toBe("voter_not_authorized");
  });
});

describe("isWorkflowApprovalComplete", () => {
  test("returns hasWorkflow false when no instance", async () => {
    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "no workflow test",
      purpose: "sales.outreach",
      summary: "ワークフローなし",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_noins_${Date.now()}`,
      metadata: {},
    });

    const status = await isWorkflowApprovalComplete(approval.approval.id);
    expect(status.hasWorkflow).toBe(false);
    expect(status.complete).toBe(false);
    expect(status.approved).toBe(false);
  });

  test("returns complete true after workflow approved", async () => {
    const stage = makeStage("stage_0", "承認", ["user_1"], "any");
    const policy = makePolicy([stage]);
    await setOrgApprovalWorkflowPolicy(DEMO_ORG.id, policy);

    const approval = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_sales",
      credentialId: "cred_sales",
      title: "complete test",
      purpose: "sales.outreach",
      summary: "完了テスト",
      risk: "medium",
      tool: "mail.send",
      jobId: `job_comp_${Date.now()}`,
      metadata: {},
    });

    await initializeWorkflowForApproval(approval.approval, "emp_sales");
    await handleWorkflowVote(approval.approval.id, "user_1", "approve");

    const status = await isWorkflowApprovalComplete(approval.approval.id);
    expect(status.hasWorkflow).toBe(true);
    expect(status.complete).toBe(true);
    expect(status.approved).toBe(true);
  });
});
