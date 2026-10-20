/**
 * Fail-first: 社員証 auto-renew R-now (今すぐ更新).
 * CREDENTIAL_AUTO_RENEW_ENABLED + org allowlist, default OFF.
 * No gen1 HTTP, no overlap claim, no boot script.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fulfillApprovedAdmin, parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { SELF_APPROVAL_DENIED } from "@/lib/admin-mcp/self-approval";
import { classifyApproverRequirement, isApproverAuthorityTargetTool } from "@/lib/approver-authority/targets";
import { loadApproverClassificationContext } from "@/lib/approver-authority/filing";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { getBinding, rotateCredential as demoRotate } from "@/lib/bindings";
import { getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { closeApprovalWithoutSend } from "@/lib/data/approvals";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import {
  demoListCredentialRenewals,
  demoPatchCredentialRenewal,
  demoResetCredentialRenewals,
  markCredentialRenewalClaimable,
} from "@/lib/data/credential-renewals";
import { getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool, listAdminMcpToolsForOrg, readApprovedAdminResult } from "@/lib/mcp/admin-tools";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import {
  CREDENTIAL_AUTO_RENEW_ADMIN_TOOL,
  CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS,
  expireStaleCredentialRenewals,
  findOpenCredentialRenewal,
  proposeCredentialAutoRenewNow,
} from "./credential-auto-renew";
import { demoSetEmployeeHold, demoSetOrgHold } from "@/lib/safety/hold";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { Employee } from "@/lib/types";

const TOOL = "employees.credential.auto_renew";
const FLAG = "CREDENTIAL_AUTO_RENEW_ENABLED";
const ALLOWLIST = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST";
const REQUIRED = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST_REQUIRED";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ADMIN_GROK = "grok_admin_autorenew";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_autorenew" };
const SECRETISH = /gb_emp_[A-Za-z0-9]{6,}|oneTimeSecret|secret_hash|secretHash\b|claim_token/;
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
    id: `emp_ar_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    scopes: ["tools:read", "approvals:request", "audit:append"],
    credentialId: `cred_ar_${seq}`,
    credentialExpiresAt: extra.credentialExpiresAt === undefined ? "2026-12-01T00:00:00.000Z" : extra.credentialExpiresAt,
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  demoRotate(employee.id, orgId, `fp_ar_${seq}`);
  return employee;
}
const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;
async function proposeMcp(employeeId: string, c = cred()) {
  return data(await callAdminMcpTool(TOOL, { employeeId, reason: "now" }, c));
}
async function approve(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", HUMAN.email, orgId, { actorId: HUMAN.memberId });
  expect(approved).not.toBeNull();
  return approved!;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, ALLOWLIST, REQUIRED] as const) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = "1";
  process.env[ALLOWLIST] = ORG_A;
  demoResetCredentialRenewals();
  demoSetEmployeeHold("", null);
});
afterEach(() => {
  for (const k of [FLAG, ALLOWLIST, REQUIRED] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    demoSetEmployeeHold("cleanup", null);
    demoSetOrgHold(ORG_A, null);
  } catch {
    /* demo_only when not demo — ignore */
  }
});

describe("registry (R-now)", () => {
  test("name, always_human / approvalClass admin, admin.policy audit, every plan, not employee MCP", async () => {
    expect(CREDENTIAL_AUTO_RENEW_ADMIN_TOOL).toBe(TOOL);
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(TOOL)).toBe(true);
    const def = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!;
    expect(def.approvalClass).toBe("admin");
    expect(def.description).toContain("always_human");
    expect(def.description).toMatch(/鍵は|secret|key/i);
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

  test("schema: employeeId (+ reason / jobId / approvalId), no orgId, reason is now only", () => {
    const schema = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["approvalId", "employeeId", "jobId", "reason"]);
    expect(schema.required).toEqual(["employeeId"]);
    expect(schema.additionalProperties).toBe(false);
    const reason = schema.properties.reason as { enum?: string[] };
    expect(reason.enum).toEqual(["now"]);
  });

  test("tools/list hides the tool unless the org is allowed; flag OFF hides it", () => {
    expect(listAdminMcpToolsForOrg(ORG_A).some((t) => t.name === TOOL)).toBe(true);
    expect(listAdminMcpToolsForOrg(ORG_B).some((t) => t.name === TOOL)).toBe(false);
    expect(listAdminMcpToolsForOrg(null).some((t) => t.name === TOOL)).toBe(false);
    delete process.env[FLAG];
    expect(listAdminMcpToolsForOrg(ORG_A).some((t) => t.name === TOOL)).toBe(false);
  });
});

