/**
 * 木村 2026-10-09 round 3 F2: the state a ticket was judged on is stored at
 * filing (approver_authority.contextFingerprint) and re-read right before
 * fulfil. If an owner changed it in between (e.g. lowered a cost cap, removed
 * a scope), approving the old ticket must not put the old state back: refuse
 * with approver_context_changed and ask for a new filing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, resetRuntimeMembers } from "@/lib/demo-data";
import type { ApprovalRequest } from "@/lib/types";

const mocks = scopedModuleMocks();
await mocks.mock("@/lib/notify/channels", {
  sendApprovalNotifications: async () => [{ ok: true, provider: "slack" }],
  refreshWorkflowNotification: async () => {},
  updateApprovalNotificationMessages: async () => [],
  notifyOwnerApprovalPending: async () => ({ ok: true, provider: "slack" }),
  notifyOwnersApproverAuthorityApproved: async () => ({ owners: 0, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null }),
});

const { createApproval, getApprovalById } = await import("@/lib/data/approvals");
const { demoUpdateApproval } = await import("@/lib/data/demo-approvals-store");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { assertApprovalExecutionAuthority } = await import("@/lib/approvals/execution-authority");
const { setOrgSchedulingPolicy, resetDemoSchedulingPolicy } = await import("@/lib/data/scheduling-policy");
const { getEmployee, updateEmployeePolicy } = await import("@/lib/data/employees");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { approverAuthorityReplyJa, approverAuthorityNextStepJa } = await import("@/lib/approver-authority/reply");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const EMP = "emp_sales";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = "true";
  resetRuntimeMembers();
  resetDemoSchedulingPolicy();
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  resetRuntimeMembers();
  resetDemoSchedulingPolicy();
});

async function fileApproved(tool: string, adminMutation: Record<string, unknown>): Promise<ApprovalRequest> {
  const { approval } = await createApproval({
    orgId: ORG, employeeId: "", credentialId: "", title: tool, purpose: "admin.policy", summary: tool, risk: "high", tool,
    jobId: crypto.randomUUID(),
    metadata: {
      auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: tool, isAdminMcpTool: true, adminMutation,
      adminRequester: { kind: "admin_agent", actorId: "admin_agent_ctx_requester", grokBotAgentId: "grok_ctx", credentialGeneration: 1 },
    },
  });
  const r = await resolveApprovalWithWorkflow(approval.id, "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
  expect(r.ok).toBe(true);
  return (await getApprovalById(approval.id, ORG))!;
}

const capPolicy = (cap: number) => ({ policyName: "P", rules: [{ id: "r1", confirmAutomation: "always_human", costCapJpy: cap }] });

describe("schedulingPolicy.patch", () => {
  test("fixtures are valid policies (the store would silently fall back to the default otherwise)", async () => {
    const { validateSchedulingPolicy } = await import("@/lib/scheduling-policy/validate");
    for (const cap of [3000, 5000, 9000]) expect(validateSchedulingPolicy(capPolicy(cap)).ok).toBe(true);
  });

  test("no policy stored (built-in default) → same state at every read → runs", async () => {
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    await expect(assertApprovalExecutionAuthority(t)).resolves.toBeUndefined();
  });

  test("filing records the state it was judged on", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    expect(t.requiredApproverKind).toBe("owner");
    expect(typeof t.approverAuthority?.contextFingerprint).toBe("string");
  });

  test("unchanged since filing → runs", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    await expect(assertApprovalExecutionAuthority(t)).resolves.toBeUndefined();
  });

  test("an owner lowered the cap after filing → refused; the reply asks for a new filing", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    await setOrgSchedulingPolicy(ORG, capPolicy(3000) as never);
    await expect(assertApprovalExecutionAuthority(t)).rejects.toThrow("approver_context_changed");
    expect(approverAuthorityNextStepJa("approver_context_changed")).toContain("もう一度申請");
    expect(approverAuthorityReplyJa("approver_context_changed")).toContain("実行しませんでした");
  });

  test("a ticket without the recorded state (filed before this check) → refused", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    const { contextFingerprint: _drop, ...rest } = t.approverAuthority ?? {};
    void _drop;
    const stripped = (await demoUpdateApproval(t.id, { approverAuthority: rest }))!;
    await expect(assertApprovalExecutionAuthority(stripped)).rejects.toThrow("approver_context_changed");
  });

  test("flag OFF → today's behaviour", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    await setOrgSchedulingPolicy(ORG, capPolicy(3000) as never);
    delete process.env[FLAG];
    await expect(assertApprovalExecutionAuthority(t)).resolves.toBeUndefined();
  });
});

describe("policy.patch (scopes)", () => {
  test("the employee's scopes changed after filing → refused; unchanged → runs", async () => {
    const before = (await getEmployee(EMP, ORG))!;
    const patch = { employeeId: EMP, scopes: [...before.scopes] };
    const same = await fileApproved("policy.patch", patch);
    await expect(assertApprovalExecutionAuthority(same)).resolves.toBeUndefined();
    const t = await fileApproved("policy.patch", patch);
    try {
      await updateEmployeePolicy({
        orgId: ORG, employeeId: EMP, scopes: before.scopes.slice(1), allowedPurposes: before.allowedPurposes, approvalPolicy: before.approvalPolicy,
      });
      await expect(assertApprovalExecutionAuthority(t)).rejects.toThrow("approver_context_changed");
    } finally {
      await updateEmployeePolicy({
        orgId: ORG, employeeId: EMP, scopes: before.scopes, allowedPurposes: before.allowedPurposes, approvalPolicy: before.approvalPolicy,
      });
    }
  });
});

describe("after a successful run", () => {
  test("calling fulfil again returns the stored result (the applied change itself is not a 'change since filing')", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    const first = await fulfillApprovedAdmin(t);
    expect(first).toMatchObject({ ok: true });
    const again = await fulfillApprovedAdmin((await getApprovalById(t.id, ORG))!);
    expect(again?.ok).toBe(true);
  });
});
