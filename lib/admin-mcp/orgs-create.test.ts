import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clampTrialDays,
  validateOrgCreateInput,
  platformCreateOrg,
  platformOrgStatus,
} from "@/lib/admin-mcp/orgs-create";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { getApprovalById, listApprovals } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { resolveApproval } from "@/lib/data/approvals";

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
  encryptionKey: process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY,
};

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = envBackup.emails;
  process.env.PLATFORM_OPS_ORG_ID = envBackup.platformOrgId;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = envBackup.encryptionKey;
});

function allowPlatformOpsInDemo() {
  process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
  delete process.env.PLATFORM_OPS_ORG_ID;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY =
    "test-notification-encryption-key-32b";
}

const STRICT_FLAG = "ORG_NAME_INPUT_STRICT_ENABLED";
const savedStrict = process.env[STRICT_FLAG];

describe("orgs.create validation", () => {
  afterEach(() => {
    if (savedStrict === undefined) delete process.env[STRICT_FLAG];
    else process.env[STRICT_FLAG] = savedStrict;
  });

  test("trialDays defaults to 14 and rejects out of range", () => {
    expect(clampTrialDays(undefined)).toBe(14);
    expect(clampTrialDays(30)).toBe(30);
    expect(() => clampTrialDays(0)).toThrow();
    expect(() => clampTrialDays(400)).toThrow();
    expect(() => clampTrialDays("x")).toThrow();
  });

  test("requires password or invite for new users", () => {
    const missing = validateOrgCreateInput({
      orgName: "株式会社スペースツリー",
      ownerEmail: "k.nogi@spacetree.jp",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("password_or_invite_required");
    }

    const invite = validateOrgCreateInput({
      orgName: "株式会社スペースツリー",
      ownerEmail: "k.nogi@spacetree.jp",
      invite: true,
    });
    expect(invite.ok).toBe(true);

    const password = validateOrgCreateInput({
      orgName: "株式会社スペースツリー",
      ownerEmail: "k.nogi@spacetree.jp",
      ownerPassword: "secure-pass-123",
    });
    expect(password.ok).toBe(true);
  });

  describe("ORG_NAME_INPUT_STRICT_ENABLED flag", () => {
    describe("flag OFF (default)", () => {
      beforeEach(() => {
        delete process.env[STRICT_FLAG];
      });

      test("allows org name with bidi characters", () => {
        const result = validateOrgCreateInput({
          orgName: "Test\u202EOrg",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(true);
      });

      test("allows org name with URL-like string", () => {
        const result = validateOrgCreateInput({
          orgName: "example.com Corp",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(true);
      });
    });

    describe("flag ON", () => {
      beforeEach(() => {
        process.env[STRICT_FLAG] = "true";
      });

      test("rejects org name with bidi characters", () => {
        const result = validateOrgCreateInput({
          orgName: "Test\u202EOrg",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("invalid_org_name");
          expect(result.message).toContain("双方向");
          expect(result.message).not.toContain("Test");
          expect(result.nextStep).toBeTruthy();
        }
      });

      test("rejects org name with zero-width characters", () => {
        const result = validateOrgCreateInput({
          orgName: "Test\u200BOrg",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("invalid_org_name");
          expect(result.message).toContain("不可視");
        }
      });

      test("rejects org name with URL-like string (domain)", () => {
        const result = validateOrgCreateInput({
          orgName: "example.com Corp",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("invalid_org_name");
          expect(result.message).toContain("URL");
        }
      });

      test("rejects org name with https:// scheme", () => {
        const result = validateOrgCreateInput({
          orgName: "会社 https://evil.com",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain("URL");
      });

      test("allows legitimate Japanese company names", () => {
        const result = validateOrgCreateInput({
          orgName: "株式会社スペースツリー",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(true);
      });

      test("allows legitimate English company names", () => {
        const result1 = validateOrgCreateInput({
          orgName: "TOKYO307 Inc.",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result1.ok).toBe(true);

        const result2 = validateOrgCreateInput({
          orgName: "A&B Co., Ltd.",
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result2.ok).toBe(true);
      });

      test("rejects org name exceeding max length (200 for admin)", () => {
        // Admin path allows up to 200 characters when flag is ON
        const result = validateOrgCreateInput({
          orgName: "a".repeat(201),
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("invalid_org_name");
          expect(result.message).toContain("200");
        }
      });

      test("accepts org name at 150 characters (between signup 100 and admin 200)", () => {
        const result = validateOrgCreateInput({
          orgName: "a".repeat(150),
          ownerEmail: "test@example.com",
          invite: true,
        });
        expect(result.ok).toBe(true);
      });
    });
  });
});

describe("orgs.create admin MCP: ORG_NAME_INPUT_STRICT_ENABLED", () => {
  afterEach(() => {
    if (savedStrict === undefined) delete process.env[STRICT_FLAG];
    else process.env[STRICT_FLAG] = savedStrict;
  });

  describe("flag ON: invalid org name via MCP", () => {
    beforeEach(() => {
      process.env[STRICT_FLAG] = "true";
      allowPlatformOpsInDemo();
    });

    test("returns isError + code: invalid_org_name for bidi characters", async () => {
      const beforeApprovals = (await listApprovals(DEMO_ORG.id)).length;
      const result = await callAdminMcpTool(
        "orgs.create",
        {
          orgName: "株式会社\u202Eテスト",
          ownerEmail: "test@example.com",
          invite: true,
        },
        demoCred()
      );
      expect(result.isError).toBe(true);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.code).toBe("invalid_org_name");
      expect(data.nextStep).toBeTruthy();
      // No approval created (no side effects)
      expect((await listApprovals(DEMO_ORG.id)).length).toBe(beforeApprovals);
    });

    test("returns isError + code: invalid_org_name for URL-like string", async () => {
      const beforeApprovals = (await listApprovals(DEMO_ORG.id)).length;
      const result = await callAdminMcpTool(
        "orgs.create",
        {
          orgName: "https://malware.example.com",
          ownerEmail: "test@example.com",
          invite: true,
        },
        demoCred()
      );
      expect(result.isError).toBe(true);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.code).toBe("invalid_org_name");
      // No approval created
      expect((await listApprovals(DEMO_ORG.id)).length).toBe(beforeApprovals);
    });

    test("rejects org name with CRLF (control characters)", async () => {
      const result = await callAdminMcpTool(
        "orgs.create",
        {
          orgName: "株式会社\r\nテスト",
          ownerEmail: "test@example.com",
          invite: true,
        },
        demoCred()
      );
      expect(result.isError).toBe(true);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.code).toBe("invalid_org_name");
    });

    test("rejects org name exceeding 200 characters (admin limit)", async () => {
      const result = await callAdminMcpTool(
        "orgs.create",
        {
          orgName: "a".repeat(201),
          ownerEmail: "test@example.com",
          invite: true,
        },
        demoCred()
      );
      expect(result.isError).toBe(true);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.code).toBe("invalid_org_name");
    });
  });

  describe("flag OFF: existing behavior preserved", () => {
    beforeEach(() => {
      delete process.env[STRICT_FLAG];
      allowPlatformOpsInDemo();
    });

    test("allows org name with bidi characters (queues approval)", async () => {
      const beforeApprovals = (await listApprovals(DEMO_ORG.id)).length;
      const result = await callAdminMcpTool(
        "orgs.create",
        {
          orgName: "Test\u202EOrg",
          ownerEmail: "bidi-off@example.com",
          invite: true,
        },
        demoCred()
      );
      expect(Boolean(result.isError)).toBe(false);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.needs_approval).toBe(true);
      expect((await listApprovals(DEMO_ORG.id)).length).toBe(beforeApprovals + 1);
    });

    test("allows org name with URL-like string (queues approval)", async () => {
      const result = await callAdminMcpTool(
        "orgs.create",
        {
          orgName: "example.com Corp",
          ownerEmail: "url-off@example.com",
          invite: true,
        },
        demoCred()
      );
      expect(Boolean(result.isError)).toBe(false);
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.needs_approval).toBe(true);
    });
  });
});

describe("orgs.create admin MCP", () => {
  test("rejects normal tenant without platform allowlist", async () => {
    process.env.SUPER_ADMIN_EMAILS = "ops@other-company.example";
    const result = await callAdminMcpTool(
      "orgs.create",
      {
        orgName: "株式会社スペースツリー",
        ownerEmail: "k.nogi@spacetree.jp",
        invite: true,
      },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("platform_ops_forbidden");
  });

  test("queues always_human when platform ops allowed", async () => {
    allowPlatformOpsInDemo();
    const before = (await listApprovals(DEMO_ORG.id)).length;
    const result = await callAdminMcpTool(
      "orgs.create",
      {
        orgName: "株式会社スペースツリー",
        ownerEmail: "k.nogi@spacetree.jp",
        invite: true,
        trialDays: 30,
      },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.create_org");
    expect(data.approvalId).toBeTruthy();
    expect((await listApprovals(DEMO_ORG.id)).length).toBe(before + 1);
  });

  test("reinvoke with approvalId fulfills approved ticket and returns orgId", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.create",
      {
        orgName: "株式会社リインボーク",
        ownerEmail: "reinvoke@spacetree.jp",
        invite: true,
      },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );
    await resolveApproval(
      approvalId,
      "approved",
      "human-approver@example.com",
      DEMO_ORG.id
    );

    const result = await callAdminMcpTool(
      "orgs.create",
      { approvalId },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.orgId).toBeTruthy();
    expect(data.ownerEmail).toBe("reinvoke@spacetree.jp");
    expect(data.trialEndsAt).toBeTruthy();
    expect(data.summaryJa).toBeTruthy();
    expect(data.nextStepJa).toBeTruthy();
    expect(data.needs_approval).toBeUndefined();
  });

  test("reinvoke with approvalId returns cached fulfillment without double create", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.create",
      {
        orgName: "株式会社キャッシュ",
        ownerEmail: "cached@spacetree.jp",
        invite: true,
      },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "human-approver@example.com",
      DEMO_ORG.id
    );
    const firstFulfillment = await fulfillApprovedAdmin(approved!);
    expect(firstFulfillment?.ok).toBe(true);

    const first = await callAdminMcpTool("orgs.create", { approvalId }, demoCred());
    const second = await callAdminMcpTool("orgs.create", { approvalId }, demoCred());
    const firstData = first.structuredContent as Record<string, unknown>;
    const secondData = second.structuredContent as Record<string, unknown>;
    expect(firstData.ok).toBe(true);
    expect(secondData.ok).toBe(true);
    expect(secondData.orgId).toBe(firstData.orgId);
    expect(secondData.orgId).toBe(firstFulfillment?.orgId);
  });

  test("reinvoke with approvalId on pending ticket returns needs_approval", async () => {
    allowPlatformOpsInDemo();
    const before = (await listApprovals(DEMO_ORG.id)).length;
    const queued = await callAdminMcpTool(
      "orgs.create",
      {
        orgName: "株式会社ペンディング",
        ownerEmail: "pending@spacetree.jp",
        invite: true,
      },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );

    const pending = await callAdminMcpTool("orgs.create", { approvalId }, demoCred());
    expect(Boolean(pending.isError)).toBe(false);
    const data = pending.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.code).toBe("needs_approval");
    expect(data.approvalId).toBe(approvalId);
    expect(data.pollHint).toBe("continue_polling");
    expect((await listApprovals(DEMO_ORG.id)).length).toBe(before + 1);
  });

  test("fulfillment creates org in demo without password in audit metadata", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.create",
      {
        orgName: "株式会社スペースツリー",
        ownerEmail: "k.nogi@spacetree.jp",
        ownerPassword: "super-secret-pass",
        trialDays: 14,
      },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );
    expect(approvalId).toBeTruthy();
    const pending = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(pending).toBeTruthy();
    const mutation = (pending?.metadata?.adminMutation || {}) as Record<string, unknown>;
    expect(mutation.ownerPassword).toBeUndefined();
    expect(mutation.ownerPasswordPresent).toBe(true);
    expect(mutation.ownerPasswordCiphertext).toBeTruthy();

    const approved = await resolveApproval(
      approvalId,
      "approved",
      "human-approver@example.com",
      DEMO_ORG.id
    );
    expect(approved).toBeTruthy();
    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.orgId).toBeTruthy();
    expect(fulfillment?.ownerEmail).toBe("k.nogi@spacetree.jp");
    expect(fulfillment?.ownerUserId).toBeTruthy();
    expect((fulfillment as Record<string, unknown>).ownerPassword).toBeUndefined();
  });
});

describe("orgs.status admin MCP", () => {
  test("read-only status for platform ops", async () => {
    allowPlatformOpsInDemo();
    const result = await callAdminMcpTool(
      "orgs.status",
      { orgId: DEMO_ORG.id },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.orgId).toBe(DEMO_ORG.id);
    expect(data.subscriptionStatus).toBeTruthy();
  });

  test("platformCreateOrg demo path never returns password", async () => {
    const created = await platformCreateOrg(
      {
        orgName: "Demo Org",
        ownerEmail: "owner@new.example",
        integrationMode: "managed",
        trialDays: 14,
        invite: true,
        ownerPassword: "should-not-appear",
      },
      { email: "owner@example.com", userId: null, orgId: DEMO_ORG.id }
    );
    expect(created.orgId).toBeTruthy();
    expect((created as Record<string, unknown>).ownerPassword).toBeUndefined();
    const status = await platformOrgStatus(created.orgId);
    expect(status.ok).toBe(true);
  });
});