describe("flag / allowlist OFF (default)", () => {
  test("global OFF → feature_disabled, no ticket, no renewal row", async () => {
    delete process.env[FLAG];
    const emp = newEmployee(ORG_A);
    const before = (await listApprovals(ORG_A)).length;
    const res = await proposeMcp(emp.id);
    expect(res.code).toBe("feature_disabled");
    expect((await listApprovals(ORG_A)).length).toBe(before);
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toBeNull();
  });

  test("global ON + other org → feature_disabled (allowlist contents not echoed)", async () => {
    const emp = newEmployee(ORG_B);
    const res = await proposeMcp(emp.id, cred(ORG_B));
    expect(res.code).toBe("feature_disabled");
    expect(JSON.stringify(res)).not.toContain(ORG_A);
    expect(JSON.stringify(res)).not.toMatch(SECRETISH);
  });
});

describe("propose (今すぐ更新)", () => {
  test("unlimited credential is allowed; ticket is always_human; no secret", async () => {
    const emp = newEmployee(ORG_A, { credentialExpiresAt: null });
    const q = await proposeMcp(emp.id);
    expect(q).toMatchObject({ code: "needs_approval", always_human: true, tool: TOOL });
    expect(String(q.summary)).toContain("無期限");
    expect(String(q.summary)).toContain("90");
    expect(JSON.stringify(q)).not.toMatch(SECRETISH);
    const approval = (await getApprovalById(String(q.approvalId), ORG_A))!;
    expect(approval.metadata.adminMutation).toEqual({ employeeId: emp.id, reason: "now" });
    expect(approval.summary).toContain("更新");
    expect(JSON.stringify(approval)).not.toMatch(SECRETISH);
    const open = await findOpenCredentialRenewal(ORG_A, emp.id);
    expect(open).toMatchObject({ threshold: "now", state: "pending_approval", employeeId: emp.id, orgId: ORG_A });
    expect(JSON.stringify(open)).not.toMatch(SECRETISH);
  });

  test("web proposeCredentialAutoRenewNow files the same ticket (source=web)", async () => {
    const emp = newEmployee(ORG_A, { credentialExpiresAt: null });
    const r = await proposeCredentialAutoRenewNow({
      orgId: ORG_A,
      employeeId: emp.id,
      source: "web",
      actor: { memberId: HUMAN.memberId, email: HUMAN.email },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.approvalId).toBeTruthy();
    expect(r.nextStepJa).toContain("Slack");
    expect(JSON.stringify(r)).not.toMatch(SECRETISH);
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toMatchObject({ threshold: "now", state: "pending_approval" });
  });

  test("BOLA: another org's employee → employee_not_found", async () => {
    const other = newEmployee(ORG_B);
    const before = (await listApprovals(ORG_A)).length;
    expect((await proposeMcp(other.id)).code).toBe("employee_not_found");
    expect((await listApprovals(ORG_A)).length).toBe(before);
  });

  test("suspended / revoked / hold / unreadable hold / already_pending", async () => {
    const suspended = newEmployee(ORG_A, { status: "suspended" });
    expect((await proposeMcp(suspended.id)).code).toBe("employee_terminated");

    const revoked = newEmployee(ORG_A);
    const { revokeBinding } = await import("@/lib/data/bindings");
    await revokeBinding(revoked.id, ORG_A);
    expect((await proposeMcp(revoked.id)).code).toBe("revoked");

    const held = newEmployee(ORG_A);
    demoSetEmployeeHold(held.id, { kind: "leave", holdId: "hold_leave_ar" });
    expect((await proposeMcp(held.id)).code).toBe("held");
    demoSetEmployeeHold(held.id, null);

    const stopped = newEmployee(ORG_A);
    demoSetEmployeeHold(stopped.id, { kind: "stopped", holdId: "hold_stop_ar" });
    expect((await proposeMcp(stopped.id)).code).toBe("held");
    demoSetEmployeeHold(stopped.id, null);

    const first = newEmployee(ORG_A);
    expect((await proposeMcp(first.id)).code).toBe("needs_approval");
    expect((await proposeMcp(first.id)).code).toBe("already_pending");
  });

  test("admin agent cannot target its own bound badge; unknown / secret args refused", async () => {
    const emp = newEmployee(ORG_A);
    const { linkAgent } = await import("@/lib/data/bindings");
    await linkAgent(emp.id, { orgId: ORG_A, grokBotAgentId: ADMIN_GROK, grokBotWorkspaceId: null });
    expect((await proposeMcp(emp.id)).code).toBe("cannot_target_self");
    const ok = newEmployee(ORG_A);
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, orgId: ORG_B }, cred())).code).toBe("unexpected_argument");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, reason: "7d" }, cred())).code).toBe("invalid_reason");
  });
});

