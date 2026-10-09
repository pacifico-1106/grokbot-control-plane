/**
 * 木村 2026-10-05 #284 decision 4: every write of project_access.projectIds
 * must name projects of the SAME org as the employee being written. Any id
 * that is not (another org's, unknown, deleted, moved) → refused, nothing
 * written, ONE audit row with IDs only, Japanese nextStep. Admin MCP queue:
 * checked at filing and again at fulfil. Demo mode, no network.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ApprovalRequest, OrgProject } from "@/lib/types";

const { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees, getRuntimeApprovals } = await import("@/lib/demo-data");

const realSession = await import("@/lib/auth/session");
const realDemoActor = await import("@/lib/team/demo-actor");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getCurrentOrgId: async () => DEMO_ORG.id,
  getSessionContext: async () => ({ demo: true, userId: null, email: "owner@example.com", orgId: DEMO_ORG.id, member: null }),
}));
mock.module("@/lib/team/demo-actor", () => ({
  ...realDemoActor,
  requireCapability: async () => ({
    ok: true as const,
    actor: { id: "mem_1", orgId: DEMO_ORG.id, email: "owner@example.com", displayName: "山田 太郎", role: "owner",
      jobRole: "owner", capabilities: ["hire_issue_credentials"], status: "active" },
  }),
}));

const { POST: issuePost } = await import("@/app/api/employees/issue/route");
const { PATCH: policyPatch } = await import("@/app/api/employees/[id]/policy/route");
const { issueEmployee, updateEmployeePolicy, getEmployee } = await import("@/lib/data/employees");
const { upsertOrgProject, deleteOrgProject, DEMO_PROJECT_A_ID } = await import("@/lib/data/projects");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");

const OTHER_ORG = "00000000-0000-4000-8000-0000000bb0b1";
const AUDIT_ACTION = "employee.project_access_refused";
const CODE = "project_access_cross_org";

const otherOrgProject = await upsertOrgProject({ orgId: OTHER_ORG, name: `他社案件 ${Date.now()}` });
async function ownProject(): Promise<OrgProject> {
  return upsertOrgProject({ orgId: DEMO_ORG.id, name: `自社案件 ${Date.now()} ${Math.random().toString(36).slice(2, 6)}` });
}
const selected = (...projectIds: string[]) => ({ mode: "selected", projectIds });
const refusals = () => getRuntimeAudit().filter((e) => e.action === AUDIT_ACTION);
/** Refusal rows written since `before` (a count taken earlier); order-independent. */
let seen = new Set<unknown>();
const snapshotRefusals = () => { seen = new Set(refusals()); return seen.size; };
const newRefusals = () => refusals().filter((e) => !seen.has(e));

