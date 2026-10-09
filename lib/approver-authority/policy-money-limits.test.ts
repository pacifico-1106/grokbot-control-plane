/**
 * 木村 2026-10-09 23:58 (Problem A): policy.patch must not let a designated
 * admin remove money limits.
 * - actionLimits, when sent, replaces the whole map with
 *   normalizeActionLimits(args.actionLimits), so a map without commerce.order
 *   (or {}) empties that cap (null is refused by parsePolicyPatchArgs since #275). 2026-10-10: LEFT OUT keeps the current
 *   value (fulfillPolicy passes it explicitly), so omission is not a change
 *   (policy-patch-omitted-limits.test.ts).
 * - toolApprovalDefaults, when sent, replaces the whole map with
 *   normalizeToolApprovalDefaults(args.toolApprovalDefaults), so a partial map
 *   with only non-money keys resets commerce.order (e.g. deny → always_human).
 * The judgement compares the CURRENT values with what the save path would
 * write (same normalizers): any money key that changes → owner; a key emptied
 * by an explicit map counts as changed. Both values are part of the F2 fingerprint.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { classifyApproverRequirement } from "@/lib/approver-authority/targets";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { policyPatchTicket } from "../../tests/helpers/policy-patch-ticket";
import { DEMO_ORG, resetRuntimeMembers } from "@/lib/demo-data";
import type { ApprovalRequest } from "@/lib/types";

const mocks = scopedModuleMocks();
await mocks.mock("@/lib/notify/channels", {
  sendApprovalNotifications: async () => [{ ok: true, provider: "slack" }],
  refreshWorkflowNotification: async () => undefined,
  updateApprovalNotificationMessages: async () => [],
  notifyOwnerApprovalPending: async () => ({ ok: true, provider: "slack" }),
  notifyOwnersApproverAuthorityApproved: async () => ({ owners: 0, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null }),
});
const { createApproval, getApprovalById } = await import("@/lib/data/approvals");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { assertApprovalExecutionAuthority } = await import("@/lib/approvals/execution-authority");
const { getEmployee, updateEmployeePolicy } = await import("@/lib/data/employees");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");

const CAPS = { "commerce.order": { perDay: 3, perMonth: 20 }, "slack.post": { perDay: 50 } };
const STRICT = normalizeToolApprovalDefaults({});
const DENY_ORDER = { ...STRICT, "commerce.order": "deny" };
const ctx = (over: Record<string, unknown> = {}) => ({
  currentEmployeeScopes: ["slack:post", "mail:send"],
  currentEmployeeApprovalPolicy: "always_human",
  currentEmployeeActionLimits: CAPS,
  currentEmployeeToolApprovalDefaults: DENY_ORDER,
  ...over,
});
const base = { employeeId: "e", scopes: ["slack:post", "mail:send"], approvalPolicy: "always_human" };
const classify = (args: Record<string, unknown>, context: Record<string, unknown> | null = ctx()) =>
  classifyApproverRequirement({ tool: "policy.patch", metadata: { adminMutation: { ...base, ...args } }, context: context as never });

describe("policy.patch money limits (pure)", () => {
  test("actionLimits left out → current value kept → not a change; an explicit {} empties every cap → owner", () => {
    expect(classify({})?.kind).toBe("owner_or_designated_admin");
    const r = classify({ actionLimits: {} });
    expect(r?.kind).toBe("owner");
    expect(r?.reasons).toContain("money_tool_limits");
  });
  test("toolApprovalDefaults with only non-money keys → commerce.order resets deny → always_human → owner", () => {
    const r = classify({ actionLimits: CAPS, toolApprovalDefaults: { "mail.send": "auto" } });
    expect(r?.kind).toBe("owner");
    expect(r?.reasons).toContain("money_approval_weakened");
  });
  test("a real money-key change → owner", () => {
    expect(classify({ actionLimits: { ...CAPS, "commerce.order": { perDay: 30, perMonth: 20 } } })?.kind).toBe("owner");
    expect(classify({ actionLimits: CAPS, toolApprovalDefaults: { ...DENY_ORDER, "commerce.order": "auto" } })?.kind).toBe("owner");
    // A money key the normalizer would drop on save also counts as changed
    // (only when toolApprovalDefaults is sent; left out = not written).
    expect(classify({ actionLimits: CAPS, toolApprovalDefaults: DENY_ORDER }, ctx({ currentEmployeeToolApprovalDefaults: { ...DENY_ORDER, "plan.upgrade": "deny" } }))?.kind).toBe("owner");
  });
  test("non-money-only changes stay standard (money keys sent unchanged are fine)", () => {
    const r = classify({
      actionLimits: { "slack.post": { perDay: 10 }, "commerce.order": { perMonth: 20, perDay: 3 } },
      toolApprovalDefaults: { ...DENY_ORDER, "mail.send": "auto" },
    });
    expect(r?.kind).toBe("owner_or_designated_admin");
    // toolApprovalDefaults left out = not written = unchanged.
    expect(classify({ actionLimits: CAPS })?.kind).toBe("owner_or_designated_admin");
    // No money key stored and none sent: partial map is fine.
    expect(classify({ actionLimits: { "slack.post": { perDay: 1 } }, toolApprovalDefaults: { "mail.send": "auto" } },
      ctx({ currentEmployeeActionLimits: { "slack.post": { perDay: 50 } }, currentEmployeeToolApprovalDefaults: STRICT }))?.kind).toBe("owner_or_designated_admin");
  });
  test("current limits / defaults unreadable → owner", () => {
    expect(classify({ actionLimits: CAPS }, ctx({ currentEmployeeActionLimits: undefined }))?.reasons).toContain("money_limits_unverified");
    expect(classify({ actionLimits: CAPS }, ctx({ currentEmployeeToolApprovalDefaults: undefined }))?.kind).toBe("owner");
    expect(classify({ actionLimits: CAPS }, null)?.kind).toBe("owner");
  });
});

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const EMP = "emp_sales";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
let savedFlag: string | undefined;
let saved: Awaited<ReturnType<typeof getEmployee>>;

async function setEmp(patch: { actionLimits?: unknown; toolApprovalDefaults?: unknown; allowedPurposes?: string[] }) {
  const e = (await getEmployee(EMP, ORG))!;
  await updateEmployeePolicy({
    orgId: ORG, employeeId: EMP, scopes: e.scopes, allowedPurposes: patch.allowedPurposes ?? e.allowedPurposes, approvalPolicy: e.approvalPolicy,
    actionLimits: (patch.actionLimits ?? e.actionLimits) as never,
    toolApprovalDefaults: (patch.toolApprovalDefaults ?? e.toolApprovalDefaults) as never,
  });
}
beforeEach(async () => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = "true";
  resetRuntimeMembers();
  saved = structuredClone((await getEmployee(EMP, ORG))!);
  await setEmp({ actionLimits: CAPS, toolApprovalDefaults: DENY_ORDER });
});
afterEach(async () => {
  await updateEmployeePolicy({
    orgId: ORG, employeeId: EMP, scopes: saved!.scopes, allowedPurposes: saved!.allowedPurposes, approvalPolicy: saved!.approvalPolicy,
    actionLimits: saved!.actionLimits, toolApprovalDefaults: (saved!.toolApprovalDefaults ?? STRICT) as never,
  });
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  resetRuntimeMembers();
});

async function file(mutation: Record<string, unknown>, approve = true): Promise<ApprovalRequest> {
  // What intake stores since #275 (card record + card text).
  const { adminMutation, summary } = await policyPatchTicket(ORG, mutation);
  const { approval } = await createApproval({
    orgId: ORG, employeeId: "", credentialId: "", title: "policy.patch", purpose: "admin.policy", summary, risk: "high", tool: "policy.patch",
    jobId: crypto.randomUUID(),
    metadata: {
      auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: "policy.patch", isAdminMcpTool: true, adminMutation,
      adminRequester: { kind: "admin_agent", actorId: "admin_agent_pml", grokBotAgentId: "grok_pml", credentialGeneration: 1 },
    },
  });
  if (approve) {
    const r = await resolveApprovalWithWorkflow(approval.id, "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
    expect(r.ok).toBe(true);
  }
  return (await getApprovalById(approval.id, ORG))!;
}
const current = async () => (await getEmployee(EMP, ORG))!;

describe("policy.patch money limits (filing reads the real employee)", () => {
  test("omitted actionLimits → kept → filed as standard; explicit {} → owner-only", async () => {
    const e = await current();
    const t = await file({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy }, false);
    expect(t.requiredApproverKind).toBe("owner_or_designated_admin");
    const u = await file({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy, actionLimits: {} }, false);
    expect(u.requiredApproverKind).toBe("owner");
  });
  test("partial toolApprovalDefaults (non-money keys only) → owner-only", async () => {
    const e = await current();
    const t = await file({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy, actionLimits: CAPS, toolApprovalDefaults: { "mail.send": "auto" } }, false);
    expect(t.requiredApproverKind).toBe("owner");
  });
  test("non-money-only change → standard", async () => {
    const e = await current();
    const t = await file({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy, actionLimits: { ...CAPS, "slack.post": { perDay: 9 } } }, false);
    expect(t.requiredApproverKind).toBe("owner_or_designated_admin");
  });
  test("F2 fingerprint covers actionLimits and toolApprovalDefaults", async () => {
    const e = await current();
    const patch = { employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy, actionLimits: CAPS };
    const a = await file(patch);
    await setEmp({ actionLimits: { "commerce.order": { perDay: 1 } } });
    await expect(assertApprovalExecutionAuthority(a)).rejects.toThrow("approver_context_changed");
    await setEmp({ actionLimits: CAPS });
    const b = await file(patch);
    await setEmp({ toolApprovalDefaults: { ...DENY_ORDER, "mail.send": "deny" } });
    await expect(assertApprovalExecutionAuthority(b)).rejects.toThrow("approver_context_changed");
  });
  test("allowedPurposes left out → the current value is kept (not emptied)", async () => {
    await setEmp({ allowedPurposes: ["sales.outreach", "commerce.quote"] });
    const e = await current();
    const t = await file({ employeeId: EMP, scopes: e.scopes, approvalPolicy: e.approvalPolicy, actionLimits: CAPS });
    expect((await fulfillApprovedAdmin(t))?.ok).toBe(true);
    expect((await current()).allowedPurposes).toEqual(["sales.outreach", "commerce.quote"]);
    expect((await current()).actionLimits).toEqual(CAPS);
  });
});