describe("self-approval / AI resolver / approver class", () => {
  test("requesting admin agent cannot approve; AI resolver is refused", async () => {
    const emp = newEmployee(ORG_A);
    const c = cred();
    const q = await proposeMcp(emp.id, c);
    let denied = false;
    try {
      await resolveApproval(String(q.approvalId), "approved", c.actorId, ORG_A, {
        grokBotAgentId: c.grokBotAgentId,
        actorId: c.actorId,
      });
    } catch (e) {
      denied = e instanceof Error && e.message === SELF_APPROVAL_DENIED;
    }
    expect(denied).toBe(true);
  });

  test("approver authority: same as reissue (standard; money / unknown → owner)", async () => {
    expect(isApproverAuthorityTargetTool(TOOL)).toBe(true);
    const mutation = { adminMutation: { employeeId: "emp_x", reason: "now" } };
    expect(classifyApproverRequirement({ tool: TOOL, metadata: mutation, context: { currentEmployeeScopes: ["tools:read"] } })?.kind).toBe(
      "owner_or_designated_admin"
    );
    expect(classifyApproverRequirement({ tool: TOOL, metadata: mutation, context: { currentEmployeeScopes: ["commerce:order"] } })).toMatchObject({
      kind: "owner",
      reasons: ["employee_has_money_scope"],
    });
    expect(classifyApproverRequirement({ tool: TOOL, metadata: mutation, context: null })).toMatchObject({
      kind: "owner",
      reasons: ["money_scope_unverified"],
    });
    const emp = newEmployee(ORG_A, { scopes: ["commerce:order"] });
    const ctx = await loadApproverClassificationContext(ORG_A, TOOL, { adminMutation: { employeeId: emp.id } });
    expect(ctx?.currentEmployeeScopes).toContain("commerce:order");
  });
});

