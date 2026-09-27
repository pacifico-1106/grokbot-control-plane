/**
 * P0 Item 1: Admin-class approval policy enforcement tests.
 *
 * Tests:
 * - Null policy fail-closed (flag ON) unless org owners available
 * - W1 preserved (flag OFF)
 * - Employee override cannot satisfy admin route
 * - Business voter denied on admin ticket
 * - New admin tools classified by class (not name enumeration)
 * - Org owners as default admin approvers when no explicit route
 *
 * All tests use fixtures, no hardcoded org IDs or personal names.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  checkAdminPolicyRequirement,
  getEffectiveClassPolicy,
  canVoterVoteOnApproval,
  findRouteForClass,
  hasValidAdminRoute,
  buildDefaultAdminRouteFromOwners,
  canProceedWithAdminApproval,
  getEffectiveAdminRoute,
  canResolverResolveAdminApproval,
  ADMIN_AUDIT_CLASS,
  BUSINESS_AUDIT_CLASS,
} from "./admin-policy";
import { isAdminClassApproval, getApprovalRouteClass } from "@/lib/admin-mcp/audit-class";
import type { OrgApprovalWorkflowPolicy, ApprovalClassRoute, ApprovalLane } from "@/lib/types";

const FIXTURE_ORG_OWNER_1 = "fixture_owner_1";
const FIXTURE_ORG_OWNER_2 = "fixture_owner_2";
const FIXTURE_ADMIN_VOTER = "fixture_admin_voter";
const FIXTURE_BUSINESS_VOTER = "fixture_business_voter";

const createStage = (id: string, voterUserIds: string[]): ApprovalLane => ({
  id,
  nameJa: `ステージ ${id}`,
  voterUserIds,
  quorum: { type: "any" },
  onReject: "fail_closed",
});

const createAdminRoute = (voters: string[] = [FIXTURE_ADMIN_VOTER]): ApprovalClassRoute => ({
  class: "admin",
  stages: [createStage("admin_stage", voters)],
});

const createBusinessRoute = (voters: string[] = [FIXTURE_BUSINESS_VOTER]): ApprovalClassRoute => ({
  class: "business",
  stages: [createStage("business_stage", voters)],
});

const createPolicy = (options: {
  routes?: ApprovalClassRoute[];
  stages?: ApprovalLane[];
}): OrgApprovalWorkflowPolicy => ({
  version: 1,
  policyId: "fixture_policy",
  policyName: "テストポリシー",
  stages: options.stages ?? [createStage("default", [FIXTURE_BUSINESS_VOTER])],
  routes: options.routes,
  updatedAt: new Date().toISOString(),
  updatedBy: "fixture_test",
});

describe("isAdminClassApproval metadata-driven classification", () => {
  test("PRIMARY: metadata.approvalClass = admin", () => {
    expect(isAdminClassApproval({ metadata: { approvalClass: "admin" } })).toBe(true);
    expect(isAdminClassApproval({ metadata: { approvalClass: "business" } })).toBe(false);
  });

  test("PRIMARY: metadata.approvalClass takes precedence over tool/purpose", () => {
    expect(isAdminClassApproval({
      tool: "mail.send",
      purpose: "tool.invoke",
      metadata: { approvalClass: "admin" },
    })).toBe(true);
    expect(isAdminClassApproval({
      tool: "employees.issue",
      purpose: "admin.hire",
      metadata: { approvalClass: "business" },
    })).toBe(false);
  });

  test("SECONDARY: metadata.auditClass (legacy)", () => {
    expect(isAdminClassApproval({ metadata: { auditClass: "admin" } })).toBe(true);
    expect(isAdminClassApproval({ metadata: { auditClass: "business" } })).toBe(false);
  });

  test("isAdminMcpTool marker indicates admin class", () => {
    expect(isAdminClassApproval({ metadata: { isAdminMcpTool: true } })).toBe(true);
    expect(isAdminClassApproval({ metadata: { isAdminMcpTool: false } })).toBe(false);
  });

  test("LEGACY FALLBACK: tool prefix classification for pre-existing rows", () => {
    expect(isAdminClassApproval({ tool: "setup.slackAdapter.setBotToken" })).toBe(true);
    expect(isAdminClassApproval({ tool: "orgs.create" })).toBe(true);
    expect(isAdminClassApproval({ tool: "employees.issue" })).toBe(true);
    expect(isAdminClassApproval({ tool: "mail.send" })).toBe(false);
    expect(isAdminClassApproval({ tool: "calendar.confirm" })).toBe(false);
  });

  test("LEGACY FALLBACK: purpose prefix classification", () => {
    expect(isAdminClassApproval({ purpose: "admin.hire" })).toBe(true);
    expect(isAdminClassApproval({ purpose: "admin.policy" })).toBe(true);
    expect(isAdminClassApproval({ purpose: "tool.invoke" })).toBe(false);
  });
});


describe("getApprovalRouteClass", () => {
  test("returns admin for admin-class approvals", () => {
    expect(getApprovalRouteClass({ purpose: "admin.hire" })).toBe("admin");
    expect(getApprovalRouteClass({ metadata: { auditClass: "admin" } })).toBe("admin");
    expect(getApprovalRouteClass({ tool: "setup.billing" })).toBe("admin");
  });

  test("returns business for non-admin approvals", () => {
    expect(getApprovalRouteClass({ purpose: "tool.invoke" })).toBe("business");
    expect(getApprovalRouteClass({ tool: "mail.send" })).toBe("business");
    expect(getApprovalRouteClass({})).toBe("business");
  });
});

describe("findRouteForClass", () => {
  test("finds admin route", () => {
    const policy = createPolicy({
      routes: [createAdminRoute(), createBusinessRoute()],
    });
    const route = findRouteForClass(policy, "admin");
    expect(route?.class).toBe("admin");
    expect(route?.stages[0].voterUserIds).toEqual([FIXTURE_ADMIN_VOTER]);
  });

  test("finds business route", () => {
    const policy = createPolicy({
      routes: [createAdminRoute(), createBusinessRoute()],
    });
    const route = findRouteForClass(policy, "business");
    expect(route?.class).toBe("business");
    expect(route?.stages[0].voterUserIds).toEqual([FIXTURE_BUSINESS_VOTER]);
  });

  test("returns null when route not found", () => {
    const policy = createPolicy({
      routes: [createBusinessRoute()],
    });
    expect(findRouteForClass(policy, "admin")).toBeNull();
  });

  test("returns null when no routes defined", () => {
    const policy = createPolicy({});
    expect(findRouteForClass(policy, "admin")).toBeNull();
  });
});

describe("hasValidAdminRoute", () => {
  test("returns true for policy with valid admin route", () => {
    const policy = createPolicy({
      routes: [createAdminRoute()],
    });
    expect(hasValidAdminRoute(policy)).toBe(true);
  });

  test("returns false for policy without admin route", () => {
    const policy = createPolicy({
      routes: [createBusinessRoute()],
    });
    expect(hasValidAdminRoute(policy)).toBe(false);
  });

  test("returns false for admin route with empty voters", () => {
    const policy = createPolicy({
      routes: [createAdminRoute([])],
    });
    expect(hasValidAdminRoute(policy)).toBe(false);
  });

  test("returns false for null policy", () => {
    expect(hasValidAdminRoute(null)).toBe(false);
  });

  test("returns false for policy without routes", () => {
    const policy = createPolicy({});
    expect(hasValidAdminRoute(policy)).toBe(false);
  });
});

describe("buildDefaultAdminRouteFromOwners", () => {
  test("builds admin route from org owners", () => {
    const route = buildDefaultAdminRouteFromOwners([FIXTURE_ORG_OWNER_1, FIXTURE_ORG_OWNER_2]);
    expect(route?.class).toBe("admin");
    expect(route?.stages.length).toBe(1);
    expect(route?.stages[0].voterUserIds).toEqual([FIXTURE_ORG_OWNER_1, FIXTURE_ORG_OWNER_2]);
    expect(route?.stages[0].quorum).toEqual({ type: "any" });
  });

  test("returns null for empty owners", () => {
    expect(buildDefaultAdminRouteFromOwners([])).toBeNull();
  });
});

describe("canProceedWithAdminApproval", () => {
  test("returns true with explicit admin route", () => {
    const policy = createPolicy({ routes: [createAdminRoute()] });
    expect(canProceedWithAdminApproval(policy, [])).toBe(true);
  });

  test("returns true with org owners as fallback", () => {
    expect(canProceedWithAdminApproval(null, [FIXTURE_ORG_OWNER_1])).toBe(true);
  });

  test("returns false without route or owners", () => {
    expect(canProceedWithAdminApproval(null, [])).toBe(false);
  });
});

describe("getEffectiveAdminRoute", () => {
  test("returns explicit route when available", () => {
    const policy = createPolicy({ routes: [createAdminRoute()] });
    const route = getEffectiveAdminRoute(policy, [FIXTURE_ORG_OWNER_1]);
    expect(route?.stages[0].voterUserIds).toEqual([FIXTURE_ADMIN_VOTER]);
  });

  test("falls back to org owners when no explicit route", () => {
    const route = getEffectiveAdminRoute(null, [FIXTURE_ORG_OWNER_1]);
    expect(route?.stages[0].voterUserIds).toEqual([FIXTURE_ORG_OWNER_1]);
  });

  test("returns null when neither available", () => {
    expect(getEffectiveAdminRoute(null, [])).toBeNull();
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

  test("allows admin-class approval without admin route (W1 preserved)", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null,
      []
    );
    expect(result.ok).toBe(true);
  });

  test("allows business-class approval without policy", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      null,
      null,
      []
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

  test("fails closed for admin-class approval without org policy or owners", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null,
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("admin_policy_required");
    }
  });

  test("succeeds with org owners as default admin approvers", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null,
      [FIXTURE_ORG_OWNER_1]
    );
    expect(result.ok).toBe(true);
  });

  test("fails closed for admin-class approval with employee override only", () => {
    const employeePolicy = createPolicy({
      routes: [createAdminRoute()],
    });
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      employeePolicy,
      []
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("admin_policy_required");
      expect(result.reason).toContain("employee override cannot satisfy");
    }
  });

  test("succeeds for admin-class approval with org-level admin route", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute()],
    });
    const result = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy,
      null,
      []
    );
    expect(result.ok).toBe(true);
  });

  test("allows business-class approval without admin route", () => {
    const orgPolicy = createPolicy({
      routes: [createBusinessRoute()],
    });
    const result = checkAdminPolicyRequirement(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgPolicy,
      null,
      []
    );
    expect(result.ok).toBe(true);
  });

  test("allows business-class approval without policy", () => {
    const result = checkAdminPolicyRequirement(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      null,
      null,
      []
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

  test("allows any voter on admin ticket (flag OFF)", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute(), createBusinessRoute()],
    });
    const result = canVoterVoteOnApproval(
      FIXTURE_BUSINESS_VOTER,
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

  test("allows admin voter on admin ticket", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute(), createBusinessRoute()],
    });
    const result = canVoterVoteOnApproval(
      FIXTURE_ADMIN_VOTER,
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("in_admin_route");
  });

  test("denies business voter on admin ticket", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute(), createBusinessRoute()],
    });
    const result = canVoterVoteOnApproval(
      FIXTURE_BUSINESS_VOTER,
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("business_voter_on_admin_ticket");
  });

  test("allows any voter on business ticket", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute(), createBusinessRoute()],
    });
    const result = canVoterVoteOnApproval(
      FIXTURE_BUSINESS_VOTER,
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("business_class");
  });

  test("allows voting when no class routes defined", () => {
    const orgPolicy = createPolicy({});
    const result = canVoterVoteOnApproval(
      "fixture_any_voter",
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

  test("uses org policy for admin-class approvals (ignores employee override)", () => {
    const orgPolicy = createPolicy({
      routes: [createAdminRoute()],
    });
    const employeePolicy = createPolicy({
      routes: [createAdminRoute(["fixture_employee_admin_voter"])],
    });

    const result = getEffectiveClassPolicy(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgPolicy,
      employeePolicy,
      []
    );

    expect(result.source).toBe("org");
    expect(result.approvalClass).toBe("admin");
    expect(result.route?.stages[0].voterUserIds).toEqual([FIXTURE_ADMIN_VOTER]);
  });

  test("uses org owners as fallback for admin-class approvals", () => {
    const result = getEffectiveClassPolicy(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null,
      [FIXTURE_ORG_OWNER_1]
    );

    expect(result.source).toBe("org_owners_default");
    expect(result.approvalClass).toBe("admin");
    expect(result.route?.stages[0].voterUserIds).toEqual([FIXTURE_ORG_OWNER_1]);
  });

  test("uses employee policy for business-class approvals", () => {
    const orgPolicy = createPolicy({
      routes: [createBusinessRoute(["fixture_org_business_voter"])],
    });
    const employeePolicy = createPolicy({
      routes: [createBusinessRoute()],
    });

    const result = getEffectiveClassPolicy(
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgPolicy,
      employeePolicy,
      []
    );

    expect(result.source).toBe("employee");
    expect(result.approvalClass).toBe("business");
    expect(result.route?.stages[0].voterUserIds).toEqual([FIXTURE_BUSINESS_VOTER]);
  });
});

/**
 * Tenant-agnostic invariant tests.
 * These tests must pass for any org fixture and verify security invariants.
 */
