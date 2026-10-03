/**
 * Admin MCP: employees.allowedAccounts.{add,remove,list} — demo mode.
 *
 * Covers: exact registry names (#240 looks up `employees.allowedAccounts.add`),
 * add/remove always_human (approvalClass admin, ticket first, change only on
 * fulfillment), list read-only, tools/list === callable (#239 regression class),
 * org scoping from the credential only (other org → not found, no leak),
 * strict per-provider validation, idempotent add, remove of a missing account,
 * fulfillment re-validation, admin change-log audit entry, flag OFF.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin, parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import {
  ALLOWED_ACCOUNTS_TOOLS,
  ALLOWED_ACCOUNTS_TOOLS_FLAG,
  isAdminMcpAllowedAccountsToolsEnabled,
  isEmployeesAllowedAccountsAdminToolAvailable,
  validateAllowedAccountInput,
} from "@/lib/admin-mcp/allowed-accounts-tools";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { linkAgent } from "@/lib/data/bindings";
import {
  bindEmployeeSlackIdentity,
  getEmployeesBySlackUserIds,
  getLinkedSlackUserToken,
  revokeEmployeeSlackIdentity,
  setDemoSlackIdentityStatusForTests,
} from "@/lib/data/slack-identities";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { ADMIN_MCP_TOOLS, callAdminMcpTool, isAdminMcpToolName } from "@/lib/mcp/admin-tools";
import { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { AllowedAccount, Employee } from "@/lib/types";

const ADD = "employees.allowedAccounts.add";
const REMOVE = "employees.allowedAccounts.remove";
const LIST = "employees.allowedAccounts.list";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_allowed_accounts_other_tenant";
const SLACK_U = "U0C1RN0AHE1";
const ADMIN_GROK = "grok_admin_allowed_accounts";

let savedFlag: string | undefined;
let seq = 0;

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: ADMIN_GROK, status: "linked" });
  return {
    orgId,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function newEmployee(orgId: string, accounts: AllowedAccount[], extra: Partial<Employee> = {}): Employee {
  seq += 1;
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = {
    ...base,
    id: `emp_aa_${Date.now().toString(36)}_${seq}`,
    orgId,
    displayName: "稲盛",
    status: "active",
    scopes: ["slack:post"] as Employee["scopes"],
    allowedAccounts: accounts.map((a) => ({ ...a })),
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function runtimeEmployee(id: string): Employee | undefined {
  return getRuntimeEmployees().find((e) => e.id === id);
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

async function approveAndFulfill(approvalId: string, orgId = ORG_A) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_human_aa" });
  expect(approved).not.toBeNull();
  return fulfillApprovedAdmin(approved!);
}

async function approvalCount(): Promise<number> {
  return (await listApprovals(ORG_A)).length;
}

beforeEach(() => {
  savedFlag = process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG];
  process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG] = "true";
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG];
  else process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG] = savedFlag;
});

describe("registry", () => {
  test("exact tool names exist on the admin MCP (tools/list and callable)", () => {
    expect([...ALLOWED_ACCOUNTS_TOOLS]).toEqual([ADD, REMOVE, LIST]);
    for (const name of [ADD, REMOVE, LIST]) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(true);
      expect(ADMIN_MCP_TOOLS.some((t) => t.name === name)).toBe(true);
      expect(isAdminMcpToolName(name)).toBe(true);
    }
  });

  test("add/remove are always_human (approvalClass admin); list is read-only", () => {
    const byName = (n: string) => ADMIN_MCP_TOOLS.find((t) => t.name === n)!;
    for (const name of [ADD, REMOVE]) {
      expect(byName(name).approvalClass).toBe("admin");
      expect(byName(name).description).toContain("always_human");
      expect(byName(name).description).not.toMatch(/NOT (wrapped in another )?always_human/i);
      expect(auditActionForAdminTool(name)).toBe("admin.policy");
      expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(name)).toBe(false);
    }
    expect(byName(LIST).approvalClass).toBeUndefined();
    expect(byName(LIST).description).toContain("read-only");
    expect(byName(LIST).description.includes("always_human")).toBe(false);
    expect((READ_ONLY_ADMIN_TOOLS as readonly string[]).includes(LIST)).toBe(true);
  });

  test("no orgId argument in any schema (org comes from the credential only)", () => {
    for (const name of [ADD, REMOVE, LIST]) {
      const schema = ADMIN_MCP_TOOLS.find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, unknown>;
        additionalProperties: boolean;
      };
      expect(Object.keys(schema.properties)).not.toContain("orgId");
      expect(schema.additionalProperties).toBe(false);
    }
  });

  test("available on every tenant plan (same as employees.issue)", () => {
    for (const plan of Object.keys(PLAN_ADMIN_SCOPES) as Array<keyof typeof PLAN_ADMIN_SCOPES>) {
      const scopes = PLAN_ADMIN_SCOPES[plan] as readonly string[];
      expect(scopes.includes("employees.issue")).toBe(true);
      for (const name of [ADD, REMOVE, LIST]) expect({ plan, name, ok: scopes.includes(name) }).toEqual({ plan, name, ok: true });
    }
  });

  test("absent from the employee badge MCP (/api/mcp)", async () => {
    const employeeNames = [...STAFFPASS_MCP_TOOLS, ...listStaffpassMcpTools()].map((t) => t.name);
    const emp = newEmployee(ORG_A, []);
    for (const name of [ADD, REMOVE, LIST]) {
      expect(employeeNames.includes(name)).toBe(false);
      const res = await callStaffpassMcpTool(name, {}, { employeeId: emp.id, orgId: ORG_A } as unknown as ResolvedEmployeeCredential);
      expect(data(res).code).toBe("unknown_mcp_tool");
    }
  });

  test("tools/list consistency: every advertised tool is callable (decision.deputyActivate is #239)", async () => {
    // #239 removes the uncallable decision.deputyActivate from tools/list; until
    // then it is the only known exception. Everything else must line up 1:1.
    const advertised = ADMIN_MCP_TOOLS.map((t) => t.name).filter((n) => n !== "decision.deputyActivate");
    expect(advertised).toEqual([...ADMIN_MCP_TOOL_NAMES]);
    for (const name of advertised) expect({ name, callable: isAdminMcpToolName(name) }).toEqual({ name, callable: true });
    for (const name of [ADD, REMOVE, LIST]) {
      const res = data(await callAdminMcpTool(name, {}, cred()));
      expect({ name, code: res.code }).not.toEqual({ name, code: "unknown_mcp_tool" });
    }
  });
});

describe("flag OFF (default)", () => {
  test("default is OFF and every tool fails closed without a ticket", async () => {
    delete process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG];
    expect(isAdminMcpAllowedAccountsToolsEnabled()).toBe(false);
    expect(isEmployeesAllowedAccountsAdminToolAvailable()).toBe(false);
    const emp = newEmployee(ORG_A, [{ service: "slack", accountId: "U0EXISTING1" }]);
    const before = await approvalCount();
    for (const [name, args] of [
      [ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }],
      [REMOVE, { employeeId: emp.id, provider: "slack", accountId: "U0EXISTING1" }],
      [LIST, { employeeId: emp.id }],
    ] as const) {
      const res = await callAdminMcpTool(name, { ...args }, cred());
      expect(res.isError).toBe(true);
      expect(data(res).code).toBe("allowed_accounts_tools_disabled");
      expect(String(data(res).nextStepJa)).toContain("ブラウザ・外部アカウント");
    }
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([{ service: "slack", accountId: "U0EXISTING1" }]);
  });

  test("flag turned OFF after the ticket was queued: fulfillment fails closed, no change", async () => {
    const emp = newEmployee(ORG_A, []);
    const queued = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(queued.code).toBe("needs_approval");
    delete process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG];
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("allowed_accounts_tools_disabled");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });

  test("ON values", () => {
    for (const v of ["true", "1", "on", "enabled", "TRUE"]) {
      process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG] = v;
      expect(isAdminMcpAllowedAccountsToolsEnabled()).toBe(true);
      expect(isEmployeesAllowedAccountsAdminToolAvailable()).toBe(true);
    }
    for (const v of ["", "false", "0", "off", "yes"]) {
      process.env[ALLOWED_ACCOUNTS_TOOLS_FLAG] = v;
      expect(isAdminMcpAllowedAccountsToolsEnabled()).toBe(false);
    }
  });
});

describe("org scoping", () => {
  test("another org's employee is 'not found' — same answer as a non-existent id, no ticket", async () => {
    const empB = newEmployee(ORG_B, [{ service: "slack", accountId: "U0ORGBUSER1" }]);
    const before = await approvalCount();
    for (const [name, args] of [
      [ADD, { provider: "slack", accountId: SLACK_U }],
      [REMOVE, { provider: "slack", accountId: "U0ORGBUSER1" }],
      [LIST, {}],
    ] as const) {
      const other = await callAdminMcpTool(name, { employeeId: empB.id, ...args }, cred(ORG_A));
      const missing = await callAdminMcpTool(name, { employeeId: "emp_does_not_exist", ...args }, cred(ORG_A));
      expect(other.isError).toBe(true);
      expect(data(other)).toEqual(data(missing));
      expect(data(other).code).toBe("employee_not_found");
      expect(JSON.stringify(data(other))).not.toContain("U0ORGBUSER1");
    }
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(empB.id)!.allowedAccounts).toEqual([{ service: "slack", accountId: "U0ORGBUSER1" }]);
  });

  test("orgId argument is rejected (never taken from tool arguments)", async () => {
    const empB = newEmployee(ORG_B, []);
    for (const name of [ADD, REMOVE, LIST]) {
      const res = data(await callAdminMcpTool(name, { employeeId: empB.id, orgId: ORG_B, provider: "slack", accountId: SLACK_U }, cred(ORG_A)));
      expect(res.code).toBe("unexpected_argument");
    }
    expect(runtimeEmployee(empB.id)!.allowedAccounts).toEqual([]);
  });

  test("fulfillment uses the approval's org: an employee moved out of the org is not found", async () => {
    const emp = newEmployee(ORG_A, []);
    const queued = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    runtimeEmployee(emp.id)!.orgId = ORG_B;
    const fulfillment = await approveAndFulfill(String(queued.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("employee_not_found");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });

  test("admin agent cannot edit the badge it is bound to", async () => {
    const emp = newEmployee(ORG_A, []);
    await linkAgent(emp.id, { orgId: ORG_A, grokBotAgentId: ADMIN_GROK, grokBotWorkspaceId: null });
    const res = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(res.code).toBe("cannot_target_self");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });
});

describe("validation", () => {
  test("slack: user id must be U…/W… uppercase, 9+ chars", () => {
    expect(validateAllowedAccountInput({ provider: "slack", accountId: SLACK_U }).ok).toBe(true);
    expect(validateAllowedAccountInput({ provider: "slack", accountId: "W0C1RN0AHE1" }).ok).toBe(true);
    for (const bad of ["u0c1rn0ahe1", "U0C1RN0", "C0C1RN0AHE1", "D0C1RN0AHE1", "T0C1RN0AHE1", "U0C1RN0AHE1 extra", "<@U0C1RN0AHE1>", "U0C1-RN0AHE1", ""]) {
      const r = validateAllowedAccountInput({ provider: "slack", accountId: bad });
      expect({ bad, ok: r.ok }).toEqual({ bad, ok: false });
    }
  });

  test("google / microsoft365 require an email address", () => {
    expect(validateAllowedAccountInput({ provider: "google", accountId: "sales@example.co.jp" }).ok).toBe(true);
    expect(validateAllowedAccountInput({ provider: "microsoft365", accountId: "ops@example.com" }).ok).toBe(true);
    for (const bad of ["sales", "@brand", "a@b", "a b@example.com", "sales@example.co.jp,x@y.com"]) {
      expect(validateAllowedAccountInput({ provider: "google", accountId: bad }).ok).toBe(false);
    }
  });

  test("SNS handles: no spaces / URLs / separators", () => {
    expect(validateAllowedAccountInput({ provider: "x", accountId: "@brand_jp" }).ok).toBe(true);
    expect(validateAllowedAccountInput({ provider: "instagram", accountId: "brand.jp" }).ok).toBe(true);
    for (const bad of ["https://x.com/brand", "brand jp", "brand/jp", "a,b", "@"]) {
      expect(validateAllowedAccountInput({ provider: "x", accountId: bad }).ok).toBe(false);
    }
  });

  test("unknown / free-text providers are rejected (other, chatwork, empty)", () => {
    for (const provider of ["other", "chatwork", "", "Slack ", "custom"]) {
      const r = validateAllowedAccountInput({ provider, accountId: SLACK_U });
      expect({ provider, ok: r.ok }).toEqual({ provider, ok: false });
      if (!r.ok) expect(r.code).toBe("unsupported_provider");
    }
  });

  test("tool rejects a bad Slack id / unknown provider before any ticket", async () => {
    const emp = newEmployee(ORG_A, []);
    const before = await approvalCount();
    const bad = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: "u0c1rn0ahe1" }, cred()));
    expect(bad.code).toBe("invalid_account_id");
    const unknown = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "chatwork", accountId: "abc" }, cred()));
    expect(unknown.code).toBe("unsupported_provider");
    const missing = data(await callAdminMcpTool(ADD, { employeeId: emp.id }, cred()));
    expect(missing.code).toBe("missing_required_fields");
    const secret = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U, label: "xoxb-1234-SECRET" }, cred()));
    expect(secret.code).toBe("secret_not_accepted");
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });
});

describe("add", () => {
  test("queues a ticket with a plain-Japanese summary; nothing changes before approval", async () => {
    const emp = newEmployee(ORG_A, [{ service: "google", accountId: "sales@example.co.jp", browserRequired: true }]);
    const res = await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred());
    const out = data(res);
    expect(res.isError).toBe(false);
    expect(out.code).toBe("needs_approval");
    expect(out.always_human).toBe(true);
    expect(String(out.summary)).toContain(`社員「稲盛」の許可アカウントに Slack ${SLACK_U} を追加`);
    const approval = await getApprovalById(String(out.approvalId), ORG_A);
    expect(approval?.status).toBe("pending");
    expect(approval?.metadata?.adminTool).toBe(ADD);
    // Not applied yet.
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([{ service: "google", accountId: "sales@example.co.jp", browserRequired: true }]);
    // Re-invoke while pending: still needs approval, still unchanged.
    const again = data(await callAdminMcpTool(ADD, { approvalId: out.approvalId }, cred()));
    expect(again.code).toBe("needs_approval");
    expect(runtimeEmployee(emp.id)!.allowedAccounts!.length).toBe(1);
  });

  test("rejected ticket: no change", async () => {
    const emp = newEmployee(ORG_A, []);
    const out = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    await resolveApproval(String(out.approvalId), "rejected", "owner@example.com", ORG_A, { actorId: "mem_human_aa" });
    const again = data(await callAdminMcpTool(ADD, { approvalId: out.approvalId }, cred()));
    expect(again.code).toBe("approval_rejected");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });

  test("fulfillment applies the change and writes the admin audit entry (before/after/actor/approver/ticket)", async () => {
    const existing = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [existing]);
    const c = cred();
    const out = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U, label: "稲盛 Slack" }, c));
    const approvalId = String(out.approvalId);
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.employeeId).toBe(emp.id);
    expect(String(fulfillment?.summaryJa)).toContain(`社員「稲盛」の許可アカウントに Slack ${SLACK_U} を追加しました`);
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([
      existing,
      { service: "slack", accountId: SLACK_U, label: "稲盛 Slack", browserRequired: false },
    ]);
    const audit = getRuntimeAudit().find(
      (e) => e.orgId === ORG_A && e.metadata?.event === "employee.allowed_accounts.added" && e.metadata?.approvalId === approvalId
    );
    expect(audit).toBeTruthy();
    expect(audit!.action).toBe("admin.policy");
    expect(audit!.employeeId).toBe(emp.id);
    expect(audit!.summary).toContain(`社員「稲盛」の許可アカウントに Slack ${SLACK_U} を追加`);
    expect(audit!.metadata).toMatchObject({
      auditClass: "admin",
      tool: ADD,
      approvalId,
      employeeId: emp.id,
      provider: "slack",
      accountId: SLACK_U,
      approver: "owner@example.com",
      actor: { kind: "admin_agent", adminAgentId: c.adminAgentId, grokBotAgentId: ADMIN_GROK },
      before: [existing],
      after: [existing, { service: "slack", accountId: SLACK_U, label: "稲盛 Slack", browserRequired: false }],
    });
    // Re-invoke reads the stored result; fulfillment is not applied twice.
    const read = data(await callAdminMcpTool(ADD, { approvalId }, c));
    expect(read.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.allowedAccounts!.length).toBe(2);
  });

  test("idempotent: adding an existing account returns alreadyPresent, no ticket, no duplicate", async () => {
    const emp = newEmployee(ORG_A, [{ service: "slack", accountId: SLACK_U }]);
    const before = await approvalCount();
    const res = await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred());
    expect(res.isError).toBe(false);
    expect(data(res)).toMatchObject({ ok: true, code: "already_allowed", alreadyPresent: true, changed: false });
    expect(await approvalCount()).toBe(before);
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([{ service: "slack", accountId: SLACK_U }]);
  });

  test("email duplicates are case-insensitive", async () => {
    const emp = newEmployee(ORG_A, [{ service: "google", accountId: "Sales@Example.co.jp" }]);
    const res = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "google", accountId: "sales@example.co.jp" }, cred()));
    expect(res.code).toBe("already_allowed");
  });

  test("re-validated at fulfillment: added meanwhile (e.g. dashboard) → no duplicate, ok with alreadyPresent", async () => {
    const emp = newEmployee(ORG_A, []);
    const out = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: SLACK_U }];
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(String(fulfillment?.summaryJa)).toContain("既に");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([{ service: "slack", accountId: SLACK_U }]);
  });

  test("re-validated at fulfillment: suspended employee → refused, no change", async () => {
    const emp = newEmployee(ORG_A, []);
    const out = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    runtimeEmployee(emp.id)!.status = "suspended";
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("employee_terminated");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });

  test("tampered ticket payload is re-validated at fulfillment", async () => {
    const emp = newEmployee(ORG_A, []);
    const out = data(await callAdminMcpTool(ADD, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    const approval = await getApprovalById(String(out.approvalId), ORG_A);
    (approval!.metadata!.adminMutation as Record<string, unknown>).accountId = "not-a-slack-id";
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("invalid_account_id");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([]);
  });
});

describe("remove", () => {
  test("remove of a missing account is a clear error, no ticket", async () => {
    const emp = newEmployee(ORG_A, [{ service: "slack", accountId: "U0EXISTING1" }]);
    const before = await approvalCount();
    const res = await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred());
    expect(res.isError).toBe(true);
    expect(data(res).code).toBe("allowed_account_not_found");
    expect(String(data(res).message)).toContain(SLACK_U);
    expect(await approvalCount()).toBe(before);
  });

  test("queues, then fulfillment removes it and audits before/after", async () => {
    const keep = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const drop = { service: "slack", accountId: SLACK_U };
    const emp = newEmployee(ORG_A, [keep, drop]);
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(out.code).toBe("needs_approval");
    expect(String(out.summary)).toContain(`社員「稲盛」の許可アカウントから Slack ${SLACK_U} を削除`);
    expect(runtimeEmployee(emp.id)!.allowedAccounts!.length).toBe(2);
    const approvalId = String(out.approvalId);
    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([keep]);
    const audit = getRuntimeAudit().find((e) => e.metadata?.event === "employee.allowed_accounts.removed" && e.metadata?.approvalId === approvalId);
    expect(audit?.metadata).toMatchObject({ before: [keep, drop], after: [keep], provider: "slack", accountId: SLACK_U, approver: "owner@example.com" });
  });

  test("re-validated at fulfillment: removed meanwhile → conflict error, no change", async () => {
    const emp = newEmployee(ORG_A, [{ service: "slack", accountId: SLACK_U }]);
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "slack", accountId: "U0SOMEONE01" }];
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("allowed_account_not_found");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([{ service: "slack", accountId: "U0SOMEONE01" }]);
  });

  test("browser:use badge cannot lose its last allowed account (same rule as the dashboard)", async () => {
    const only = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [only], { scopes: ["browser:use"] as Employee["scopes"] });
    const res = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "google", accountId: "sales@example.co.jp" }, cred()));
    expect(res.code).toBe("allowed_accounts_required");
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([only]);
  });
});

describe("list (read-only)", () => {
  test("returns this org's employee accounts without creating a ticket", async () => {
    const emp = newEmployee(ORG_A, [{ service: "slack", accountId: SLACK_U, label: "Slack" }]);
    const before = await approvalCount();
    const res = await callAdminMcpTool(LIST, { employeeId: emp.id }, cred());
    expect(res.isError).toBe(false);
    expect(data(res)).toMatchObject({
      ok: true,
      employeeId: emp.id,
      allowedAccounts: [{ service: "slack", accountId: SLACK_U, label: "Slack", browserRequired: false }],
    });
    expect(await approvalCount()).toBe(before);
  });
});

/**
 * Runtime Slack paths do NOT re-check allowedAccounts: they read
 * employee_slack_identities (+ its user token) only. allowedAccounts is checked
 * when an identity is bound (OAuth callback / #240 re-authorize, both through
 * bindEmployeeSlackIdentity). So removing a Slack U… does not stop an identity
 * that is already linked — remove must say so (no auto-unlink in this PR).
 */
