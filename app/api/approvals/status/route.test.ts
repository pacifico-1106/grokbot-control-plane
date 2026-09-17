import { beforeEach, expect, mock, test, describe } from "bun:test";
import type { ApprovalRequest } from "@/lib/types";

const GATEWAY_APPROVAL_ID = "gateway-approval-123";
const ADMIN_APPROVAL_ID = "admin-approval-456";
const STATUS_TOKEN = "valid-status-token";

let gatewayApproval: ApprovalRequest;
let adminApproval: ApprovalRequest;
let pendingApproval: ApprovalRequest;
let approvedButNotFulfilledApproval: ApprovalRequest;

beforeEach(() => {
  currentApproval = null;
  gatewayApproval = {
    id: GATEWAY_APPROVAL_ID,
    orgId: "fixture-org",
    employeeId: "fixture-employee",
    credentialId: "cred-123",
    status: "approved",
    statusToken: STATUS_TOKEN,
    tool: "slack.post",
    title: "Slack Post",
    summary: "Post a message",
    purpose: "test",
    risk: "low",
    createdAt: "2026-09-17T00:00:00Z",
    resolvedAt: "2026-09-17T00:01:00Z",
    jobId: "job-123",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    metadata: {
      fulfillment: {
        ok: true,
        delivery: "slack",
        channel: "C12345",
        ts: "1726567890.123456",
        at: "2026-09-17T00:01:00Z",
      },
    },
  } as unknown as ApprovalRequest;

  adminApproval = {
    id: ADMIN_APPROVAL_ID,
    orgId: "fixture-org",
    employeeId: "fixture-employee",
    credentialId: "cred-123",
    status: "approved",
    statusToken: STATUS_TOKEN,
    tool: "employees.issue",
    title: "Issue Employee",
    summary: "Issue a new employee",
    purpose: "admin.hire",
    risk: "high",
    createdAt: "2026-09-17T00:00:00Z",
    resolvedAt: "2026-09-17T00:01:00Z",
    jobId: "admin-job-123",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    metadata: {
      auditClass: "admin_mcp",
      adminFulfillment: {
        ok: true,
        tool: "employees.issue",
        employeeId: "new-emp-123",
        secretPrefix: "gb_emp_abc",
        at: "2026-09-17T00:01:00Z",
      },
    },
  } as unknown as ApprovalRequest;

  pendingApproval = {
    id: "pending-approval-789",
    orgId: "fixture-org",
    employeeId: "fixture-employee",
    credentialId: "cred-123",
    status: "pending",
    statusToken: STATUS_TOKEN,
    tool: "slack.post",
    title: "Pending Post",
    summary: "Waiting for approval",
    purpose: "test",
    risk: "medium",
    createdAt: "2026-09-17T00:00:00Z",
    resolvedAt: null,
    jobId: "job-456",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    metadata: {},
  } as unknown as ApprovalRequest;

  approvedButNotFulfilledApproval = {
    id: "approved-unfulfilled-111",
    orgId: "fixture-org",
    employeeId: "fixture-employee",
    credentialId: "cred-123",
    status: "approved",
    statusToken: STATUS_TOKEN,
    tool: "commerce.order",
    title: "Order",
    summary: "Place an order",
    purpose: "test",
    risk: "high",
    createdAt: "2026-09-17T00:00:00Z",
    resolvedAt: "2026-09-17T00:01:00Z",
    jobId: "job-789",
    revisionNote: null,
    revisionCount: 0,
    parentApprovalId: null,
    metadata: {},
  } as unknown as ApprovalRequest;
});

let currentApproval: ApprovalRequest | null = null;

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "demo" as const,
}));
mock.module("@/lib/data", () => ({
  getApprovalStatusByToken: async (id: string, token: string) => {
    if (token !== STATUS_TOKEN) return null;
    if (id === gatewayApproval.id) return gatewayApproval;
    if (id === adminApproval.id) return adminApproval;
    if (id === pendingApproval.id) return pendingApproval;
    if (id === approvedButNotFulfilledApproval.id) return approvedButNotFulfilledApproval;
    return currentApproval;
  },
  runtimeModeLabel: () => "demo",
}));
mock.module("@/lib/approval-workflow", () => ({
  getApprovalWorkflowProgress: async () => null,
}));
mock.module("@/lib/approvals/fulfill", () => ({
  parseFulfillment: (metadata: Record<string, unknown> | undefined | null) => {
    const raw = metadata?.fulfillment;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.ok !== "boolean") return null;
    return rec;
  },
}));
mock.module("@/lib/admin-mcp/fulfill-admin", () => ({
  parseAdminFulfillment: (metadata: Record<string, unknown> | undefined | null) => {
    const raw = metadata?.adminFulfillment ?? metadata?.fulfillment;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.ok !== "boolean") return null;
    return rec;
  },
}));
mock.module("@/lib/admin-mcp/audit-class", () => ({
  isAdminClassApproval: (approval: ApprovalRequest) => {
    return approval.metadata?.auditClass === "admin_mcp";
  },
  ADMIN_AUDIT_CLASS: "admin_mcp",
}));
mock.module("@/lib/data/redaction", () => ({
  redactMetadata: (data: Record<string, unknown>) => {
    const result = { ...data };
    delete result.oneTimeSecret;
    return result;
  },
}));

