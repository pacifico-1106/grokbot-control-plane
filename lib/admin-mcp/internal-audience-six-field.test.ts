/**
 * PR-2: internalAudienceRule.patch writes target org_internal_audience_rule,
 * requires reason + result, and never stores the full rule when the six-field
 * flag is ON. Flag OFF keeps today's metadata.rule payload.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { resolveApproval } from "@/lib/data";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const FLAG = "ADMIN_AUDIT_SIX_FIELD_WRITE_ENABLED";
const ORGS = "ADMIN_AUDIT_SIX_FIELD_WRITE_ORG_IDS";
const APPROVER = "reviewer@example.com";
const DOMAIN = "six-field-internal.example";
const saved: { flag?: string; orgs?: string } = {};

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
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

async function fulfillInternalAudience() {
  const queued = await callAdminMcpTool(
    "internalAudienceRule.patch",
    { emailDomains: [DOMAIN] },
    demoCred()
  );
  const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId || "");
  expect(approvalId).toBeTruthy();
  const approved = await resolveApproval(approvalId, "approved", APPROVER, DEMO_ORG.id, {
    actorId: "mem_reviewer",
  });
  expect(approved).toBeTruthy();
  const fulfillment = await fulfillApprovedAdmin(approved!);
  expect(fulfillment?.ok).toBe(true);
  return {
    approvalId,
    row: getRuntimeAudit().find(
      (e) =>
        e.action === "admin.policy" &&
        e.metadata?.approvalId === approvalId &&
        !String(e.summary || "").startsWith("承認待ち")
    ),
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

describe("internalAudienceRule.patch six-field", () => {
  test("flag OFF: still stores the rule object (regression)", async () => {
    const { row } = await fulfillInternalAudience();
    expect(row).toBeTruthy();
    expect(row!.metadata?.rule).toBeTruthy();
    expect(JSON.stringify(row!.metadata?.rule)).toContain(DOMAIN);
    expect(row!.metadata?.target).toBeUndefined();
    expect(row!.metadata?.result).toBeUndefined();
  });

  test("flag ON: target / reason / result required and no rule text", async () => {
    process.env[FLAG] = "true";
    const { row } = await fulfillInternalAudience();
    expect(row).toBeTruthy();
    expect(row!.metadata?.target).toEqual({
      type: "org_internal_audience_rule",
      id: DEMO_ORG.id,
    });
    const reason = row!.metadata?.reason as { code?: string; labelJa?: string };
    expect(typeof reason?.code).toBe("string");
    expect(reason!.code!.length).toBeGreaterThan(0);
    expect(reason!.labelJa).toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    expect(row!.metadata?.result).toBe("success");
    expect(row!.metadata?.rule).toBeUndefined();
    const blob = JSON.stringify(row!.metadata);
    expect(blob).not.toContain(DOMAIN);
    expect(blob).not.toMatch(/gb_adm_|gb_emp_|sp_at_/);
    const hash = row!.metadata?.ruleHashPrefix;
    if (typeof hash === "string") expect(hash.length).toBeLessThanOrEqual(12);
  });
});