function issueReq(projectAccess: unknown, name = `PA ${Math.random().toString(36).slice(2, 8)}`) {
  return issuePost(new Request("https://x.invalid/api/employees/issue", {
    method: "POST",
    body: JSON.stringify({ displayName: name, roleLabel: "テスト", scopes: ["mail:draft"], projectAccess }),
  }));
}
async function newEmployee() {
  const r = await issueEmployee({
    orgId: DEMO_ORG.id, displayName: `PA対象 ${Math.random().toString(36).slice(2, 8)}`, roleLabel: "テスト",
    scopes: ["mail:draft"], allowedPurposes: [], approvalPolicy: "risk_based", spend: null, allowedAccounts: [],
    secretHash: "b".repeat(64), secretPrefix: "gb_emp_pa", expiresAt: null, auditSummary: "pa test",
  });
  return r.employee;
}
function patchReq(id: string, projectAccess: unknown) {
  return policyPatch(
    new Request(`https://x.invalid/api/employees/${id}/policy`, {
      method: "PATCH",
      body: JSON.stringify({ scopes: ["mail:draft"], allowedPurposes: [], approvalPolicy: "risk_based", projectAccess }),
    }),
    { params: Promise.resolve({ id }) }
  );
}
function adminApproval(mutation: Record<string, unknown>): ApprovalRequest {
  return {
    id: `apr_pa_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: "employees.issue", summary: "employees.issue",
    purpose: "admin.employees.issue", risk: "high", tool: "employees.issue", status: "approved", createdAt: new Date().toISOString(),
    metadata: { approvalClass: "admin", adminTool: "employees.issue", adminMutation: mutation },
  } as unknown as ApprovalRequest;
}
function demoCred() {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
  return { orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id,
    generation: agent.credentialGeneration, via: "bearer", agent } as unknown as Parameters<typeof callAdminMcpTool>[2];
}
function expectRefusedBody(body: Record<string, unknown>) {
  expect(body.ok).toBe(false);
  expect(body.code).toBe(CODE);
  expect(String(body.nextStep)).toMatch(/この組織のプロジェクト/);
  expect(String(body.nextStep)).toMatch(/保存していません|発行していません/);
}
function expectOneAuditIdsOnly(before: number, refusedIds: string[], path: string) {
  void before;
  const rows = newRefusals();
  expect(rows).toHaveLength(1);
  const m = rows[0].metadata as Record<string, unknown>;
  expect(m.path).toBe(path);
  expect(m.refusedProjectIds).toEqual(refusedIds);
  // IDs only: no project names, no free text
  expect(JSON.stringify(rows[0])).not.toContain(otherOrgProject.name);
}

describe("web POST /api/employees/issue", () => {
  test("BOLA: another org's project id → 400, nothing issued, one IDs-only audit row", async () => {
    const before = getRuntimeEmployees().length;
    const audits = snapshotRefusals();
    const res = await issueReq(selected(otherOrgProject.id));
    expect(res.status).toBe(400);
    expectRefusedBody(await res.json());
    expect(getRuntimeEmployees().length).toBe(before);
    expectOneAuditIdsOnly(audits, [otherOrgProject.id], "web.employees.issue");
  });
  test("an unknown id → 400, nothing issued", async () => {
    const before = getRuntimeEmployees().length;
    const res = await issueReq(selected("prj_does_not_exist"));
    expect(res.status).toBe(400);
    expectRefusedBody(await res.json());
    expect(getRuntimeEmployees().length).toBe(before);
  });
  test("a mix of valid and invalid ids → refused as a whole, nothing issued; only the bad ids are named", async () => {
    const own = await ownProject();
    const before = getRuntimeEmployees().length;
    const audits = snapshotRefusals();
    const res = await issueReq(selected(own.id, otherOrgProject.id, "prj_unknown_x"));
    expect(res.status).toBe(400);
    expect(getRuntimeEmployees().length).toBe(before);
    expectOneAuditIdsOnly(audits, [otherOrgProject.id, "prj_unknown_x"], "web.employees.issue");
  });
  test("valid same-org ids still work", async () => {
    const own = await ownProject();
    snapshotRefusals();
    const res = await issueReq(selected(DEMO_PROJECT_A_ID, own.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.employee.projectAccess).toEqual(selected(DEMO_PROJECT_A_ID, own.id));
    expect(newRefusals()).toHaveLength(0);
  });
  test("mode company / all ignore projectIds (unchanged behaviour)", async () => {
    const res = await issueReq({ mode: "all", projectIds: [otherOrgProject.id] });
    expect(res.status).toBe(200);
    expect((await res.json()).employee.projectAccess).toEqual({ mode: "all", projectIds: [] });
  });
});

describe("web PATCH /api/employees/[id]/policy", () => {
  test("BOLA / mix → 400, the employee's policy is not touched, one audit row", async () => {
    const emp = await newEmployee();
    const own = await ownProject();
    await updateEmployeePolicy({ orgId: DEMO_ORG.id, employeeId: emp.id, scopes: emp.scopes, allowedPurposes: [],
      approvalPolicy: emp.approvalPolicy, projectAccess: selected(own.id) as never });
    const snapshot = JSON.stringify(await getEmployee(emp.id, DEMO_ORG.id));
    const audits = snapshotRefusals();
    const res = await patchReq(emp.id, selected(own.id, otherOrgProject.id));
    expect(res.status).toBe(400);
    expectRefusedBody(await res.json());
    expect(JSON.stringify(await getEmployee(emp.id, DEMO_ORG.id))).toBe(snapshot);
    expectOneAuditIdsOnly(audits, [otherOrgProject.id], "web.employees.policy");
    expect(newRefusals()[0].employeeId).toBe(emp.id);
  });
  test("valid same-org ids still save", async () => {
    const emp = await newEmployee();
    const own = await ownProject();
    const res = await patchReq(emp.id, selected(own.id));
    expect(res.status).toBe(200);
    expect((await getEmployee(emp.id, DEMO_ORG.id))?.projectAccess).toEqual(selected(own.id));
  });
});

describe("data writers refuse on their own (defence in depth for any caller)", () => {
  test("issueEmployee / updateEmployeePolicy throw before writing", async () => {
    const before = getRuntimeEmployees().length;
    const issued = await issueEmployee({
      orgId: DEMO_ORG.id, displayName: "直書き", roleLabel: "テスト", scopes: ["mail:draft"], allowedPurposes: [],
      approvalPolicy: "risk_based", spend: null, allowedAccounts: [], projectAccess: selected(otherOrgProject.id) as never,
      secretHash: "c".repeat(64), secretPrefix: "gb_emp_pa2", expiresAt: null, auditSummary: "t",
    }).then(() => null, (e: unknown) => e as { code?: string });
    expect(issued?.code).toBe(CODE);
    expect(getRuntimeEmployees().length).toBe(before);
    const emp = await newEmployee();
    const updated = await updateEmployeePolicy({ orgId: DEMO_ORG.id, employeeId: emp.id, scopes: emp.scopes,
      allowedPurposes: [], approvalPolicy: emp.approvalPolicy, projectAccess: selected(otherOrgProject.id) as never,
    }).then(() => null, (e: unknown) => e as { code?: string });
    expect(updated?.code).toBe(CODE);
    expect((await getEmployee(emp.id, DEMO_ORG.id))?.projectAccess).toEqual({ mode: "company", projectIds: [] });
  });
});

describe("Admin MCP employees.issue: checked at filing and at fulfil", () => {
  test("filing: another org's id → refused, no approval queued, one audit row", async () => {
    const approvals = getRuntimeApprovals().length;
    const audits = snapshotRefusals();
    const r = await callAdminMcpTool("employees.issue", {
      displayName: "MCP他社", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(otherOrgProject.id),
    }, demoCred());
    expect(r.isError).toBe(true);
    expectRefusedBody(r.structuredContent as Record<string, unknown>);
    expect(getRuntimeApprovals().length).toBe(approvals);
    expectOneAuditIdsOnly(audits, [otherOrgProject.id], "admin_mcp.employees.issue");
    expect((newRefusals()[0].metadata as Record<string, unknown>).phase).toBe("file");
  });
  test("filing: valid same-org ids → queued for approval as today", async () => {
    const own = await ownProject();
    const r = await callAdminMcpTool("employees.issue", {
      displayName: "MCP自社", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(own.id),
    }, demoCred());
    expect((r.structuredContent as Record<string, unknown>).needs_approval).toBe(true);
  });
  test("fulfil: the project was deleted after filing → not issued, nextStepJa, audit (phase fulfil)", async () => {
    const own = await ownProject();
    expect(await deleteOrgProject(DEMO_ORG.id, own.id)).toBe(true);
    const before = getRuntimeEmployees().length;
    const audits = snapshotRefusals();
    const approval = adminApproval({ displayName: "削除後", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(own.id) });
    const r = await fulfillApprovedAdmin(approval);
    expect(r?.ok).toBe(false);
    expect(r?.error).toBe(CODE);
    expect(String(r?.nextStepJa)).toMatch(/この組織のプロジェクト/);
    expect(getRuntimeEmployees().length).toBe(before);
    expectOneAuditIdsOnly(audits, [own.id], "admin_mcp.employees.issue");
    const m = newRefusals()[0].metadata as Record<string, unknown>;
    expect(m.phase).toBe("fulfil");
    expect(m.approvalId).toBe(approval.id);
  });
  test("fulfil: the project moved to another org after filing → not issued", async () => {
    const own = await ownProject();
    own.orgId = OTHER_ORG; // demo row moved
    const before = getRuntimeEmployees().length;
    const r = await fulfillApprovedAdmin(adminApproval({ displayName: "移動後", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(own.id) }));
    expect(r?.ok).toBe(false);
    expect(r?.error).toBe(CODE);
    expect(getRuntimeEmployees().length).toBe(before);
  });
  test("fulfil: valid same-org ids → issued with that access", async () => {
    const own = await ownProject();
    const r = await fulfillApprovedAdmin(adminApproval({ displayName: "正常", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(own.id) }));
    expect(r?.ok).toBe(true);
    expect((await getEmployee(String(r?.employeeId), DEMO_ORG.id))?.projectAccess).toEqual(selected(own.id));
  });
});

// 木村 2026-10-09 (#296 follow-up): the nextStep lists the ids to remove, and
// never a project name (another org's names must not leak).
describe("nextStep lists the refused project IDs (IDs only, never names)", () => {
  const PHRASE = "これらのプロジェクト ID を除いて保存し直してください";
  test("web issue: refused ids in nextStep, the valid one and every name absent", async () => {
    const own = await ownProject();
    const res = await issueReq(selected(own.id, otherOrgProject.id, "prj_unknown_ns"));
    expect(res.status).toBe(400);
    const body = await res.json();
    const nextStep = String(body.nextStep);
    expect(nextStep).toContain(PHRASE);
    expect(nextStep).toContain(otherOrgProject.id);
    expect(nextStep).toContain("prj_unknown_ns");
    expect(nextStep).not.toContain(own.id);
    const whole = JSON.stringify(body);
    expect(whole).not.toContain(otherOrgProject.name);
    expect(whole).not.toContain(own.name);
  });
  test("policy PATCH and Admin MCP filing / fulfil: same", async () => {
    const emp = await newEmployee();
    const patched = await (await patchReq(emp.id, selected(otherOrgProject.id))).json();
    expect(String(patched.nextStep)).toContain(PHRASE);
    expect(String(patched.nextStep)).toContain(otherOrgProject.id);
    expect(JSON.stringify(patched)).not.toContain(otherOrgProject.name);
    const filed = await callAdminMcpTool("employees.issue", {
      displayName: "MCP名なし", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(otherOrgProject.id),
    }, demoCred());
    const d = filed.structuredContent as Record<string, unknown>;
    expect(String(d.nextStep)).toContain(PHRASE);
    expect(String(d.nextStep)).toContain(otherOrgProject.id);
    expect(JSON.stringify(filed)).not.toContain(otherOrgProject.name);
    const gone = await ownProject();
    await deleteOrgProject(DEMO_ORG.id, gone.id);
    const f = await fulfillApprovedAdmin(adminApproval({ displayName: "名なし", roleLabel: "テスト", scopes: ["mail:draft"], projectAccess: selected(gone.id) }));
    expect(String(f?.nextStepJa)).toContain(PHRASE);
    expect(String(f?.nextStepJa)).toContain(gone.id);
    expect(JSON.stringify(f)).not.toContain(gone.name);
  });
});

// 木村 2026-10-09 #296 follow-ups.
// (1) information_assets.project_id from web settings/directory: same org only.
// (3) policy.patch never applies projectAccess.
const { PUT: directoryPut } = await import("@/app/api/settings/directory/route");
const { upsertInformationAsset, getInformationAsset } = await import("@/lib/data/directory");
const ASSET_AUDIT_ACTION = "information_asset.project_refused";
const assetRefusals = () => getRuntimeAudit().filter((e) => e.action === ASSET_AUDIT_ACTION);
function assetReq(body: Record<string, unknown>) {
  return directoryPut(new Request("https://x.invalid/api/settings/directory", {
    method: "PUT", body: JSON.stringify({ record: "asset", class: "internal", ...body }),
  }));
}
const assetRef = () => `asset-${Math.random().toString(36).slice(2, 10)}`;

describe("web PUT /api/settings/directory asset: project_id must be a project of this org", () => {
  const PHRASE = "これらのプロジェクト ID を除いて保存し直してください";
  test("BOLA: another org's project id → 400, asset not written, one IDs-only audit row, nextStep lists the id", async () => {
    const ref = assetRef();
    const before = new Set(assetRefusals());
    const res = await assetReq({ ref, projectId: otherOrgProject.id });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(CODE);
    expect(String(body.nextStep)).toContain(PHRASE);
    expect(String(body.nextStep)).toContain(otherOrgProject.id);
    expect(JSON.stringify(body)).not.toContain(otherOrgProject.name);
    expect(await getInformationAsset(DEMO_ORG.id, ref)).toBeNull();
    const rows = assetRefusals().filter((e) => !before.has(e));
    expect(rows).toHaveLength(1);
    const m = rows[0].metadata as Record<string, unknown>;
    expect(m.path).toBe("web.settings.directory");
    expect(m.refusedProjectIds).toEqual([otherOrgProject.id]);
    expect(m.assetRef).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain(otherOrgProject.name);
    expect(JSON.stringify(rows[0])).not.toContain(ref);
  });
  test("an unknown id → 400; an existing asset keeps its project and class", async () => {
    const own = await ownProject();
    const ref = assetRef();
    expect((await assetReq({ ref, projectId: own.id })).status).toBe(200);
    const res = await assetReq({ ref, projectId: "prj_unknown_asset", class: "public" });
    expect(res.status).toBe(400);
    const kept = await getInformationAsset(DEMO_ORG.id, ref);
    expect(kept?.projectId).toBe(own.id);
    expect(kept?.class).toBe("internal");
  });
  test("valid same-org id saves; null clears; omitted leaves it (unchanged behaviour)", async () => {
    const own = await ownProject();
    const ref = assetRef();
    expect((await assetReq({ ref, projectId: own.id })).status).toBe(200);
    expect((await getInformationAsset(DEMO_ORG.id, ref))?.projectId).toBe(own.id);
    expect((await assetReq({ ref, class: "public" })).status).toBe(200);
    expect((await getInformationAsset(DEMO_ORG.id, ref))?.projectId).toBe(own.id);
    expect((await assetReq({ ref, projectId: null })).status).toBe(200);
    expect((await getInformationAsset(DEMO_ORG.id, ref))?.projectId).toBeNull();
  });
  test("data writer refuses on its own (any caller)", async () => {
    const ref = assetRef();
    const e = await upsertInformationAsset({ orgId: DEMO_ORG.id, ref, class: "internal", projectId: otherOrgProject.id })
      .then(() => null, (x: unknown) => x as { code?: string });
    expect(e?.code).toBe(CODE);
    expect(await getInformationAsset(DEMO_ORG.id, ref)).toBeNull();
  });
});

describe("policy.patch never applies projectAccess (pinned)", () => {
  function policyPatchApproval(mutation: Record<string, unknown>): ApprovalRequest {
    return {
      id: `apr_pp_${Math.random().toString(36).slice(2, 8)}`,
      orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: "policy.patch", summary: "policy.patch",
      purpose: "admin.policy.patch", risk: "high", tool: "policy.patch", status: "approved", createdAt: new Date().toISOString(),
      metadata: { approvalClass: "admin", adminTool: "policy.patch", adminMutation: mutation },
    } as unknown as ApprovalRequest;
  }
  test("fulfil: projectAccess in the ticket (widening to all, or another org's id) is ignored; no project check runs", async () => {
    const emp = await newEmployee();
    const own = await ownProject();
    await updateEmployeePolicy({ orgId: DEMO_ORG.id, employeeId: emp.id, scopes: emp.scopes, allowedPurposes: [],
      approvalPolicy: emp.approvalPolicy, projectAccess: selected(own.id) as never });
    for (const projectAccess of [{ mode: "all", projectIds: [] }, selected(otherOrgProject.id)]) {
      snapshotRefusals();
      const r = await fulfillApprovedAdmin(policyPatchApproval({
        employeeId: emp.id, scopes: ["mail:draft", "tools:read"], allowedPurposes: [], approvalPolicy: "risk_based", projectAccess,
      }));
      expect(r?.ok).toBe(true);
      const after = await getEmployee(emp.id, DEMO_ORG.id);
      expect(after?.scopes).toContain("tools:read");
      expect(after?.projectAccess).toEqual(selected(own.id));
      expect(newRefusals()).toHaveLength(0);
    }
  });
});
