import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ADMIN_MCP_TOOLS, callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { ADMIN_MCP_TOOL_NAMES } from "@/lib/mcp/admin-public";
import { auditActionForAdminTool } from "@/lib/admin-mcp/audit-class";
import { getToolApprovalKind } from "@/lib/approval-kind-routes/tool-kind-map";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
  return { orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id,
    generation: agent.credentialGeneration, via: "bearer", agent };
}
const KEYS = ["SPAM_ADMIN_TOOLS_ENABLED", "PLATFORM_OPS_ORG_ID", "SUPER_ADMIN_EMAILS"];
const backup = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
afterEach(() => KEYS.forEach((k) => (backup[k] === undefined ? delete process.env[k] : (process.env[k] = backup[k]))));

const SPAM_TOOLS = ["spam.scan", "accounts.suspend", "accounts.unsuspend", "accounts.delete"];
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("spam tools in Admin MCP registry", () => {
  test("registered, classified, mutating ones are always_human/admin", () => {
    for (const name of SPAM_TOOLS) {
      expect(ADMIN_MCP_TOOL_NAMES as readonly string[]).toContain(name);
      const def = ADMIN_MCP_TOOLS.find((t) => t.name === name);
      expect(def).toBeTruthy();
      expect(auditActionForAdminTool(name)).toMatch(/^admin\.spam_/);
    }
    expect(ADMIN_MCP_TOOLS.find((t) => t.name === "spam.scan")?.approvalClass).toBeUndefined();
    for (const name of ["accounts.suspend", "accounts.unsuspend", "accounts.delete"]) {
      const def = ADMIN_MCP_TOOLS.find((t) => t.name === name)!;
      expect(def.approvalClass).toBe("admin");
      expect(def.description).toContain("always_human");
      expect(getToolApprovalKind(name)).toBe("account");
    }
  });

  test("flag OFF (default) → feature_disabled for every spam tool, incl. approvalId reinvoke", async () => {
    for (const name of SPAM_TOOLS) {
      const r = parse(await callAdminMcpTool(name, { orgIds: ["aaaaaaaa-0000-4000-8000-000000000001"], reason: "spam wave", approvalId: "apr_x" }, demoCred()));
      expect(r.code).toBe("feature_disabled");
    }
  });

  test("flag ON but caller is not the platform ops org → platform_ops_forbidden", async () => {
    process.env.SPAM_ADMIN_TOOLS_ENABLED = "true";
    process.env.PLATFORM_OPS_ORG_ID = "92f3617c-0000-4000-8000-000000000000";
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    for (const name of SPAM_TOOLS) {
      const r = parse(await callAdminMcpTool(name, { orgIds: ["aaaaaaaa-0000-4000-8000-000000000001"], reason: "spam wave" }, demoCred()));
      expect(r.code).toBe("platform_ops_forbidden");
    }
  });
});
