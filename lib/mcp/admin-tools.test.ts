import { describe, expect, test } from "bun:test";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { STAFFPASS_MCP_TOOL_NAMES } from "@/lib/mcp/public";
import {
  ADMIN_MCP_TOOLS,
  DECISION_DEPUTY_ACTIVATE_TOOL_DEF_UNWIRED,
  adminToolsAlwaysHuman,
  callAdminMcpTool,
  isAdminMcpToolName,
} from "@/lib/mcp/admin-tools";
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

describe("employee MCP tool list", () => {
  test("employee MCP includes whoami / invoke / poll / health / stuck watch / decision_request", () => {
    expect(EMPLOYEE_NAMES).toEqual([
      "staffpass_whoami",
      "staffpass_invoke",
      "staffpass_get_approval_status",
      "staffpass_health",
      "staffpass_stuck_list",
      "staffpass_stuck_retry",
      "staffpass_decision_request",
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

/**
 * Classification of every Admin MCP tool. These lists are deliberately
 * hand-maintained: adding a tool that bypasses the always_human ticket
 * (no approvalClass) must be a visible, reviewed edit here.
 */
// Read-only diagnostics / no-ticket ops actions (registry: no approvalClass).
const READ_ONLY_TOOLS = [
  "setup.slackStatus",
  "setup.connectInternalBase",
  "setup.lineApprovalStatus",
  "setup.approverBindingStatus",
  "ingressHandoff.get",
  "schedulingPolicy.get",
  "replyPolicy.get",
  "mailPolicy.get",
  "internalAudienceRule.get",
  "stuckWatch.get",
  "stuckWatch.list",
  "stuckWatch.inspect",
  "stuckWatch.classify",
  "orgs.status",
  "approvalWorkflow.get",
  "approvalWorkflow.inspect",
  "approvalWorkflow.listVoterBindings",
  "approvalRoutes.get",
  "employeeIdentity.status",
  "setup.slackDmApprovalStatus",
  "dmAutoroute.list",
  "employees.allowedAccounts.list",
  "channels.list",
  "parties.list",
];
// No-ticket WRITE actions (registry: no approvalClass). NOT always_human: they
// act on an existing stuck watch item and write an audit row; retry also
// re-runs an already-approved fulfill or re-submits the stored invoke through
// the gateway (gates re-evaluated). Their descriptions must not say read-only.
const NO_TICKET_WRITE_TOOLS = ["stuckWatch.retry", "stuckWatch.resolve"];
// Platform super-admin direct actions: NOT always_human by design (the
// platform-ops human is the decider), fail-closed for tenant admins.
const PLATFORM_OPS_DIRECT_TOOLS = ["orgs.patch", "approvals.proxyResolve"];
// KNOWN EXCEPTION (reported, not fixed here): registry marks it
// approvalClass "admin", but it runs directly with no ticket (re-sends the
// verification DM for an EXISTING pending binding; grants no authority).
// Needs a decision: make it ticketed, or reclassify it as no-ticket.
const KNOWN_TICKETLESS_EXECUTE_TOOLS = ["approvalWorkflow.resendVoterVerification"];
// Tools added by #237 (Slack DM setup).
const SLACK_DM_SETUP_EXECUTE_TOOLS = ["dmAutoroute.run", "setup.approvalDelivery.autoResolve"];

const NOT_ALWAYS_HUMAN_RE = /NOT (wrapped in another )?always_human/i;

function noTicketToolNames(tools: Array<{ name: string; approvalClass?: string }>): string[] {
  return tools.filter((t) => t.approvalClass === undefined).map((t) => t.name).sort();
}

describe("admin MCP always_human", () => {
  test("advertised tools (tools/list) === callable tool names, no duplicates", () => {
    expect(adminToolsAlwaysHuman()).toBe(true);
    const advertised = ADMIN_MCP_TOOLS.map((t) => t.name);
    expect(advertised).toEqual([...ADMIN_MCP_TOOL_NAMES]);
    expect(new Set(advertised).size).toBe(advertised.length);
    for (const name of advertised) expect(isAdminMcpToolName(name)).toBe(true);
  });

  test("every advertised tool is dispatched (callable): none answers unknown_mcp_tool or throws", async () => {
    // Empty args: each tool must reach its own handler (validation error,
    // needs_approval, feature_disabled, platform_ops_forbidden …), never the
    // unknown-tool fallback. Org comes only from the credential.
    for (const name of ADMIN_MCP_TOOL_NAMES) {
      let code: unknown;
      try {
        const result = await callAdminMcpTool(name, {}, demoCred());
        code = (result.structuredContent as Record<string, unknown> | undefined)?.code;
      } catch (error) {
        code = `threw:${error instanceof Error ? error.message : String(error)}`;
      }
      expect({ name, unknown: code === "unknown_mcp_tool", threw: String(code ?? "").startsWith("threw:") }).toEqual({ name, unknown: false, threw: false });
    }
  });

  test("the only no-ticket tools are the reviewed read-only + platform-ops lists", () => {
    expect(noTicketToolNames(ADMIN_MCP_TOOLS)).toEqual(
      [...READ_ONLY_TOOLS, ...NO_TICKET_WRITE_TOOLS, ...PLATFORM_OPS_DIRECT_TOOLS].sort()
    );
  });

  test("every other (execute) tool is approvalClass admin and always_human", () => {
    const executeTools = ADMIN_MCP_TOOLS.filter(
      (t) =>
        !READ_ONLY_TOOLS.includes(t.name) &&
        !NO_TICKET_WRITE_TOOLS.includes(t.name) &&
        !PLATFORM_OPS_DIRECT_TOOLS.includes(t.name)
    );
    // Sanity: the check really covers the tool set (incl. #237 tools).
    expect(executeTools.length).toBe(
      ADMIN_MCP_TOOLS.length -
        READ_ONLY_TOOLS.length -
        NO_TICKET_WRITE_TOOLS.length -
        PLATFORM_OPS_DIRECT_TOOLS.length
    );
    for (const name of SLACK_DM_SETUP_EXECUTE_TOOLS) {
      expect(executeTools.map((t) => t.name)).toContain(name);
    }
    for (const tool of executeTools) {
      expect({ name: tool.name, approvalClass: tool.approvalClass }).toEqual({
        name: tool.name,
        approvalClass: "admin",
      });
      if (KNOWN_TICKETLESS_EXECUTE_TOOLS.includes(tool.name)) continue;
      expect({ name: tool.name, alwaysHuman: tool.description.includes("always_human") }).toEqual({
        name: tool.name,
        alwaysHuman: true,
      });
      // "NOT always_human" must not satisfy the substring check above.
      expect({ name: tool.name, negated: NOT_ALWAYS_HUMAN_RE.test(tool.description) }).toEqual({
        name: tool.name,
        negated: false,
      });
    }
  });

  test("read-only tools say read-only and never claim always_human", () => {
    for (const toolName of READ_ONLY_TOOLS) {
      const tool = ADMIN_MCP_TOOLS.find((t) => t.name === toolName);
      expect({ toolName, readOnly: tool?.description.includes("read-only") }).toEqual({ toolName, readOnly: true });
      expect({ toolName, alwaysHuman: tool?.description.includes("always_human") }).toEqual({
        toolName,
        alwaysHuman: false,
      });
    }
  });

  test("no-ticket write tools (stuckWatch.retry / resolve) say they write, are explicit NOT always_human, never read-only", () => {
    for (const toolName of NO_TICKET_WRITE_TOOLS) {
      const tool = ADMIN_MCP_TOOLS.find((t) => t.name === toolName);
      expect(tool?.approvalClass).toBeUndefined();
      expect({ toolName, readOnly: /read-only/i.test(tool?.description || "") }).toEqual({ toolName, readOnly: false });
      expect(tool?.description).toMatch(NOT_ALWAYS_HUMAN_RE);
      expect(tool?.description).toContain("Writes:");
      expect(tool?.description).toContain(`${toolName.replace("stuckWatch.", "stuck_watch.")} audit event`);
    }
    const retry = ADMIN_MCP_TOOLS.find((t) => t.name === "stuckWatch.retry");
    expect(retry?.description).toContain("already-approved fulfillment");
    expect(retry?.description).toContain("gates are re-evaluated");
  });

  test("platform-ops direct tools are explicit NOT always_human and fail closed for a tenant admin", async () => {
    for (const toolName of PLATFORM_OPS_DIRECT_TOOLS) {
      const tool = ADMIN_MCP_TOOLS.find((t) => t.name === toolName);
      expect(tool?.description).toMatch(NOT_ALWAYS_HUMAN_RE);
      expect(tool?.description).toContain("Platform super-admin only");
      const result = await callAdminMcpTool(toolName, {}, demoCred());
      expect(result.isError).toBe(true);
      expect((result.structuredContent as Record<string, unknown>).code).toBe("platform_ops_forbidden");
    }
  });

  test("known ticketless execute tool is still documented as such (see KNOWN_TICKETLESS_EXECUTE_TOOLS)", () => {
    for (const toolName of KNOWN_TICKETLESS_EXECUTE_TOOLS) {
      const tool = ADMIN_MCP_TOOLS.find((t) => t.name === toolName);
      expect(tool?.approvalClass).toBe("admin");
      expect(tool?.description.includes("always_human")).toBe(false);
      expect(tool?.description).toContain("Does not create new authority");
    }
  });

  test("decision.deputyActivate is neither advertised nor callable (unchanged fail-closed)", async () => {
    expect(DECISION_DEPUTY_ACTIVATE_TOOL_DEF_UNWIRED.name).toBe("decision.deputyActivate");
    expect(ADMIN_MCP_TOOLS.some((t) => t.name === "decision.deputyActivate")).toBe(false);
    expect(isAdminMcpToolName("decision.deputyActivate")).toBe(false);
    const result = await callAdminMcpTool(
      "decision.deputyActivate",
      { approvalId: "apr_x", deputyUserId: "user_x" },
      demoCred()
    );
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Record<string, unknown>).code).toBe("unknown_mcp_tool");
  });

  test("#237 tools: status/list read-only; run/autoResolve always_human", () => {
    const byName = (n: string) => ADMIN_MCP_TOOLS.find((t) => t.name === n);
    for (const n of ["setup.slackDmApprovalStatus", "dmAutoroute.list"]) {
      expect(byName(n)?.approvalClass).toBe(undefined);
      expect(byName(n)?.description.includes("read-only")).toBe(true);
    }
    for (const n of SLACK_DM_SETUP_EXECUTE_TOOLS) {
      expect(byName(n)?.approvalClass).toBe("admin");
      expect(byName(n)?.description.includes("always_human")).toBe(true);
    }
  });

  test("ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY=ON does not change the registry: dmAutoroute.run stays always_human", async () => {
    const prev = process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY;
    process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY = "true";
    try {
      // Fresh module instance evaluated with the flag ON (the flag is a
      // runtime bypass inside dmAutoroute.run only, never a classification).
      const freshSpecifier = "./admin-tools.ts?audit_only_on"; // query string → new module instance in bun
      const fresh = (await import(freshSpecifier)) as typeof import("./admin-tools");
      expect(fresh.ADMIN_MCP_TOOLS).not.toBe(ADMIN_MCP_TOOLS);
      expect(noTicketToolNames(fresh.ADMIN_MCP_TOOLS)).toEqual(noTicketToolNames(ADMIN_MCP_TOOLS));
      for (const n of SLACK_DM_SETUP_EXECUTE_TOOLS) {
        const tool = fresh.ADMIN_MCP_TOOLS.find((t) => t.name === n);
        expect(tool?.approvalClass).toBe("admin");
        expect(tool?.description.includes("always_human")).toBe(true);
        expect(fresh.isAdminMcpToolName(n)).toBe(true);
      }
    } finally {
      if (prev === undefined) delete process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY;
      else process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY = prev;
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
    expect(data.code).toBe("rules_required");
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

  test("ingressHandoff.get accepts employeeId parameter", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === "ingressHandoff.get");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty("employeeId");
    expect(tool?.description.includes("AI社員ごと")).toBe(true);
  });

  test("ingressHandoff.patch accepts employeeId and clearOverride parameters", () => {
    const tool = ADMIN_MCP_TOOLS.find((t) => t.name === "ingressHandoff.patch");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty("employeeId");
    expect(tool?.inputSchema.properties).toHaveProperty("clearOverride");
    expect(tool?.description.includes("AI社員ごと")).toBe(true);
  });
});

describe("ingressHandoff per-employee admin MCP", () => {
  test("ingressHandoff.get with employeeId returns effective policy with layers", async () => {
    resetDemoIngressHandoffPolicy();
    const [employee] = await listEmployees(DEMO_ORG.id);
    expect(Boolean(employee)).toBe(true);

    const result = await callAdminMcpTool(
      "ingressHandoff.get",
      { employeeId: employee.id },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.policy).toBeDefined();
    expect(data.source).toBeDefined();
    expect(data.sourceJa).toBeDefined();
    expect(data.layers).toBeDefined();
    const layers = data.layers as Record<string, unknown>;
    expect(layers).toHaveProperty("employeeOverride");
    expect(layers).toHaveProperty("orgPolicy");
  });

  test("ingressHandoff.get with invalid employeeId returns error", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool(
      "ingressHandoff.get",
      { employeeId: "nonexistent" },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("employee_not_found");
  });

  test("ingressHandoff.patch with employeeId queues per-employee approval", async () => {
    resetDemoIngressHandoffPolicy();
    const [employee] = await listEmployees(DEMO_ORG.id);
    expect(Boolean(employee)).toBe(true);

    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      {
        employeeId: employee.id,
        rules: [
          {
            applyTo: "all",
            body: "none",
            attachment: "none",
            sealith: "required",
          },
        ],
      },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(String(data.summary || "")).toContain("AI社員ごと");
  });

  test("ingressHandoff.patch clearOverride requires employeeId", async () => {
    resetDemoIngressHandoffPolicy();
    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      { clearOverride: true },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("clear_requires_employee");
  });

  test("ingressHandoff.patch clearOverride with employeeId queues approval", async () => {
    resetDemoIngressHandoffPolicy();
    const [employee] = await listEmployees(DEMO_ORG.id);
    expect(Boolean(employee)).toBe(true);

    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      {
        employeeId: employee.id,
        clearOverride: true,
      },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(String(data.summary || "")).toContain("クリア");
  });

  test("ingressHandoff.patch without rules or clearOverride fails", async () => {
    resetDemoIngressHandoffPolicy();
    const [employee] = await listEmployees(DEMO_ORG.id);
    expect(Boolean(employee)).toBe(true);

    const result = await callAdminMcpTool(
      "ingressHandoff.patch",
      { employeeId: employee.id },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("rules_required");
  });
});