const { GET } = await import("./route");

function makeRequest(id: string, token: string): Request {
  return new Request(`https://fixture.invalid/api/approvals/status?id=${id}&token=${token}`);
}

describe("Gateway approval status poll", () => {
  test("approved+fulfilled Gateway approval returns pollHint=fulfilled and fulfillment payload", async () => {
    const response = await GET(makeRequest(GATEWAY_APPROVAL_ID, STATUS_TOKEN));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
    expect(body.pollHint).toBe("fulfilled");
    expect(body.fulfillment).toBeTruthy();
    expect(body.fulfillment.fulfilled).toBe(true);
    expect(body.fulfillment.delivery).toBe("slack");
    expect(body.fulfillment.channel).toBe("C12345");
    expect(body.fulfillment.ts).toBe("1726567890.123456");
  });

  test("approved but NOT fulfilled approval returns pollHint=reinvoke_with_approvalId", async () => {
    const response = await GET(makeRequest(approvedButNotFulfilledApproval.id, STATUS_TOKEN));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
    expect(body.pollHint).toBe("reinvoke_with_approvalId");
    expect(body.fulfillment).toBeUndefined();
  });

  test("pending approval returns pollHint=continue_polling without fulfillment", async () => {
    const response = await GET(makeRequest(pendingApproval.id, STATUS_TOKEN));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.pollHint).toBe("continue_polling");
    expect(body.fulfillment).toBeUndefined();
  });

  test("fulfilled with error returns pollHint=fulfilled with error info", async () => {
    currentApproval = {
      ...gatewayApproval,
      id: "gateway-error-approval",
      metadata: {
        fulfillment: {
          ok: false,
          error: "slack_post_failed",
          at: "2026-09-17T00:01:00Z",
        },
      },
    } as unknown as ApprovalRequest;

    const response = await GET(makeRequest("gateway-error-approval", STATUS_TOKEN));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
    expect(body.pollHint).toBe("fulfilled");
    expect(body.fulfillment).toBeTruthy();
    expect(body.fulfillment.fulfilled).toBe(true);
    expect(body.fulfillment.ok).toBe(false);
    expect(body.fulfillment.error).toBe("slack_post_failed");
  });
});

describe("Admin approval status poll", () => {
  test("approved+fulfilled Admin approval without oneTimeSecret returns pollHint=fulfilled", async () => {
    const noSecretAdminApproval = {
      ...adminApproval,
      id: "admin-no-secret-approval",
      metadata: {
        auditClass: "admin_mcp",
        adminFulfillment: {
          ok: true,
          tool: "channels.classify",
          channelId: "channel-123",
          at: "2026-09-17T00:01:00Z",
        },
      },
    } as unknown as ApprovalRequest;
    currentApproval = noSecretAdminApproval;

    const response = await GET(makeRequest("admin-no-secret-approval", STATUS_TOKEN));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
    expect(body.pollHint).toBe("fulfilled");
    expect(body.fulfillment).toBeTruthy();
    expect(body.fulfillment.fulfilled).toBe(true);
    expect(body.fulfillment.channelId).toBe("channel-123");
  });

  test("approved+fulfilled Admin approval with oneTimeSecret returns pollHint=reinvoke_with_approvalId", async () => {
    const withSecretAdminApproval = {
      ...adminApproval,
      id: "admin-with-secret-approval",
      metadata: {
        auditClass: "admin_mcp",
        adminFulfillment: {
          ok: true,
          tool: "employees.issue",
          employeeId: "new-emp-123",
          secretPrefix: "gb_emp_abc",
          oneTimeSecret: "gb_emp_abc123xyz",
          at: "2026-09-17T00:01:00Z",
        },
      },
    } as unknown as ApprovalRequest;
    currentApproval = withSecretAdminApproval;

    const response = await GET(makeRequest("admin-with-secret-approval", STATUS_TOKEN));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
    expect(body.pollHint).toBe("reinvoke_with_approvalId");
    expect(body.fulfillment).toBeTruthy();
    expect(body.fulfillment.fulfilled).toBe(true);
    expect(body.fulfillment.oneTimeSecret).toBeUndefined();
    expect(body.fulfillment.secretPrefix).toBe("gb_emp_abc");
  });
});

describe("Error handling", () => {
  test("missing id and token returns 400", async () => {
    const response = await GET(new Request("https://fixture.invalid/api/approvals/status"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("id_and_token_required");
  });

  test("invalid token returns 404", async () => {
    const response = await GET(makeRequest(GATEWAY_APPROVAL_ID, "invalid-token"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_found_or_invalid_token");
  });

  test("non-existent approval returns 404", async () => {
    const response = await GET(makeRequest("non-existent-id", STATUS_TOKEN));
    expect(response.status).toBe(404);
  });
});
