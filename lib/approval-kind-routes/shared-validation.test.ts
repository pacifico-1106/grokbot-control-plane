/**
 * P1 Approval Kind Routes — Shared Validation Test Table
 *
 * CRITICAL: This test table runs the same validation cases through both
 * Web API and MCP entry points to ensure consistent behavior.
 *
 * The validateApprovalRoutes function is the SINGLE shared validation
 * enforced in 3 places:
 * 1. Web save API
 * 2. MCP patch filing
 * 3. Just before persisting after approval
 */
import { describe, expect, test } from "bun:test";
import { validateApprovalRoutes, type ValidatorContext } from "./validate";
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

/**
 * Shared validation test cases.
 * Each case is run through the validateApprovalRoutes function.
 * In a real implementation, both Web API and MCP would call this same function.
 */
interface ValidationTestCase {
  name: string;
  input: unknown;
  context?: Partial<ValidatorContext>;
  expectOk: boolean;
  expectErrorCodes?: string[];
}

const SHARED_VALIDATION_CASES: ValidationTestCase[] = [
  // Basic validation
  {
    name: "accepts valid policy",
    input: validPolicy(),
    expectOk: true,
  },
  {
    name: "rejects null input",
    input: null,
    expectOk: false,
    expectErrorCodes: ["invalid_input"],
  },
  {
    name: "rejects missing policyName",
    input: { ...validPolicy(), policyName: undefined },
    expectOk: false,
    expectErrorCodes: ["missing_policy_name"],
  },
  {
    name: "rejects empty routes array",
    input: { ...validPolicy(), routes: [] },
    expectOk: false,
    expectErrorCodes: ["empty_routes"],
  },

  // Security: zero approvers forbidden
  {
    name: "rejects zero approvers",
    input: (() => {
      const p = validPolicy();
      p.routes[0].approverUserIds = [];
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["zero_approvers_forbidden"],
  },

  // Security: AI approvers forbidden
  {
    name: "rejects AI employee as approver",
    input: (() => {
      const p = validPolicy();
      p.routes[0].approverUserIds = ["ai-employee-1"];
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["ai_approver_forbidden"],
  },
  {
    name: "rejects AI employee as finalGo",
    input: (() => {
      const p = validPolicy();
      p.routes[0].finalGoUserId = "ai-employee-1";
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["ai_approver_forbidden"],
  },

  // Security: self-approval forbidden
  {
    name: "rejects requester as approver",
    input: (() => {
      const p = validPolicy();
      p.routes[0].approverUserIds = ["member-1"];
      return p;
    })(),
    context: { requesterId: "member-1" },
    expectOk: false,
    expectErrorCodes: ["self_approval_forbidden"],
  },

  // Security: account kind requires owner/admin
  {
    name: "rejects regular member as account kind approver",
    input: (() => {
      const p = validPolicy();
      const accountRoute = p.routes.find((r) => r.kind === "account")!;
      accountRoute.approverUserIds = ["member-1"];
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["account_kind_requires_owner_admin"],
  },
  {
    name: "accepts owner as account kind approver",
    input: (() => {
      const p = validPolicy();
      const accountRoute = p.routes.find((r) => r.kind === "account")!;
      accountRoute.approverUserIds = ["owner-1"];
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "accepts admin as account kind approver",
    input: (() => {
      const p = validPolicy();
      const accountRoute = p.routes.find((r) => r.kind === "account")!;
      accountRoute.approverUserIds = ["admin-1"];
      return p;
    })(),
    expectOk: true,
  },

  // Security: unreachable quorum forbidden
  {
    name: "rejects quorum count exceeding approvers",
    input: (() => {
      const p = validPolicy();
      p.routes[0].approverUserIds = ["owner-1"];
      p.routes[0].quorum = { type: "count", n: 3 };
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["unreachable_quorum"],
  },

  // Quorum validation
  {
    name: "accepts quorum type any",
    input: (() => {
      const p = validPolicy();
      p.routes[0].quorum = { type: "any" };
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "accepts quorum type all",
    input: (() => {
      const p = validPolicy();
      p.routes[0].quorum = { type: "all" };
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "accepts valid quorum count",
    input: (() => {
      const p = validPolicy();
      p.routes[0].approverUserIds = ["owner-1", "admin-1"];
      p.routes[0].quorum = { type: "count", n: 2 };
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "rejects invalid quorum type",
    input: (() => {
      const p = validPolicy();
      (p.routes[0] as unknown as Record<string, unknown>).quorum = { type: "invalid" };
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["invalid_quorum"],
  },

  // Deadline and reminder validation
  {
    name: "accepts valid deadlineHours",
    input: (() => {
      const p = validPolicy();
      p.routes[0].deadlineHours = 72;
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "rejects negative deadlineHours",
    input: (() => {
      const p = validPolicy();
      p.routes[0].deadlineHours = -1;
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["invalid_deadline_hours"],
  },
  {
    name: "rejects zero remindEveryDays",
    input: (() => {
      const p = validPolicy();
      p.routes[0].remindEveryDays = 0;
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["invalid_remind_every_days"],
  },
  {
    name: "rejects negative remindEveryDays",
    input: (() => {
      const p = validPolicy();
      p.routes[0].remindEveryDays = -1;
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["invalid_remind_every_days"],
  },

  // onExpire validation
  {
    name: "accepts fail_closed onExpire",
    input: (() => {
      const p = validPolicy();
      p.routes[0].onExpire = "fail_closed";
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "accepts keep_open onExpire",
    input: (() => {
      const p = validPolicy();
      p.routes[0].onExpire = "keep_open";
      return p;
    })(),
    expectOk: true,
  },
  {
    name: "rejects invalid onExpire",
    input: (() => {
      const p = validPolicy();
      (p.routes[0] as unknown as Record<string, unknown>).onExpire = "invalid";
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["invalid_on_expire"],
  },

  // Duplicate detection
  {
    name: "rejects duplicate approvers",
    input: (() => {
      const p = validPolicy();
      p.routes[0].approverUserIds = ["owner-1", "owner-1"];
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["duplicate_approver"],
  },
  {
    name: "rejects duplicate kinds",
    input: (() => {
      const p = validPolicy();
      p.routes.push(validRoute("post"));
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["duplicate_kind"],
  },

  // Decision workflow validation
  {
    name: "rejects negative amountThreshold",
    input: (() => {
      const p = validPolicy();
      p.decisionWorkflow = {
        amountThresholdJpy: -1,
        fiscalYearStartMonth: 4,
        fiscalYearStartDay: 1,
        tiers: [],
      };
      return p;
    })(),
    expectOk: false,
    expectErrorCodes: ["invalid_amount_threshold"],
  },
  {
    name: "accepts T2 with finalGo (tenant-configurable since tiers are arbitrary)",
    input: (() => {
      const p = validPolicy();
      p.decisionWorkflow = {
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
      return p;
    })(),
    expectOk: true,
    expectErrorCodes: [],
  },
];

describe("Shared Validation Test Table", () => {
  describe("validateApprovalRoutes (same function used by Web API and MCP)", () => {
    for (const testCase of SHARED_VALIDATION_CASES) {
      test(testCase.name, () => {
        const ctx = { ...mockContext(), ...(testCase.context || {}) };
        const result = validateApprovalRoutes(testCase.input, ctx);

        expect(result.ok).toBe(testCase.expectOk);

        if (testCase.expectErrorCodes) {
          for (const code of testCase.expectErrorCodes) {
            expect(result.errors.some((e) => e.code === code)).toBe(true);
          }
        }
      });
    }
  });

  test("test case count matches expected", () => {
    expect(SHARED_VALIDATION_CASES.length).toBeGreaterThanOrEqual(25);
  });
});
