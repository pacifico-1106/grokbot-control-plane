/**
 * TOCTOU follow-up to F2 (木村 2026-10-09 23:58, item 2): F2 re-reads the
 * judged state right before fulfil, but a change between that check and the
 * write could still be overwritten. With APPROVER_AUTHORITY_ENABLED the write
 * itself is a compare-and-swap: it only happens if the state still equals
 * the snapshot whose fingerprint matched the one recorded at filing.
 * A concurrent change in between → approver_context_changed (same next step
 * wording as F2) and NOTHING is written. Flag OFF → today's path.
 * (Demo store here; the production RPC is covered by context-cas-prod.test.ts
 * and tests/security/db-approver-context-cas.sql.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, resetRuntimeMembers } from "@/lib/demo-data";
import type { ApprovalRequest, Employee } from "@/lib/types";

// The one await inside the window between the CAS read and the write
// (updateEmployeePolicy reads the org SoD policy before writing): a one-shot
// hook there plays "an owner saved something at that very moment".
let concurrentChange: (() => void) | null = null;
const realOrgContext = { ...(await import("@/lib/data/org-context")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/data/org-context", {
  getOrgSodWarnPolicy: (orgId?: string | null) => {
    const hook = concurrentChange;
    concurrentChange = null;
    hook?.();
    return realOrgContext.getOrgSodWarnPolicy(orgId);
  },
});

const { createApproval, getApprovalById } = await import("@/lib/data/approvals");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { setOrgSchedulingPolicy, setEmployeeSchedulingPolicy, getOrgSchedulingPolicy, getEmployeeSchedulingPolicy, resetDemoSchedulingPolicy } =
  await import("@/lib/data/scheduling-policy");
const { getEmployee } = await import("@/lib/data/employees");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { isRetryableApprovalFailure } = await import("@/lib/approvals/execution");
const { approverContextGuardForWrite } = await import("@/lib/approver-authority/filing");
const { approverAuthorityNextStepJa } = await import("@/lib/approver-authority/reply");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const EMP = "emp_sales";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
const NEXT_STEP = "ポリシーが変わったので、今の内容を読み直して申請し直してください。";
let savedFlag: string | undefined;
let savedEmployee: Employee;

const runtimeEmployee = () => getRuntimeEmployees().find((e) => e.id === EMP)! as Employee;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = "true";
  concurrentChange = null;
  resetRuntimeMembers();
  resetDemoSchedulingPolicy();
  savedEmployee = structuredClone(runtimeEmployee());
});
afterEach(() => {
  concurrentChange = null;
  const emp = runtimeEmployee() as unknown as Record<string, unknown>;
  for (const key of Object.keys(emp)) delete emp[key];
  Object.assign(emp, structuredClone(savedEmployee));
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
      adminRequester: { kind: "admin_agent", actorId: "admin_agent_cas_requester", grokBotAgentId: "grok_cas", credentialGeneration: 1 },
    },
  });
  const r = await resolveApprovalWithWorkflow(approval.id, "approved", `fixture:${OWNER}`, ORG, { memberId: OWNER, actorId: OWNER });
  expect(r.ok).toBe(true);
  return (await getApprovalById(approval.id, ORG))!;
}

const capPolicy = (cap: number) => ({ policyName: "P", rules: [{ id: "r1", confirmAutomation: "always_human", costCapJpy: cap }] });
const policyAuditFor = (approvalId: string) =>
  getRuntimeAudit().filter((e) => (e.metadata as Record<string, unknown> | undefined)?.approvalId === approvalId && e.action === "admin.policy");

async function policyPatchArgs(change: Record<string, unknown> = {}) {
  const e = (await getEmployee(EMP, ORG))!;
  return {
    employeeId: EMP, scopes: [...e.scopes], allowedPurposes: [...e.allowedPurposes], approvalPolicy: e.approvalPolicy,
    actionLimits: structuredClone(e.actionLimits), ...change,
  };
}

describe("policy.patch: the approval-executed write is a compare-and-swap", () => {
  test("a concurrent change between the check and the write → approver_context_changed, nothing written", async () => {
    const t = await fileApproved("policy.patch", await policyPatchArgs({ actionLimits: { "mail.send": { perDay: 1 } } }));
    const concurrentLimits = { "mail.send": { perDay: 99, perMonth: 999 } };
    concurrentChange = () => { runtimeEmployee().actionLimits = structuredClone(concurrentLimits) as never; };

    const result = await fulfillApprovedAdmin(t);

    expect(concurrentChange).toBeNull(); // the window was really hit
    expect(result).toMatchObject({ ok: false, error: "approver_context_changed", nextStepJa: NEXT_STEP });
    expect(approverAuthorityNextStepJa("approver_context_changed")).toBe(NEXT_STEP);
    const after = runtimeEmployee();
    expect(after.actionLimits).toEqual(concurrentLimits as never); // the concurrent save survives
    expect(after.scopes).toEqual(savedEmployee.scopes);
    expect(after.approvalPolicy).toBe(savedEmployee.approvalPolicy);
    expect(policyAuditFor(t.id)).toEqual([]); // no "updated" audit for a write that did not happen
  });

  test("a refused write is a clean stop (claim 'failed', not 'uncertain')", () => {
    expect(isRetryableApprovalFailure("policy.patch", "approver_context_changed")).toBe(true);
    expect(isRetryableApprovalFailure("schedulingPolicy.patch", "approver_context_changed")).toBe(true);
    expect(isRetryableApprovalFailure("mail.send", "approver_context_changed")).toBe(false);
  });

  test("nothing changed in between → written as approved", async () => {
    const t = await fileApproved("policy.patch", await policyPatchArgs({ actionLimits: { "mail.send": { perDay: 1 } } }));
    const result = await fulfillApprovedAdmin(t);
    expect(result).toMatchObject({ ok: true, tool: "policy.patch" });
    expect(runtimeEmployee().actionLimits).toEqual({ "mail.send": { perDay: 1 } } as never);
    expect(policyAuditFor(t.id).length).toBe(1);
  });

  test("flag OFF → no guard; today's write path (a concurrent change is overwritten as before)", async () => {
    const t = await fileApproved("policy.patch", await policyPatchArgs({ actionLimits: { "mail.send": { perDay: 1 } } }));
    delete process.env[FLAG];
    expect(await approverContextGuardForWrite(t)).toBeNull();
    concurrentChange = () => { runtimeEmployee().actionLimits = { "mail.send": { perDay: 99 } } as never; };
    const result = await fulfillApprovedAdmin(t);
    expect(result).toMatchObject({ ok: true });
    expect(runtimeEmployee().actionLimits).toEqual({ "mail.send": { perDay: 1 } } as never);
  });
});

describe("policy.patch with actionLimits left out (kept, 2026-10-10) under the guard", () => {
  const omittedArgs = async () => {
    const args: Record<string, unknown> = await policyPatchArgs({ approvalPolicy: "always_human" });
    delete args.actionLimits;
    return args;
  };
  test("nothing changed in between → current caps kept, written", async () => {
    runtimeEmployee().actionLimits = { "commerce.order": { perDay: 3, perMonth: 20 } } as never;
    const t = await fileApproved("policy.patch", await omittedArgs());
    expect(await fulfillApprovedAdmin(t)).toMatchObject({ ok: true, tool: "policy.patch" });
    expect(runtimeEmployee().actionLimits).toEqual({ "commerce.order": { perDay: 3, perMonth: 20 } } as never);
  });
  test("a concurrent cap change in the window → approver_context_changed; the kept value never overwrites it", async () => {
    runtimeEmployee().actionLimits = { "commerce.order": { perDay: 3, perMonth: 20 } } as never;
    const t = await fileApproved("policy.patch", await omittedArgs());
    const lowered = { "commerce.order": { perDay: 1, perMonth: 5 } };
    concurrentChange = () => { runtimeEmployee().actionLimits = structuredClone(lowered) as never; };
    expect(await fulfillApprovedAdmin(t)).toMatchObject({ ok: false, error: "approver_context_changed", nextStepJa: NEXT_STEP });
    expect(concurrentChange).toBeNull();
    expect(runtimeEmployee().actionLimits).toEqual(lowered as never);
    expect(policyAuditFor(t.id)).toEqual([]);
  });
});

describe("schedulingPolicy.patch: guarded writes", () => {
  test("org policy: concurrent change after the check → approver_context_changed, nothing written", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    const guard = await approverContextGuardForWrite(t);
    expect(guard).not.toBeNull();
    await setOrgSchedulingPolicy(ORG, capPolicy(3000) as never); // an owner lowers the cap right now
    await expect(setOrgSchedulingPolicy(ORG, capPolicy(9000) as never, { contextGuard: guard! })).rejects.toThrow("approver_context_changed");
    expect((await getOrgSchedulingPolicy(ORG)).rules[0]?.costCapJpy).toBe(3000);
  });

  test("org policy: unchanged → the guarded write goes through", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    const guard = await approverContextGuardForWrite(t);
    await setOrgSchedulingPolicy(ORG, capPolicy(9000) as never, { contextGuard: guard! });
    expect((await getOrgSchedulingPolicy(ORG)).rules[0]?.costCapJpy).toBe(9000);
  });

  test("employee clearOverride: concurrent change of the override → refused, override kept", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    await setEmployeeSchedulingPolicy(EMP, ORG, capPolicy(4000) as never);
    const t = await fileApproved("schedulingPolicy.patch", { employeeId: EMP, clearOverride: true });
    const guard = await approverContextGuardForWrite(t);
    expect(guard).not.toBeNull();
    await setEmployeeSchedulingPolicy(EMP, ORG, capPolicy(2000) as never);
    await expect(setEmployeeSchedulingPolicy(EMP, ORG, null, { contextGuard: guard! })).rejects.toThrow("approver_context_changed");
    expect((await getEmployeeSchedulingPolicy(EMP))?.rules[0]?.costCapJpy).toBe(2000);
  });

  test("employee override: a change of the inherited org policy is also caught", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", { employeeId: EMP, ...capPolicy(9000) });
    const guard = await approverContextGuardForWrite(t);
    await setOrgSchedulingPolicy(ORG, capPolicy(1000) as never);
    await expect(setEmployeeSchedulingPolicy(EMP, ORG, capPolicy(9000) as never, { contextGuard: guard! })).rejects.toThrow("approver_context_changed");
    expect(await getEmployeeSchedulingPolicy(EMP)).toBeNull();
  });

  test("a guard of one tool is never accepted by the other tool's write", async () => {
    const t = await fileApproved("policy.patch", await policyPatchArgs());
    const guard = await approverContextGuardForWrite(t);
    expect(guard).not.toBeNull();
    await expect(setOrgSchedulingPolicy(ORG, capPolicy(9000) as never, { contextGuard: guard! })).rejects.toThrow();
    expect((await getOrgSchedulingPolicy(ORG)).rules[0]?.costCapJpy).not.toBe(9000);
  });
});

describe("the guard itself", () => {
  test("state already changed since filing → approver_context_changed before any write", async () => {
    await setOrgSchedulingPolicy(ORG, capPolicy(5000) as never);
    const t = await fileApproved("schedulingPolicy.patch", capPolicy(9000));
    await setOrgSchedulingPolicy(ORG, capPolicy(3000) as never);
    await expect(approverContextGuardForWrite(t)).rejects.toThrow("approver_context_changed");
  });

  test("not a pinned tool → no guard", async () => {
    const t = await fileApproved("replyPolicy.patch", {});
    expect(await approverContextGuardForWrite(t)).toBeNull();
  });
});
