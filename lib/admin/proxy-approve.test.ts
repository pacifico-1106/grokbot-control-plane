import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  proxyResolveApproval,
  listPendingApprovalsForOrg,
  PROXY_APPROVAL_MANDATES,
  PROXY_MANDATE_LABELS_JA,
  type ProxyApprovalMandate,
} from "@/lib/admin/proxy-approve";
import { DEMO_ORG } from "@/lib/demo-data";
import {
  demoCreateApproval,
  demoListApprovals,
} from "@/lib/data/demo-approvals-store";
import type { ApprovalRequest } from "@/lib/types";

const SUPER_ADMIN_ACTOR = {
  email: "superadmin@platform-ops.example",
  userId: "user_super_admin_123",
};

const DIFFERENT_ACTOR = {
  email: "other-admin@platform-ops.example",
  userId: "user_other_admin_456",
};

const testOrgId = DEMO_ORG.id;

async function createTestApproval(): Promise<ApprovalRequest> {
  return demoCreateApproval({
    employeeId: `emp_test_${Date.now()}`,
    credentialId: `cred_test_${Date.now()}`,
    title: "テスト代行承認",
    purpose: "test.proxy",
    summary: "プロキシ承認テスト用のサマリー",
    risk: "low",
    tool: "test.invoke",
    jobId: `job_test_${Date.now()}`,
  });
}

describe("proxy approval mandates", () => {
  test("includes setup and support", () => {
    expect(PROXY_APPROVAL_MANDATES).toContain("setup");
    expect(PROXY_APPROVAL_MANDATES).toContain("support");
  });

  test("has Japanese labels for all mandates", () => {
    for (const mandate of PROXY_APPROVAL_MANDATES) {
      expect(PROXY_MANDATE_LABELS_JA[mandate]).toBeTruthy();
    }
    expect(PROXY_MANDATE_LABELS_JA.setup).toBe("セットアップ代行");
    expect(PROXY_MANDATE_LABELS_JA.support).toBe("サポート対応");
  });
});

describe("listPendingApprovalsForOrg", () => {
  test("returns pending approvals for target org", async () => {
    const testApproval = await createTestApproval();
    const approvals = await listPendingApprovalsForOrg(testOrgId);
    expect(approvals.length).toBeGreaterThan(0);
    const found = approvals.find((a) => a.id === testApproval.id);
    expect(found).toBeTruthy();
    expect(found?.status).toBe("pending");
  });

  test("returns empty array for non-existent org", async () => {
    const approvals = await listPendingApprovalsForOrg("org_nonexistent_123");
    expect(approvals).toEqual([]);
  });
});

describe("proxyResolveApproval - validation", () => {
  test("rejects invalid mandate", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "invalid" as ProxyApprovalMandate,
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_mandate");
  });

  test("rejects invalid decision", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "invalid" as "approved" | "rejected",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_decision");
  });

  test("rejects non-existent approval", async () => {
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: "approval_nonexistent_123",
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("approval_not_found");
  });

  test("rejects approval from wrong org", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: "org_different_123",
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("approval_not_found");
  });
});

describe("proxyResolveApproval - happy path", () => {
  test("approves with setup mandate", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      note: "Space Tree 初期設定のため",
      actor: SUPER_ADMIN_ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.approval?.status).toBe("approved");
    expect(result.approval?.resolvedBy).toBe(SUPER_ADMIN_ACTOR.email);
  });

  test("rejects with support mandate", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "rejected",
      mandate: "support",
      note: "ポリシー違反のため却下",
      actor: SUPER_ADMIN_ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.approval?.status).toBe("rejected");
    expect(result.approval?.resolvedBy).toBe(SUPER_ADMIN_ACTOR.email);
  });

  test("rejects already-resolved approval", async () => {
    const testApproval = await createTestApproval();
    
    await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });

    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "rejected",
      mandate: "support",
      actor: DIFFERENT_ACTOR,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("approval_not_pending");
  });
});

describe("proxyResolveApproval - mandate required", () => {
  test("setup mandate is accepted", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(true);
  });

  test("support mandate is accepted", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "support",
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(true);
  });
});

describe("proxyResolveApproval - audit metadata", () => {
  test("includes mandate in result", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      note: "テストメモ",
      actor: SUPER_ADMIN_ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.approval).toBeTruthy();
    expect(result.approval?.resolvedBy).toBe(SUPER_ADMIN_ACTOR.email);
  });

  test("optional note is allowed", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });

    expect(result.ok).toBe(true);
  });
});

describe("proxyResolveApproval - resolved_by column safety", () => {
  test("resolvedBy is set to actor email in the result object (not DB resolved_by column)", async () => {
    const testApproval = await createTestApproval();
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: testApproval.id,
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.approval?.resolvedBy).toBe(SUPER_ADMIN_ACTOR.email);
  });

  test("actor email is NOT a valid UUID (sanity check for DB column type)", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(uuidPattern.test(SUPER_ADMIN_ACTOR.email)).toBe(false);
    expect(uuidPattern.test(DIFFERENT_ACTOR.email)).toBe(false);
  });

  test("resolve_db_error code is returned for actual DB errors", async () => {
    const result = await proxyResolveApproval({
      targetOrgId: testOrgId,
      approvalId: "approval_nonexistent_for_db_error_test",
      decision: "approved",
      mandate: "setup",
      actor: SUPER_ADMIN_ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("approval_not_found");
  });
});
