/**
 * PR-2: admin MCP queue writes the six-field contract when the flag is ON.
 * Pending queue = result pending. Denial = result denied. Flag OFF unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const FLAG = "ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED";
const ORGS = "ADMIN_AUDIT_SIX_FIELD_WRITE_ORG_IDS";
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
    args: { displayName: "six-queue", roleLabel: "テスト", scopes: ["mail:draft"] },
    summary: "six field queue fixture",
  });
}

function latestHire() {
  return getRuntimeAudit().find(
    (e) => e.orgId === DEMO_ORG.id && e.action === "admin.hire" && e.summary?.includes("承認待ち")
  );
}

describe("admin MCP queue six-field", () => {
  test("flag OFF: pending row has no target / structured reason / result", async () => {
    const result = await queueHire();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("needs_approval");
    const row = latestHire();
    expect(row).toBeTruthy();
    expect(row!.metadata?.target).toBeUndefined();
    expect(row!.metadata?.result).toBeUndefined();
    expect(typeof row!.metadata?.reason === "object" && row!.metadata?.reason !== null).toBe(false);
    expect(row!.metadata?.actorKind).toBe("admin_agent");
  });

  test("flag ON: pending row has six fields and result=pending", async () => {
    process.env[FLAG] = "true";
    const result = await queueHire();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("needs_approval");
    const row = latestHire();
    expect(row).toBeTruthy();
    expect(row!.action).toBe("admin.hire");
    expect(row!.createdAt).toBeTruthy();
    expect(row!.metadata?.target).toEqual({
      type: "approval",
      id: expect.any(String),
    });
    expect((row!.metadata?.target as { id?: string }).id).toBeTruthy();
    const reason = row!.metadata?.reason as { code?: string; labelJa?: string };
    expect(reason.code).toBe("needs_approval");
    expect(reason.labelJa).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    expect(reason.labelJa).not.toMatch(/@|gb_adm_|gb_emp_/);
    expect(row!.metadata?.result).toBe("pending");
    expect(JSON.stringify(row!.metadata)).not.toMatch(/gb_adm_|gb_emp_|sp_at_/);
  });
});
