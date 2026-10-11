/**
 * #295 × #296 merge (木村 2026-10-10, step e): both refusals on the issue paths
 * survive the merge — a cross-org projectAccess (#296) and a non-member
 * approvalNotifyEmail (#295). Web route (pre-check + the catch clause for
 * errors thrown inside issueEmployee), Admin MCP employees.issue filing
 * (projectAccess check first, then approvalNotifyEmail), and fulfil.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ApprovalRequest, OrgMember } from "@/lib/types";
import { scopedModuleMocks } from "@/tests/helpers/scoped-module-mock";

// Members lookup: after `dropMemberAfter` calls, MEMBER_EMAIL is no longer a
// member (removed between the route's pre-check and the writer's re-check), so
// the writer throws ApprovalNotifyEmailError and the route's catch maps it.
let dropMemberAfter: number | null = null;
let memberCalls = 0;
const mocks = scopedModuleMocks();
const realMembers = { ...(await import("@/lib/data/members")) };
await mocks.mock("@/lib/data/members", {
  listMembers: async (orgId?: string | null) => {
    const rows = (await realMembers.listMembers(orgId)) as OrgMember[];
    if (dropMemberAfter !== null && memberCalls++ >= dropMemberAfter) return rows.filter((m) => m.email !== MEMBER_EMAIL);
    return rows;
  },
});

const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");

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
const { issueEmployee } = await import("@/lib/data/employees");
const { upsertOrgProject } = await import("@/lib/data/projects");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { ProjectAccessOrgError } = await import("@/lib/employees/project-access-org");
const { ApprovalNotifyEmailError } = await import("@/lib/employees/approval-notify-email");

const OTHER_ORG = "00000000-0000-4000-8000-0000000bb0b2";
const PA_CODE = "project_access_cross_org";
const ANE_CODE = "approval_notify_email_not_member";
const MEMBER_EMAIL = "accounting@example.com";
const NON_MEMBER = "someone@not-a-member.example";

const otherOrgProject = await upsertOrgProject({ orgId: OTHER_ORG, name: `他社案件 both ${Date.now()}` });
const ownProject = await upsertOrgProject({ orgId: DEMO_ORG.id, name: `自社案件 both ${Date.now()}` });
const crossOrg = { mode: "selected", projectIds: [otherOrgProject.id] };
const sameOrg = { mode: "selected", projectIds: [ownProject.id] };
const base = () => ({ displayName: `BOTH ${Math.random().toString(36).slice(2, 8)}`, roleLabel: "テスト", scopes: ["mail:draft"] });

const web = (extra: Record<string, unknown>) =>
  issuePost(new Request("https://x.invalid/api/employees/issue", { method: "POST", body: JSON.stringify({ ...base(), ...extra }) }));
function demoCred() {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_both", status: "linked" });
  return { orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id,
    generation: agent.credentialGeneration, via: "bearer", agent } as unknown as Parameters<typeof callAdminMcpTool>[2];
}
function toolJson(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
  return { ...JSON.parse(r.content?.[0]?.text ?? "{}"), __isError: r.isError === true };
}
const file = async (extra: Record<string, unknown>) => toolJson(await callAdminMcpTool("employees.issue", { ...base(), ...extra }, demoCred()));
function adminApproval(mutation: Record<string, unknown>): ApprovalRequest {
  return {
    id: `apr_both_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: "employees.issue", summary: "employees.issue",
    purpose: "admin.employees.issue", risk: "high", tool: "employees.issue", status: "approved", createdAt: new Date().toISOString(),
    metadata: { approvalClass: "admin", adminTool: "employees.issue", adminMutation: mutation },
  } as unknown as ApprovalRequest;
}
const writerInput = (extra: Record<string, unknown>) => ({
  orgId: DEMO_ORG.id, ...base(), allowedPurposes: [], approvalPolicy: "risk_based" as const, spend: null, allowedAccounts: [],
  secretHash: "c".repeat(64), secretPrefix: "gb_emp_bt", expiresAt: null, auditSummary: "both test", ...extra,
}) as unknown as Parameters<typeof issueEmployee>[0];

describe("web POST /api/employees/issue: both refusals fire, nothing issued", () => {
  test("cross-org projectAccess (member address) → 400 project_access_cross_org", async () => {
    const before = getRuntimeEmployees().length;
    const res = await web({ projectAccess: crossOrg, approvalNotifyEmail: MEMBER_EMAIL });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(PA_CODE);
    expect(getRuntimeEmployees().length).toBe(before);
  });
  test("non-member approvalNotifyEmail (same-org projectAccess) → 400 approval_notify_email_not_member", async () => {
    const before = getRuntimeEmployees().length;
    const res = await web({ projectAccess: sameOrg, approvalNotifyEmail: NON_MEMBER });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code ?? body.error).toBe(ANE_CODE);
    expect(getRuntimeEmployees().length).toBe(before);
  });
  test("control: same-org projectAccess + member address → issued", async () => {
    const res = await web({ projectAccess: sameOrg, approvalNotifyEmail: MEMBER_EMAIL });
    expect(res.status).toBe(200);
  });
});

describe("web route catch clause: both branches map errors thrown inside issueEmployee", () => {
  test("member removed after the pre-check → the writer throws ApprovalNotifyEmailError → 400 not_member, nothing issued", async () => {
    const before = getRuntimeEmployees().length;
    dropMemberAfter = 1;
    memberCalls = 0;
    try {
      const res = await web({ projectAccess: sameOrg, approvalNotifyEmail: MEMBER_EMAIL });
      expect(memberCalls).toBeGreaterThanOrEqual(2);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe(ANE_CODE);
      expect(typeof body.message).toBe("string");
    } finally {
      dropMemberAfter = null;
    }
    expect(getRuntimeEmployees().length).toBe(before);
  });
});

describe("data writer issueEmployee (what the route's catch clause maps): both error classes still thrown", () => {
  test("cross-org projectAccess → ProjectAccessOrgError; non-member → ApprovalNotifyEmailError", async () => {
    const before = getRuntimeEmployees().length;
    const pa = await issueEmployee(writerInput({ projectAccess: crossOrg, approvalNotifyEmail: MEMBER_EMAIL })).then(() => null, (e: unknown) => e);
    expect(pa instanceof ProjectAccessOrgError).toBe(true);
    const ane = await issueEmployee(writerInput({ projectAccess: sameOrg, approvalNotifyEmail: NON_MEMBER })).then(() => null, (e: unknown) => e);
    expect(ane instanceof ApprovalNotifyEmailError).toBe(true);
    expect(getRuntimeEmployees().length).toBe(before);
  });
});

describe("Admin MCP employees.issue filing: projectAccess check, then approvalNotifyEmail check", () => {
  test("cross-org projectAccess → refused project_access_cross_org", async () => {
    const r = await file({ projectAccess: crossOrg, approvalNotifyEmail: MEMBER_EMAIL });
    expect(r.__isError).toBe(true);
    expect(r.code).toBe(PA_CODE);
  });
  test("non-member approvalNotifyEmail → refused approval_notify_email_not_member", async () => {
    const r = await file({ projectAccess: sameOrg, approvalNotifyEmail: NON_MEMBER });
    expect(r.__isError).toBe(true);
    expect(r.code).toBe(ANE_CODE);
  });
  test("both bad → the projectAccess refusal comes first", async () => {
    const r = await file({ projectAccess: crossOrg, approvalNotifyEmail: NON_MEMBER });
    expect(r.__isError).toBe(true);
    expect(r.code).toBe(PA_CODE);
  });
  test("control: both valid → filed", async () => {
    const r = await file({ projectAccess: sameOrg, approvalNotifyEmail: MEMBER_EMAIL });
    expect(r.__isError).toBe(false);
  });
});

describe("Admin MCP fulfil: both re-checked, nothing issued", () => {
  for (const [label, extra] of [
    ["cross-org projectAccess", { projectAccess: crossOrg, approvalNotifyEmail: MEMBER_EMAIL }],
    ["non-member approvalNotifyEmail", { projectAccess: sameOrg, approvalNotifyEmail: NON_MEMBER }],
  ] as const) {
    test(label, async () => {
      const before = getRuntimeEmployees().length;
      const r = await fulfillApprovedAdmin(adminApproval({ ...base(), ...extra }))
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      expect((r as { ok?: boolean } | null)?.ok).toBe(false);
      expect(getRuntimeEmployees().length).toBe(before);
    });
  }
});