const SLACK_NOTICE_JA = "既存の Slack 紐づけは残っています。止めるにはダッシュボードで解除してください";
const TEAM = "T0ALLOWEDAA1";

async function linkSlack(emp: Employee, slackUserId = SLACK_U) {
  await bindEmployeeSlackIdentity({
    employeeId: emp.id,
    orgId: emp.orgId,
    slackUserId,
    slackTeamId: TEAM,
    displayName: "inamori",
    userToken: "xoxp-test-user-token-aa",
  });
}

function removedAudit(approvalId: string) {
  return getRuntimeAudit().find((e) => e.metadata?.event === "employee.allowed_accounts.removed" && e.metadata?.approvalId === approvalId);
}

describe("remove: an existing Slack identity stays linked", () => {
  test("evidence: after removal the linked identity is still used by ingress and user-token send", async () => {
    const keep = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [keep, { service: "slack", accountId: SLACK_U }]);
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect((await approveAndFulfill(String(out.approvalId)))?.ok).toBe(true);
    expect(runtimeEmployee(emp.id)!.allowedAccounts).toEqual([keep]);
    // Send path (resolveConversationToken → getLinkedSlackUserToken): token still returned.
    expect(await getLinkedSlackUserToken(emp.id)).toBe("xoxp-test-user-token-aa");
    // Ingress path (mention / user-token channel): still resolves to this employee.
    const targets = await getEmployeesBySlackUserIds([SLACK_U], TEAM);
    expect(targets.map((t) => t.employeeId)).toContain(emp.id);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("linked identity for the removed U…: MCP result, ticket, fulfillment and audit carry the notice", async () => {
    const keep = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [keep, { service: "slack", accountId: SLACK_U }]);
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(out.code).toBe("needs_approval");
    expect(out.slackIdentityRemains).toBe(true);
    expect(out.slackIdentityNoticeJa).toBe(SLACK_NOTICE_JA);
    expect(String(out.summary)).toContain(SLACK_NOTICE_JA);
    const approvalId = String(out.approvalId);
    const ticket = await getApprovalById(approvalId, ORG_A);
    expect(String(ticket?.summary)).toContain(SLACK_NOTICE_JA);

    const fulfillment = await approveAndFulfill(approvalId);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.noticeJa).toBe(SLACK_NOTICE_JA);
    expect(String(fulfillment?.summaryJa)).toContain(SLACK_NOTICE_JA);
    // Persisted on the ticket (what approval polling returns).
    const persisted = parseAdminFulfillment((await getApprovalById(approvalId, ORG_A))?.metadata);
    expect(persisted?.noticeJa).toBe(SLACK_NOTICE_JA);
    expect(String(persisted?.nextStepJa)).toContain("連携を解除");
    const audit = removedAudit(approvalId);
    expect(audit?.metadata).toMatchObject({ slackIdentityRemains: true, slackIdentityNoticeJa: SLACK_NOTICE_JA });
    expect(String(audit?.summary)).toContain(SLACK_NOTICE_JA);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("no identity: no notice anywhere", async () => {
    const keep = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [keep, { service: "slack", accountId: SLACK_U }]);
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(out.code).toBe("needs_approval");
    expect(out.slackIdentityRemains).toBeUndefined();
    expect(out.slackIdentityNoticeJa).toBeUndefined();
    expect(String(out.summary)).not.toContain(SLACK_NOTICE_JA);
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.noticeJa).toBeUndefined();
    expect(removedAudit(String(out.approvalId))?.metadata?.slackIdentityRemains).toBe(false);
  });

  test("identity linked to a different U… or a non-Slack removal: no notice", async () => {
    const emp = newEmployee(ORG_A, [
      { service: "slack", accountId: SLACK_U },
      { service: "slack", accountId: "U0OTHERAA01" },
      { service: "google", accountId: "sales@example.co.jp", browserRequired: true },
    ]);
    await linkSlack(emp, SLACK_U);
    const other = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: "U0OTHERAA01" }, cred()));
    expect(other.code).toBe("needs_approval");
    expect(other.slackIdentityNoticeJa).toBeUndefined();
    const google = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "google", accountId: "sales@example.co.jp" }, cred()));
    expect(google.code).toBe("needs_approval");
    expect(google.slackIdentityNoticeJa).toBeUndefined();
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("needs_reauth identity is not in use (no token, no wake): no notice", async () => {
    const keep = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [keep, { service: "slack", accountId: SLACK_U }]);
    await linkSlack(emp);
    setDemoSlackIdentityStatusForTests(emp.id, "needs_reauth");
    expect(await getLinkedSlackUserToken(emp.id)).toBe("");
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(out.slackIdentityNoticeJa).toBeUndefined();
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });

  test("checked again at fulfillment: unlinked on the dashboard before approval → no notice", async () => {
    const keep = { service: "google", accountId: "sales@example.co.jp", browserRequired: true };
    const emp = newEmployee(ORG_A, [keep, { service: "slack", accountId: SLACK_U }]);
    await linkSlack(emp);
    const out = data(await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred()));
    expect(out.slackIdentityNoticeJa).toBe(SLACK_NOTICE_JA);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    const fulfillment = await approveAndFulfill(String(out.approvalId));
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.noticeJa).toBeUndefined();
    expect(removedAudit(String(out.approvalId))?.metadata?.slackIdentityRemains).toBe(false);
  });

  test("already removed from allowedAccounts but still linked: the not-found error carries the notice", async () => {
    const emp = newEmployee(ORG_A, [{ service: "slack", accountId: SLACK_U }]);
    await linkSlack(emp);
    runtimeEmployee(emp.id)!.allowedAccounts = [{ service: "google", accountId: "sales@example.co.jp" }];
    const res = await callAdminMcpTool(REMOVE, { employeeId: emp.id, provider: "slack", accountId: SLACK_U }, cred());
    expect(res.isError).toBe(true);
    expect(data(res).code).toBe("allowed_account_not_found");
    expect(data(res).slackIdentityNoticeJa).toBe(SLACK_NOTICE_JA);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  });
});
