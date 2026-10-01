/**
 * P1 Approval Kind Routes — Validation Tests
 *
 * Shared test table for validation across Web API and MCP.
 * These same cases must pass through both entry points.
 */
import { describe, expect, test } from "bun:test";
import {
  validateApprovalRoutes,
  defaultApprovalKindRoute,
  defaultTopicGateConfig,
  DEFAULT_SENSITIVE_TOPICS,
  type ValidatorContext,
} from "./validate";
import type { ApprovalKind, ApprovalKindRoute, OrgApprovalKindRoutesPolicy } from "./types";
import { APPROVAL_KINDS } from "./types";

const mockContext = (): ValidatorContext => ({
  orgOwnerUserIds: ["owner-1"],
  orgAdminUserIds: ["admin-1", "admin-2"],
  orgHumanMemberUserIds: ["owner-1", "admin-1", "admin-2", "member-1", "member-2"],
  aiEmployeeUserIds: ["ai-employee-1"],
  requesterId: null,
});

const validRoute = (kind: ApprovalKind): ApprovalKindRoute => ({
  kind,
  approverUserIds: ["owner-1"],
  quorum: { type: "any" },
  finalGoUserId: null,
  deadlineHours: null,
  onExpire: "fail_closed",
  remindEveryDays: 3,
  notifyChannelIds: [],
});

const validPolicy = (): OrgApprovalKindRoutesPolicy => ({
  version: 1,
  policyId: "test-policy",
  policyName: "テストポリシー",
  routes: APPROVAL_KINDS.map(validRoute),
  updatedAt: new Date().toISOString(),
  updatedBy: "test",
});

