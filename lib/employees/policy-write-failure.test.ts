/**
 * Callers of updateEmployeePolicy must be fail-closed when the write throws
 * (updateEmployeePolicy throws on employees / credentials write errors):
 * - PATCH /api/employees/[id]/policy and PATCH /api/employees/[id]/slack-identity
 *   answer a clean 500 with the error code and a Japanese message (same shape
 *   as the other policy errors), never ok:true, no `employee.updated` audit,
 *   no storage detail in the response;
 * - admin MCP policy.patch / setup.lineApproval.setEmployeeInbox fulfillment
 *   is ok:false with the code (no storage detail) and no success audit.
 * Demo mode; only the storage write is faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG } from "../demo-data";

type FakeFailure = { code: string; rolledBack?: boolean } | "plain" | null;
let failWith: FakeFailure = null;

function fakeError(failure: Exclude<FakeFailure, null>): Error {
  if (failure === "plain") return new Error("unexpected_boom detail=internal_table_x");
  const error = new Error(`${failure.code}: credentials_boom detail=internal_table_x`) as Error & {
    code: string;
    rolledBack?: boolean;
  };
  error.name = "EmployeePolicyWriteError";
  error.code = failure.code;
  if (failure.rolledBack !== undefined) error.rolledBack = failure.rolledBack;
  return error;
}

const realData = { ...(await import("@/lib/data")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/data", {
  updateEmployeePolicy: async (input: Parameters<typeof realData.updateEmployeePolicy>[0]) => {
    if (failWith) throw fakeError(failWith);
    return realData.updateEmployeePolicy(input);
  },
});
await mocks.mock("@/lib/auth/session", { getCurrentOrgId: async () => DEMO_ORG.id });
await mocks.mock("@/lib/team/demo-actor", {
  requireCapability: async () => ({
    ok: true as const,
    actor: {
      id: "mem_1",
      orgId: DEMO_ORG.id,
      email: "owner@example.com",
      displayName: "山田 太郎",
      role: "owner",
      jobRole: "owner",
      capabilities: ["hire_issue_credentials"],
      status: "active",
    },
  }),
});

const { PATCH: patchPolicy } = await import("../../app/api/employees/[id]/policy/route");
const { PATCH: patchSlackIdentity } = await import("../../app/api/employees/[id]/slack-identity/route");
const { issueEmployee } = await import("@/lib/data/employees");
const { getEmployee, listAuditEvents, resolveApproval, upsertNotificationChannel, resetDemoNotificationChannels } =
  await import("@/lib/data");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { POLICY_ERROR_MESSAGES } = await import("./policy-errors");
type ResolvedAdminCredential = import("@/lib/auth/admin-credential").ResolvedAdminCredential;
type EmployeeScope = import("@/lib/types").EmployeeScope;

const ORG = DEMO_ORG.id;
const SCOPES: EmployeeScope[] = ["tools:read", "slack:post", "approvals:request", "audit:append"];

async function hire(label: string) {
  const issued = await issueEmployee({
    orgId: ORG,
    displayName: `書き込み失敗 ${label}`,
    roleLabel: "テスト",
    scopes: SCOPES,
    allowedPurposes: ["ops.admin"],
    approvalPolicy: "risk_based",
    spend: null,
    allowedAccounts: [],
    secretHash: `hash_policy_write_failure_${label}`,
    secretPrefix: "gb_emp_pwf",
    expiresAt: null,
    auditSummary: "policy write failure test",
  });
  return issued.employee;
}

function req(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function updatedAudits(employeeId: string) {
  return (await listAuditEvents(ORG, 500)).filter(
    (event) => event.employeeId === employeeId && event.action === "employee.updated"
  );
}

async function withFailure<T>(failure: Exclude<FakeFailure, null>, fn: () => Promise<T>): Promise<T> {
  failWith = failure;
  try {
    return await fn();
  } finally {
    failWith = null;
  }
}

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_policy_write", status: "linked" });
  return {
    orgId: ORG,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

describe("PATCH /api/employees/[id]/policy when the write fails", () => {
  const cases: Array<{ name: string; failure: Exclude<FakeFailure, null>; code: string; contains: string }> = [
    { name: "credentials write failed, restored", failure: { code: "employee_policy_credentials_update_failed", rolledBack: true }, code: "employee_policy_credentials_update_failed", contains: "元に戻しました" },
    { name: "credentials write failed, restore failed", failure: { code: "employee_policy_credentials_update_failed", rolledBack: false }, code: "employee_policy_credentials_update_failed", contains: "元に戻すこともできませんでした" },
    { name: "employees write failed", failure: { code: "employee_policy_update_failed" }, code: "employee_policy_update_failed", contains: "反映していません" },
    { name: "unexpected error", failure: "plain", code: "employee_policy_update_failed", contains: "現在の設定を確認" },
  ];
  for (const c of cases) {
    test(`${c.name} → 500 ${c.code}, Japanese message, no ok, no audit, no storage detail`, async () => {
      const employee = await hire(`policy_${c.code}_${String((c.failure as { rolledBack?: boolean }).rolledBack)}`);
      const res = await withFailure(c.failure, () =>
        patchPolicy(
          req(`/api/employees/${employee.id}/policy`, {
            scopes: SCOPES,
            allowedPurposes: ["ops.admin"],
            approvalPolicy: "risk_based",
            actionLimits: employee.actionLimits,
            displayName: "変えたい名前",
          }),
          { params: Promise.resolve({ id: employee.id }) }
        )
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body.ok).not.toBe(true);
      expect(body.error).toBe(c.code);
      expect(String(body.message)).toContain(c.contains);
      expect(text).not.toContain("internal_table_x");
      expect(text).not.toContain("boom");
      expect(await updatedAudits(employee.id)).toHaveLength(0);
    });
  }

  test("message table has Japanese text for both codes", () => {
    expect(POLICY_ERROR_MESSAGES.employee_policy_update_failed).toContain("反映していません");
    expect(POLICY_ERROR_MESSAGES.employee_policy_credentials_update_failed).toContain("元に戻しました");
  });

  test("without a failure the route still saves (unchanged)", async () => {
    const employee = await hire("policy_ok");
    const res = await patchPolicy(
      req(`/api/employees/${employee.id}/policy`, {
        scopes: SCOPES,
        allowedPurposes: ["ops.admin"],
        approvalPolicy: "risk_based",
        actionLimits: employee.actionLimits,
        displayName: "変えた名前",
      }),
      { params: Promise.resolve({ id: employee.id }) }
    );
    expect(res.status).toBe(200);
    expect((await getEmployee(employee.id, ORG))?.displayName).toBe("変えた名前");
    expect(await updatedAudits(employee.id)).toHaveLength(1);
  });
});

describe("PATCH /api/employees/[id]/slack-identity when the write fails", () => {
  test("credentials write failed → 500 with code, no ok, no audit", async () => {
    const employee = await hire("slack_identity");
    const res = await withFailure({ code: "employee_policy_credentials_update_failed", rolledBack: true }, () =>
      patchSlackIdentity(req(`/api/employees/${employee.id}/slack-identity`, { postingAs: "bot" }), {
        params: Promise.resolve({ id: employee.id }),
      })
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).not.toBe(true);
    expect(body.error).toBe("employee_policy_credentials_update_failed");
    expect(String(body.message)).toContain("元に戻しました");
    expect(text).not.toContain("internal_table_x");
    expect(await updatedAudits(employee.id)).toHaveLength(0);
  });

  test("without a failure: saved through the shared posting-identity write; audit records from / to (dashboard still allows user without a token)", async () => {
    const employee = await hire("slack_identity_ok");
    expect((await getEmployee(employee.id, ORG))?.postingAs).toBe("bot");
    const res = await patchSlackIdentity(req(`/api/employees/${employee.id}/slack-identity`, { postingAs: "user" }), {
      params: Promise.resolve({ id: employee.id }),
    });
    expect(res.status).toBe(200);
    expect((await getEmployee(employee.id, ORG))?.postingAs).toBe("user");
    const audits = await updatedAudits(employee.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata?.actorEmail).toBe("owner@example.com");
    expect(audits[0].metadata).toMatchObject({ postingAs: "user", from: "bot", to: "user" });
  });
});

describe("admin MCP fulfillment when the write fails", () => {
  // Approval cards for the seeded LINE inbox are sent to a local fake (no network).
  let savedFetch: typeof globalThis.fetch;
  beforeAll(() => {
    savedFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (!String(url).startsWith("https://api.line.me/")) throw new Error("unexpected_fixture_endpoint");
      return Response.json({});
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = savedFetch;
  });

  test("policy.patch → ok:false with the code (no storage detail), no admin.policy audit", async () => {
    const employee = await hire("mcp_policy");
    const queued = await callAdminMcpTool(
      "policy.patch",
      { employeeId: employee.id, scopes: SCOPES, approvalPolicy: "always_human" },
      demoCred()
    );
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    expect(approvalId.length).toBeGreaterThan(0);
    const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_1" });
    const fulfillment = await withFailure({ code: "employee_policy_credentials_update_failed", rolledBack: false }, () =>
      fulfillApprovedAdmin(approved!)
    );
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("employee_policy_credentials_update_failed");
    expect(String(fulfillment?.nextStepJa ?? "")).toContain("元に戻すこともできませんでした");
    expect(JSON.stringify(fulfillment)).not.toContain("internal_table_x");
    const audits = (await listAuditEvents(ORG, 500)).filter(
      (event) => event.employeeId === employee.id && event.action === "admin.policy"
    );
    expect(audits).toHaveLength(0);
    expect((await getEmployee(employee.id, ORG))?.approvalPolicy).toBe("risk_based");
  });

  test("employees.postingIdentity.set → ok:false with the code (no storage detail), no change audit, postingAs unchanged", async () => {
    const employee = await hire("mcp_posting_identity");
    await realData.updateEmployeePolicy({
      orgId: ORG,
      employeeId: employee.id,
      scopes: employee.scopes,
      allowedPurposes: employee.allowedPurposes,
      approvalPolicy: employee.approvalPolicy,
      actionLimits: employee.actionLimits,
      postingAs: "user",
    });
    const queued = await callAdminMcpTool("employees.postingIdentity.set", { employeeId: employee.id, postingAs: "bot" }, demoCred());
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    expect(approvalId.length).toBeGreaterThan(0);
    const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_1" });
    const fulfillment = await withFailure({ code: "employee_policy_credentials_update_failed", rolledBack: true }, () =>
      fulfillApprovedAdmin(approved!)
    );
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("employee_policy_credentials_update_failed");
    expect(JSON.stringify(fulfillment)).not.toContain("internal_table_x");
    const changed = (await listAuditEvents(ORG, 500)).filter(
      (event) => event.employeeId === employee.id && event.metadata?.event === "employee.posting_as.changed"
    );
    expect(changed).toHaveLength(0);
    expect((await getEmployee(employee.id, ORG))?.postingAs).toBe("user");
  });

  test("setup.lineApproval.setEmployeeInbox → ok:false with the code, no admin.notificationChannel audit", async () => {
    const savedKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
    try {
      const line = await upsertNotificationChannel({
        orgId: ORG,
        provider: "line",
        enabled: true,
        isDefault: true,
        label: "承認",
        config: { destinationId: "Uboss1234567890abcdef", allowedUserIds: ["Uboss1234567890abcdef"] },
        secrets: { channelAccessToken: "line-token-test-value", channelSecret: "line-secret-test-value" },
      });
      const employee = await hire("mcp_inbox");
      const queued = await callAdminMcpTool(
        "setup.lineApproval.setEmployeeInbox",
        { employeeId: employee.id, approvalChannelId: line.id },
        demoCred()
      );
      const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
      const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "mem_human_1" });
      const fulfillment = await withFailure({ code: "employee_policy_update_failed" }, () => fulfillApprovedAdmin(approved!));
      expect(fulfillment?.ok).toBe(false);
      expect(fulfillment?.error).toBe("employee_policy_update_failed");
      expect(JSON.stringify(fulfillment)).not.toContain("internal_table_x");
      const audits = (await listAuditEvents(ORG, 500)).filter(
        (event) => event.employeeId === employee.id && event.action === "admin.notificationChannel"
      );
      expect(audits).toHaveLength(0);
    } finally {
      if (savedKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
      else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedKey;
      resetDemoNotificationChannels(ORG);
    }
  });
});
