import { describe, expect, test } from "bun:test";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { STAFFPASS_MCP_TOOL_NAMES } from "@/lib/mcp/public";
import { ADMIN_MCP_TOOLS, adminToolsAlwaysHuman, callAdminMcpTool, isAdminMcpToolName } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES, ADMIN_MCP_SERVER_NAME } from "@/lib/mcp/admin-public";
import { MCP_SERVER_NAME } from "@/lib/mcp/tools";
import { listEmployees, resetDemoIngressHandoffPolicy } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { OrgIngressHandoffPolicy } from "@/lib/types";

const EMPLOYEE_NAMES = STAFFPASS_MCP_TOOLS.map((t) => t.name);

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({
    grokBotAgentId: "grok_admin_demo",
    status: "linked",
  });
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

describe("employee MCP tool list unchanged", () => {
  test("employee MCP stays whoami / invoke / poll / health", () => {
    expect(EMPLOYEE_NAMES).toEqual([
      "staffpass_whoami",
      "staffpass_invoke",
      "staffpass_get_approval_status",
      "staffpass_health",
    ]);
    expect([...STAFFPASS_MCP_TOOL_NAMES]).toEqual(EMPLOYEE_NAMES);
  });

  test("admin tools are not in the employee list", () => {
    for (const name of ADMIN_MCP_TOOL_NAMES) {
      expect(EMPLOYEE_NAMES.includes(name)).toBe(false);
      expect(isAdminMcpToolName(name)).toBe(true);
    }
  });

  test("server names differ", () => {
    expect(ADMIN_MCP_SERVER_NAME).toBe("staffpass-admin");
    expect(MCP_SERVER_NAME).toBe("staffpass");
    expect(ADMIN_MCP_SERVER_NAME).not.toBe(MCP_SERVER_NAME);
  });
});

