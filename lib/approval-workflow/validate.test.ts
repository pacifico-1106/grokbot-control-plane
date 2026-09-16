/**
 * F8 Approval Workflow Validation Tests
 */

import { describe, expect, test } from "bun:test";
import {
  validateApprovalWorkflowPolicy,
  normalizeApprovalWorkflowPolicy,
  summarizeApprovalWorkflowPolicyJa,
  nextStepApprovalWorkflowJa,
} from "./validate";
import type { OrgApprovalWorkflowPolicy } from "@/lib/types";

describe("validateApprovalWorkflowPolicy", () => {
  test("rejects duplicate voters/stages, unreachable or fractional quorum, and malformed match filters", () => {
    const stage = { id: "review", nameJa: "Review", voterUserIds: ["v1", "v2"], quorum: { type: "any" }, onReject: "fail_closed" };
    for (const patch of [
      { voterUserIds: ["v1", "v1"] }, { voterUserIds: [" v1", "v2"] }, { id: "final_go" },
      { quorum: { type: "count", n: 3 } }, { quorum: { type: "count", n: 1.5 } },
      { quorum: { type: "ratio", numerator: 1.5, denominator: 2 } },
    ]) expect(validateApprovalWorkflowPolicy({ policyName: "Fixture", stages: [{ ...stage, ...patch }] }).ok).toBe(false);
    expect(validateApprovalWorkflowPolicy({ policyName: "Fixture", stages: [stage, stage] }).ok).toBe(false);
    expect(validateApprovalWorkflowPolicy({ policyName: "Fixture", stages: [stage], match: { tools: [123] } }).ok).toBe(false);
  });
  test("rejects null input", () => {
    const result = validateApprovalWorkflowPolicy(null);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("invalid_input");
  });

  test("rejects missing policyName", () => {
    const result = validateApprovalWorkflowPolicy({
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "missing_policy_name")).toBe(true);
  });

  test("rejects missing stages", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "missing_stages")).toBe(true);
  });

  test("rejects empty stages array", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "empty_stages")).toBe(true);
  });

  test("validates stage id requirement", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "missing_lane_id")).toBe(true);
  });

  test("validates stage nameJa requirement", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "missing_lane_name")).toBe(true);
  });

  test("validates voterUserIds requirement", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: [],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "missing_voters")).toBe(true);
  });

  test("validates quorum rule type 'any'", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("validates quorum rule type 'count' with n >= 1", () => {
    const valid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "count", n: 1 },
          onReject: "fail_closed",
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "count", n: 0 },
          onReject: "fail_closed",
        },
      ],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.some((e) => e.code === "invalid_quorum")).toBe(true);
  });

  test("validates quorum rule type 'ratio'", () => {
    const valid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1", "user_2", "user_3"],
          quorum: { type: "ratio", numerator: 2, denominator: 3 },
          onReject: "fail_closed",
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "ratio", numerator: 3, denominator: 2 },
          onReject: "fail_closed",
        },
      ],
    });
    expect(invalid.ok).toBe(false);
  });

  test("validates quorum rule type 'majority'", () => {
    const result = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1", "user_2", "user_3"],
          quorum: { type: "majority" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("validates onReject values", () => {
    const failClosed = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(failClosed.ok).toBe(true);

    const countAsVote = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "count_as_vote",
        },
      ],
    });
    expect(countAsVote.ok).toBe(true);

    const invalid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "invalid_value",
        },
      ],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.some((e) => e.code === "invalid_on_reject")).toBe(true);
  });

  test("validates finalGoUserId when set", () => {
    const valid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      finalGoUserId: "ceo@example.com",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      finalGoUserId: "",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.some((e) => e.code === "invalid_final_go_user")).toBe(true);
  });

  test("validates match object when provided", () => {
    const validTools = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      match: { tools: ["mail.send"] },
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(validTools.ok).toBe(true);

    const invalidMatch = validateApprovalWorkflowPolicy({
      policyName: "テスト",
      match: "invalid",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(invalidMatch.ok).toBe(false);
    expect(invalidMatch.errors.some((e) => e.code === "invalid_match")).toBe(true);
  });
});

