import { afterEach, describe, expect, test } from "bun:test";
import {
  validateOrgPatchInput,
  platformPatchOrg,
  ORG_NAME_MAX_LENGTH,
} from "@/lib/admin-mcp/orgs-patch";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
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

const envBackup = {
  emails: process.env.SUPER_ADMIN_EMAILS,
  platformOrgId: process.env.PLATFORM_OPS_ORG_ID,
};

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = envBackup.emails;
  process.env.PLATFORM_OPS_ORG_ID = envBackup.platformOrgId;
  DEMO_ORG.name = "デモ株式会社";
});

function allowPlatformOpsInDemo() {
  process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
  delete process.env.PLATFORM_OPS_ORG_ID;
}

describe("orgs.patch validation", () => {
  test("requires orgId", () => {
    const result = validateOrgPatchInput({ name: "New Name" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("org_id_required");
    }
  });

  test("requires name", () => {
    const result = validateOrgPatchInput({ orgId: "test-org" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("name_required");
    }
  });

  test("rejects empty name after trim", () => {
    const result = validateOrgPatchInput({ orgId: "test-org", name: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("name_required");
    }
  });

  test("rejects name exceeding max length", () => {
    const longName = "あ".repeat(ORG_NAME_MAX_LENGTH + 1);
    const result = validateOrgPatchInput({ orgId: "test-org", name: longName });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("name_too_long");
    }
  });

  test("accepts valid input", () => {
    const result = validateOrgPatchInput({
      orgId: "test-org",
      name: "トーキョーサンマルサンマルナナ株式会社",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgId).toBe("test-org");
      expect(result.value.name).toBe("トーキョーサンマルサンマルナナ株式会社");
    }
  });

  test("trims name", () => {
    const result = validateOrgPatchInput({
      orgId: "  test-org  ",
      name: "  New Name  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgId).toBe("test-org");
      expect(result.value.name).toBe("New Name");
    }
  });
});

describe("orgs.patch admin MCP", () => {
  test("rejects normal tenant without platform allowlist", async () => {
    process.env.SUPER_ADMIN_EMAILS = "ops@other-company.example";
    const result = await callAdminMcpTool(
      "orgs.patch",
      {
        orgId: DEMO_ORG.id,
        name: "トーキョーサンマルサンマルナナ株式会社",
      },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("platform_ops_forbidden");
  });

  test("executes immediately when platform ops allowed (NOT always_human)", async () => {
    allowPlatformOpsInDemo();
    const previousName = DEMO_ORG.name;
    const newName = "トーキョーサンマルサンマルナナ株式会社";
    
    const result = await callAdminMcpTool(
      "orgs.patch",
      {
        orgId: DEMO_ORG.id,
        name: newName,
      },
      demoCred()
    );
    
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.previousName).toBe(previousName);
    expect(data.newName).toBe(newName);
    expect(data.needs_approval).toBeUndefined();
    expect(data.always_human).toBeUndefined();
    expect(DEMO_ORG.name).toBe(newName);
  });

  test("returns no change when name is same", async () => {
    allowPlatformOpsInDemo();
    const currentName = DEMO_ORG.name;
    
    const result = await callAdminMcpTool(
      "orgs.patch",
      {
        orgId: DEMO_ORG.id,
        name: currentName,
      },
      demoCred()
    );
    
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.previousName).toBe(currentName);
    expect(data.newName).toBe(currentName);
    expect(DEMO_ORG.name).toBe(currentName);
  });

  test("rejects invalid name", async () => {
    allowPlatformOpsInDemo();
    
    const result = await callAdminMcpTool(
      "orgs.patch",
      {
        orgId: DEMO_ORG.id,
        name: "",
      },
      demoCred()
    );
    
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("name_required");
  });

  test("rejects name exceeding max length", async () => {
    allowPlatformOpsInDemo();
    const longName = "あ".repeat(ORG_NAME_MAX_LENGTH + 1);
    
    const result = await callAdminMcpTool(
      "orgs.patch",
      {
        orgId: DEMO_ORG.id,
        name: longName,
      },
      demoCred()
    );
    
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("name_too_long");
  });
});

describe("platformPatchOrg", () => {
  test("updates demo org name and returns summary", async () => {
    const previousName = DEMO_ORG.name;
    const newName = "株式会社スペースツリー";
    
    const result = await platformPatchOrg(
      { orgId: DEMO_ORG.id, name: newName },
      { email: "owner@example.com", userId: null, orgId: DEMO_ORG.id }
    );
    
    expect(result.orgId).toBe(DEMO_ORG.id);
    expect(result.previousName).toBe(previousName);
    expect(result.newName).toBe(newName);
    expect(result.summaryJa).toContain(previousName);
    expect(result.summaryJa).toContain(newName);
    expect(DEMO_ORG.name).toBe(newName);
  });
});
