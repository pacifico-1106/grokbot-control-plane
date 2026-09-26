/**
 * P0 Item 1: Admin-class approval policy enforcement tests.
 *
 * Tests:
 * - Null policy fail-closed (flag ON)
 * - W1 preserved (flag OFF)
 * - Employee override cannot satisfy admin route
 * - Business voter denied on admin ticket
 * - New admin tools classified by class (not name enumeration)
 */
import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  checkAdminPolicyRequirement,
  getEffectiveClassPolicy,
  canVoterVoteOnApproval,
  findRouteForClass,
  hasValidAdminRoute,
  ADMIN_AUDIT_CLASS,
  BUSINESS_AUDIT_CLASS,
} from "./admin-policy";
import { isAdminClassApproval, isAdminClassTool, getApprovalRouteClass } from "@/lib/admin-mcp/audit-class";
import type { OrgApprovalWorkflowPolicy, ApprovalClassRoute, ApprovalLane } from "@/lib/types";

const createStage = (id: string, voterUserIds: string[]): ApprovalLane => ({
  id,
  nameJa: `ステージ ${id}`,
  voterUserIds,
  quorum: { type: "any" },
  onReject: "fail_closed",
});

const createAdminRoute = (voters: string[]): ApprovalClassRoute => ({
  class: "admin",
  stages: [createStage("admin_stage", voters)],
});

const createBusinessRoute = (voters: string[]): ApprovalClassRoute => ({
  class: "business",
  stages: [createStage("business_stage", voters)],
});

const createPolicy = (options: {
  routes?: ApprovalClassRoute[];
  stages?: ApprovalLane[];
}): OrgApprovalWorkflowPolicy => ({
  version: 1,
  policyId: "test_policy",
  policyName: "テストポリシー",
  stages: options.stages ?? [createStage("default", ["voter_1"])],
  routes: options.routes,
  updatedAt: new Date().toISOString(),
  updatedBy: "test",
});

describe("isAdminClassTool", () => {
  it("classifies admin.* tools as admin class", () => {
    expect(isAdminClassTool("admin.hire")).toBe(true);
    expect(isAdminClassTool("admin.policy")).toBe(true);
  });

  it("classifies setup.* tools as admin class", () => {
    expect(isAdminClassTool("setup.slackAdapter.setBotToken")).toBe(true);
    expect(isAdminClassTool("setup.lineApproval.upsert")).toBe(true);
    expect(isAdminClassTool("setup.billing")).toBe(true);
    expect(isAdminClassTool("setup.card")).toBe(true);
    expect(isAdminClassTool("setup.portal")).toBe(true);
  });

  it("classifies orgs.* tools as admin class", () => {
    expect(isAdminClassTool("orgs.create")).toBe(true);
    expect(isAdminClassTool("orgs.issueAdminCredential")).toBe(true);
    expect(isAdminClassTool("orgs.patch")).toBe(true);
  });

  it("classifies billing/portal/card tools as admin class", () => {
    expect(isAdminClassTool("billing.patch")).toBe(true);
    expect(isAdminClassTool("billing.update")).toBe(true);
    expect(isAdminClassTool("portal.setup")).toBe(true);
    expect(isAdminClassTool("portal.patch")).toBe(true);
    expect(isAdminClassTool("externalContractCard.setup")).toBe(true);
    expect(isAdminClassTool("externalContractCard.patch")).toBe(true);
  });

  it("classifies explicit admin tools as admin class", () => {
    expect(isAdminClassTool("employees.issue")).toBe(true);
    expect(isAdminClassTool("link")).toBe(true);
    expect(isAdminClassTool("policy.patch")).toBe(true);
    expect(isAdminClassTool("parties.upsert")).toBe(true);
    expect(isAdminClassTool("channels.classify")).toBe(true);
    expect(isAdminClassTool("ingressHandoff.patch")).toBe(true);
    expect(isAdminClassTool("schedulingPolicy.patch")).toBe(true);
    expect(isAdminClassTool("mailPolicy.patch")).toBe(true);
  });

  it("classifies future admin tools by prefix", () => {
    expect(isAdminClassTool("internalAudienceRule.patch")).toBe(true);
    expect(isAdminClassTool("approvalWorkflow.patch")).toBe(true);
  });

  it("does not classify business tools as admin class", () => {
    expect(isAdminClassTool("mail.send")).toBe(false);
    expect(isAdminClassTool("calendar.confirm")).toBe(false);
    expect(isAdminClassTool("commerce.order")).toBe(false);
    expect(isAdminClassTool("slack.post")).toBe(false);
    expect(isAdminClassTool("comm.send")).toBe(false);
    expect(isAdminClassTool("sns.publish")).toBe(false);
  });
});

