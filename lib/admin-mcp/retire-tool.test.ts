/**
 * Fail-first: admin MCP employees.retire (EMPLOYEE_RETIRE_ENABLED, default OFF).
 * File-only: always_human ticket; fulfil does not retire; the dashboard human executes.
 * AI (employee MCP) cannot call it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { SELF_APPROVAL_DENIED } from "@/lib/admin-mcp/self-approval";
import { classifyApproverRequirement, isApproverAuthorityTargetTool } from "@/lib/approver-authority/targets";
import { PLAN_ADMIN_SCOPES, READ_ONLY_ADMIN_TOOLS } from "@/lib/billing/plan-scopes";
import { createApproval, getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const { getEmployee } = await import("@/lib/data/employees");
const { ADMIN_MCP_TOOL_NAMES } = await import("@/lib/mcp/admin-public");
const { ADMIN_MCP_TOOLS, callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { callStaffpassMcpTool, listStaffpassMcpTools, STAFFPASS_MCP_TOOLS } = await import("@/lib/mcp/tools");
const { EMPLOYEE_RETIRE_TOOL } = await import("@/lib/employees/retire");
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { Employee } from "@/lib/types";

const TOOL = "employees.retire";
const FLAG = "EMPLOYEE_RETIRE_ENABLED";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_retire_other_tenant";
const ADMIN_GROK = "grok_admin_retire";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_retire" };
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
    id: `emp_retire_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    scopes: ["tools:read", "approvals:request", "audit:append"],
    credentialId: `cred_retire_${seq}`,
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  return employee;
}
const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;
async function propose(employeeId: string, c = cred()) {
  return data(await callAdminMcpTool(TOOL, { employeeId }, c));
}

beforeEach(() => {
  process.env[FLAG] = "1";
});
afterEach(() => {
  delete process.env[FLAG];
});

describe("registry", () => {
  test("name, always_human / approvalClass admin, admin.policy audit, not read-only, every plan, not on the employee MCP", async () => {
    expect(EMPLOYEE_RETIRE_TOOL).toBe(TOOL);
    expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(TOOL)).toBe(true);
    const def = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!;
    expect(def).toBeTruthy();
    expect(def.approvalClass).toBe("admin");
    expect(def.description).toContain("always_human");
    expect(def.description).toContain("EMPLOYEE_RETIRE_ENABLED");
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
  test("schema: employeeId (+ jobId / approvalId), no orgId", () => {
    const schema = ADMIN_MCP_TOOLS.find((t) => t.name === TOOL)!.inputSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(["approvalId", "employeeId", "jobId"]);
    expect(schema.required).toEqual(["employeeId"]);
    expect(schema.additionalProperties).toBe(false);
  });
  test("approver authority target: standard; money scope → owner", () => {
    expect(isApproverAuthorityTargetTool(TOOL)).toBe(true);
    expect(classifyApproverRequirement({ tool: TOOL, metadata: { adminMutation: { employeeId: "e" } }, context: { currentEmployeeScopes: ["slack:post"] } })?.kind).toBe("owner_or_designated_admin");
    expect(classifyApproverRequirement({ tool: TOOL, metadata: { adminMutation: { employeeId: "e" } }, context: { currentEmployeeScopes: ["commerce:order"] } })?.kind).toBe("owner");
    expect(classifyApproverRequirement({ tool: TOOL, metadata: { adminMutation: { employeeId: "e" } } })?.kind).toBe("owner");
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
    expect((await getEmployee(emp.id, ORG_A))?.status).toBe("active");
  });
});

describe("propose (queue only)", () => {
  test("same org → always_human ticket; employee stays active", async () => {
    const emp = newEmployee(ORG_A);
    const q = await propose(emp.id);
    expect(q).toMatchObject({ code: "needs_approval", always_human: true, tool: TOOL });
    const approval = (await getApprovalById(String(q.approvalId), ORG_A))!;
    expect(approval.metadata.adminMutation).toEqual({ employeeId: emp.id });
    expect(approval.summary).toContain(emp.id);
    expect((await getEmployee(emp.id, ORG_A))?.status).toBe("active");
  });
  test("BOLA: another org's employee → employee_not_found, no ticket", async () => {
    const other = newEmployee(ORG_B);
    const before = (await listApprovals(ORG_A)).length;
    const res = await propose(other.id);
    expect(res.code).toBe("employee_not_found");
    expect((await listApprovals(ORG_A)).length).toBe(before);
  });
  test("orgId / secret-ish args refused", async () => {
    const ok = newEmployee(ORG_A);
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, orgId: ORG_B }, cred())).code).toBe("unexpected_argument");
    expect(data(await callAdminMcpTool(TOOL, { employeeId: ok.id, reason: "gb_emp_0123456789abcdef_0123456789abcdef0123456789abcdef" }, cred())).code).toBe("unexpected_argument");
  });
});

describe("self-approval and fulfil (does not execute)", () => {
  test("the requesting admin agent cannot approve its own retire ticket", async () => {
    const emp = newEmployee(ORG_A);
    const c = cred();
    const q = await propose(emp.id, c);
    let denied = false;
    try {
      await resolveApproval(String(q.approvalId), "approved", "admin-agent", ORG_A, { actorId: c.actorId });
    } catch (error) {
      denied = String(error).includes(SELF_APPROVAL_DENIED) || String((error as Error).message).includes("self");
    }
    const after = await getApprovalById(String(q.approvalId), ORG_A);
    if (after?.status === "approved") {
      expect(after.resolvedBy).not.toBe(c.actorId);
    } else {
      expect(denied || after?.status === "pending").toBe(true);
    }
    expect((await getEmployee(emp.id, ORG_A))?.status).toBe("active");
  });

  test("human approve + fulfil does not retire; dashboard pointer only", async () => {
    const emp = newEmployee(ORG_A);
    const q = await propose(emp.id);
    expect(q.code).toBe("needs_approval");
    const approved = await resolveApproval(String(q.approvalId), "approved", HUMAN.email, ORG_A, { actorId: HUMAN.memberId });
    expect(approved).not.toBeNull();
    const f = await fulfillApprovedAdmin(approved!);
    expect(f?.ok).toBe(true);
    expect(f?.tool).toBe(TOOL);
    expect(JSON.stringify(f)).toContain("/app/employees/");
    expect((await getEmployee(emp.id, ORG_A))?.status).toBe("active");
  });

  test("fulfil with flag OFF → feature_disabled, employee unchanged", async () => {
    const emp = newEmployee(ORG_A);
    const created = await createApproval({
      orgId: ORG_A,
      employeeId: emp.id,
      credentialId: emp.credentialId ?? "",
      title: "退職",
      purpose: "admin.policy",
      summary: "retire",
      risk: "high",
      tool: TOOL,
      jobId: `job_retire_${Date.now()}`,
      metadata: {
        approvalClass: "admin",
        always_human: true,
        isAdminMcpTool: true,
        adminTool: TOOL,
        adminMutation: { employeeId: emp.id },
      },
    });
    const approved = await resolveApproval(created.approval.id, "approved", HUMAN.email, ORG_A, { actorId: HUMAN.memberId });
    delete process.env[FLAG];
    const f = await fulfillApprovedAdmin(approved!);
    expect(f?.ok).toBe(false);
    expect(f?.error).toBe("feature_disabled");
    expect((await getEmployee(emp.id, ORG_A))?.status).toBe("active");
  });
});
