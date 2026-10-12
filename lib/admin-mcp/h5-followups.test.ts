/**
 * #352 (H5) follow-ups, 木村 10/12:
 * 3) secret key names are matched case- and separator-insensitively, nested keys
 *    included (BotToken, bot_token, ChannelSecret, secrets.channelSecret …), and any
 *    key outside the tool's schema is refused (allowlist). Before: a renamed key went
 *    into the approval queue instead of being refused.
 * 4) a label holding a LINE-secret-shaped value (32 hex chars) used to slip into the
 *    queue. Labels are now ≤ 60 chars, without long hex / base64 runs, and pass the
 *    secret detector.
 * 5) orgs.create ownerPassword stays (refusal comes later, after invite=true mail is
 *    confirmed) but is always_human, and the plaintext appears in no response, log,
 *    audit row or queue row (encrypted at rest only).
 *
 * Demo mode, dummy values, no network. Nothing is echoed: every refusal is checked
 * for the value across the response, console, audit rows and approvals.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { listApprovals, listAuditEvents, resetDemoNotificationChannels, upsertConversationAdapter, upsertNotificationChannel } from "@/lib/data";
import { getApprovalById } from "@/lib/data/approvals";
import { DEMO_ORG } from "@/lib/demo-data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";

const ORG = DEMO_ORG.id;
const ENCRYPTION_KEY = "test-key-that-is-at-least-32-characters-long";

function demoCred(grokBotAgentId = "grok_admin_demo"): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId, status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

const ENV_KEYS = ["NOTIFICATION_CONFIG_ENCRYPTION_KEY", "SUPER_ADMIN_EMAILS", "PLATFORM_OPS_ORG_ID"];
let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let logged: string[] = [];
let restoreConsole: Array<() => void> = [];
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = ENCRYPTION_KEY;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url) === "https://slack.com/api/auth.test") return Response.json({ ok: true, team_id: "TFIX", user_id: "UFIX" });
    if (String(url).startsWith("https://api.line.me/")) return Response.json({});
    throw new Error("unexpected_fixture_endpoint");
  }) as typeof fetch;
  logged = [];
  restoreConsole = (["log", "info", "warn", "error", "debug"] as const).map((m) => {
    const original = console[m];
    console[m] = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    return () => { console[m] = original; };
  });
});
afterEach(async () => {
  for (const r of restoreConsole) r();
  globalThis.fetch = savedFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetDemoNotificationChannels(ORG);
  await upsertConversationAdapter({ orgId: ORG, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

async function seedLine() {
  return upsertNotificationChannel({
    orgId: ORG, provider: "line", enabled: true, isDefault: true, label: "承認 LINE",
    config: { destinationId: "Uboss1234567890abcdef", allowedUserIds: [] },
    secrets: { channelAccessToken: "stored-line-access-token-value-0001", channelSecret: "stored-line-channel-secret-value-01" },
  });
}

async function expectValueNowhere(value: string, result: unknown) {
  expect(JSON.stringify(result)).not.toContain(value);
  expect(logged.join("\n")).not.toContain(value);
  expect(JSON.stringify(await listAuditEvents(ORG, 300))).not.toContain(value);
  expect(JSON.stringify(await listApprovals(ORG))).not.toContain(value);
}

const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;

describe("3) secret key names: case / separator / nesting insensitive", () => {
  const SECRET = "renamed-secret-value-from-chat-4242";
  const CASES: Array<{ tool: string; args: Record<string, unknown>; path: string }> = [
    { tool: "setup.slackAdapter.setBotToken", args: { enabled: false, BotToken: SECRET }, path: "BotToken" },
    { tool: "setup.slackAdapter.setBotToken", args: { enabled: false, bot_token: SECRET }, path: "bot_token" },
    { tool: "setup.slackAdapter.setBotToken", args: { enabled: false, "bot-token": SECRET }, path: "bot-token" },
    { tool: "setup.slackAdapter.setBotToken", args: { enabled: false, BOTTOKEN: SECRET }, path: "BOTTOKEN" },
    { tool: "setup.lineApproval.upsert", args: { destinationId: "Unew1234567890abcdef", ChannelSecret: SECRET }, path: "ChannelSecret" },
    { tool: "setup.lineApproval.upsert", args: { destinationId: "Unew1234567890abcdef", channel_access_token: SECRET }, path: "channel_access_token" },
    { tool: "setup.lineApproval.upsert", args: { destinationId: "Unew1234567890abcdef", secrets: { channelSecret: SECRET } }, path: "secrets.channelSecret" },
    { tool: "setup.lineApproval.upsert", args: { destinationId: "Unew1234567890abcdef", config: { auth: { Channel_Access_Token: SECRET } } }, path: "config.auth.Channel_Access_Token" },
    { tool: "setup.lineApproval.upsert", args: { destinationId: "Unew1234567890abcdef", allowedUserIds: [{ token: SECRET }] }, path: "allowedUserIds[0].token" },
  ];
  for (const c of CASES) {
    test(`${c.tool} ${c.path} → secret_argument_refused (name only), nothing queued`, async () => {
      const line = await seedLine();
      const before = (await listApprovals(ORG)).length;
      const args = c.tool === "setup.lineApproval.upsert" ? { ...c.args, channelId: line.id } : c.args;
      const result = await callAdminMcpTool(c.tool, args, demoCred());
      expect(result.isError).toBe(true);
      expect(data(result).code).toBe("secret_argument_refused");
      expect(data(result).refusedArgs).toEqual([c.path]);
      expect(data(result).nextAction).toBe("use_dashboard");
      expect((await listApprovals(ORG)).length).toBe(before);
      await expectValueNowhere(SECRET, result);
    });
  }

  test("unknown key on setup.lineApproval.upsert → unknown_argument_refused (allowlist), nothing queued, value not echoed", async () => {
    const line = await seedLine();
    const before = (await listApprovals(ORG)).length;
    const result = await callAdminMcpTool("setup.lineApproval.upsert", { channelId: line.id, destinationId: "Unew1234567890abcdef", label: "本社", colour: "value-not-echoed-7777" }, demoCred());
    expect(result.isError).toBe(true);
    expect(data(result).code).toBe("unknown_argument_refused");
    expect(data(result).unknownArgs).toEqual(["colour"]);
    expect((await listApprovals(ORG)).length).toBe(before);
    await expectValueNowhere("value-not-echoed-7777", result);
  });

  test("unknown key on setup.slackAdapter.setBotToken → unknown_argument_refused", async () => {
    const before = (await listApprovals(ORG)).length;
    const result = await callAdminMcpTool("setup.slackAdapter.setBotToken", { enabled: false, xoxb: "value-not-echoed-8888" }, demoCred());
    expect(data(result).code).toBe("unknown_argument_refused");
    expect((await listApprovals(ORG)).length).toBe(before);
    await expectValueNowhere("value-not-echoed-8888", result);
  });

  test("lock-in: only allowlisted, non-secret keys → still queued", async () => {
    const line = await seedLine();
    const result = await callAdminMcpTool("setup.lineApproval.upsert", { channelId: line.id, destinationId: "Unew1234567890abcdef", label: "承認用LINE（本社）", enabled: true, jobId: "job_h5_fu_ok" }, demoCred());
    expect(data(result).code).toBe("needs_approval");
  });
});

describe("4) label: length, charset and the secret detector", () => {
  const HEX32 = "0123456789abcdef0123456789abcdef";
  const BAD: Array<[string, string]> = [
    ["a LINE-secret-shaped 32-hex label", HEX32],
    ["32 hex inside text", `LINE ${HEX32.toUpperCase()} 本社`],
    ["a base64 run", "label QWxhZGRpbjpvcGVuIHNlc2FtZQ0K"],
    ["a Slack token", ["xo", "xb-1234567890-0987654321-AbCdEfGhIjKlMnOp"].join("")],
    ["longer than 60 chars", "承".repeat(61)],
  ];
  for (const tool of ["setup.lineApproval.upsert", "setup.slackAdapter.setBotToken"]) {
    for (const [name, label] of BAD) {
      test(`${tool}: ${name} → invalid_label, nothing queued, value not echoed`, async () => {
        const line = await seedLine();
        const before = (await listApprovals(ORG)).length;
        const args = tool === "setup.lineApproval.upsert" ? { channelId: line.id, destinationId: "Unew1234567890abcdef", label } : { enabled: false, label };
        const result = await callAdminMcpTool(tool, args, demoCred());
        expect(result.isError).toBe(true);
        expect(data(result).code).toBe("invalid_label");
        expect((await listApprovals(ORG)).length).toBe(before);
        await expectValueNowhere(label, result);
      });
    }
  }

  test("lock-in: ordinary labels (Japanese, ≤ 60 chars, short numbers) are accepted", async () => {
    for (const label of ["承認用LINE（本社）", "LINE 2", "Slack 会話投稿 2026"]) {
      const line = await seedLine();
      const result = await callAdminMcpTool("setup.lineApproval.upsert", { channelId: line.id, destinationId: "Unew1234567890abcdef", label }, demoCred());
      expect(data(result).code).toBe("needs_approval");
    }
  });
});

describe("5) orgs.create ownerPassword: always_human, never in plaintext", () => {
  const PASSWORD = "Plain-Owner-Pass-6161";
  function allowPlatformOps() {
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    delete process.env.PLATFORM_OPS_ORG_ID;
  }

  test("queued as always_human (pending, never auto-approved); ciphertext only in the queue; plaintext in no response / log / audit / approval", async () => {
    allowPlatformOps();
    const result = await callAdminMcpTool("orgs.create", { orgName: "株式会社パスワード検証", ownerEmail: "owner-pw@example.com", ownerPassword: PASSWORD, jobId: "job_h5_pw" }, demoCred("grok_platform_ops"));
    const d = data(result);
    expect(d.needs_approval).toBe(true);
    expect(d.always_human).toBe(true);
    const approval = await getApprovalById(String(d.approvalId), ORG);
    expect(approval?.status).toBe("pending");
    expect(approval?.metadata?.always_human).toBe(true);
    const mutation = approval?.metadata?.adminMutation as Record<string, unknown>;
    expect(mutation.ownerPassword).toBeUndefined();
    expect(mutation.ownerPasswordPresent).toBe(true);
    expect(typeof mutation.ownerPasswordCiphertext).toBe("string");
    expect(String(mutation.ownerPasswordCiphertext)).not.toContain(PASSWORD);
    await expectValueNowhere(PASSWORD, result);
  });

  test("the summary / title / card text carry no password, and a re-invoke response does not either", async () => {
    allowPlatformOps();
    const queued = await callAdminMcpTool("orgs.create", { orgName: "株式会社再呼び出し", ownerEmail: "owner-pw2@example.com", ownerPassword: PASSWORD }, demoCred("grok_platform_ops"));
    const approvalId = String(data(queued).approvalId);
    const approval = await getApprovalById(approvalId, ORG);
    expect(`${approval?.title}\n${approval?.summary}`).not.toContain(PASSWORD);
    const again = await callAdminMcpTool("orgs.create", { approvalId }, demoCred("grok_platform_ops"));
    await expectValueNowhere(PASSWORD, again);
  });

  test("the orgs.create tool description says always_human", async () => {
    const { ADMIN_MCP_TOOLS } = await import("@/lib/mcp/admin-tools");
    expect(ADMIN_MCP_TOOLS.find((t) => t.name === "orgs.create")?.description).toContain("always_human");
  });
});
