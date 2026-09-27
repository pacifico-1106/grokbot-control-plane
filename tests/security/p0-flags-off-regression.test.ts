/**
 * P0 Item 7: Flags-OFF Regression Suite
 * 
 * With every flag OFF, the legacy W1 approve/reject flow and channel delivery
 * behave exactly as before (snapshot key outputs).
 * 
 * Flags tested:
 * - ADMIN_APPROVER_POLICY_REQUIRED (default OFF)
 * - SLACK_APPROVAL_STRICT (default OFF)
 * - APPROVAL_RECIPIENT_ROUTING (default OFF)
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

const envBackup = {
  adminPolicy: process.env.ADMIN_APPROVER_POLICY_REQUIRED,
  slackStrict: process.env.SLACK_APPROVAL_STRICT,
  recipientRouting: process.env.APPROVAL_RECIPIENT_ROUTING,
};

beforeEach(() => {
  delete process.env.ADMIN_APPROVER_POLICY_REQUIRED;
  delete process.env.SLACK_APPROVAL_STRICT;
  delete process.env.APPROVAL_RECIPIENT_ROUTING;
});

afterEach(() => {
  process.env.ADMIN_APPROVER_POLICY_REQUIRED = envBackup.adminPolicy;
  process.env.SLACK_APPROVAL_STRICT = envBackup.slackStrict;
  process.env.APPROVAL_RECIPIENT_ROUTING = envBackup.recipientRouting;
});

const {
  isAdminApproverPolicyRequired,
  isSlackApprovalStrict,
} = await import("@/lib/feature-flags");

const { isRecipientRoutingEnabled } = await import("@/lib/notify/recipient-routing");

const {
  canVoterVoteOnApproval,
  canResolverResolveAdminApproval,
  checkAdminPolicyRequirement,
} = await import("@/lib/approval-workflow/admin-policy");

const { isSlackUserFromExpectedTeam } = await import("@/lib/slack/channel-validation");

describe("FLAGS-OFF REGRESSION: Feature flags default to OFF", () => {
  test("ADMIN_APPROVER_POLICY_REQUIRED is OFF by default", () => {
    expect(isAdminApproverPolicyRequired()).toBe(false);
  });

  test("SLACK_APPROVAL_STRICT is OFF by default", () => {
    expect(isSlackApprovalStrict()).toBe(false);
  });

  test("APPROVAL_RECIPIENT_ROUTING is OFF by default", () => {
    expect(isRecipientRoutingEnabled()).toBe(false);
  });
});

describe("FLAGS-OFF REGRESSION: W1 legacy approve/reject preserved", () => {
  test("canVoterVoteOnApproval allows any voter when flag OFF", () => {
    const adminApproval = {
      purpose: "admin.hire",
      metadata: { approvalClass: "admin" },
    };

    const result = canVoterVoteOnApproval("any_user", adminApproval, null);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("flag_off");
  });

  test("canResolverResolveAdminApproval allows any resolver when enforcement OFF", () => {
    const adminApproval = {
      purpose: "admin.hire",
      metadata: { approvalClass: "admin" },
    };

    const result = canResolverResolveAdminApproval(
      "any_resolver",
      adminApproval,
      null,
      [],
      false
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("enforcement_off");
  });

  test("checkAdminPolicyRequirement allows all when flag OFF", () => {
    const adminApproval = {
      purpose: "admin.hire",
      tool: "employees.issue",
      metadata: { approvalClass: "admin" },
    };

    const result = checkAdminPolicyRequirement(
      adminApproval,
      null,
      null,
      []
    );
    expect(result.ok).toBe(true);
  });
});

describe("FLAGS-OFF REGRESSION: Slack team check non-strict", () => {
  test("allows when no team check configured (non-strict default)", () => {
    const result = isSlackUserFromExpectedTeam("T_USER", undefined, false);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("no_team_check_configured");
  });

  test("allows same team", () => {
    const result = isSlackUserFromExpectedTeam("T_SAME", "T_SAME", false);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("same_team");
  });

  test("still rejects external team even in non-strict mode", () => {
    const result = isSlackUserFromExpectedTeam("T_EXTERNAL", "T_EXPECTED", false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("external_team_user");
  });
});

describe("FLAGS-OFF REGRESSION: Recipient routing falls back to default channel", () => {
  test("routeApprovalToRecipients returns fallbackToDefault when flag OFF", async () => {
    const { routeApprovalToRecipients } = await import("@/lib/notify/recipient-routing");

    const approval = {
      id: "test",
      orgId: "test_org",
      employeeId: "",
      credentialId: "",
      title: "Test",
      summary: "Test",
      purpose: "tool.invoke",
      risk: "medium" as const,
      tool: "mail.send",
      status: "pending" as const,
      metadata: {},
      createdAt: new Date().toISOString(),
      pollPath: "/api/approvals/test/status",
    };

    const result = await routeApprovalToRecipients({
      approval,
      employee: null,
    });

    expect(result.fallbackToDefault).toBe(true);
    expect(result.reason).toBe("feature_flag_off");
  });
});