describe("normalizeApprovalWorkflowPolicy", () => {
  test("generates policyId when not provided", () => {
    const result = normalizeApprovalWorkflowPolicy({
      policyName: "テストポリシー",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.policyId).toMatch(/^awp_/);
  });

  test("preserves provided policyId", () => {
    const result = normalizeApprovalWorkflowPolicy({
      policyId: "awp_custom",
      policyName: "テストポリシー",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.policyId).toBe("awp_custom");
  });

  test("normalizes stage id when missing", () => {
    const result = normalizeApprovalWorkflowPolicy({
      policyName: "テストポリシー",
      stages: [
        {
          id: "",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.stages[0].id).toBe("stage_0");
  });

  test("normalizes finalGoUserId", () => {
    const result = normalizeApprovalWorkflowPolicy({
      policyName: "テストポリシー",
      finalGoUserId: "  ceo@example.com  ",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.finalGoUserId).toBe("ceo@example.com");
  });

  test("normalizes match filters", () => {
    const result = normalizeApprovalWorkflowPolicy({
      policyName: "テストポリシー",
      match: {
        tools: ["mail.send", "", "commerce.order"],
        purposes: ["sales.outreach", ""],
      },
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
    });
    expect(result.match?.tools).toEqual(["mail.send", "commerce.order"]);
    expect(result.match?.purposes).toEqual(["sales.outreach"]);
  });

  test("defaults onReject to fail_closed", () => {
    const result = normalizeApprovalWorkflowPolicy({
      policyName: "テストポリシー",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
        },
      ],
    });
    expect(result.stages[0].onReject).toBe("fail_closed");
  });
});

describe("summarizeApprovalWorkflowPolicyJa", () => {
  test("returns default message when policy is null", () => {
    const result = summarizeApprovalWorkflowPolicyJa(null);
    expect(result).toContain("未設定");
    expect(result).toContain("1人承認");
  });

  test("summarizes single-stage policy", () => {
    const policy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_test",
      policyName: "管理者承認",
      stages: [
        {
          id: "s0",
          nameJa: "管理者レビュー",
          voterUserIds: ["user_1", "user_2"],
          quorum: { type: "count", n: 2 },
          onReject: "fail_closed",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const result = summarizeApprovalWorkflowPolicyJa(policy);
    expect(result).toContain("管理者承認");
    expect(result).toContain("管理者レビュー");
    expect(result).toContain("2人");
    expect(result).toContain("1却下で即終了");
  });

  test("summarizes multi-stage policy with finalGo", () => {
    const policy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_test",
      policyName: "部門承認",
      stages: [
        {
          id: "s0",
          nameJa: "担当者確認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
        {
          id: "s1",
          nameJa: "管理者承認",
          voterUserIds: ["manager_1", "manager_2"],
          quorum: { type: "majority" },
          onReject: "fail_closed",
        },
      ],
      finalGoUserId: "ceo@example.com",
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const result = summarizeApprovalWorkflowPolicyJa(policy);
    expect(result).toContain("部門承認");
    expect(result).toContain("担当者確認");
    expect(result).toContain("管理者承認");
    expect(result).toContain("過半数");
    expect(result).toContain("最終Go");
    expect(result).toContain("ceo@example.com");
  });

  test("summarizes policy with match filters", () => {
    const policy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_test",
      policyName: "高額承認",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
      match: {
        tools: ["commerce.order", "mail.send"],
        purposes: ["sales.outreach"],
      },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const result = summarizeApprovalWorkflowPolicyJa(policy);
    expect(result).toContain("ツール: commerce.order, mail.send");
    expect(result).toContain("目的: sales.outreach");
  });
});

describe("nextStepApprovalWorkflowJa", () => {
  test("returns setup instruction when policy is null", () => {
    const result = nextStepApprovalWorkflowJa(null);
    expect(result).toContain("approvalWorkflow.patch");
    expect(result).toContain("1人承認");
  });

  test("returns setup complete message when policy is valid", () => {
    const policy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_test",
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const result = nextStepApprovalWorkflowJa(policy);
    expect(result).toContain("設定済み");
    expect(result).toContain("1ステージ");
  });

  test("mentions finalGo when configured", () => {
    const policy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_test",
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: ["user_1"],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
      finalGoUserId: "ceo@example.com",
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const result = nextStepApprovalWorkflowJa(policy);
    expect(result).toContain("最終Go");
  });

  test("warns about empty voters", () => {
    const policy: OrgApprovalWorkflowPolicy = {
      version: 1,
      policyId: "awp_test",
      policyName: "テスト",
      stages: [
        {
          id: "s0",
          nameJa: "承認",
          voterUserIds: [],
          quorum: { type: "any" },
          onReject: "fail_closed",
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const result = nextStepApprovalWorkflowJa(policy);
    expect(result).toContain("投票者が未設定");
    expect(result).toContain("承認");
  });
});
