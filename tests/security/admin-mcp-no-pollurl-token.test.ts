/**
 * Admin / config MCP must never echo a token-bearing poll URL (or the token
 * itself) in a tool response, audit row, or error. Clients keep only approvalId
 * and re-invoke the same tool.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { listEmployees } from "@/lib/data";
import { listAuditEvents } from "@/lib/data/audit";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { createConfigChangeRequest } from "@/lib/config-change-request/service";

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

const TOKEN_KEYS = ["pollUrl", "pollPath", "statusToken", "poll_path", "status_token"] as const;
const TOKEN_URL_RE = /\/api\/approvals\/status\?[^\s"'<>]*token=/i;

function leakedPayload(value: unknown): string[] {
  const hits: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string) => {
    if (node == null || seen.has(node)) return;
    if (typeof node === "string") {
      if (TOKEN_URL_RE.test(node)) hits.push(`${path}: token-bearing URL`);
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if ((TOKEN_KEYS as readonly string[]).includes(key) && child != null && child !== "") {
        hits.push(`${path}.${key}`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(value, "root");
  return hits;
}

function assertNoTokenLeak(value: unknown, label: string) {
  const hits = leakedPayload(value);
  expect(hits, `${label} leaked ${hits.join(", ")}`).toEqual([]);
  const blob = JSON.stringify(value);
  expect(blob).not.toMatch(TOKEN_URL_RE);
  for (const key of TOKEN_KEYS) {
    expect(blob).not.toMatch(new RegExp(`"${key}"\\s*:`));
  }
}

describe("admin MCP never returns token-bearing poll URLs", () => {
  test("internalAudienceRule.patch pending response keeps approvalId only", async () => {
    const result = await callAdminMcpTool(
      "internalAudienceRule.patch",
      { emailDomains: ["internal.example"] },
      demoCred()
    );
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(typeof data.approvalId).toBe("string");
    expect(String(data.approvalId).length).toBeGreaterThan(0);
    assertNoTokenLeak(result, "internalAudienceRule.patch");
  });

  test("pending re-invoke of internalAudienceRule.patch still omits tokens", async () => {
    const cred = demoCred();
    const queued = await callAdminMcpTool(
      "internalAudienceRule.patch",
      { emailDomains: ["reinvoke.example"] },
      cred
    );
    const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    const again = await callAdminMcpTool("internalAudienceRule.patch", { approvalId }, cred);
    const data = again.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.approvalId).toBe(approvalId);
    assertNoTokenLeak(again, "internalAudienceRule.patch reinvoke");
  });

  test("other admin.* / policy tools have the same pending shape", async () => {
    const cred = demoCred();
    const [employee] = await listEmployees(DEMO_ORG.id);
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      {
        tool: "policy.patch",
        args: {
          employeeId: employee.id,
          scopes: employee.scopes,
          allowedPurposes: employee.allowedPurposes,
          approvalPolicy: employee.approvalPolicy,
        },
      },
      {
        tool: "mailPolicy.patch",
        args: { rules: [{ id: "mpr_test", audience: "external", sendMode: "draft_only" }] },
      },
      {
        tool: "ingressHandoff.patch",
        args: {
          rules: [
            { applyTo: "all", body: "full", attachment: "meta", sealith: "off" },
          ],
        },
      },
    ];
    for (const { tool, args } of cases) {
      const result = await callAdminMcpTool(tool, args, cred);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.needs_approval, tool).toBe(true);
      expect(data.approvalId, tool).toBeTruthy();
      assertNoTokenLeak(result, tool);
    }
  });

  test("admin.policy queue audit and errors omit poll tokens", async () => {
    const cred = demoCred();
    const result = await callAdminMcpTool(
      "internalAudienceRule.patch",
      { slackTeamIds: ["TTOKENTEST"] },
      cred
    );
    const data = result.structuredContent as Record<string, unknown>;
    const approvalId = String(data.approvalId);
    const audits = await listAuditEvents(DEMO_ORG.id, 50);
    const related = audits.filter(
      (row) =>
        row.metadata?.approvalId === approvalId ||
        (row.action === "admin.policy" && row.metadata?.tool === "internalAudienceRule.patch")
    );
    expect(related.length).toBeGreaterThan(0);
    for (const row of related) {
      assertNoTokenLeak(row, `audit ${row.id}`);
    }

    const denied = await callAdminMcpTool(
      "approvals.proxyResolve",
      { orgId: DEMO_ORG.id, approvalId, decision: "approved", mandate: "setup" },
      cred
    );
    assertNoTokenLeak(denied, "approvals.proxyResolve error");
  });
});

describe("config tools never return token-bearing poll URLs", () => {
  test("config.change_request pending result has approvalId, not pollUrl", async () => {
    process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED = "1";
    const created = await createConfigChangeRequest(
      {
        orgId: DEMO_ORG.id,
        employeeId: "emp_sales",
        credentialId: "cred_emp_sales",
        args: {
          kind: "instructions",
          jobId: `job_pollurl_${Date.now().toString(36)}`,
          requestedBy: { name: "山田", slackUserId: "UTEST" },
          reason: "敬語を統一したい",
          instructions: { mode: "replace", text: "お客様には必ず敬語で返信する。" },
        },
      },
      {
        resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
        notify: async () => true,
      }
    );
    expect(created.code).toBe("needs_approval");
    expect("approvalId" in created && created.approvalId).toBeTruthy();
    expect("pollUrl" in created && (created as { pollUrl?: unknown }).pollUrl).toBeFalsy();
    const blob = JSON.stringify(created);
    expect(blob).not.toMatch(TOKEN_URL_RE);
    expect(blob).not.toMatch(/"pollUrl"\s*:/);
    const audits = await listAuditEvents(DEMO_ORG.id, 30);
    const row = audits.find(
      (event) =>
        event.action === "config.change_requested" &&
        event.metadata?.approvalId === (created as { approvalId: string }).approvalId
    );
    expect(row).toBeTruthy();
    assertNoTokenLeak(row, "config.change_requested audit");
  });
});

describe("admin/config sources do not assign pollUrl on MCP-facing results", () => {
  test("queue and admin/config handlers omit pollUrl from returned objects", () => {
    const root = join(import.meta.dir, "../..");
    const files = [
      "lib/admin-mcp/queue.ts",
      "lib/mcp/admin-tools.ts",
      "lib/config-change-request/service.ts",
      "lib/approval-kind-routes/mcp-handlers.ts",
      "lib/external-contract-card/queue-card-setup.ts",
      "lib/external-contract-card/queue-portal-link.ts",
    ];
    const offenders: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      if (/pollUrl:\s*(created|result|buildPollUrl|approval)/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
