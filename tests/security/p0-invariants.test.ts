/**
 * P0 Item 7: Security Invariant Tests
 * 
 * Tenant-agnostic invariant suite parametrized over synthetic orgs.
 * No hardcoded real org IDs/names.
 * 
 * Invariants tested:
 * a. Slack Connect / shared channels rejected everywhere
 * b. Cross-org votes blocked
 * c. Unverified/expired/revoked bindings never count
 * d. Verification codes single-use, expire, bound to org+user+team
 * e. Unclassified tools = admin; admin-class without approver fails closed
 * f. Business voters cannot resolve admin-class tickets
 * g. Interactivity endpoint security checks
 * h. Recipient routing never delivers to shared/wrong channels
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import type { OrgMember, OrgApprovalWorkflowPolicy, ApprovalRequest } from "@/lib/types";

const SYNTH_ORG_A = "synth_org_invariant_a";
const SYNTH_ORG_B = "synth_org_invariant_b";
const SYNTH_CHANNEL_A = "synth_channel_a";
const SYNTH_CHANNEL_B = "synth_channel_b";
const SYNTH_MEMBER_A = "synth_member_a";
const SYNTH_MEMBER_B = "synth_member_b";
const SYNTH_OWNER_A = "synth_owner_a";
const SYNTH_EXTERNAL_USER = "U_EXT_USER";
const SYNTH_INTERNAL_USER = "U_INT_USER";

const demoMembers = new Map<string, OrgMember>();

const baseMemberA: OrgMember = {
  id: SYNTH_MEMBER_A,
  orgId: SYNTH_ORG_A,
  email: "member-a@synth-org-a.example",
  displayName: "Synth Member A",
  role: "member",
  capabilities: ["approve_actions"],
  status: "active",
  jobRole: "admin_affairs",
};

const baseMemberB: OrgMember = {
  id: SYNTH_MEMBER_B,
  orgId: SYNTH_ORG_B,
  email: "member-b@synth-org-b.example",
  displayName: "Synth Member B",
  role: "member",
  capabilities: ["approve_actions"],
  status: "active",
  jobRole: "admin_affairs",
};

const ownerA: OrgMember = {
  id: SYNTH_OWNER_A,
  orgId: SYNTH_ORG_A,
  email: "owner@synth-org-a.example",
  displayName: "Synth Owner A",
  role: "owner",
  capabilities: ["approve_actions"],
  status: "active",
  jobRole: "owner",
};

mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
  isSupabaseConfigured: () => false,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo",
}));

mock.module("@/lib/demo-data", () => ({
  getRuntimeMemberById: (id: string) => demoMembers.get(id) ?? null,
  setRuntimeMember: (m: OrgMember) => demoMembers.set(m.id, m),
  resetRuntimeMembers: () => demoMembers.clear(),
  DEMO_ORG: { id: "demo_org_fixture" },
}));

const {
  validateSlackChannelNotExternal,
  isSlackUserFromExpectedTeam,
} = await import("@/lib/slack/channel-validation");

const {
  setDemoWorkflowVoterBinding,
  resetDemoWorkflowData,
  getDemoWorkflowVoterBinding,
} = await import("@/lib/approval-workflow/data");

const {
  createPendingVoterBinding,
  verifyVoterBinding,
  revokeVoterBinding,
  listVoterBindings,
  checkMemberBelongsToOrg,
  resetDemoVoterBindings,
} = await import("@/lib/approval-workflow/voter-binding");

const {
  isAdminClassApproval,
  getApprovalRouteClass,
} = await import("@/lib/admin-mcp/audit-class");

const {
  canVoterVoteOnApproval,
  canResolverResolveAdminApproval,
  checkAdminPolicyRequirement,
  ADMIN_AUDIT_CLASS,
  BUSINESS_AUDIT_CLASS,
} = await import("@/lib/approval-workflow/admin-policy");

const {
  validateDeliveryRecipient,
  isRecipientRoutingEnabled,
} = await import("@/lib/notify/recipient-routing");

const { isSlackUserAuthorizedForApproval } = await import("@/lib/approval-workflow/slack-voter");

const makeMockFetch = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve({
      status,
      json: () => Promise.resolve(body),
    })) as typeof fetch;

const SYNTH_ORGS = [SYNTH_ORG_A, SYNTH_ORG_B];

describe("INVARIANT SUITE: Slack Connect / shared channels rejected", () => {
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  const EXTERNAL_CHANNEL_CASES = [
    { name: "is_ext_shared", flags: { is_ext_shared: true }, code: "slack_connect_channel" },
    { name: "is_shared", flags: { is_shared: true }, code: "shared_channel" },
    { name: "is_pending_ext_shared", flags: { is_pending_ext_shared: true }, code: "pending_external_share" },
  ];

  for (const orgId of SYNTH_ORGS) {
    describe(`Org: ${orgId}`, () => {
      for (const { name, flags, code } of EXTERNAL_CHANNEL_CASES) {
        test(`INVARIANT: ${name} channel is rejected at registration`, async () => {
          globalThis.fetch = makeMockFetch({
            ok: true,
            channel: { id: `C_${name}_${orgId}`, name: `channel-${name}`, ...flags },
          }) as typeof fetch;

          const result = await validateSlackChannelNotExternal("xoxb-test-token", `C_${name}_${orgId}`);
          expect(result.ok).toBe(false);
        });
      }

      test("INVARIANT: internal channel without any share flags is allowed", async () => {
        globalThis.fetch = makeMockFetch({
          ok: true,
          channel: {
            id: `C_INTERNAL_${orgId}`,
            name: "internal-channel",
            is_ext_shared: false,
            is_shared: false,
            is_pending_ext_shared: false,
            is_org_shared: false,
          },
        }) as typeof fetch;

        const result = await validateSlackChannelNotExternal("xoxb-test-token", `C_INTERNAL_${orgId}`);
        expect(result.ok).toBe(true);
      });
    });
  }
});

describe("INVARIANT SUITE: Cross-org votes blocked", () => {
  beforeEach(() => {
    resetDemoWorkflowData();
    resetDemoVoterBindings();
    demoMembers.clear();
    demoMembers.set(baseMemberA.id, baseMemberA);
    demoMembers.set(baseMemberB.id, baseMemberB);
    demoMembers.set(ownerA.id, ownerA);
  });

  afterEach(() => {
    resetDemoWorkflowData();
    resetDemoVoterBindings();
    demoMembers.clear();
  });

  test("INVARIANT: voter binding in org B cannot vote in org A (per-ref Slack path)", async () => {
    setDemoWorkflowVoterBinding({
      orgId: SYNTH_ORG_B,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      userId: SYNTH_EXTERNAL_USER,
      memberId: SYNTH_MEMBER_B,
      verifiedAt: new Date().toISOString(),
    });

    const result = await isSlackUserAuthorizedForApproval(
      SYNTH_ORG_A,
      SYNTH_CHANNEL_A,
      SYNTH_EXTERNAL_USER,
      [],
      true
    );
    expect(result.authorized).toBe(false);
  });

  test("INVARIANT: voter binding in org A is only valid for org A", async () => {
    setDemoWorkflowVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      userId: SYNTH_INTERNAL_USER,
      memberId: SYNTH_MEMBER_A,
      verifiedAt: new Date().toISOString(),
    });

    const resultA = await isSlackUserAuthorizedForApproval(
      SYNTH_ORG_A, SYNTH_CHANNEL_A, SYNTH_INTERNAL_USER, [], true
    );
    expect(resultA.authorized).toBe(true);

    const resultB = await isSlackUserAuthorizedForApproval(
      SYNTH_ORG_B, SYNTH_CHANNEL_A, SYNTH_INTERNAL_USER, [], true
    );
    expect(resultB.authorized).toBe(false);
  });

  test("INVARIANT: createPendingVoterBinding rejects cross-org member", async () => {
    const result = await createPendingVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_EXTERNAL_USER,
      memberId: SYNTH_MEMBER_B,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cross_org|member_not_found/);
    }
  });
});

describe("INVARIANT SUITE: Unverified/expired/revoked bindings never count", () => {
  beforeEach(() => {
    resetDemoWorkflowData();
    resetDemoVoterBindings();
    demoMembers.clear();
    demoMembers.set(baseMemberA.id, baseMemberA);
  });

  afterEach(() => {
    resetDemoWorkflowData();
    resetDemoVoterBindings();
  });

  for (const orgId of SYNTH_ORGS) {
    describe(`Org: ${orgId}`, () => {
      test("INVARIANT: unverified binding (pending) is not counted", async () => {
        setDemoWorkflowVoterBinding({
          orgId,
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
          memberId: SYNTH_MEMBER_A,
        });

        const memberId = getDemoWorkflowVoterBinding(orgId, {
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
        });
        expect(memberId).toBe("");
      });

      test("INVARIANT: expired binding is not counted", async () => {
        const expiredDate = new Date(Date.now() - 1000).toISOString();
        setDemoWorkflowVoterBinding({
          orgId,
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
          memberId: SYNTH_MEMBER_A,
          verifiedAt: new Date(Date.now() - 86400000).toISOString(),
          expiresAt: expiredDate,
        });

        const memberId = getDemoWorkflowVoterBinding(orgId, {
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
        });
        expect(memberId).toBe("");
      });

      test("INVARIANT: revoked binding is not counted", async () => {
        setDemoWorkflowVoterBinding({
          orgId,
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
          memberId: SYNTH_MEMBER_A,
          verifiedAt: new Date().toISOString(),
          revoked: true,
        });

        const memberId = getDemoWorkflowVoterBinding(orgId, {
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
        });
        expect(memberId).toBe("");
      });

      test("INVARIANT: valid verified binding IS counted", async () => {
        demoMembers.set(SYNTH_MEMBER_A, { ...baseMemberA, orgId });
        
        setDemoWorkflowVoterBinding({
          orgId,
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
          memberId: SYNTH_MEMBER_A,
          verifiedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        });

        const memberId = getDemoWorkflowVoterBinding(orgId, {
          provider: "slack",
          channelKey: SYNTH_CHANNEL_A,
          userId: SYNTH_INTERNAL_USER,
        });
        expect(memberId).toBe(SYNTH_MEMBER_A);
      });
    });
  }
});

describe("INVARIANT SUITE: Verification codes", () => {
  beforeEach(() => {
    resetDemoVoterBindings();
    demoMembers.clear();
    demoMembers.set(baseMemberA.id, baseMemberA);
  });

  afterEach(() => {
    resetDemoVoterBindings();
  });

  test("INVARIANT: verification code is single-use", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      memberId: SYNTH_MEMBER_A,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const firstVerify = await verifyVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      verificationCode: createResult.verificationCode,
    });
    expect(firstVerify.ok).toBe(true);

    const secondVerify = await verifyVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      verificationCode: createResult.verificationCode,
    });
    expect(secondVerify.ok).toBe(false);
    if (!secondVerify.ok) {
      expect(secondVerify.reason).toBe("already_verified");
    }
  });

  test("INVARIANT: verification code is bound to org+user combo", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      memberId: SYNTH_MEMBER_A,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const wrongOrgVerify = await verifyVoterBinding({
      orgId: SYNTH_ORG_B,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      verificationCode: createResult.verificationCode,
    });
    expect(wrongOrgVerify.ok).toBe(false);

    const wrongUserVerify = await verifyVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: "WRONG_USER",
      verificationCode: createResult.verificationCode,
    });
    expect(wrongUserVerify.ok).toBe(false);
  });

  test("INVARIANT: wrong verification code is rejected", async () => {
    const createResult = await createPendingVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      memberId: SYNTH_MEMBER_A,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const verifyResult = await verifyVoterBinding({
      orgId: SYNTH_ORG_A,
      provider: "slack",
      channelKey: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
      verificationCode: "000000",
    });
    expect(verifyResult.ok).toBe(false);
    if (!verifyResult.ok) {
      expect(verifyResult.reason).toBe("invalid_verification_code");
    }
  });
});

describe("INVARIANT SUITE: Admin-class approvals", () => {
  const envBackup = { adminPolicy: process.env.ADMIN_APPROVER_POLICY_REQUIRED };

  beforeEach(() => {
    process.env.ADMIN_APPROVER_POLICY_REQUIRED = "true";
  });

  afterEach(() => {
    process.env.ADMIN_APPROVER_POLICY_REQUIRED = envBackup.adminPolicy;
  });

  const createApprovalFixture = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    id: "test_approval",
    orgId: SYNTH_ORG_A,
    employeeId: "",
    credentialId: "",
    title: "Test Approval",
    summary: "Test summary",
    purpose: "tool.invoke",
    risk: "medium",
    tool: "mail.send",
    status: "pending",
    metadata: {},
    createdAt: new Date().toISOString(),
    pollPath: "/api/approvals/test/status",
    ...overrides,
  });

  const createPolicy = (options: {
    adminVoters?: string[];
    businessVoters?: string[];
  }): OrgApprovalWorkflowPolicy => ({
    version: 1,
    policyId: "test_policy",
    policyName: "Test Policy",
    stages: [],
    routes: [
      ...(options.adminVoters ? [{
        class: ADMIN_AUDIT_CLASS as "admin",
        stages: [{
          id: "admin_stage",
          nameJa: "管理承認",
          voterUserIds: options.adminVoters,
          quorum: { type: "any" as const },
          onReject: "fail_closed" as const,
        }],
      }] : []),
      ...(options.businessVoters ? [{
        class: BUSINESS_AUDIT_CLASS as "business",
        stages: [{
          id: "business_stage",
          nameJa: "業務承認",
          voterUserIds: options.businessVoters,
          quorum: { type: "any" as const },
          onReject: "fail_closed" as const,
        }],
      }] : []),
    ],
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  });

  test("INVARIANT: unclassified tools default to admin class", () => {
    expect(getApprovalRouteClass({ tool: "setup.unknown" })).toBe("admin");
    expect(getApprovalRouteClass({ purpose: "admin.unknown" })).toBe("admin");
    expect(getApprovalRouteClass({ metadata: { auditClass: "admin" } })).toBe("admin");
  });

  test("INVARIANT: business tools are business class", () => {
    expect(getApprovalRouteClass({ tool: "mail.send" })).toBe("business");
    expect(getApprovalRouteClass({ purpose: "tool.invoke" })).toBe("business");
  });

  test("INVARIANT: metadata.approvalClass takes precedence", () => {
    expect(getApprovalRouteClass({
      tool: "mail.send",
      metadata: { approvalClass: "admin" },
    })).toBe("admin");

    expect(getApprovalRouteClass({
      tool: "setup.admin",
      metadata: { approvalClass: "business" },
    })).toBe("business");
  });

  test("INVARIANT: business voter cannot vote on admin-class ticket (flag ON)", () => {
    const policy = createPolicy({
      adminVoters: ["admin_voter"],
      businessVoters: ["business_voter"],
    });

    const adminApproval = createApprovalFixture({
      metadata: { approvalClass: "admin" },
    });

    const check = canVoterVoteOnApproval("business_voter", adminApproval, policy);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("business_voter_on_admin_ticket");
  });

  test("INVARIANT: admin voter CAN vote on admin-class ticket (flag ON)", () => {
    const policy = createPolicy({
      adminVoters: ["admin_voter"],
      businessVoters: ["business_voter"],
    });

    const adminApproval = createApprovalFixture({
      metadata: { approvalClass: "admin" },
    });

    const check = canVoterVoteOnApproval("admin_voter", adminApproval, policy);
    expect(check.allowed).toBe(true);
    expect(check.reason).toBe("in_admin_route");
  });

  test("INVARIANT: non-owner cannot resolve admin-class ticket when enforcement ON", () => {
    const policy = createPolicy({ businessVoters: ["business_voter"] });
    const adminApproval = createApprovalFixture({
      metadata: { approvalClass: "admin" },
    });

    const check = canResolverResolveAdminApproval(
      "business_voter",
      adminApproval,
      policy,
      [SYNTH_OWNER_A],
      true
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("non_owner_on_admin_ticket");
  });

  test("INVARIANT: org owner CAN resolve admin-class ticket as default", () => {
    const policy = createPolicy({ businessVoters: ["business_voter"] });
    const adminApproval = createApprovalFixture({
      metadata: { approvalClass: "admin" },
    });

    const check = canResolverResolveAdminApproval(
      SYNTH_OWNER_A,
      adminApproval,
      policy,
      [SYNTH_OWNER_A],
      true
    );
    expect(check.allowed).toBe(true);
    expect(check.reason).toBe("org_owner_default");
  });
});

describe("INVARIANT SUITE: Interactivity endpoint security", () => {
  test("INVARIANT: user from external team is rejected", () => {
    const result = isSlackUserFromExpectedTeam("T_EXTERNAL", "T_EXPECTED");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("external_team_user");
  });

  test("INVARIANT: user with matching team is allowed", () => {
    const result = isSlackUserFromExpectedTeam("T_EXPECTED", "T_EXPECTED");
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("same_team");
  });

  test("INVARIANT: missing user team_id is rejected", () => {
    const result = isSlackUserFromExpectedTeam(undefined, "T_EXPECTED");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_team_id_missing");
  });

  test("INVARIANT: strict mode rejects when expectedTeamId not configured", () => {
    const result = isSlackUserFromExpectedTeam("T_USER", undefined, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("expected_team_id_not_configured");
  });
});

describe("INVARIANT SUITE: Recipient routing security", () => {
  test("INVARIANT: admin-class tickets must use channel delivery, not DM", () => {
    const adminApproval: ApprovalRequest = {
      id: "admin_test",
      orgId: SYNTH_ORG_A,
      employeeId: "",
      credentialId: "",
      title: "Admin Approval",
      summary: "Admin test",
      purpose: "admin.hire",
      risk: "high",
      tool: "employees.issue",
      status: "pending",
      metadata: { approvalClass: "admin" },
      createdAt: new Date().toISOString(),
      pollPath: "/api/approvals/admin_test/status",
    };

    const dmRecipient = {
      kind: "dm" as const,
      provider: "slack" as const,
      channelId: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
    };

    const check = validateDeliveryRecipient(dmRecipient, adminApproval);
    expect(check.valid).toBe(false);
    expect(check.reason).toBe("admin_class_must_use_channel");
  });

  test("INVARIANT: business-class tickets can use DM delivery", () => {
    const businessApproval: ApprovalRequest = {
      id: "business_test",
      orgId: SYNTH_ORG_A,
      employeeId: "",
      credentialId: "",
      title: "Business Approval",
      summary: "Business test",
      purpose: "tool.invoke",
      risk: "medium",
      tool: "mail.send",
      status: "pending",
      metadata: { approvalClass: "business" },
      createdAt: new Date().toISOString(),
      pollPath: "/api/approvals/business_test/status",
    };

    const dmRecipient = {
      kind: "dm" as const,
      provider: "slack" as const,
      channelId: SYNTH_CHANNEL_A,
      externalUserId: SYNTH_INTERNAL_USER,
    };

    const check = validateDeliveryRecipient(dmRecipient, businessApproval);
    expect(check.valid).toBe(true);
  });
});
