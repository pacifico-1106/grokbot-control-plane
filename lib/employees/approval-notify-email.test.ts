/**
 * employee.approvalNotifyEmail — members only (木村 2026-10-05 mail tightening, item 1).
 *
 * - set time: dashboard POST /api/employees/issue, admin MCP employees.issue
 *   (filing AND fulfil) and the data writer issueEmployee all refuse an address
 *   that is not an ACTIVE member of THAT org (case-insensitive).
 * - send time: re-checked; a non-member is not sent to and the audit row
 *   carries IDs only (no address).
 * - body: only "an approval was decided" + a dashboard link (no summary).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ApprovalRequest, Employee, OrgMember } from "@/lib/types";
import { scopedModuleMocks } from "@/tests/helpers/scoped-module-mock";

type Sent = { to: string; subject: string; text?: string; html: string; template: string };
const sent: Sent[] = [];
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/resend", {
  sendTransactionalEmail: async (input: Sent) => {
    sent.push(input);
    return { ok: true, id: "stub_test", stub: true };
  },
});

const {
  DEMO_ORG,
  getRuntimeAudit,
  getRuntimeEmployees,
  getRuntimeMembers,
  resetRuntimeMembers,
  setRuntimeMember,
} = await import("@/lib/demo-data");
const {
  validateApprovalNotifyEmail,
  ApprovalNotifyEmailError,
  buildApprovalNotifyEmail,
} = await import("@/lib/employees/approval-notify-email");
const { issueEmployee } = await import("@/lib/data");
const { POST: issuePost } = await import("@/app/api/employees/issue/route");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { runApprovalResolveSideEffects } = await import("@/lib/approvals/resolve-side-effects");

const OTHER_ORG_MEMBER: OrgMember = {
  id: "mem_ane_other_org",
  orgId: "org_ane_other",
  email: "outsider@other-org.example",
  displayName: "他社の人",
  role: "owner",
  capabilities: [],
  status: "active",
} as OrgMember;

function member(id: string): OrgMember {
  const m = getRuntimeMembers().find((x) => x.id === id);
  if (!m) throw new Error(`missing ${id}`);
  return m;
}

beforeEach(() => {
  resetRuntimeMembers();
  setRuntimeMember(OTHER_ORG_MEMBER);
  sent.length = 0;
});
afterAll(() => resetRuntimeMembers());

const SECRET_SUMMARY = "極秘: 取引先A社へ 980万円 の発注 (summary-marker-7f3)";
function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: `apr_ane_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id,
    employeeId: "emp_sales",
    credentialId: null,
    title: "タイトル-marker-a1",
    summary: SECRET_SUMMARY,
    purpose: "purpose-marker-b2",
    risk: "high",
    tool: "tool-marker-c3",
    status: "approved",
    revisionNote: "revision-marker-d4",
    revisionCount: 0,
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as ApprovalRequest;
}

function employeeWith(email: string | null): Employee {
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_sales")!;
  return { ...emp, approvalNotifyEmail: email, callbackUrl: null };
}

function demoCred() {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_ane", status: "linked" });
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer" as const,
    agent,
  };
}

function toolJson(result: unknown): Record<string, unknown> {
  const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
  return { ...JSON.parse(r.content?.[0]?.text ?? "{}"), __isError: r.isError === true };
}

function adminIssueApproval(mutation: Record<string, unknown>): ApprovalRequest {
  return {
    id: `apr_ane_issue_${Math.random().toString(36).slice(2, 8)}`,
    orgId: DEMO_ORG.id, employeeId: "emp_ops", credentialId: null, title: "employees.issue", summary: "employees.issue",
    purpose: "admin.employees.issue", risk: "high", tool: "employees.issue", status: "approved", createdAt: new Date().toISOString(),
    metadata: { approvalClass: "admin", adminTool: "employees.issue", adminMutation: mutation },
  } as unknown as ApprovalRequest;
}

describe("validateApprovalNotifyEmail (set-time rule)", () => {
  test("an active member's address is accepted; the stored value is the member's own address", async () => {
    const r = await validateApprovalNotifyEmail(DEMO_ORG.id, "sales@example.com");
    expect(r).toEqual({ ok: true, email: member("mem_2").email });
  });

  test("case-insensitive and trimmed", async () => {
    const r = await validateApprovalNotifyEmail(DEMO_ORG.id, "  SALES@Example.COM ");
    expect(r).toEqual({ ok: true, email: "sales@example.com" });
  });

  test("empty / null / undefined → no address (allowed)", async () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(await validateApprovalNotifyEmail(DEMO_ORG.id, v)).toEqual({ ok: true, email: null });
    }
  });

  test("a non-member address is refused", async () => {
    const r = await validateApprovalNotifyEmail(DEMO_ORG.id, "someone@not-a-member.example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("approval_notify_email_not_member");
  });

  test("BOLA: another org's ACTIVE member address is refused", async () => {
    const r = await validateApprovalNotifyEmail(DEMO_ORG.id, OTHER_ORG_MEMBER.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("approval_notify_email_not_member");
  });

  test("removed (disabled) and invited members are refused", async () => {
    setRuntimeMember({ ...member("mem_2"), status: "disabled" } as OrgMember);
    const disabled = await validateApprovalNotifyEmail(DEMO_ORG.id, "sales@example.com");
    expect(disabled.ok).toBe(false);
    setRuntimeMember({ ...member("mem_2"), status: "invited" } as OrgMember);
    const invited = await validateApprovalNotifyEmail(DEMO_ORG.id, "sales@example.com");
    expect(invited.ok).toBe(false);
  });

  test("non-string / malformed / overlong values are refused", async () => {
    for (const v of [42, { email: "sales@example.com" }, ["sales@example.com"], "not-an-email", "a@b", `${"x".repeat(250)}@example.com`, "sales@example.com, evil@x.example"]) {
      const r = await validateApprovalNotifyEmail(DEMO_ORG.id, v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("approval_notify_email_invalid");
    }
  });

  test("no org → refused (fail closed)", async () => {
    const r = await validateApprovalNotifyEmail(null, "sales@example.com");
    expect(r.ok).toBe(false);
  });
});

describe("set time — every write path", () => {
  const base = { displayName: "通知テスト", roleLabel: "テスト", scopes: ["mail:draft"] };

  test("data writer issueEmployee refuses a non-member (defence in depth for any caller)", async () => {
    const before = getRuntimeEmployees().length;
    const thrown = await issueEmployee({
      orgId: DEMO_ORG.id, displayName: "x", roleLabel: "y", scopes: ["mail:draft"], allowedPurposes: [],
      approvalPolicy: "risk_based", spend: null, allowedAccounts: [], approvalNotifyEmail: OTHER_ORG_MEMBER.email,
      secretHash: "a".repeat(64), secretPrefix: "gb_emp_test", expiresAt: null, auditSummary: "t",
    }).then(() => null, (e: unknown) => e);
    expect(thrown instanceof ApprovalNotifyEmailError).toBe(true);
    expect(getRuntimeEmployees().length).toBe(before);
  });

  test("data writer stores the member's canonical address", async () => {
    const r = await issueEmployee({
      orgId: DEMO_ORG.id, displayName: "x", roleLabel: "y", scopes: ["mail:draft"], allowedPurposes: [],
      approvalPolicy: "risk_based", spend: null, allowedAccounts: [], approvalNotifyEmail: " Owner@EXAMPLE.com ",
      secretHash: "b".repeat(64), secretPrefix: "gb_emp_test", expiresAt: null, auditSummary: "t",
    });
    expect(r.employee.approvalNotifyEmail).toBe("owner@example.com");
  });

  test("dashboard POST /api/employees/issue: non-member → 400, nothing issued; member (any case) → stored", async () => {
    const before = getRuntimeEmployees().length;
    const bad = await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST", body: JSON.stringify({ ...base, approvalNotifyEmail: "someone@not-a-member.example" }),
    }));
    expect(bad.status).toBe(400);
    const badBody = await bad.json();
    expect(badBody.code ?? badBody.error).toBe("approval_notify_email_not_member");
    expect(JSON.stringify(badBody)).not.toContain("someone@not-a-member.example");
    expect(getRuntimeEmployees().length).toBe(before);

    const bola = await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST", body: JSON.stringify({ ...base, approvalNotifyEmail: OTHER_ORG_MEMBER.email }),
    }));
    expect(bola.status).toBe(400);

    const ok = await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST", body: JSON.stringify({ ...base, approvalNotifyEmail: "ACCOUNTING@example.com" }),
    }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).employee.approvalNotifyEmail).toBe("accounting@example.com");
  });

  test("dashboard route stays gated: a member without hire_issue_credentials cannot call it", async () => {
    const res = await issuePost(new Request("https://x.invalid/api/employees/issue", {
      method: "POST",
      headers: { "x-member-id": "mem_3" },
      body: JSON.stringify({ ...base, approvalNotifyEmail: "accounting@example.com", actorMemberId: "mem_3" }),
    }));
    expect([401, 403]).toContain(res.status);
  });

  test("admin MCP employees.issue: refused at filing (non-member, other org, non-string); member accepted", async () => {
    for (const v of ["someone@not-a-member.example", OTHER_ORG_MEMBER.email, 123]) {
      const r = toolJson(await callAdminMcpTool("employees.issue", { ...base, approvalNotifyEmail: v }, demoCred()));
      expect(r.__isError).toBe(true);
      expect(String(r.code)).toMatch(/^approval_notify_email_(not_member|invalid)$/);
    }
    const ok = toolJson(await callAdminMcpTool("employees.issue", { ...base, approvalNotifyEmail: "Sales@Example.com" }, demoCred()));
    expect(ok.__isError).toBe(false);
  });

  test("admin MCP employees.issue: re-checked at fulfil (member removed after filing) → not issued", async () => {
    setRuntimeMember({ ...member("mem_2"), status: "disabled" } as OrgMember);
    const before = getRuntimeEmployees().length;
    const r = await fulfillApprovedAdmin(adminIssueApproval({ ...base, approvalNotifyEmail: "sales@example.com" })).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    expect(r?.ok).toBe(false);
    expect(getRuntimeEmployees().length).toBe(before);
  });
});

describe("send time", () => {
  test("active member → sent to the member's address", async () => {
    const res = await runApprovalResolveSideEffects({
      approval: approval(), decision: "approved", actorEmail: "web:owner@example.com", employee: employeeWith("SALES@example.com"),
    });
    expect(res.employeeEmail.ok).toBe(true);
    // (the approver notification to the org owner is a separate mail)
    const mail = sent.find((m) => m.to === "sales@example.com");
    expect(mail).toBeTruthy();
  });

  test("member removed after it was set → not sent; audit row has IDs only", async () => {
    setRuntimeMember({ ...member("mem_2"), status: "disabled" } as OrgMember);
    const a = approval();
    const res = await runApprovalResolveSideEffects({
      approval: a, decision: "approved", actorEmail: "web:owner@example.com", employee: employeeWith("sales@example.com"),
    });
    expect(sent.filter((m) => m.to === "sales@example.com")).toHaveLength(0);
    expect(res.employeeEmail.ok).toBe(false);
    expect(res.employeeEmail.skipped).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === a.id && e.purpose === "approval_notify_email.recipient_not_member");
    expect(row).toBeTruthy();
    expect(row?.metadata?.employeeId).toBe("emp_sales");
    expect(JSON.stringify(row)).not.toContain("@");
  });

  test("saved while an active member, member deactivated before the decision → not sent (end to end)", async () => {
    const issued = await issueEmployee({
      orgId: DEMO_ORG.id, displayName: "通知E2E", roleLabel: "y", scopes: ["mail:draft"], allowedPurposes: [],
      approvalPolicy: "risk_based", spend: null, allowedAccounts: [], approvalNotifyEmail: "Accounting@Example.com",
      secretHash: "c".repeat(64), secretPrefix: "gb_emp_test", expiresAt: null, auditSummary: "t",
    });
    expect(issued.employee.approvalNotifyEmail).toBe("accounting@example.com");
    const acct = getRuntimeMembers().find((m) => m.email === "accounting@example.com")!;
    setRuntimeMember({ ...acct, status: "disabled" } as OrgMember);
    const a = approval({ employeeId: issued.employee.id });
    const res = await runApprovalResolveSideEffects({
      approval: a, decision: "approved", actorEmail: "web:owner@example.com", employee: issued.employee,
    });
    expect(sent.filter((m) => m.to === "accounting@example.com")).toHaveLength(0);
    expect(res.employeeEmail.skipped).toBe(true);
    const row = getRuntimeAudit().find((e) => e.metadata?.approvalId === a.id && e.purpose === "approval_notify_email.recipient_not_member");
    expect(row?.metadata).toEqual({ approvalId: a.id, employeeId: issued.employee.id, reason: "approval_notify_email_not_member" });
    expect(JSON.stringify(row)).not.toContain("@");
  });

  test("BOLA at send time: an employee of org A configured with org B's active member → not sent", async () => {
    const res = await runApprovalResolveSideEffects({
      approval: approval(), decision: "approved", actorEmail: "web:owner@example.com", employee: employeeWith("OUTSIDER@other-org.example"),
    });
    expect(res.employeeEmail.ok).toBe(false);
    expect(sent.filter((m) => m.to.toLowerCase() === OTHER_ORG_MEMBER.email)).toHaveLength(0);
  });

  test("an address that was never a member (e.g. written before this rule) → not sent", async () => {
    await runApprovalResolveSideEffects({
      approval: approval(), decision: "rejected", actorEmail: "web:owner@example.com", employee: employeeWith(OTHER_ORG_MEMBER.email),
    });
    expect(sent.filter((m) => m.to === OTHER_ORG_MEMBER.email)).toHaveLength(0);
  });

  test("no address → nothing sent, nothing audited", async () => {
    const a = approval();
    const res = await runApprovalResolveSideEffects({
      approval: a, decision: "approved", actorEmail: "web:owner@example.com", employee: employeeWith(null),
    });
    expect(res.employeeEmail).toEqual({ ok: true, skipped: true });
    expect(getRuntimeAudit().some((e) => e.metadata?.approvalId === a.id && e.purpose === "approval_notify_email.recipient_not_member")).toBe(false);
  });
});

describe("body has no approval summary", () => {
  const MARKERS = [SECRET_SUMMARY, "980万円", "タイトル-marker-a1", "purpose-marker-b2", "tool-marker-c3", "revision-marker-d4", "web:owner@example.com", "emp_sales"];

  test("builder: only 'an approval was decided' + dashboard link", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://notify-mail.example.test";
    const m = buildApprovalNotifyEmail();
    expect(m.text).toContain("https://notify-mail.example.test/app/approvals");
    expect(m.html).toContain("https://notify-mail.example.test/app/approvals");
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  test("the email actually sent carries none of the approval's details", async () => {
    const a = approval();
    await runApprovalResolveSideEffects({
      approval: a, decision: "approved", actorEmail: "web:owner@example.com", employee: employeeWith("sales@example.com"),
    });
    const mail = sent.find((m) => m.to === "sales@example.com");
    expect(mail).toBeTruthy();
    const all = `${mail!.subject}\n${mail!.text ?? ""}\n${mail!.html}`;
    for (const marker of [...MARKERS, a.id]) expect(all).not.toContain(marker);
    expect(all).toContain("/app/approvals");
  });
});

describe("write-path inventory (every set/update path is known and checked)", () => {
  test("only the guarded writer and the row mapper touch approval_notify_email; approvalNotifyEmail is passed only by the checked paths", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    for (const d of ["app", "lib", "components", "scripts"]) {
      try { walk(join(root, d)); } catch { /* dir may not exist */ }
    }
    const snake = new Set<string>();
    const camel = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const rel = relative(root, f);
      // the column name only (not the error codes / audit purpose that share the prefix)
      if (/approval_notify_email\b(?!\.)/.test(src)) snake.add(rel);
      if (/approvalNotifyEmail\??\s*:/.test(src)) camel.add(rel);
    }
    expect([...snake].sort()).toEqual(["lib/data/employees.ts", "lib/data/mappers.ts"]);
    expect([...camel].sort()).toEqual([
      "app/api/employees/issue/route.ts",
      "lib/admin-mcp/fulfill-admin.ts",
      "lib/data/employees.ts",
      "lib/data/mappers.ts",
      "lib/mcp/admin-tools.ts",
      "lib/types.ts",
    ]);
  });
});