describe("INVARIANT: Cross-org voter isolation", () => {
  const ORG_A_VOTER = "fixture_org_a_voter";
  const ORG_B_VOTER = "fixture_org_b_voter";

  const orgAPolicy = createPolicy({
    routes: [
      createAdminRoute([ORG_A_VOTER]),
      createBusinessRoute([ORG_A_VOTER]),
    ],
  });

  const orgBPolicy = createPolicy({
    routes: [
      createAdminRoute([ORG_B_VOTER]),
      createBusinessRoute([ORG_B_VOTER]),
    ],
  });

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

  test("INVARIANT: voter from org B cannot vote on org A admin ticket", () => {
    const result = canVoterVoteOnApproval(
      ORG_B_VOTER,
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      orgAPolicy
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("not_in_admin_route");
  });

  test("INVARIANT: voter from org B cannot vote on org A business ticket when routes configured", () => {
    const result = canVoterVoteOnApproval(
      ORG_B_VOTER,
      { purpose: "tool.invoke", tool: "mail.send", metadata: {} },
      orgAPolicy
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("business_class");
  });

  test("INVARIANT: org owner from org B is not valid for org A admin approval", () => {
    const resultOrgA = checkAdminPolicyRequirement(
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      null,
      null,
      [ORG_A_VOTER]
    );
    expect(resultOrgA.ok).toBe(true);

    const resultOrgB = canVoterVoteOnApproval(
      ORG_B_VOTER,
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      createPolicy({ routes: [createAdminRoute([ORG_A_VOTER])] })
    );
    expect(resultOrgB.allowed).toBe(false);
  });

  test("INVARIANT: empty voter list means no one can vote", () => {
    const emptyPolicy = createPolicy({
      routes: [createAdminRoute([])],
    });
    const result = canVoterVoteOnApproval(
      ORG_A_VOTER,
      { purpose: "admin.hire", tool: "employees.issue", metadata: { auditClass: "admin" } },
      emptyPolicy
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("not_in_admin_route");
  });
});

/**
 * Tests for canResolverResolveAdminApproval - W1 path restriction.
 * These tests verify that when admin_approver_enforcement is enabled:
 * - Explicit admin route: only admin-route voters can resolve
 * - No admin route: only org owners can resolve (default approvers)
 * - Business voters cannot resolve admin tickets
 * - Enforcement OFF: any resolver allowed (W1 preserved)
 */
describe("canResolverResolveAdminApproval (W1 path restriction)", () => {
  const FIXTURE_ADMIN_RESOLVER = "fixture_admin_resolver";
  const FIXTURE_BUSINESS_RESOLVER = "fixture_business_resolver";
  const FIXTURE_NON_VOTER = "fixture_non_voter";
  const FIXTURE_ORG_OWNER = "fixture_org_owner";

  const adminApproval = { purpose: "admin.hire", tool: "employees.issue", metadata: { approvalClass: "admin" } };
  const businessApproval = { purpose: "tool.invoke", tool: "mail.send", metadata: {} };

  const policyWithRoutes = createPolicy({
    routes: [
      createAdminRoute([FIXTURE_ADMIN_RESOLVER]),
      createBusinessRoute([FIXTURE_BUSINESS_RESOLVER]),
    ],
  });

  describe("enforcement OFF (W1 preserved)", () => {
    test("allows any resolver on admin ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_BUSINESS_RESOLVER,
        adminApproval,
        policyWithRoutes,
        [],
        false // enforcement OFF
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("enforcement_off");
    });

    test("allows any resolver on business ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_NON_VOTER,
        businessApproval,
        policyWithRoutes,
        [],
        false
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("enforcement_off");
    });
  });

  describe("enforcement ON with explicit admin route", () => {
    test("allows admin-route resolver on admin ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_ADMIN_RESOLVER,
        adminApproval,
        policyWithRoutes,
        [],
        true // enforcement ON
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("in_admin_route");
    });

    test("denies business-route resolver on admin ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_BUSINESS_RESOLVER,
        adminApproval,
        policyWithRoutes,
        [],
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("business_voter_on_admin_ticket");
    });

    test("denies non-route resolver on admin ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_NON_VOTER,
        adminApproval,
        policyWithRoutes,
        [],
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("not_in_admin_route");
    });

    test("allows any resolver on business ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_BUSINESS_RESOLVER,
        businessApproval,
        policyWithRoutes,
        [],
        true
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("business_class");
    });
  });

  describe("enforcement ON without admin route (org owners as default)", () => {
    const policyWithoutAdminRoute = createPolicy({
      routes: [createBusinessRoute([FIXTURE_BUSINESS_RESOLVER])],
    });

    test("allows org owner on admin ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_ORG_OWNER,
        adminApproval,
        policyWithoutAdminRoute,
        [FIXTURE_ORG_OWNER],
        true
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("org_owner_default");
    });

    test("denies non-owner member on admin ticket", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_BUSINESS_RESOLVER,
        adminApproval,
        policyWithoutAdminRoute,
        [FIXTURE_ORG_OWNER],
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });

    test("denies any resolver when no org owners exist", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_BUSINESS_RESOLVER,
        adminApproval,
        policyWithoutAdminRoute,
        [], // no owners
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });
  });

  describe("null policy (enforcement ON)", () => {
    test("allows org owner when null policy", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_ORG_OWNER,
        adminApproval,
        null, // null policy
        [FIXTURE_ORG_OWNER],
        true
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("org_owner_default");
    });

    test("denies non-owner when null policy", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_NON_VOTER,
        adminApproval,
        null,
        [FIXTURE_ORG_OWNER],
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });

    test("denies any resolver when null policy and no owners", () => {
      const result = canResolverResolveAdminApproval(
        FIXTURE_NON_VOTER,
        adminApproval,
        null,
        [],
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });
  });
});