describe("fulfil: authorize claimable window, mint nothing", () => {
  test("approval opens a 24h claimable window; no secret; Slack copy is 更新しますか", async () => {
    const emp = newEmployee(ORG_A, { credentialExpiresAt: null });
    const q = await proposeMcp(emp.id);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    const genBefore = getBinding(emp.id)?.credentialGeneration;
    const approval = await approve(String(q.approvalId));
    const f = await fulfillApprovedAdmin(approval);
    expect(f?.ok).toBe(true);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect(getBinding(emp.id)?.credentialGeneration).toBe(genBefore);
    const open = await findOpenCredentialRenewal(ORG_A, emp.id);
    expect(open?.state).toBe("claimable");
    expect(open?.claimableUntil).toBeTruthy();
    const until = Date.parse(String(open?.claimableUntil));
    expect(until - Date.now()).toBeGreaterThan(CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS - 5_000);
    expect(until - Date.now()).toBeLessThan(CREDENTIAL_AUTO_RENEW_CLAIM_WINDOW_MS + 5_000);
    const stored = (await getApprovalById(String(q.approvalId), ORG_A))!;
    const parsed = parseAdminFulfillment(stored.metadata)!;
    expect(String(parsed.nextStepJa)).toMatch(/鍵|起動スクリプト|受け取り/);
    expect(JSON.stringify(parsed)).not.toMatch(SECRETISH);
    const forAi = await readApprovedAdminResult(cred(), String(q.approvalId));
    expect(JSON.stringify(forAi)).not.toMatch(SECRETISH);
    expect(JSON.stringify(forAi)).not.toContain("claim_token");
  });

  test("hold after propose → fulfil refuses, no claimable row", async () => {
    const emp = newEmployee(ORG_A);
    const q = await proposeMcp(emp.id);
    demoSetEmployeeHold(emp.id, { kind: "stopped", holdId: "hold_after" });
    const f = await fulfillApprovedAdmin(await approve(String(q.approvalId)));
    expect(f).toMatchObject({ ok: false, error: "held" });
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toMatchObject({ state: "pending_approval" });
    demoSetEmployeeHold(emp.id, null);
  });

  test("audit proposed / approved carry ids only", async () => {
    const emp = newEmployee(ORG_A);
    const q = await proposeMcp(emp.id);
    await fulfillApprovedAdmin(await approve(String(q.approvalId)));
    const proposed = getRuntimeAudit().find((e) => e.action === "credential.renew_proposed" && e.metadata?.approvalId === q.approvalId);
    expect(proposed).toBeDefined();
    expect(proposed!.metadata).toMatchObject({ threshold: "now", source: "admin_mcp", employeeId: emp.id });
    expect(JSON.stringify(proposed)).not.toMatch(SECRETISH);
    const approved = getRuntimeAudit().find((e) => e.action === "credential.renew_approved" && e.metadata?.approvalId === q.approvalId);
    expect(approved).toBeDefined();
    expect(JSON.stringify(approved)).not.toMatch(SECRETISH);
  });
});

