import { afterEach, describe, expect, test } from "bun:test";
import { assertPlatformOpsFromAdminCred } from "@/lib/admin/platform-ops-gate";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

function demoCred(orgId = DEMO_ORG.id): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
  return {
    orgId,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent: { ...agent, orgId },
  };
}

const envBackup = {
  userIds: process.env.SUPER_ADMIN_USER_IDS,
  emails: process.env.SUPER_ADMIN_EMAILS,
  platformOrgId: process.env.PLATFORM_OPS_ORG_ID,
};

afterEach(() => {
  process.env.SUPER_ADMIN_USER_IDS = envBackup.userIds;
  process.env.SUPER_ADMIN_EMAILS = envBackup.emails;
  process.env.PLATFORM_OPS_ORG_ID = envBackup.platformOrgId;
});

describe("platform ops gate", () => {
  test("allows demo org owner when allowlist matches", async () => {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    delete process.env.PLATFORM_OPS_ORG_ID;
    const result = await assertPlatformOpsFromAdminCred(demoCred());
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.actor.email).toBe("owner@example.com");
      expect(result.actor.orgId).toBe(DEMO_ORG.id);
    }
  });

  test("rejects when owner is not on super admin allowlist", async () => {
    process.env.SUPER_ADMIN_EMAILS = "ops@other-company.example";
    delete process.env.PLATFORM_OPS_ORG_ID;
    const result = await assertPlatformOpsFromAdminCred(demoCred());
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("platform_ops_forbidden");
    }
  });

  test("rejects when PLATFORM_OPS_ORG_ID does not match caller org", async () => {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    process.env.PLATFORM_OPS_ORG_ID = "org_other_platform_ops";
    const result = await assertPlatformOpsFromAdminCred(demoCred());
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("platform_ops_forbidden");
    }
  });
});