describe("validateApprovalRoutes", () => {
  describe("basic validation", () => {
    test("accepts valid policy", () => {
      const result = validateApprovalRoutes(validPolicy(), mockContext());
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("rejects null input", () => {
      const result = validateApprovalRoutes(null, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors[0].code).toBe("invalid_input");
    });

    test("rejects missing policyName", () => {
      const policy = validPolicy();
      delete (policy as unknown as Record<string, unknown>).policyName;
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "missing_policy_name")).toBe(true);
    });

    test("rejects empty routes", () => {
      const policy = validPolicy();
      policy.routes = [];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "empty_routes")).toBe(true);
    });
  });

  describe("security: zero approvers forbidden", () => {
    test("rejects route with zero approvers", () => {
      const policy = validPolicy();
      policy.routes[0].approverUserIds = [];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "zero_approvers_forbidden")).toBe(true);
    });
  });

  describe("security: AI approvers forbidden", () => {
    test("rejects AI employee as approver", () => {
      const policy = validPolicy();
      policy.routes[0].approverUserIds = ["ai-employee-1"];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "ai_approver_forbidden")).toBe(true);
    });

    test("rejects AI employee as finalGo", () => {
      const policy = validPolicy();
      policy.routes[0].finalGoUserId = "ai-employee-1";
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "ai_approver_forbidden")).toBe(true);
    });
  });

  describe("security: self-approval forbidden", () => {
    test("rejects requester as approver", () => {
      const ctx = mockContext();
      ctx.requesterId = "member-1";
      const policy = validPolicy();
      policy.routes[0].approverUserIds = ["member-1"];
      const result = validateApprovalRoutes(policy, ctx);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "self_approval_forbidden")).toBe(true);
    });
  });

  describe("security: account kind requires owner/admin", () => {
    test("rejects regular member as account kind approver", () => {
      const policy = validPolicy();
      const accountRoute = policy.routes.find((r) => r.kind === "account")!;
      accountRoute.approverUserIds = ["member-1"];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "account_kind_requires_owner_admin")).toBe(true);
    });

    test("accepts owner as account kind approver", () => {
      const policy = validPolicy();
      const accountRoute = policy.routes.find((r) => r.kind === "account")!;
      accountRoute.approverUserIds = ["owner-1"];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("accepts admin as account kind approver", () => {
      const policy = validPolicy();
      const accountRoute = policy.routes.find((r) => r.kind === "account")!;
      accountRoute.approverUserIds = ["admin-1"];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });
  });

  describe("security: unreachable quorum forbidden", () => {
    test("rejects quorum count exceeding approvers", () => {
      const policy = validPolicy();
      policy.routes[0].approverUserIds = ["owner-1"];
      policy.routes[0].quorum = { type: "count", n: 3 };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "unreachable_quorum")).toBe(true);
    });
  });

  describe("quorum validation", () => {
    test("accepts quorum type any", () => {
      const policy = validPolicy();
      policy.routes[0].quorum = { type: "any" };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("accepts quorum type all", () => {
      const policy = validPolicy();
      policy.routes[0].quorum = { type: "all" };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("accepts valid quorum count", () => {
      const policy = validPolicy();
      policy.routes[0].approverUserIds = ["owner-1", "admin-1"];
      policy.routes[0].quorum = { type: "count", n: 2 };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("rejects invalid quorum type", () => {
      const policy = validPolicy();
      (policy.routes[0] as unknown as Record<string, unknown>).quorum = { type: "invalid" };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "invalid_quorum")).toBe(true);
    });
  });

  describe("deadline and reminder validation", () => {
    test("accepts valid deadlineHours", () => {
      const policy = validPolicy();
      policy.routes[0].deadlineHours = 72;
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("rejects negative deadlineHours", () => {
      const policy = validPolicy();
      policy.routes[0].deadlineHours = -1;
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "invalid_deadline_hours")).toBe(true);
    });

    test("rejects zero remindEveryDays", () => {
      const policy = validPolicy();
      policy.routes[0].remindEveryDays = 0;
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "invalid_remind_every_days")).toBe(true);
    });

    test("rejects negative remindEveryDays", () => {
      const policy = validPolicy();
      policy.routes[0].remindEveryDays = -1;
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "invalid_remind_every_days")).toBe(true);
    });
  });

  describe("onExpire validation", () => {
    test("accepts fail_closed", () => {
      const policy = validPolicy();
      policy.routes[0].onExpire = "fail_closed";
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("accepts keep_open", () => {
      const policy = validPolicy();
      policy.routes[0].onExpire = "keep_open";
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });

    test("rejects invalid onExpire", () => {
      const policy = validPolicy();
      (policy.routes[0] as unknown as Record<string, unknown>).onExpire = "invalid";
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "invalid_on_expire")).toBe(true);
    });
  });

  describe("duplicate detection", () => {
    test("rejects duplicate approvers", () => {
      const policy = validPolicy();
      policy.routes[0].approverUserIds = ["owner-1", "owner-1"];
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "duplicate_approver")).toBe(true);
    });

    test("rejects duplicate kinds", () => {
      const policy = validPolicy();
      policy.routes.push(validRoute("post"));
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "duplicate_kind")).toBe(true);
    });
  });

  describe("decision workflow validation", () => {
    test("rejects negative amountThreshold", () => {
      const policy = validPolicy();
      policy.decisionWorkflow = {
        amountThresholdJpy: -1,
        fiscalYearStartMonth: 4,
        fiscalYearStartDay: 1,
        tiers: [],
      };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === "invalid_amount_threshold")).toBe(true);
    });

    test("accepts T2 with finalGo (tenant-configurable)", () => {
      const policy = validPolicy();
      policy.decisionWorkflow = {
        amountThresholdJpy: 500000,
        fiscalYearStartMonth: 4,
        fiscalYearStartDay: 1,
        tiers: [
          {
            tier: "T2",
            nameJa: "理事過半数",
            approverUserIds: ["owner-1", "admin-1", "admin-2"],
            quorum: { type: "count", n: 2 },
            finalGoUserId: "owner-1",
            deadlineHours: 72,
            onExpire: "fail_closed",
            remindEveryDays: 3,
          },
        ],
      };
      const result = validateApprovalRoutes(policy, mockContext());
      expect(result.ok).toBe(true);
    });
  });
});

