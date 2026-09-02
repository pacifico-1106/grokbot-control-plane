import { describe, expect, test } from "bun:test";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { STAFFPASS_MCP_TOOL_NAMES } from "@/lib/mcp/public";
import { ADMIN_MCP_TOOLS, adminToolsAlwaysHuman, callAdminMcpTool, isAdminMcpToolName } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES, ADMIN_MCP_SERVER_NAME } from "@/lib/mcp/admin-public";
import { MCP_SERVER_NAME } from "@/lib/mcp/tools";
import { listEmployees } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

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
  test("all admin tools are always_human", () => {
    expect(adminToolsAlwaysHuman()).toBe(true);
    expect(ADMIN_MCP_TOOLS.map((t) => t.name)).toEqual([...ADMIN_MCP_TOOL_NAMES]);
    expect(ADMIN_MCP_TOOLS.every((t) => t.description.includes("always_human"))).toBe(true);
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