describe("M-A: reject / expire then re-file the same badge × now", () => {
  test("Slack reject marks rejected; same old credential × now can re-file; old approval_id cannot open the window", async () => {
    const emp = newEmployee(ORG_A);
    const first = await proposeMcp(emp.id);
    expect(first.code).toBe("needs_approval");
    const oldApprovalId = String(first.approvalId);
    const original = await findOpenCredentialRenewal(ORG_A, emp.id);
    expect(original).toMatchObject({ state: "pending_approval", approvalId: oldApprovalId });
    const rejected = await resolveApproval(oldApprovalId, "rejected", HUMAN.email, ORG_A, { actorId: HUMAN.memberId });
    expect(rejected?.status).toBe("rejected");
    await expireStaleCredentialRenewals({ orgId: ORG_A });
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toBeNull();
    expect(demoListCredentialRenewals().find((r) => r.id === original?.id)?.state).toBe("rejected");

    const second = await proposeMcp(emp.id);
    expect(second.code).toBe("needs_approval");
    expect(String(second.approvalId)).not.toBe(oldApprovalId);
    const reused = await findOpenCredentialRenewal(ORG_A, emp.id);
    expect(reused).toMatchObject({
      id: original?.id,
      state: "pending_approval",
      approvalId: String(second.approvalId),
      oldCredentialId: emp.credentialId,
      threshold: "now",
    });
    const openedWithOld = await markCredentialRenewalClaimable({
      orgId: ORG_A,
      employeeId: emp.id,
      approvalId: oldApprovalId,
      claimableUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(openedWithOld).toBeNull();
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toMatchObject({
      state: "pending_approval",
      approvalId: String(second.approvalId),
    });
  });

  test("expired approval ticket marks expired; same old credential × now can re-file", async () => {
    const emp = newEmployee(ORG_A);
    const first = await proposeMcp(emp.id);
    expect(first.code).toBe("needs_approval");
    const oldApprovalId = String(first.approvalId);
    const original = await findOpenCredentialRenewal(ORG_A, emp.id);
    const closed = await closeApprovalWithoutSend({
      approval: { id: oldApprovalId, orgId: ORG_A },
      from: ["pending"],
      to: "expired",
      meta: { reason: "approval_ttl_elapsed" },
    });
    expect(closed?.status).toBe("expired");
    await expireStaleCredentialRenewals({ orgId: ORG_A });
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toBeNull();
    expect(demoListCredentialRenewals().find((r) => r.id === original?.id)?.state).toBe("expired");

    const second = await proposeMcp(emp.id);
    expect(second.code).toBe("needs_approval");
    expect(String(second.approvalId)).not.toBe(oldApprovalId);
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toMatchObject({
      id: original?.id,
      state: "pending_approval",
      approvalId: String(second.approvalId),
    });
    const openedWithOld = await markCredentialRenewalClaimable({
      orgId: ORG_A,
      employeeId: emp.id,
      approvalId: oldApprovalId,
      claimableUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(openedWithOld).toBeNull();
  });
});

describe("L-C: MCP filing failure after the ticket is queued", () => {
  test("renewal INSERT/reuse failure returns already_pending and invalidates the new ticket", async () => {
    const emp = newEmployee(ORG_A);
    const first = await proposeMcp(emp.id);
    expect(first.code).toBe("needs_approval");
    const open = await findOpenCredentialRenewal(ORG_A, emp.id);
    expect(open).toBeTruthy();
    demoPatchCredentialRenewal(open!.id, { state: "old_revoked" });
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toBeNull();
    const pendingBefore = (await listApprovals(ORG_A)).filter(
      (a) => a.employeeId === emp.id && a.tool === TOOL && a.status === "pending"
    );
    const second = await proposeMcp(emp.id);
    expect(second.code).toBe("already_pending");
    expect(second.needs_approval).not.toBe(true);
    expect(second.approvalId).toBeUndefined();
    const pendingAfter = (await listApprovals(ORG_A)).filter(
      (a) => a.employeeId === emp.id && a.tool === TOOL && a.status === "pending"
    );
    expect(pendingAfter.map((a) => a.id).sort()).toEqual(pendingBefore.map((a) => a.id).sort());
  });
});

describe("L2/L4 expire stale claimable / stuck claimed", () => {
  test("expired claimable becomes expired; open finder then returns null", async () => {
    const emp = newEmployee(ORG_A);
    const q = await proposeMcp(emp.id);
    await fulfillApprovedAdmin(await approve(String(q.approvalId)));
    const open = await findOpenCredentialRenewal(ORG_A, emp.id);
    expect(open?.state).toBe("claimable");
    const n = await expireStaleCredentialRenewals({
      orgId: ORG_A,
      now: new Date(Date.parse(String(open?.claimableUntil)) + 1000),
    });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await findOpenCredentialRenewal(ORG_A, emp.id)).toBeNull();
  });
});

describe("sources do not leak secrets or tenant ids", () => {
  test("R-now production sources have no スペースツリー / 稲盛 / gb_emp_ literals", () => {
    const files = [
      "lib/employees/credential-auto-renew.ts",
      "lib/data/credential-renewals.ts",
      "app/api/employees/[id]/renew/route.ts",
      "components/employees/BindingPanel.tsx",
    ];
    for (const f of files) {
      const text = readFileSync(resolve(f), "utf8");
      expect(text).not.toContain("6d134a38-a0ab-4a8e-aba7-3202650ff523");
      expect(text.toLowerCase()).not.toContain("9a795dfd");
      expect(text).not.toMatch(/gb_emp_[0-9a-f]{8}_[0-9a-f]+/i);
    }
  });
});
