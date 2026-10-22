/**
 * PR-1: card setup / portal mint queues go through appendAdminAuditEvent.
 * Flag ON → actorKind=system + actorLabel (no fabricated email).
 * Flag OFF → helper write as admin_agent with empty email (no raw admin.* append).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { EXTERNAL_CONTRACT_CARD_SETUP_FLAG } from "@/lib/external-contract-card/feature-flag";

const FLAG = "ADMIN_AUDIT_WHO_REQUIRED_ENABLED";
const ORGS = "ADMIN_AUDIT_WHO_REQUIRED_ORG_IDS";
const saved: { flag?: string; orgs?: string; card?: string } = {};

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
  saved.card = process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];
  delete process.env[FLAG];
  delete process.env[ORGS];
  process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = "1";
});

afterEach(() => {
  if (saved.flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved.flag;
  if (saved.orgs === undefined) delete process.env[ORGS];
  else process.env[ORGS] = saved.orgs;
  if (saved.card === undefined) delete process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];
  else process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG] = saved.card;
});

describe("card setup / portal who", () => {
  test("flag OFF: card setup goes through the helper as admin_agent with empty email", async () => {
    const { queueCardSetupLinkMint } = await import("@/lib/external-contract-card/queue-card-setup");
    const marker = `card_off_${Date.now()}`;
    const result = await queueCardSetupLinkMint({ cred: demoCred(), jobId: marker });
    expect(result.ok).toBe(false);
    if (result.ok === false && result.code === "needs_approval") {
      expect(result.auditAction).toBe("admin.card_setup_link_mint");
    }
    const row = getRuntimeAudit().find(
      (e) => e.action === "admin.card_setup_link_mint" && e.metadata?.approvalId && e.orgId === DEMO_ORG.id
    );
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("admin_agent");
    expect(row!.actorEmail ?? null).toBeNull();
    expect(row!.metadata?.actorLabel).toBeUndefined();
  });

  test("flag ON: card setup is system + actorLabel and never fabricates email", async () => {
    process.env[FLAG] = "true";
    const { queueCardSetupLinkMint } = await import("@/lib/external-contract-card/queue-card-setup");
    const result = await queueCardSetupLinkMint({ cred: demoCred(), jobId: `card_on_${Date.now()}` });
    expect(result.ok).toBe(false);
    const row = getRuntimeAudit().find(
      (e) => e.action === "admin.card_setup_link_mint" && e.orgId === DEMO_ORG.id
    );
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("system");
    expect(String(row!.metadata?.actorLabel || "").trim().length).toBeGreaterThan(0);
    expect(String(row!.metadata?.actorLabel)).not.toMatch(/@/);
    expect(row!.actorEmail ?? null).toBeNull();
  });

  test("flag ON: portal mint is system + actorLabel via the helper", async () => {
    process.env[FLAG] = "true";
    const { queuePortalLinkMint } = await import("@/lib/external-contract-card/queue-portal-link");
    const result = await queuePortalLinkMint({
      cred: demoCred(),
      purpose: "change",
      jobId: `portal_on_${Date.now()}`,
    });
    expect(result.ok).toBe(false);
    const row = getRuntimeAudit().find(
      (e) => e.action === "admin.card_portal_link_mint" && e.orgId === DEMO_ORG.id
    );
    expect(row).toBeTruthy();
    expect(row!.metadata?.actorKind).toBe("system");
    expect(String(row!.metadata?.actorLabel || "").trim().length).toBeGreaterThan(0);
    expect(row!.actorEmail ?? null).toBeNull();
  });
});
