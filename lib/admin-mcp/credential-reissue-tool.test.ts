/**
 * Admin MCP: employees.credential.reissue (ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED,
 * default OFF; 木村 2026-10-12). Demo mode.
 *
 * The AI asks, a human approves (always_human, #279 approver authority), and the
 * new 社員証 is minted only at the EXISTING hand-over path: a credential admin
 * opens the AI社員 page and reissues there (POST /api/employees/[id]/rotate with
 * reissueApprovalId) — the one-time secret goes to that human's browser only.
 * The key is never minted at fulfil, never stored, never returned to the AI.
 * The old credential keeps working until the new one is issued and is revoked
 * on issue (rotate semantics).
 *
 * Covers: registry, flag OFF, BOLA (another org's employee / approval), self-
 * approval, approver class, fulfil (no mint, no secret, audit), redeem
 * (revoke-old-on-issue, single use, window, mismatch, audit), no key to the AI.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin, parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { SELF_APPROVAL_DENIED } from "@/lib/admin-mcp/self-approval";
import { classifyApproverRequirement, isApproverAuthorityTargetTool } from "@/lib/approver-authority/targets";
import { loadApproverClassificationContext } from "@/lib/approver-authority/filing";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { getBinding, rotateCredential as demoRotate } from "@/lib/bindings";
import { createApproval, getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool, readApprovedAdminResult } from "@/lib/mcp/admin-tools";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import {
  CREDENTIAL_REISSUE_PICKUP_WINDOW_MS,
  CREDENTIAL_REISSUE_TOOL,
  findPendingCredentialReissue,
  redeemCredentialReissue,
} from "@/lib/employees/credential-reissue";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { Employee } from "@/lib/types";

const TOOL = "employees.credential.reissue";
const FLAG = "ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_reissue_other_tenant";
const ADMIN_GROK = "grok_admin_reissue";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_reissue" };
const SECRETISH = /gb_emp_[A-Za-z0-9]{6,}|oneTimeSecret|secret_hash|secretHash\b/;
let seq = 0;

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: ADMIN_GROK, status: "linked" });
  return { orgId, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}
function newEmployee(orgId: string, extra: Partial<Employee> = {}): Employee {
  seq += 1;
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = {
    ...base,
    id: `emp_ri_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    scopes: ["tools:read", "approvals:request", "audit:append"],
    credentialId: `cred_ri_${seq}`,
    credentialExpiresAt: "2026-09-23T00:00:00.000Z",
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  demoRotate(employee.id, orgId, `fp_old_${seq}`);
  return employee;
}
const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;
async function propose(employeeId: string, c = cred()) {
  return data(await callAdminMcpTool(TOOL, { employeeId, reason: "expired" }, c));
}
async function approve(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", HUMAN.email, orgId, { actorId: HUMAN.memberId });
  expect(approved).not.toBeNull();
  return approved!;
}
async function approvedTicket(emp: Employee) {
  const q = await propose(emp.id);
  expect(q.code).toBe("needs_approval");
  const approval = await approve(String(q.approvalId));
  const f = await fulfillApprovedAdmin(approval);
  expect(f?.ok).toBe(true);
  return String(q.approvalId);
}
const actor = { memberId: HUMAN.memberId, email: HUMAN.email };

beforeEach(() => {
  process.env[FLAG] = "1";
});
afterEach(() => {
  delete process.env[FLAG];
});

describe("registry", () => {
  test("name, always_human / approvalClass admin, admin.policy audit, not read-only, every plan, not on the employee MCP", async () => {
    expect(CREDENTIAL_REISSUE_TOOL).toBe(TOOL);
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(TOOL)).toBe(true);
    const def = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!;
    expect(def.approvalClass).toBe("admin");
    expect(def.description).toContain("always_human");
    expect(auditActionForAdminTool(TOOL)).toBe("admin.policy");
    expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(TOOL)).toBe(false);
    for (const plan of Object.keys(PLAN_ADMIN_SCOPES) as Array<keyof typeof PLAN_ADMIN_SCOPES>) {
      expect({ plan, ok: (PLAN_ADMIN_SCOPES[plan] as readonly string[]).includes(TOOL) }).toEqual({ plan, ok: true });
    }
    expect([...STAFFPASS_MCP_TOOLS, ...listStaffpassMcpTools()].some((t) => t.name === TOOL)).toBe(false);
    const emp = newEmployee(ORG_A);
    const res = await callStaffpassMcpTool(TOOL, {}, { employeeId: emp.id, orgId: ORG_A } as unknown as ResolvedEmployeeCredential);
    expect(data(res).code).toBe("unknown_mcp_tool");
  });
  test("schema: employeeId (+ reason / jobId / approvalId), no orgId, no extra keys", () => {
    const schema = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!.inputSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(["approvalId", "employeeId", "jobId", "reason"]);
    expect(schema.required).toEqual(["employeeId"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("flag OFF (default)", () => {
  test("tool refuses with feature_disabled, no ticket", async () => {
    delete process.env[FLAG];
    const emp = newEmployee(ORG_A);
    const before = (await listApprovals(ORG_A)).length;
    const res = await propose(emp.id);
    expect(res.code).toBe("feature_disabled");
    expect((await listApprovals(ORG_A)).length).toBe(before);
  });
  test("redeem refuses with feature_disabled", async () => {
    const emp = newEmployee(ORG_A);
    const approvalId = await approvedTicket(emp);
    delete process.env[FLAG];
    expect(await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor })).toMatchObject({ ok: false, code: "feature_disabled" });
  });
});

describe("propose (queue)", () => {
  test("same org → always_human ticket with ids only; old credential untouched", async () => {
    const emp = newEmployee(ORG_A);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    const q = await propose(emp.id);
    expect(q).toMatchObject({ code: "needs_approval", always_human: true, tool: TOOL });
    const approval = (await getApprovalById(String(q.approvalId), ORG_A))!;
    expect(approval.metadata.adminMutation).toEqual({ employeeId: emp.id, reason: "expired" });
    expect(approval.summary).toContain(emp.id);
    expect(approval.summary).toContain("期限切れ");
    expect(JSON.stringify(approval)).not.toMatch(SECRETISH);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
  });
  test("BOLA: another org's employee → employee_not_found, no ticket", async () => {
    const other = newEmployee(ORG_B);
    const before = (await listApprovals(ORG_A)).length;
    const res = await propose(other.id);
    expect(res.code).toBe("employee_not_found");
    expect((await listApprovals(ORG_A)).length).toBe(before);
  });
  test("suspended employee → employee_terminated; unknown / secret-ish args refused", async () => {
    const emp = newEmployee(ORG_A, { status: "suspended" });
    expect((await propose(emp.id)).code).toBe("employee_terminated");
    const ok = newEmployee(ORG_A);
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, orgId: ORG_B }, cred())).code).toBe("unexpected_argument");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, reason: "gb_emp_0123456789abcdef_0123456789abcdef0123456789abcdef" }, cred())).code).toBe("secret_not_accepted");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, reason: "because" }, cred())).code).toBe("invalid_reason");
  });
  test("the admin agent cannot reissue the badge bound to its own Grok Bot", async () => {
    const emp = newEmployee(ORG_A);
    const { linkAgent } = await import("@/lib/data/bindings");
    await linkAgent(emp.id, { orgId: ORG_A, grokBotAgentId: ADMIN_GROK, grokBotWorkspaceId: null });
    expect((await propose(emp.id)).code).toBe("cannot_target_self");
  });
});

describe("self-approval and approver class (#279)", () => {
  test("the requesting admin agent cannot approve its own reissue ticket", async () => {
    const emp = newEmployee(ORG_A);
    const c = cred();
    const q = await propose(emp.id, c);
    let denied = false;
    try {
      await resolveApproval(String(q.approvalId), "approved", c.actorId, ORG_A, { grokBotAgentId: c.grokBotAgentId, actorId: c.actorId });
    } catch (e) {
      denied = e instanceof Error && e.message === SELF_APPROVAL_DENIED;
    }
    expect(denied).toBe(true);
  });
  test("approver authority target: standard (owner or designated admin); money-scope employee or unknown scopes → owner", async () => {
    expect(isApproverAuthorityTargetTool(TOOL)).toBe(true);
    const mutation = { adminMutation: { employeeId: "emp_x", reason: "expired" } };
    expect(classifyApproverRequirement({ tool: TOOL, metadata: mutation, context: { currentEmployeeScopes: ["tools:read"] } })?.kind).toBe("owner_or_designated_admin");
    expect(classifyApproverRequirement({ tool: TOOL, metadata: mutation, context: { currentEmployeeScopes: ["commerce:order"] } })).toMatchObject({ kind: "owner", reasons: ["employee_has_money_scope"] });
    expect(classifyApproverRequirement({ tool: TOOL, metadata: mutation, context: null })).toMatchObject({ kind: "owner", reasons: ["money_scope_unverified"] });
  });
  test("filing context reads the target employee's scopes in the ticket org only", async () => {
    const emp = newEmployee(ORG_A, { scopes: ["commerce:order", "tools:read"] });
    const ctx = await loadApproverClassificationContext(ORG_A, TOOL, { adminMutation: { employeeId: emp.id } });
    expect(ctx?.currentEmployeeScopes).toContain("commerce:order");
    expect(await loadApproverClassificationContext(ORG_B, TOOL, { adminMutation: { employeeId: emp.id } })).toBeNull();
  });
});

describe("fulfil (human approved): authorizes the hand-over, mints nothing, returns no key", () => {
  test("no rotation at fulfil; fulfillment / AI result carry no secret; nextStep points to the dashboard", async () => {
    const emp = newEmployee(ORG_A);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    const genBefore = getBinding(emp.id)?.credentialGeneration;
    const approvalId = await approvedTicket(emp);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect(getBinding(emp.id)?.credentialGeneration).toBe(genBefore);
    const approval = (await getApprovalById(approvalId, ORG_A))!;
    const f = parseAdminFulfillment(approval.metadata)!;
    expect(f).toMatchObject({ ok: true, tool: TOOL, employeeId: emp.id });
    expect(f.oneTimeSecret).toBeUndefined();
    expect(String(f.nextStepJa)).toContain(`/app/employees/${emp.id}`);
    const forAi = await readApprovedAdminResult(cred(), approvalId);
    expect(forAi).not.toBeNull();
    expect(JSON.stringify(forAi)).not.toMatch(SECRETISH);
    expect(JSON.stringify(approval.metadata)).not.toMatch(SECRETISH);
  });
  test("approval audit: admin class, ids only", async () => {
    const emp = newEmployee(ORG_A);
    const approvalId = await approvedTicket(emp);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === approvalId && e.metadata?.event === "employee.credential.reissue_approved");
    expect(row).toBeDefined();
    expect(row!.metadata).toMatchObject({ auditClass: "admin", tool: TOOL, employeeId: emp.id, approver: HUMAN.email });
    expect(JSON.stringify(row)).not.toMatch(SECRETISH);
  });
  test("employee suspended after propose → fulfil refuses (ok:false), nothing to pick up", async () => {
    const emp = newEmployee(ORG_A);
    const q = await propose(emp.id);
    getRuntimeEmployees().find((e) => e.id === emp.id)!.status = "suspended";
    const f = await fulfillApprovedAdmin(await approve(String(q.approvalId)));
    expect(f).toMatchObject({ ok: false, error: "employee_terminated" });
    expect(await findPendingCredentialReissue(ORG_A, emp.id)).toBeNull();
  });
});

describe("redeem at the dashboard hand-over (rotate)", () => {
  test("old credential stays current until redeem; redeem revokes it on issue (generation+1, new fingerprint) and returns the key to the human only", async () => {
    const emp = newEmployee(ORG_A);
    const approvalId = await approvedTicket(emp);
    const before = getBinding(emp.id)!;
    expect(await findPendingCredentialReissue(ORG_A, emp.id)).toMatchObject({ approvalId });
    const r = await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.raw.startsWith("gb_emp_")).toBe(true);
    const after = getBinding(emp.id)!;
    expect(after.credentialGeneration).toBe(before.credentialGeneration + 1);
    expect(after.credentialFingerprint).not.toBe(before.credentialFingerprint);
    expect(after.credentialFingerprint).toBe(r.secret.fingerprint);
    // nothing about the key is stored on the ticket or readable by the AI
    const approval = (await getApprovalById(approvalId, ORG_A))!;
    expect(JSON.stringify(approval.metadata)).not.toContain(r.secret.raw);
    expect(JSON.stringify(approval.metadata)).not.toContain(r.secret.fingerprint);
    expect(JSON.stringify(await readApprovedAdminResult(cred(), approvalId))).not.toContain(r.secret.raw);
    // audit: credential.rotated with the ticket id + 12-char hash prefix only
    const row = getRuntimeAudit().find((e) => e.action === "credential.rotated" && e.metadata?.reissueApprovalId === approvalId);
    expect(row).toBeDefined();
    expect(row!.metadata).toMatchObject({ secretHashPrefix: r.secret.fingerprint.slice(0, 12), actorMemberId: HUMAN.memberId });
    expect(JSON.stringify(row)).not.toContain(r.secret.raw);
    expect(JSON.stringify(row)).not.toContain(r.secret.fingerprint);
    expect(await findPendingCredentialReissue(ORG_A, emp.id)).toBeNull();
  });
  test("single use: a second redeem is refused (reissue_approval_used), no second rotation", async () => {
    const emp = newEmployee(ORG_A);
    const approvalId = await approvedTicket(emp);
    expect((await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor })).ok).toBe(true);
    const gen = getBinding(emp.id)!.credentialGeneration;
    expect(await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor })).toMatchObject({ ok: false, code: "reissue_approval_used" });
    expect(getBinding(emp.id)!.credentialGeneration).toBe(gen);
  });
  test("BOLA: another org's session, another employee's path, another tool's ticket, a pending ticket → refused, no rotation", async () => {
    const emp = newEmployee(ORG_A);
    const other = newEmployee(ORG_A);
    const approvalId = await approvedTicket(emp);
    const gen = getBinding(emp.id)!.credentialGeneration;
    expect(await redeemCredentialReissue({ orgId: ORG_B, employeeId: emp.id, approvalId, actor })).toMatchObject({ ok: false, code: "reissue_approval_not_found" });
    expect(await redeemCredentialReissue({ orgId: ORG_A, employeeId: other.id, approvalId, actor })).toMatchObject({ ok: false, code: "reissue_approval_mismatch" });
    const policy = await createApproval({
      orgId: ORG_A, employeeId: "", credentialId: "", title: "x", purpose: "admin.policy", summary: "x", risk: "high", tool: "policy.patch",
      jobId: `job_ri_${Date.now()}`, metadata: { auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: "policy.patch", adminMutation: { employeeId: emp.id } },
    });
    await approve(policy.approval.id);
    expect(await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId: policy.approval.id, actor })).toMatchObject({ ok: false, code: "reissue_approval_mismatch" });
    const pending = await propose(emp.id);
    expect(await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId: String(pending.approvalId), actor })).toMatchObject({ ok: false, code: "reissue_approval_not_approved" });
    expect(getBinding(emp.id)!.credentialGeneration).toBe(gen);
  });
  test(`window: ${CREDENTIAL_REISSUE_PICKUP_WINDOW_MS / 3_600_000}h after approval → reissue_approval_expired`, async () => {
    expect(CREDENTIAL_REISSUE_PICKUP_WINDOW_MS).toBe(24 * 3_600_000);
    const emp = newEmployee(ORG_A);
    const approvalId = await approvedTicket(emp);
    const later = new Date(Date.now() + CREDENTIAL_REISSUE_PICKUP_WINDOW_MS + 60_000);
    expect(await redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor, now: later })).toMatchObject({ ok: false, code: "reissue_approval_expired" });
    expect(await findPendingCredentialReissue(ORG_A, emp.id, later)).toBeNull();
  });
});