describe("admin MCP always_human", () => {
  test("all admin tools except read-only tools are always_human", () => {
    expect(adminToolsAlwaysHuman()).toBe(true);
    expect(ADMIN_MCP_TOOLS.map((t) => t.name)).toEqual([...ADMIN_MCP_TOOL_NAMES]);
    const readOnlyTools = ["setup.slackStatus", "ingressHandoff.get"];
    const mutatingTools = ADMIN_MCP_TOOLS.filter((t) => !readOnlyTools.includes(t.name));
    expect(mutatingTools.every((t) => t.description.includes("always_human"))).toBe(true);
    for (const toolName of readOnlyTools) {
      const tool = ADMIN_MCP_TOOLS.find((t) => t.name === toolName);
      expect(tool?.description.includes("read-only")).toBe(true);
      expect(tool?.description.includes("no approval required")).toBe(true);
    }
  });

  test("employees.issue queues a ticket and does not mutate", async () => {
    const before = (await listEmployees(DEMO_ORG.id)).length;
    const result = await callAdminMcpTool(
      "employees.issue",
      {
        displayName: "試験AI社員",
        roleLabel: "事務",
        scopes: ["tools:read", "audit:append"],
      },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditClass).toBe("admin");
    expect(data.auditAction).toBe("admin.hire");
    expect(data.approvalId).toBeTruthy();
    expect(data.nextStepJa).toBe(undefined);
    expect((await listEmployees(DEMO_ORG.id)).length).toBe(before);
  });

  test("roles.propose is admin-only and still always_human", async () => {
    expect(EMPLOYEE_NAMES.includes("roles.propose")).toBe(false);
    const result = await callAdminMcpTool(
      "roles.propose",
      { documentText: "秘書としてメールの下書きと社内Slackの返信をしてほしい" },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.role");
    expect(data.nextStepJa).toBe(undefined);
  });

  test("link does not claim completion while approval is pending", async () => {
    const [employee] = await listEmployees(DEMO_ORG.id);
    expect(Boolean(employee)).toBe(true);
    const result = await callAdminMcpTool(
      "link",
      { employeeId: employee.id, grokBotAgentId: "agent-pending" },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.nextStepJa).toBe(undefined);
    expect(data.noticeJa).toBe(undefined);
  });
});

describe("roles.propose PROCESS SOURCE via admin MCP", () => {
  test("text-only without Drive queues always_human", async () => {
    const result = await callAdminMcpTool(
      "roles.propose",
      { sourceType: "text", text: "事務として請求確認と社内資料の整理をしてほしい" },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.role");
    expect(data.approvalId).toBeTruthy();
  });

  test("voice transcript without Drive queues always_human", async () => {
    const result = await callAdminMcpTool(
      "roles.propose",
      {
        sourceType: "voice",
        transcript: "営業アシスタントとして見積の下書きと顧客フォローをお願いします",
      },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.role");
  });

  test("empty roles.propose does not require Drive", async () => {
    const result = await callAdminMcpTool("roles.propose", {}, demoCred());
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("content_required");
    expect(data.driveRequired).toBe(false);
  });

  test("location-only without Drive queues always_human", async () => {
    const result = await callAdminMcpTool(
      "roles.propose",
      { sourceType: "document", location: "Supabase / ops / 職務.md" },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.role");
  });
});

describe("ingressHandoff admin MCP tools", () => {
  test("ingressHandoff.get returns policy without approval (read-only)", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool("ingressHandoff.get", {}, demoCred());
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.policy).toBeDefined();
    expect(data.summaryJa).toBeDefined();
    expect(data.nextStepJa).toBeDefined();
    const policy = data.policy as OrgIngressHandoffPolicy;
    expect(policy.version).toBe(1);
    expect(policy.rules.length).toBeGreaterThan(0);
  });

  test("ingressHandoff.get returns convenience default for new org", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool("ingressHandoff.get", {}, demoCred());
    const data = result.structuredContent as Record<string, unknown>;
    const policy = data.policy as OrgIngressHandoffPolicy;
    expect(policy.rules[0].applyTo).toBe("all");
    expect(policy.rules[0].body).toBe("full");
    expect(policy.rules[0].attachment).toBe("meta");
    expect(policy.rules[0].sealith).toBe("off");
  });

  test("ingressHandoff.patch queues always_human approval", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      {
        rules: [
          {
            applyTo: "classified_external_sensitive",
            body: "prefix",
            bodyPrefixChars: 200,
            attachment: "none",
            sealith: "required",
          },
          {
            applyTo: "all",
            body: "full",
            attachment: "meta",
            sealith: "off",
          },
        ],
      },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditClass).toBe("admin");
    expect(data.auditAction).toBe("admin.ingressHandoff");
    expect(data.approvalId).toBeTruthy();
  });

  test("ingressHandoff.patch validates rules before queueing", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      {
        rules: [
          {
            applyTo: "invalid_value",
            body: "full",
            attachment: "meta",
            sealith: "off",
          },
        ],
      },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("validation_failed");
    expect(data.errors).toBeDefined();
  });

  test("ingressHandoff.patch rejects empty rules array", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool("ingressHandoff.patch", { rules: [] }, demoCred());
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("validation_failed");
  });

  test("ingressHandoff.patch requires bodyPrefixChars when body=prefix", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      {
        rules: [
          {
            applyTo: "all",
            body: "prefix",
            attachment: "meta",
            sealith: "off",
          },
        ],
      },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("validation_failed");
  });

  test("ingressHandoff tool names are in admin catalog", () => {
    expect(ADMIN_MCP_TOOL_NAMES).toContain("ingressHandoff.get");
    expect(ADMIN_MCP_TOOL_NAMES).toContain("ingressHandoff.patch");
  });

  test("ingressHandoff.get is read-only (no always_human in description)", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === "ingressHandoff.get");
    expect(tool).toBeDefined();
    expect(tool?.description.includes("read-only")).toBe(true);
    expect(tool?.description.includes("no approval required")).toBe(true);
  });

  test("ingressHandoff.patch is always_human", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === "ingressHandoff.patch");
    expect(tool).toBeDefined();
    expect(tool?.description.includes("always_human")).toBe(true);
  });
});
