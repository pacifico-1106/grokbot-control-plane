/**
 * 木村 2026-10-10 (production data loss since 30a631f): approving
 * setup.lineApproval.setEmployeeInbox wiped every action limit (incl.
 * commerce.order), because the fulfilment calls updateEmployeePolicy without
 * actionLimits and an omitted value was written as {}.
 *
 * Demo path, end to end through the real admin MCP queue → human approval →
 * fulfilment: an omitted field keeps the stored value; an explicit {} clears.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { getEmployee, resolveApproval, resetDemoNotificationChannels, upsertNotificationChannel } from "@/lib/data";
import { issueEmployee, updateEmployeePolicy } from "@/lib/data/employees";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ActionLimits, EmployeeScope } from "@/lib/types";

const ORG = DEMO_ORG.id;
const LIMITS: ActionLimits = { "commerce.order": { perDay: 3, perMonth: 20 }, "mail.send": { perDay: 50 } };
const SPEND = { maxPerOrderJpy: 5000, maxPerDayJpy: 20000 };
const TOOL_DEFAULTS = { "mail.send": "always_human" } as const;
const PURPOSES = ["sales.followup", "ops.report"];
const SCOPES: EmployeeScope[] = ["mail:send", "commerce:order"];

let savedKey: string | undefined;
let savedFetch: typeof globalThis.fetch;
beforeEach(() => {
  savedKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (!String(url).startsWith("https://api.line.me/")) throw new Error("unexpected_fixture_endpoint");
    return Response.json({});
  }) as typeof fetch;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedKey;
  globalThis.fetch = savedFetch;
  resetDemoNotificationChannels(ORG);
});

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_keep", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

let seq = 0;
async function hire() {
  seq += 1;
  const issued = await issueEmployee({
    orgId: ORG,
    displayName: `上限保持 ${seq}`,
    roleLabel: "購買",
    jobDescription: "",
    scopes: SCOPES,
    allowedPurposes: PURPOSES,
    approvalPolicy: "risk_based",
    toolApprovalDefaults: TOOL_DEFAULTS,
    actionLimits: LIMITS,
    spend: SPEND,
    allowedAccounts: [],
    approverUserIds: ["U0APPROVER1"],
    secretHash: `hash_keep_${seq}`,
    secretPrefix: `gb_emp_keep${seq}`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    auditSummary: "test hire",
  });
  return issued.employee.id;
}

async function approveAndFulfil(tool: string, args: Record<string, unknown>) {
  const queued = await callAdminMcpTool(tool, args, demoCred());
  const sc = queued.structuredContent as Record<string, unknown>;
  expect(typeof sc.approvalId).toBe("string");
  const approved = await resolveApproval(String(sc.approvalId), "approved", "owner@example.com", ORG, { actorId: "mem_human_1" });
  return fulfillApprovedAdmin(approved!);
}

function expectAllKept(e: Awaited<ReturnType<typeof getEmployee>>) {
  expect(e?.actionLimits).toEqual(LIMITS);
  expect(e?.spend?.maxPerOrderJpy).toBe(SPEND.maxPerOrderJpy);
  expect(e?.spend?.maxPerDayJpy).toBe(SPEND.maxPerDayJpy);
  expect((e?.toolApprovalDefaults as Record<string, unknown> | undefined)?.["mail.send"]).toBe("always_human");
  expect([...(e?.allowedPurposes ?? [])].sort()).toEqual([...PURPOSES].sort());
  expect([...(e?.scopes ?? [])].sort()).toEqual([...SCOPES].sort());
  expect(e?.approverUserIds).toEqual(["U0APPROVER1"]);
  expect(e?.approvalPolicy).toBe("risk_based");
}

describe("setup.lineApproval.setEmployeeInbox keeps every limit (the production bug)", () => {
  test("approving the LINE inbox sets the inbox and keeps action limits (commerce.order), spend, tool defaults, purposes, scopes", async () => {
    const line = await upsertNotificationChannel({
      orgId: ORG, provider: "line", enabled: true, isDefault: true, label: "LINE 承認",
      config: { destinationId: "Uboss1234567890abcdef", allowedUserIds: ["Uboss1234567890abcdef"] },
      secrets: { channelAccessToken: "line-access-token-keep", channelSecret: "line-secret-keep" },
    });
    const employeeId = await hire();
    expect((await getEmployee(employeeId, ORG))?.actionLimits).toEqual(LIMITS);
    const fulfilment = await approveAndFulfil("setup.lineApproval.setEmployeeInbox", { employeeId, approvalChannelId: line.id });
    expect(fulfilment?.ok).toBe(true);
    const after = await getEmployee(employeeId, ORG);
    expect(after?.approvalChannelId).toBe(line.id);
    expectAllKept(after);
  });
});

describe("updateEmployeePolicy (demo): omitted = keep, explicit {} = clear", () => {
  test("omitting actionLimits keeps them (and every other optional field)", async () => {
    const employeeId = await hire();
    const updated = await updateEmployeePolicy({ orgId: ORG, employeeId, scopes: SCOPES, allowedPurposes: PURPOSES, approvalPolicy: "risk_based", displayName: "改名のみ" });
    expect(updated?.displayName).toBe("改名のみ");
    expectAllKept(await getEmployee(employeeId, ORG));
  });
  test("explicit {} clears action limits", async () => {
    const employeeId = await hire();
    await updateEmployeePolicy({ orgId: ORG, employeeId, scopes: SCOPES, allowedPurposes: PURPOSES, approvalPolicy: "risk_based", actionLimits: {} });
    expect((await getEmployee(employeeId, ORG))?.actionLimits).toEqual({});
  });
  test("another org's id → null and the employee is untouched (BOLA unchanged)", async () => {
    const employeeId = await hire();
    const res = await updateEmployeePolicy({ orgId: "org_someone_else", employeeId, scopes: ["mail:send"], allowedPurposes: [], approvalPolicy: "auto", actionLimits: {} });
    expect(res).toBeNull();
    expectAllKept(await getEmployee(employeeId, ORG));
  });
});

describe("admin MCP policy.patch (same class): omitted actionLimits keeps them", () => {
  test("scopes-only patch keeps action limits", async () => {
    const employeeId = await hire();
    const fulfilment = await approveAndFulfil("policy.patch", { employeeId, scopes: SCOPES, allowedPurposes: PURPOSES, approvalPolicy: "risk_based" });
    expect(fulfilment?.ok).toBe(true);
    expect((await getEmployee(employeeId, ORG))?.actionLimits).toEqual(LIMITS);
  });
  test("explicit actionLimits: {} still clears them", async () => {
    const employeeId = await hire();
    const fulfilment = await approveAndFulfil("policy.patch", { employeeId, scopes: SCOPES, allowedPurposes: PURPOSES, approvalPolicy: "risk_based", actionLimits: {} });
    expect(fulfilment?.ok).toBe(true);
    expect((await getEmployee(employeeId, ORG))?.actionLimits).toEqual({});
  });
});