describe("isAdminClassApproval", () => {
  it("detects admin class by auditClass metadata", () => {
    expect(isAdminClassApproval({ metadata: { auditClass: "admin" } })).toBe(true);
    expect(isAdminClassApproval({ metadata: { auditClass: "business" } })).toBe(false);
  });

  it("detects admin class by always_human + adminTool metadata", () => {
    expect(isAdminClassApproval({
      metadata: { always_human: true, adminTool: "employees.issue" },
    })).toBe(true);
    // Note: employees.issue is an admin-class tool by itself, so even without always_human,
    // it will be detected as admin class due to the tool check
    expect(isAdminClassApproval({
      metadata: { always_human: false, adminTool: "employees.issue" },
    })).toBe(true);
    // Use a business tool to verify always_human check is separate
    expect(isAdminClassApproval({
      metadata: { always_human: true, adminTool: "mail.send" },
    })).toBe(true);
    expect(isAdminClassApproval({
      metadata: { always_human: false, tool: "mail.send" },
    })).toBe(false);
  });

  it("detects admin class by purpose prefix", () => {
    expect(isAdminClassApproval({ purpose: "admin.hire" })).toBe(true);
    expect(isAdminClassApproval({ purpose: "admin.policy" })).toBe(true);
    expect(isAdminClassApproval({ purpose: "tool.invoke" })).toBe(false);
  });

  it("detects admin class by tool", () => {
    expect(isAdminClassApproval({ tool: "employees.issue" })).toBe(true);
    expect(isAdminClassApproval({ tool: "setup.billing" })).toBe(true);
    expect(isAdminClassApproval({ tool: "mail.send" })).toBe(false);
  });
});

describe("getApprovalRouteClass", () => {
  it("returns admin for admin-class approvals", () => {
    expect(getApprovalRouteClass({ purpose: "admin.hire" })).toBe("admin");
    expect(getApprovalRouteClass({ metadata: { auditClass: "admin" } })).toBe("admin");
    expect(getApprovalRouteClass({ tool: "setup.billing" })).toBe("admin");
  });

  it("returns business for non-admin approvals", () => {
    expect(getApprovalRouteClass({ purpose: "tool.invoke" })).toBe("business");
    expect(getApprovalRouteClass({ tool: "mail.send" })).toBe("business");
    expect(getApprovalRouteClass({})).toBe("business");
  });
});

describe("findRouteForClass", () => {
  it("finds admin route", () => {
    const policy = createPolicy({
      routes: [createAdminRoute(["admin_voter"]), createBusinessRoute(["business_voter"])],
    });
    const route = findRouteForClass(policy, "admin");
    expect(route?.class).toBe("admin");
    expect(route?.stages[0].voterUserIds).toEqual(["admin_voter"]);
  });

  it("finds business route", () => {
    const policy = createPolicy({
      routes: [createAdminRoute(["admin_voter"]), createBusinessRoute(["business_voter"])],
    });
    const route = findRouteForClass(policy, "business");
    expect(route?.class).toBe("business");
    expect(route?.stages[0].voterUserIds).toEqual(["business_voter"]);
  });

  it("returns null when route not found", () => {
    const policy = createPolicy({
      routes: [createBusinessRoute(["business_voter"])],
    });
    expect(findRouteForClass(policy, "admin")).toBeNull();
  });

  it("returns null when no routes defined", () => {
    const policy = createPolicy({});
    expect(findRouteForClass(policy, "admin")).toBeNull();
  });
});

describe("hasValidAdminRoute", () => {
  it("returns true for policy with valid admin route", () => {
    const policy = createPolicy({
      routes: [createAdminRoute(["admin_voter"])],
    });
    expect(hasValidAdminRoute(policy)).toBe(true);
  });

  it("returns false for policy without admin route", () => {
    const policy = createPolicy({
      routes: [createBusinessRoute(["business_voter"])],
    });
    expect(hasValidAdminRoute(policy)).toBe(false);
  });

  it("returns false for admin route with empty voters", () => {
    const policy = createPolicy({
      routes: [createAdminRoute([])],
    });
    expect(hasValidAdminRoute(policy)).toBe(false);
  });

  it("returns false for null policy", () => {
    expect(hasValidAdminRoute(null)).toBe(false);
  });

  it("returns false for policy without routes", () => {
    const policy = createPolicy({});
    expect(hasValidAdminRoute(policy)).toBe(false);
  });
});

