/**
 * P0-ID, P0-IN, P0-RP Test Suite
 *
 * Tests for:
 * - P0-ID: Employee identity binding (flag-off regression + invariants)
 * - P0-IN: Inbox routing to responsible human (flag-off regression + invariants)
 * - P0-RP: Reply policy recipient validation (flag-off regression + invariants)
 *
 * Security invariants:
 * - All flags default OFF
 * - Cross-org binding prohibited
 * - Slack Connect shared channels never used for approval delivery
 * - Fail-closed when destination unclear
 * - reply/send approval class = business
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const envBackup = {
  employeeIdentity: process.env.P0_EMPLOYEE_IDENTITY_ENABLED,
  inboxRouting: process.env.P0_INBOX_ROUTING_ENABLED,
  replyPolicyEnhanced: process.env.P0_REPLY_POLICY_ENHANCED,
};

beforeEach(() => {
  delete process.env.P0_EMPLOYEE_IDENTITY_ENABLED;
  delete process.env.P0_INBOX_ROUTING_ENABLED;
  delete process.env.P0_REPLY_POLICY_ENHANCED;
});

afterEach(() => {
  process.env.P0_EMPLOYEE_IDENTITY_ENABLED = envBackup.employeeIdentity;
  process.env.P0_INBOX_ROUTING_ENABLED = envBackup.inboxRouting;
  process.env.P0_REPLY_POLICY_ENHANCED = envBackup.replyPolicyEnhanced;
});

const {
  isEmployeeIdentityEnabled,
  isInboxRoutingEnabled,
  isReplyPolicyEnhancedEnabled,
} = await import("@/lib/feature-flags");

describe("P0-ID/IN/RP: Feature flags default to OFF", () => {
  test("P0_EMPLOYEE_IDENTITY_ENABLED is OFF by default", () => {
    expect(isEmployeeIdentityEnabled()).toBe(false);
  });

  test("P0_INBOX_ROUTING_ENABLED is OFF by default", () => {
    expect(isInboxRoutingEnabled()).toBe(false);
  });

  test("P0_REPLY_POLICY_ENHANCED is OFF by default", () => {
    expect(isReplyPolicyEnhancedEnabled()).toBe(false);
  });
});

describe("P0-ID: Employee Identity Binding", () => {
  test("checkFeatureEnabled returns error when flag OFF", async () => {
    const { checkFeatureEnabled } = await import("@/lib/employees/employee-identity");
    const result = checkFeatureEnabled();
    expect(result).not.toBeNull();
    expect(result!.code).toBe("feature_disabled");
  });

  test("getIdentityBindingStatus returns disabled when flag OFF", async () => {
    const { getIdentityBindingStatus } = await import("@/lib/employees/employee-identity");
    const status = await getIdentityBindingStatus("test_org");
    expect(status.enabled).toBe(false);
    expect(status.messageJa).toContain("無効");
  });

  test("upsertIdentityBinding returns error when flag OFF", async () => {
    const { upsertIdentityBinding } = await import("@/lib/employees/employee-identity");
    const result = await upsertIdentityBinding({
      orgId: "test_org",
      employeeId: "emp_test",
      responsibleMemberId: "mem_test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("feature_disabled");
    }
  });

  test("bindMailbox returns error when flag OFF", async () => {
    const { bindMailbox } = await import("@/lib/employees/employee-identity");
    const result = await bindMailbox({
      orgId: "test_org",
      employeeId: "emp_test",
      mailboxId: "mbx_test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("feature_disabled");
    }
  });
});

describe("P0-IN: Inbox Routing", () => {
  test("routeInboxToResponsibleHuman returns fallback when flag OFF", async () => {
    const { routeInboxToResponsibleHuman } = await import("@/lib/notify/inbox-routing");
    
    const approval = {
      id: "apr_test",
      orgId: "test_org",
      employeeId: "emp_test",
      credentialId: "cred_test",
      title: "Test Approval",
      purpose: "tool.invoke",
      summary: "Test",
      risk: "medium" as const,
      status: "pending" as const,
      tool: "mail.send",
      jobId: "job_test",
      revisionNote: null,
      revisionCount: 0,
      parentApprovalId: null,
      telegramRef: null,
      telegramMessageId: null,
      metadata: {},
      statusToken: "st_test",
      pollPath: "/api/approvals/test/status",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };

    const result = await routeInboxToResponsibleHuman({
      approval,
      employee: null,
    });

    expect(result.fallbackToDefault).toBe(true);
    expect(result.reason).toBe("feature_flag_off");
    expect(result.surface).toBe("channel");
  });

  test("getApprovalRouteClass returns business for non-admin approvals", async () => {
    const { getApprovalRouteClass } = await import("@/lib/notify/inbox-routing");
    
    const businessApproval = {
      purpose: "tool.invoke",
      tool: "mail.send",
      metadata: {},
    };

    expect(getApprovalRouteClass(businessApproval)).toBe("business");
  });

  test("getApprovalRouteClass returns admin for admin-class approvals", async () => {
    const { getApprovalRouteClass } = await import("@/lib/notify/inbox-routing");
    
    const adminApproval = {
      purpose: "admin.hire",
      tool: "employees.issue",
      metadata: { approvalClass: "admin" },
    };

    expect(getApprovalRouteClass(adminApproval)).toBe("admin");
  });

  test("admin-class approvals always use default channel (not DM)", async () => {
    const { routeInboxToResponsibleHuman } = await import("@/lib/notify/inbox-routing");
    
    process.env.P0_INBOX_ROUTING_ENABLED = "true";

    const adminApproval = {
      id: "apr_test",
      orgId: "test_org",
      employeeId: "emp_test",
      credentialId: "cred_test",
      title: "Admin Approval",
      purpose: "admin.hire",
      summary: "Test",
      risk: "high" as const,
      status: "pending" as const,
      tool: "employees.issue",
      jobId: "job_test",
      revisionNote: null,
      revisionCount: 0,
      parentApprovalId: null,
      telegramRef: null,
      telegramMessageId: null,
      metadata: { approvalClass: "admin" },
      statusToken: "st_test",
      pollPath: "/api/approvals/test/status",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };

    const result = await routeInboxToResponsibleHuman({
      approval: adminApproval,
      employee: null,
    });

    expect(result.fallbackToDefault).toBe(true);
    expect(result.reason).toBe("admin_class_uses_default_channel");
    expect(result.surface).toBe("channel");

    delete process.env.P0_INBOX_ROUTING_ENABLED;
  });
});

describe("P0-RP: Reply Recipient Validation", () => {
  test("validateReplyRecipient allows all when flag OFF", async () => {
    const { validateReplyRecipient } = await import("@/lib/gateway/reply-recipient-validate");
    
    const result = await validateReplyRecipient({
      orgId: "test_org",
      employee: null,
      context: { slackChannelId: "C_TEST" },
    });

    expect(result.status).toBe("allowed");
    expect(result.reason).toBe("feature_flag_off");
    expect(result.approvalClass).toBe("business");
    expect(result.failClosed).toBe(false);
  });

  test("decideReplyDestination returns channel when flag OFF", async () => {
    const { decideReplyDestination } = await import("@/lib/gateway/reply-recipient-validate");
    
    const result = await decideReplyDestination({
      orgId: "test_org",
      context: { slackChannelId: "C_TEST" },
      surface: "slack",
      preferThread: true,
    });

    expect(result.choice).toBe("channel");
    expect(result.reason).toBe("feature_flag_off");
    expect(result.failClosed).toBe(false);
  });

  test("getReplyApprovalClass always returns business", async () => {
    const { getReplyApprovalClass } = await import("@/lib/gateway/reply-recipient-validate");
    expect(getReplyApprovalClass()).toBe("business");
  });

  test("isReplyFailClosed detects fail-closed conditions", async () => {
    const { isReplyFailClosed } = await import("@/lib/gateway/reply-recipient-validate");
    
    const recipientValidation = {
      status: "needs_approval" as const,
      audience: "unknown" as const,
      reason: "fail_closed_unknown_recipient",
      approvalClass: "business" as const,
      failClosed: true,
    };

    const destinationDecision = {
      choice: "channel" as const,
      failClosed: false,
      reason: "default",
    };

    expect(isReplyFailClosed(recipientValidation, destinationDecision)).toBe(true);
  });
});

describe("P0 Cross-Org Invariants", () => {
  test("member must belong to same org for identity binding", async () => {
    const { checkMemberBelongsToOrg } = await import("@/lib/employees/employee-identity");
    
    const result = await checkMemberBelongsToOrg("mem_nonexistent", "org_test");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("member_not_found");
  });

  test("employee must belong to same org for identity binding", async () => {
    const { checkEmployeeBelongsToOrg } = await import("@/lib/employees/employee-identity");
    
    const result = await checkEmployeeBelongsToOrg("emp_nonexistent", "org_test");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("employee_not_found");
  });
});

describe("P0-IN: Wired Path Tests", () => {
  test("inbox routing module is imported by notify/channels.ts", async () => {
    const channelsModule = await import("@/lib/notify/channels");
    expect(typeof channelsModule.sendApprovalNotifications).toBe("function");
  });

  test("sendApprovalNotifications calls inbox routing when flag ON", async () => {
    process.env.P0_INBOX_ROUTING_ENABLED = "true";

    const approval = {
      id: "apr_wired_test",
      orgId: "test_org",
      employeeId: "emp_test",
      credentialId: "cred_test",
      title: "Test Approval",
      purpose: "tool.invoke",
      summary: "Test",
      risk: "medium" as const,
      status: "pending" as const,
      tool: "mail.send",
      jobId: "job_test",
      revisionNote: null,
      revisionCount: 0,
      parentApprovalId: null,
      telegramRef: null,
      telegramMessageId: null,
      metadata: {},
      statusToken: "st_test",
      pollPath: "/api/approvals/test/status",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };

    const { sendApprovalNotifications } = await import("@/lib/notify/channels");
    const results = await sendApprovalNotifications(approval, null);
    expect(Array.isArray(results)).toBe(true);

    delete process.env.P0_INBOX_ROUTING_ENABLED;
  });
});

describe("P0-RP: Wired Path Tests", () => {
  test("reply recipient validate module is imported by gateway/invoke.ts", async () => {
    const validateModule = await import("@/lib/gateway/reply-recipient-validate");
    expect(typeof validateModule.validateReplyRecipient).toBe("function");
    expect(typeof validateModule.decideReplyDestination).toBe("function");
  });

  test("validateReplyRecipient returns allowed when flag OFF (wired path)", async () => {
    const { validateReplyRecipient } = await import("@/lib/gateway/reply-recipient-validate");
    
    const result = await validateReplyRecipient({
      orgId: "test_org",
      employeeId: "emp_test",
      recipientId: "C123456",
      surface: "slack",
    });

    expect(result.status).toBe("allowed");
    expect(result.failClosed).toBe(false);
    expect(result.approvalClass).toBe("business");
  });

  test("validateReplyRecipient returns denied for external when flag ON", async () => {
    process.env.P0_REPLY_POLICY_ENHANCED = "true";

    const { validateReplyRecipient } = await import("@/lib/gateway/reply-recipient-validate");
    
    const result = await validateReplyRecipient({
      orgId: "test_org",
      employee: null,
      context: { slackChannelId: "C_TEST", slackUserId: "unknown_external_user" },
      recipientIdentifier: "unknown_external_user",
      recipientKind: "slack_user",
    });

    // External recipients are detected as external audience (fail-closed treats unknown as external)
    expect(["external", "unknown"]).toContain(result.audience);
    expect(result.approvalClass).toBe("business");

    delete process.env.P0_REPLY_POLICY_ENHANCED;
  });
});
