/**
 * P1 Approval Kind Routes — MCP Handlers Tests
 */
import { describe, expect, test, mock, beforeEach } from "bun:test";
import {
  handleApprovalRoutesGet,
  validateApprovalRoutesPatch,
  generatePolicyDiff,
  checkBeforeStateMatch,
} from "./mcp-handlers";
import type { OrgApprovalKindRoutesPolicy } from "./types";

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => null,
}));
mock.module("@/lib/mode", () => ({
  isDemoMode: () => true,
}));

const envBackup = process.env.P1_APPROVAL_KIND_ROUTES_ENABLED;

beforeEach(() => {
  delete process.env.P1_APPROVAL_KIND_ROUTES_ENABLED;
});

const mockCred = () => ({
  orgId: "test-org",
  adminAgentId: "test-admin-agent",
  grokBotAgentId: null,
  actorId: "test-actor",
  generation: 1,
  via: "bearer" as const,
  agent: {
    id: "test-admin-agent",
    orgId: "test-org",
    grokBotAgentId: null,
    grokBotWorkspaceId: null,
    credentialFingerprint: null,
    secretPrefix: "gb_adm_test",
    credentialGeneration: 1,
    status: "linked" as const,
    opsDocLocation: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

describe("handleApprovalRoutesGet", () => {
  test("returns disabled state when flag is OFF", async () => {
    const result = await handleApprovalRoutesGet(mockCred(), {});
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.message).toContain("OFF");
  });

  test("returns enabled state when flag is ON", async () => {
    process.env.P1_APPROVAL_KIND_ROUTES_ENABLED = "1";
    const { resetDemoApprovalKindRoutesData } = await import("./data");
    resetDemoApprovalKindRoutesData();
    
    const result = await handleApprovalRoutesGet(mockCred(), {});
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.effectiveRoutes).toBeDefined();
    
    process.env.P1_APPROVAL_KIND_ROUTES_ENABLED = envBackup;
  });
});

describe("validateApprovalRoutesPatch", () => {
  test("rejects invalid routes", async () => {
    process.env.P1_APPROVAL_KIND_ROUTES_ENABLED = "1";
    
    const result = await validateApprovalRoutesPatch(mockCred(), {
      policyName: "テスト",
      routes: [
        {
          kind: "post",
          approverUserIds: [], // Invalid: zero approvers
          quorum: { type: "any" },
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
    });
    
    expect(result.ok).toBe(false);
    expect(result.code).toBe("validation_failed");
    expect(result.validationErrors).toBeDefined();
    
    process.env.P1_APPROVAL_KIND_ROUTES_ENABLED = envBackup;
  });
});

describe("generatePolicyDiff", () => {
  test("generates diff for new policy", () => {
    const after: OrgApprovalKindRoutesPolicy = {
      version: 1,
      policyId: "test",
      policyName: "テスト",
      routes: [
        {
          kind: "post",
          approverUserIds: ["user-1"],
          quorum: { type: "any" },
          finalGoUserId: null,
          deadlineHours: null,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const diff = generatePolicyDiff(null, after);
    expect(diff[0]).toContain("新規ポリシー");
  });

  test("generates diff for policy name change", () => {
    const before: OrgApprovalKindRoutesPolicy = {
      version: 1,
      policyId: "test",
      policyName: "旧名",
      routes: [],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const after: OrgApprovalKindRoutesPolicy = {
      ...before,
      policyName: "新名",
    };

    const diff = generatePolicyDiff(before, after);
    expect(diff.some((d) => d.includes("旧名") && d.includes("新名"))).toBe(true);
  });

  test("detects approver changes", () => {
    const before: OrgApprovalKindRoutesPolicy = {
      version: 1,
      policyId: "test",
      policyName: "テスト",
      routes: [
        {
          kind: "post",
          approverUserIds: ["user-1"],
          quorum: { type: "any" },
          finalGoUserId: null,
          deadlineHours: null,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    const after: OrgApprovalKindRoutesPolicy = {
      ...before,
      routes: [
        {
          kind: "post",
          approverUserIds: ["user-1", "user-2"],
          quorum: { type: "any" },
          finalGoUserId: null,
          deadlineHours: null,
          onExpire: "fail_closed",
          remindEveryDays: 3,
        },
      ],
    };

    const diff = generatePolicyDiff(before, after);
    expect(diff.some((d) => d.includes("user-2") && d.includes("追加"))).toBe(true);
  });
});

describe("checkBeforeStateMatch", () => {
  test("matches when both null", async () => {
    const { resetDemoApprovalKindRoutesData } = await import("./data");
    resetDemoApprovalKindRoutesData();
    
    const result = await checkBeforeStateMatch("test-org", null);
    expect(result.matches).toBe(true);
  });

  test("does not match when expected null but current exists", async () => {
    const { setOrgApprovalKindRoutesPolicy, resetDemoApprovalKindRoutesData } = await import("./data");
    resetDemoApprovalKindRoutesData();
    
    const policy: OrgApprovalKindRoutesPolicy = {
      version: 1,
      policyId: "test",
      policyName: "テスト",
      routes: [],
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };
    await setOrgApprovalKindRoutesPolicy("test-org", policy);
    
    const result = await checkBeforeStateMatch("test-org", null);
    expect(result.matches).toBe(false);
    
    resetDemoApprovalKindRoutesData();
  });
});