describe("checkAdminPolicyRequirement (flag OFF)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_APPROVER_POLICY_REQUIRED = originalEnv;
    } else {
      delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    }
  });

  it("allows admin-class approval without admin route (W1 preserved)", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null
    );
    expect(result.ok).toBe(true);
  });

  it("allows business-class approval without policy", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      null,
      null
    );
    expect(result.ok).toBe(true);
  });
});

describe("checkAdminPolicyRequirement (flag ON)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    process.env.ADMIN_APPROVER_POLICY_REQUIRED = "true";
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_APPROVER_POLICY_REQUIRED = originalEnv;
    } else {
      delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    }
  });

  it("fails closed for admin-class approval without org policy", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("admin_policy_required");
    }
  });

  it("fails closed for admin-class approval with employee override only", () => {
    const employeePolicy = createPolicy({
      routes: [createAdminRoute(["employee_admin_voter"])],
    });
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      employeePolicy
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("admin_policy_required");
      expect(result.reason).toContain("employee override cannot satisfy");
    }
  });

  it("succeeds for admin-class approval with org-level admin route", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute(["admin_voter"])],
    });
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy,
      null
    );
    expect(result.ok).toBe(true);
  });

  it("allows business-class approval without admin route", () => {
    const orgPolicy = createPolicy({
      routes: [createBusinessRoute(["business_voter"])],
    });
    const result = checkAdminPolicyRequirement(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgPolicy,
      null
    );
    expect(result.ok).toBe(true);
  });

  it("allows business-class approval without policy", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      null,
      null
    );
    expect(result.ok).toBe(true);
  });
});

describe("canVoterVoteOnApproval (flag OFF)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_APPROVER_POLICY_REQUIRED = originalEnv;
    } else {
      delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    }
  });

  it("allows any voter on admin ticket (flag OFF)", () => {
    const orgPolicy = createPolicy({
      routes: [
        createAdminRoute(["admin_voter"]),
        createBusinessRoute(["business_voter"]),
      ],
    });
    const result = canVoterVoteOnApproval(
      "business_voter",
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("flag_off");
  });
});

describe("canVoterVoteOnApproval (flag ON)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    process.env.ADMIN_APPROVER_POLICY_REQUIRED = "true";
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_APPROVER_POLICY_REQUIRED = originalEnv;
    } else {
      delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    }
  });

  it("allows admin voter on admin ticket", () => {
    const orgPolicy = createPolicy({
      routes: [
        createAdminRoute(["admin_voter"]),
        createBusinessRoute(["business_voter"]),
      ],
    });
    const result = canVoterVoteOnApproval(
      "admin_voter",
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("in_admin_route");
  });

  it("denies business voter on admin ticket", () => {
    const orgPolicy = createPolicy({
      routes: [
        createAdminRoute(["admin_voter"]),
        createBusinessRoute(["business_voter"]),
      ],
    });
    const result = canVoterVoteOnApproval(
      "business_voter",
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("business_voter_on_admin_ticket");
  });

  it("allows any voter on business ticket", () => {
    const orgPolicy = createPolicy({
      routes: [
        createAdminRoute(["admin_voter"]),
        createBusinessRoute(["business_voter"]),
      ],
    });
    const result = canVoterVoteOnApproval(
      "business_voter",
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("business_class");
  });

  it("allows voting when no class routes defined", () => {
    const orgPolicy = createPolicy({});
    const result = canVoterVoteOnApproval(
      "any_voter",
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("no_class_routes");
  });
});

describe("getEffectiveClassPolicy (flag ON)", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    process.env.ADMIN_APPROVER_POLICY_REQUIRED = "true";
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_APPROVER_POLICY_REQUIRED = originalEnv;
    } else {
      delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
    }
  });

  it("uses org policy for admin-class approvals (ignores employee override)", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute(["org_admin_voter"])],
    });
    const employeePolicy = createPolicy({
      routes: [createAdminRoute(["employee_admin_voter"])],
    });

    const result = getEffectiveClassPolicy(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy,
      employeePolicy
    );

    expect(result.source).toBe("org");
    expect(result.approvalClass).toBe("admin");
    expect(result.route?.stages[0].voterUserIds).toEqual(["org_admin_voter"]);
  });

  it("uses employee policy for business-class approvals", () => {
    const orgPolicy = createPolicy({
      routes: [createBusinessRoute(["org_business_voter"])],
    });
    const employeePolicy = createPolicy({
      routes: [createBusinessRoute(["employee_business_voter"])],
    });

    const result = getEffectiveClassPolicy(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgPolicy,
      employeePolicy
    );

    expect(result.source).toBe("employee");
    expect(result.approvalClass).toBe("business");
    expect(result.route?.stages[0].voterUserIds).toEqual(["employee_business_voter"]);
  });
});
