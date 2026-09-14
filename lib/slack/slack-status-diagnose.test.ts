import { describe, expect, test } from "bun:test";
import { DEMO_EMPLOYEES, DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  computeSlackStatusNextStepJa,
  DASHBOARD_BOT_TOKEN_PATH_JA,
  diagnoseSlackStatus,
  slackAuthorizeUrlTemplate,
} from "@/lib/slack/slack-status-diagnose";

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

function baseNextStepInput() {
  return {
    botTokenPresent: true,
    authTest: { ok: true, bot_id: "B1", user_id: "U1" },
    botHasFilesWrite: true,
    botFilesWriteCode: "ok",
    adapterEnabled: true,
    imRoutesCount: 1,
    postingMismatch: [] as string[],
    employees: [] as Array<{
      employeeId: string;
      displayName: string;
      postingAs: string;
      slackIdentityLinked: boolean;
      slackIdentityStatus: string | null;
      needsPathB: boolean;
      fileUploadReady: boolean | null;
      needsReoauthForFilesWrite: boolean;
      authorizeUrlTemplate: string | null;
    }>,
    pathBReadiness: {
      pathBEmployeeCount: 0,
      linkedCount: 0,
      fileUploadReadyCount: 0,
      needsReoauthCount: 0,
      needsAuthorizeCount: 0,
      ready: true,
    },
  };
}

describe("computeSlackStatusNextStepJa", () => {
  test("no bot token mentions files:write and dashboard path", () => {
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      botTokenPresent: false,
    });
    expect(msg).toContain("files:write");
    expect(msg).toContain(DASHBOARD_BOT_TOKEN_PATH_JA);
  });

  test("missing bot files:write scope", () => {
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      botHasFilesWrite: false,
      botFilesWriteCode: "missing_scope",
    });
    expect(msg).toContain("Bot Token Scopes");
    expect(msg).toContain("files:write");
    expect(msg).toContain("再インストール");
  });

  test("auth failure", () => {
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      authTest: { ok: false, error: "invalid_auth" },
    });
    expect(msg).toContain("invalid_auth");
  });

  test("adapter disabled", () => {
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      adapterEnabled: false,
    });
    expect(msg).toContain(DASHBOARD_BOT_TOKEN_PATH_JA);
  });

  test("path B needs authorize", () => {
    const employeeId = "emp_test";
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      employees: [
        {
          employeeId,
          displayName: "テスト社員",
          postingAs: "user",
          slackIdentityLinked: false,
          slackIdentityStatus: null,
          needsPathB: true,
          fileUploadReady: false,
          needsReoauthForFilesWrite: false,
          authorizeUrlTemplate: slackAuthorizeUrlTemplate(employeeId),
        },
      ],
      pathBReadiness: {
        pathBEmployeeCount: 1,
        linkedCount: 0,
        fileUploadReadyCount: 0,
        needsReoauthCount: 0,
        needsAuthorizeCount: 1,
        ready: false,
      },
    });
    expect(msg).toContain("Authorize");
    expect(msg).toContain(employeeId);
    expect(msg).toContain("/api/slack/oauth/start");
  });

  test("path B needs re-OAuth for files:write", () => {
    const employeeId = "emp_reoauth";
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      employees: [
        {
          employeeId,
          displayName: "再認可社員",
          postingAs: "user",
          slackIdentityLinked: true,
          slackIdentityStatus: "linked",
          needsPathB: true,
          fileUploadReady: false,
          needsReoauthForFilesWrite: true,
          authorizeUrlTemplate: slackAuthorizeUrlTemplate(employeeId),
        },
      ],
      pathBReadiness: {
        pathBEmployeeCount: 1,
        linkedCount: 1,
        fileUploadReadyCount: 0,
        needsReoauthCount: 1,
        needsAuthorizeCount: 0,
        ready: false,
      },
    });
    expect(msg).toContain("User Token");
    expect(msg).toContain("files:write");
    expect(msg).toContain("再連携");
  });

  test("no im routes", () => {
    const msg = computeSlackStatusNextStepJa({
      ...baseNextStepInput(),
      imRoutesCount: 0,
    });
    expect(msg).toContain("channels.classify");
  });

  test("complete state mentions e2e", () => {
    const msg = computeSlackStatusNextStepJa(baseNextStepInput());
    expect(msg).toContain("完了");
  });
});