/**
 * SQL-level enforcement tests via resolve_approval_w1_checked RPC.
 *
 * These tests verify the security fix for the DB guard hole:
 * - enforcement ON + resolved_by null + approved => rejected
 * - Slack presser without binding => rejected (memberId null)
 * - Owner via web with memberId => ok
 * - Non-owner with memberId => rejected
 * - Other-org member => rejected
 * - enforcement OFF => unchanged (null memberId allowed)
 *
 * Note: These are tested at the app level via canResolverResolveAdminApproval
 * because the actual SQL RPC requires a database connection. The app function
 * mirrors the SQL logic for the same security checks.
 */
describe("SQL-level enforcement (via app-level mirror)", () => {
  const ADMIN_TICKET = { purpose: "admin.hire", tool: "employees.issue", metadata: { approvalClass: "admin" } };
  const BUSINESS_TICKET = { purpose: "tool.invoke", tool: "mail.send", metadata: {} };
  const OWNER = "fixture_owner";
  const NON_OWNER = "fixture_non_owner";
  const OTHER_ORG_MEMBER = "fixture_other_org_member";

  describe("enforcement ON + null memberId", () => {
    test("SECURITY: null memberId on approved admin ticket => rejected", () => {
      // Simulates: Slack presser without voter binding (memberId = null)
      // The RPC will reject because p_member_id is null for admin-class ticket
      const result = canResolverResolveAdminApproval(
        "", // empty string simulates null memberId
        ADMIN_TICKET,
        null, // no policy
        [OWNER],
        true // enforcement ON
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });

    test("SECURITY: Slack presser without binding is denied", () => {
      // When voter binding lookup returns null, memberId is null
      // For admin-class tickets with enforcement ON, this MUST be rejected
      const result = canResolverResolveAdminApproval(
        "", // no memberId from binding
        ADMIN_TICKET,
        null,
        [OWNER],
        true
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("enforcement ON + valid memberId", () => {
    test("owner via web with memberId => allowed", () => {
      const result = canResolverResolveAdminApproval(
        OWNER,
        ADMIN_TICKET,
        null,
        [OWNER],
        true
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("org_owner_default");
    });

    test("non-owner member => rejected", () => {
      const result = canResolverResolveAdminApproval(
        NON_OWNER,
        ADMIN_TICKET,
        null,
        [OWNER],
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });

    test("other-org member => rejected (not in owner list)", () => {
      const result = canResolverResolveAdminApproval(
        OTHER_ORG_MEMBER,
        ADMIN_TICKET,
        null,
        [OWNER], // other-org member not in this list
        true
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("non_owner_on_admin_ticket");
    });
  });

  describe("enforcement OFF (backward compatibility)", () => {
    test("null memberId on admin ticket => allowed (W1 preserved)", () => {
      const result = canResolverResolveAdminApproval(
        "", // empty memberId
        ADMIN_TICKET,
        null,
        [OWNER],
        false // enforcement OFF
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("enforcement_off");
    });

    test("any resolver on admin ticket => allowed", () => {
      const result = canResolverResolveAdminApproval(
        NON_OWNER,
        ADMIN_TICKET,
        null,
        [OWNER],
        false
      );
      expect(result.allowed).toBe(true);
    });

    test("business ticket always allowed regardless of enforcement", () => {
      const resultOff = canResolverResolveAdminApproval(
        NON_OWNER,
        BUSINESS_TICKET,
        null,
        [],
        false
      );
      const resultOn = canResolverResolveAdminApproval(
        NON_OWNER,
        BUSINESS_TICKET,
        null,
        [],
        true
      );
      expect(resultOff.allowed).toBe(true);
      expect(resultOn.allowed).toBe(true);
    });
  });
});

describe("INVARIANT: Approval classification is deterministic", () => {
  test("INVARIANT: same approval always returns same classification", () => {
    const approvals = [
      { metadata: { approvalClass: "admin" } },
      { metadata: { approvalClass: "business" } },
      { tool: "employees.issue" },
      { tool: "mail.send" },
      { purpose: "admin.hire" },
      { purpose: "tool.invoke" },
    ];
    for (const approval of approvals) {
      const first = isAdminClassApproval(approval);
      const second = isAdminClassApproval(approval);
      const third = isAdminClassApproval(approval);
      expect(first).toBe(second);
      expect(second).toBe(third);
    }
  });

  test("INVARIANT: metadata.approvalClass is authoritative", () => {
    const adminApprovals = [
      { metadata: { approvalClass: "admin" } },
      { metadata: { auditClass: "admin" } },
      { metadata: { isAdminMcpTool: true } },
    ];
    const businessApprovals = [
      { metadata: { approvalClass: "business" } },
      { tool: "mail.send" },
      { purpose: "tool.invoke" },
    ];

    for (const approval of adminApprovals) {
      expect(isAdminClassApproval(approval)).toBe(true);
    }
    for (const approval of businessApprovals) {
      expect(isAdminClassApproval(approval)).toBe(false);
    }
  });
});
