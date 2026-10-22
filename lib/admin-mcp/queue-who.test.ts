/**
 * PR-1: admin MCP queue writes a displayable who.
 * Flag ON → actorKind=system + actorLabel (no fabricated email).
 * Flag OFF → today's admin_agent row with empty actor_email.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const FLAG = "ADMIN_AUDIT_WHO_REQUIRED_ENABLED";
const ORGS = "ADMIN_AUDIT_WHO_REQUIRED_ORG_IDS";
const saved: { flag?: string; orgs?: string } = {};

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent();
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId || null,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

beforeEach(() => {
  saved.flag = process.env[FLAG];
  saved.orgs = process.env[ORGS];
  delete process.env[FLAG];
  delete process.env[ORGS];
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  if (saved.orgs === undefined) delete process.env[ORGS];
  else process.env[ORGS] = saved.orgs;
});

async function queueHire() {
  return queueAdminTool({
    cred: demoCred(),
    tool: "employees.issue",
    args: { displayName: "who-queue", roleLabel: "テスト", scopes: ["mail:draft"] },
    summary: "who queue fixture",
  });
}

function latestHire() {
  return getRuntimeAudit().find(
    (e) => e.orgId === DEMO_ORG.id && e.action === "admin.hire" && e.summary?.includes("承認待ち")
  );
}

describe("admin MCP queue who", () => {
  test("flag OFF: pending row stays admin_agent with empty email (regression)", async () => {
    const result = await queueHire();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("needs_approval");
    const row = latestHire();
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("admin_agent");
    expect(row!.actorEmail ?? null).toBeNull();
    expect(row!.metadata?.actorLabel).toBeUndefined();
    expect(row!.metadata?.adminAgentId).toBe(demoCred().adminAgentId);
  });

  test("flag ON: pending row is system + actorLabel and never fabricates email", async () => {
    process.env[FLAG] = "true";
    const result = await queueHire();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("needs_approval");
    const row = latestHire();
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("system");
    expect(String(row!.metadata?.actorLabel || "").trim().length).toBeGreaterThan(0);
    expect(String(row!.metadata?.actorLabel)).not.toMatch(/@/);
    expect(row!.actorEmail ?? null).toBeNull();
    expect(JSON.stringify(row!.metadata)).not.toMatch(/gb_adm_|gb_emp_|sp_at_/);
  });
});