describe("diagnoseSlackStatus integration", () => {
  test("setup.slackStatus via admin MCP returns new fields", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return Response.json({ ok: true, bot_id: "B1", user_id: "U1" });
        }
        if (url.includes("files.getUploadURLExternal")) {
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/abc",
            file_id: "F123",
          });
        }
        return Response.json({ ok: false, error: "unexpected" });
      }) as typeof fetch;

      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: true,
        secrets: { botToken: "xoxb-demo" },
      });

      const result = await callAdminMcpTool("setup.slackStatus", {}, demoCred());
      const data = result.structuredContent as Record<string, unknown>;
      expect(data.ok).toBeDefined();
      expect(data.botHasFilesWrite).toBe(true);
      expect(data.botFilesWriteCode).toBe("ok");
      expect(data.pathBReadiness).toBeDefined();
      expect(data.dashboardBotTokenPathJa).toBe(DASHBOARD_BOT_TOKEN_PATH_JA);
      expect(data.nextStepJa).toBeTruthy();
      expect(String(data.nextStepJa)).not.toContain("xoxb-");
    } finally {
      globalThis.fetch = originalFetch;
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("detects bot missing files:write scope", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return Response.json({ ok: true, bot_id: "B1", user_id: "U1" });
        }
        if (url.includes("files.getUploadURLExternal")) {
          return Response.json({
            ok: false,
            error: "missing_scope",
            needed: "files:write",
          });
        }
        return Response.json({ ok: false });
      }) as typeof fetch;

      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: true,
        secrets: { botToken: "xoxb-missing-scope" },
      });

      const status = await diagnoseSlackStatus(DEMO_ORG.id);
      expect(status.botHasFilesWrite).toBe(false);
      expect(status.botFilesWriteCode).toBe("missing_scope");
      expect(status.nextStepJa).toContain("files:write");
      expect(status.issues.some((i) => i.includes("files:write"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("detects user token missing files:write for path B employee", async () => {
    const originalFetch = globalThis.fetch;
    const employeeId = "emp_comm";
    const demoEmp = DEMO_EMPLOYEES.find((e) => e.id === employeeId);
    const previousAccounts = demoEmp?.allowedAccounts;
    const previousPosting = demoEmp?.postingAs;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth =
          String(
            (init?.headers as Record<string, string> | undefined)?.authorization || ""
          );
        if (url.includes("auth.test")) {
          return Response.json({ ok: true, bot_id: "B1", user_id: "U1" });
        }
        if (url.includes("files.getUploadURLExternal")) {
          if (auth.includes("xoxp")) {
            return Response.json({
              ok: false,
              error: "missing_scope",
              needed: "files:write",
            });
          }
          return Response.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/abc",
            file_id: "F123",
          });
        }
        return Response.json({ ok: false });
      }) as typeof fetch;

      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: true,
        secrets: { botToken: "xoxb-demo" },
      });

      if (!demoEmp) throw new Error("missing emp_comm");
      demoEmp.allowedAccounts = [
        ...(demoEmp.allowedAccounts ?? []),
        { service: "slack", accountId: "U_COMM" },
      ];
      demoEmp.postingAs = "user";

      await revokeEmployeeSlackIdentity({ employeeId, orgId: DEMO_ORG.id });
      await bindEmployeeSlackIdentity({
        employeeId,
        orgId: DEMO_ORG.id,
        slackUserId: "U_COMM",
        slackTeamId: "T_DEMO",
        displayName: "社内連絡AI社員",
        userToken: "xoxp-demo-missing-files-write",
      });

      const status = await diagnoseSlackStatus(DEMO_ORG.id);
      const empStatus = status.employees.find((e) => e.employeeId === employeeId);
      expect(empStatus?.needsReoauthForFilesWrite).toBe(true);
      expect(empStatus?.fileUploadReady).toBe(false);
      expect(status.pathBReadiness.needsReoauthCount).toBeGreaterThanOrEqual(1);
      expect(status.nextStepJa).toContain("files:write");
    } finally {
      globalThis.fetch = originalFetch;
      if (demoEmp) {
        demoEmp.allowedAccounts = previousAccounts;
        demoEmp.postingAs = previousPosting;
      }
      await revokeEmployeeSlackIdentity({ employeeId, orgId: DEMO_ORG.id });
      await upsertConversationAdapter({
        orgId: DEMO_ORG.id,
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });
});