describe("defaultApprovalKindRoute", () => {
  test("creates route with owner 1名", () => {
    const route = defaultApprovalKindRoute("post", "owner-1");
    expect(route.kind).toBe("post");
    expect(route.approverUserIds).toEqual(["owner-1"]);
    expect(route.quorum).toEqual({ type: "any" });
    expect(route.finalGoUserId).toBeNull();
    expect(route.deadlineHours).toBeNull();
    expect(route.onExpire).toBe("fail_closed");
    expect(route.remindEveryDays).toBe(3);
  });
});

describe("defaultTopicGateConfig", () => {
  test("creates disabled config with default sensitive topics", () => {
    const config = defaultTopicGateConfig();
    expect(config.enabled).toBe(false);
    expect(config.sensitiveTopics).toEqual([...DEFAULT_SENSITIVE_TOPICS]);
    expect(config.mainBoardChannelIds).toEqual([]);
  });
});

describe("DEFAULT_SENSITIVE_TOPICS", () => {
  test("includes みらい社中 topics", () => {
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("金額");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("支払");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("請求");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("口座");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("予算");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("決算");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("税務");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("報酬");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("契約条件");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("個人情報");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("役員人事");
    expect(DEFAULT_SENSITIVE_TOPICS).toContain("定款");
  });
});

describe("weighted quorum validation", () => {
  test("accepts valid weighted quorum with voterWeights", () => {
    const policy = validPolicy();
    policy.decisionWorkflow = {
      amountThresholdJpy: 500000,
      fiscalYearStartMonth: 4,
      fiscalYearStartDay: 1,
      tiers: [
        {
          tier: "T2",
          nameJa: "理事過半数",
          approverUserIds: ["owner-1", "admin-1", "admin-2"],
          voterWeights: { "owner-1": 3, "admin-1": 2, "admin-2": 1 },
          quorum: { type: "weight", min: 4 },
          deadlineHours: 72,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
    };
    const result = validateApprovalRoutes(policy, mockContext());
    expect(result.ok).toBe(true);
  });

  test("rejects weighted quorum without voterWeights", () => {
    const policy = validPolicy();
    policy.decisionWorkflow = {
      amountThresholdJpy: 500000,
      fiscalYearStartMonth: 4,
      fiscalYearStartDay: 1,
      tiers: [
        {
          tier: "T2",
          nameJa: "理事過半数",
          approverUserIds: ["owner-1", "admin-1", "admin-2"],
          quorum: { type: "weight", min: 4 },
          deadlineHours: 72,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
    };
    const result = validateApprovalRoutes(policy, mockContext());
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "weight_quorum_requires_voter_weights")).toBe(true);
  });

  test("rejects unreachable weighted quorum", () => {
    const policy = validPolicy();
    policy.decisionWorkflow = {
      amountThresholdJpy: 500000,
      fiscalYearStartMonth: 4,
      fiscalYearStartDay: 1,
      tiers: [
        {
          tier: "T2",
          nameJa: "理事過半数",
          approverUserIds: ["owner-1", "admin-1", "admin-2"],
          voterWeights: { "owner-1": 1, "admin-1": 1, "admin-2": 1 },
          quorum: { type: "weight", min: 10 },
          deadlineHours: 72,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
    };
    const result = validateApprovalRoutes(policy, mockContext());
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "unreachable_weight_quorum")).toBe(true);
  });

  test("rejects negative voter weight", () => {
    const policy = validPolicy();
    policy.decisionWorkflow = {
      amountThresholdJpy: 500000,
      fiscalYearStartMonth: 4,
      fiscalYearStartDay: 1,
      tiers: [
        {
          tier: "T2",
          nameJa: "理事過半数",
          approverUserIds: ["owner-1", "admin-1"],
          voterWeights: { "owner-1": 3, "admin-1": -1 },
          quorum: { type: "count", n: 2 },
          deadlineHours: 72,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
    };
    const result = validateApprovalRoutes(policy, mockContext());
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "invalid_voter_weight")).toBe(true);
  });
});
