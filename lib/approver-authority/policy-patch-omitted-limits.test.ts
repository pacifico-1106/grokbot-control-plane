/**
 * 木村 2026-10-10 (#279 review item 1): policy.patch with actionLimits LEFT OUT
 * keeps the employee's current actionLimits, and Problem A's classification
 * agrees: an omitted actionLimits is not a change (standard, not owner).
 *
 * Robust to both save-path behaviours: a separate PR on main changes
 * updateEmployeePolicy so that an omitted actionLimits keeps the current value
 * (root fix for the LINE inbox wiping limits). fulfillPolicy does not rely on
 * either behaviour: when actionLimits is left out it passes the CURRENT value
 * explicitly. The tests run the fulfil against both
 *   - "legacy": today's updateEmployeePolicy (undefined → written as {}), and
 *   - "root-fix": a stand-in that keeps the current value when undefined,
 * and expect the same result. Sending actionLimits explicitly (incl. {})
 * still replaces the map and is still classified (a removed money cap → owner).
 * null is refused by parsePolicyPatchArgs at intake and fulfil (#275); the
 * classifier still treats it as a change (fail-safe, asserted below).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { policyPatchTicket } from "../../tests/helpers/policy-patch-ticket";
import { DEMO_ORG, resetRuntimeMembers } from "@/lib/demo-data";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import type { ApprovalRequest } from "@/lib/types";

type SavePath = "legacy" | "root-fix";
let savePath: SavePath = "legacy";
const writes: Array<{ actionLimits: unknown }> = [];
const realEmployees = { ...(await import("@/lib/data/employees")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/notify/channels", {
  sendApprovalNotifications: async () => [{ ok: true, provider: "slack" }],
  refreshWorkflowNotification: async () => undefined,
  updateApprovalNotificationMessages: async () => [],
  notifyOwnerApprovalPending: async () => ({ ok: true, provider: "slack" }),
  notifyOwnersApproverAuthorityApproved: async () => ({ owners: 0, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null }),
});
await mocks.mock("@/lib/data/employees", {
  updateEmployeePolicy: async (input: Parameters<typeof realEmployees.updateEmployeePolicy>[0]) => {
    writes.push({ actionLimits: input.actionLimits });
    if (savePath === "root-fix" && input.actionLimits === undefined) {
      const current = await realEmployees.getEmployee(input.employeeId, input.orgId);
      return realEmployees.updateEmployeePolicy({ ...input, actionLimits: current?.actionLimits });
    }
    return realEmployees.updateEmployeePolicy(input);
  },
});
const { createApproval, getApprovalById } = await import("@/lib/data/approvals");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { getEmployee } = await import("@/lib/data/employees");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { classifyApproverRequirement } = await import("@/lib/approver-authority/targets");
const { ADMIN_MCP_TOOLS } = await import("@/lib/mcp/admin-tools");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const EMP = "emp_sales";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
const CAPS = { "commerce.order": { perDay: 3, perMonth: 20 }, "slack.post": { perDay: 50 } };
const STRICT = normalizeToolApprovalDefaults({});
let savedFlag: string | undefined;
let saved: Awaited<ReturnType<typeof getEmployee>>;

async function setCaps(actionLimits: unknown) {
  const e = (await getEmployee(EMP, ORG))!;
  await realEmployees.updateEmployeePolicy({
    orgId: ORG, employeeId: EMP, scopes: e.scopes, allowedPurposes: e.allowedPurposes, approvalPolicy: e.approvalPolicy,
    actionLimits: actionLimits as never, toolApprovalDefaults: (e.toolApprovalDefaults ?? STRICT) as never,
  });
}
beforeEach(async () => {
  savedFlag = process.env[FLAG];
  resetRuntimeMembers();
  saved = structuredClone((await getEmployee(EMP, ORG))!);
  await setCaps(CAPS);
  writes.length = 0;
  savePath = "legacy";
});
afterEach(async () => {
  await realEmployees.updateEmployeePolicy({
    orgId: ORG, employeeId: EMP, scopes: saved!.scopes, allowedPurposes: saved!.allowedPurposes, approvalPolicy: saved!.approvalPolicy,
    actionLimits: saved!.actionLimits, toolApprovalDefaults: (saved!.toolApprovalDefaults ?? STRICT) as never,
  });
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  resetRuntimeMembers();
});

async function fileAndApprove(mutation: Record<string, unknown>): Promise<ApprovalRequest> {
  // What intake stores since #275 (card record + card text).
  const { adminMutation, summary } = await policyPatchTicket(ORG, mutation);
  const { approval } = await createApproval({
    orgId: ORG, employeeId: "", credentialId: "", title: "policy.patch", purpose: "admin.policy", summary, risk: "high", tool: "policy.patch",
    jobId: crypto.randomUUID(),
    metadata: {
      auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: "policy.patch", isAdminMcpTool: true, adminMutation,
      adminRequester: { kind: "admin_agent", actorId: "admin_agent_pol", grokBotAgentId: "grok_pol", credentialGeneration: 1 },
    },
  });
  const r = await resolveApprovalWithWorkflow(approval.id, "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
  expect(r.ok).toBe(true);
  return (await getApprovalById(approval.id, ORG))!;
}

const ctx = {
  currentEmployeeScopes: ["slack:post", "mail:send"],
  currentEmployeeApprovalPolicy: "always_human",
  currentEmployeeActionLimits: CAPS,
  currentEmployeeToolApprovalDefaults: STRICT,
};
const classify = (args: Record<string, unknown>) =>
  classifyApproverRequirement({
    tool: "policy.patch",
    metadata: { adminMutation: { employeeId: EMP, scopes: ["slack:post", "mail:send"], approvalPolicy: "always_human", ...args } },
    context: ctx as never,
  });

describe("policy.patch: omitted actionLimits keeps the current value", () => {
  test("classification: omitted actionLimits is not a change (standard); explicit removal still owner", () => {
    const omitted = classify({});
    expect(omitted?.kind).toBe("owner_or_designated_admin");
    expect(omitted?.reasons ?? []).not.toContain("money_tool_limits");
    expect(classify({ actionLimits: {} })?.reasons).toContain("money_tool_limits");
    // null never reaches a ticket (parsePolicyPatchArgs refuses it); if it did, still owner.
    expect(classify({ actionLimits: null })?.reasons).toContain("money_tool_limits");
    expect(classify({ actionLimits: { "slack.post": { perDay: 50 } } })?.reasons).toContain("money_tool_limits");
  });

  for (const mode of ["legacy", "root-fix"] as const) {
    for (const flag of ["true", "false"] as const) {
      test(`fulfil keeps the current caps (save path: ${mode}, ${FLAG}=${flag})`, async () => {
        process.env[FLAG] = flag;
        savePath = mode;
        const e = (await getEmployee(EMP, ORG))!;
        const t = await fileAndApprove({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy });
        if (flag === "true") expect(t.requiredApproverKind).toBe("owner_or_designated_admin");
        expect((await fulfillApprovedAdmin(t))?.ok).toBe(true);
        expect((await getEmployee(EMP, ORG))!.actionLimits).toEqual(CAPS);
        // The fulfil passes the current value explicitly: same write either way.
        expect(writes.at(-1)?.actionLimits).toEqual(CAPS);
      });
    }
  }

  test("explicit actionLimits still replaces the map (non-money change saved as sent)", async () => {
    process.env[FLAG] = "true";
    const e = (await getEmployee(EMP, ORG))!;
    const next = { "commerce.order": { perDay: 3, perMonth: 20 }, "slack.post": { perDay: 9 } };
    const t = await fileAndApprove({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy, actionLimits: next });
    expect(t.requiredApproverKind).toBe("owner_or_designated_admin");
    expect((await fulfillApprovedAdmin(t))?.ok).toBe(true);
    expect((await getEmployee(EMP, ORG))!.actionLimits).toEqual(next);
  });

  test("tool description says what an omitted actionLimits does", () => {
    const tool = ADMIN_MCP_TOOLS.find((item: { name: string }) => item.name === "policy.patch")!;
    expect(tool.description).toContain("actionLimits left out keeps the employee's current actionLimits");
    expect(tool.description).toContain("replaces the whole map");
    expect(tool.description).toContain("allowedPurposes left out keeps");
  });
});
