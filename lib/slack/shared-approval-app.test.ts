/**
 * A: shared approval app 「Staffpass承認」 (SLACK_SHARED_APPROVAL_APP_ENABLED).
 * Generic fixtures only (no tenant ids). Demo stores; Slack API stubbed via fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { createApproval, getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import {
  getNotificationChannelSecretsById,
  listNotificationChannels,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { consumeSlackOAuthStateNonce, resetDemoSlackOAuthStateUses } from "@/lib/data/slack-oauth-state-uses";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { resetApprovalAlertThrottleForTests } from "@/lib/notify/delivery-failure-alert";
import { openApprovalDeliveryDm } from "@/lib/slack/approval-dm-open";
import { signSlackBotInstallState } from "@/lib/slack/oauth";
import {
  SHARED_APPROVAL_INSTALL_MESSAGES,
  completeSharedApprovalInstall,
  sharedApprovalAuthorizeUrl,
  signSharedApprovalInstallState,
  verifySharedApprovalInstallState,
  type SlackOAuthV2Access,
} from "@/lib/slack/shared-approval-app";
import { handleSharedApprovalAppEvent } from "@/lib/slack/shared-approval-events";
import { resolveSharedApprovalInteractivity } from "@/lib/slack/shared-approval-interactivity";
import { POST as interactivityPOST } from "@/app/api/webhooks/slack/interactivity/route";
import type { NotificationChannel } from "@/lib/types";

const ORG = DEMO_ORG.id;
const OTHER_ORG = "org_shared_app_other_fixture";
const APP = "ASHAREDAPPROVAL1";
const SIGNING = "shared-approval-signing-SECRET-1";
const CLIENT_SECRET = "shared-approval-client-SECRET-2";
const BOT = "xoxb-shared-approval-bot-SECRET-3";
const APPROVER = "USHAREDAPPR1";
const DM = "DSHAREDDM001";
const ENV = [
  "SLACK_SHARED_APPROVAL_APP_ENABLED",
  "SLACK_SHARED_APPROVAL_APP_ID",
  "SLACK_SHARED_APPROVAL_CLIENT_ID",
  "SLACK_SHARED_APPROVAL_CLIENT_SECRET",
  "SLACK_SHARED_APPROVAL_SIGNING_SECRET",
  "APPROVAL_DELIVERY_FAILURE_ALERT",
  "SLACK_APPROVAL_DM_AUTO_OPEN",
  "SLACK_CLIENT_SECRET",
] as const;

let saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let calls: Array<{ method: string; auth: string; body: Record<string, unknown> }> = [];
let team = "";
let seq = 0;
let usersInfoTeam: string | null = null;

function newTeam(): string {
  seq += 1;
  return `TSHARED${Date.now().toString(36).toUpperCase()}${seq}`;
}

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = {};
    }
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    calls.push({ method, auth, body });
    const json = (payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "auth.test") {
      return json({ ok: true, team_id: team, team: "Fixture Workspace", user_id: "USHAREDBOT1", app_id: APP }, { "x-oauth-scopes": "chat:write,im:write,im:read,users:read" });
    }
    if (method === "users.info") return json({ ok: true, user: { id: String(body.user), team_id: usersInfoTeam ?? team } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: DM, is_im: true } });
    if (method === "chat.postMessage") return json({ ok: true, channel: String(body.channel || DM), ts: `17000000${calls.length}.0001` });
    if (method === "chat.update") return json({ ok: true });
    if (method === "auth.revoke") return json({ ok: true, revoked: true });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

function cred(orgId = ORG): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_shared_app", status: "linked" });
  return { orgId, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function goodExchange(overrides: Partial<SlackOAuthV2Access> = {}): SlackOAuthV2Access {
  return { ok: true, app_id: APP, access_token: BOT, token_type: "bot", bot_user_id: "USHAREDBOT1", team: { id: team, name: "Fixture Workspace" }, is_enterprise_install: false, ...overrides };
}

const revoked: string[] = [];
function deps(exchange: SlackOAuthV2Access) {
  return {
    exchange: async () => exchange,
    authTest: async () => ({ ok: true, team_id: team, team: "Fixture Workspace", user_id: "USHAREDBOT1" }),
    revoke: async (token: string) => {
      revoked.push(token);
    },
  };
}

async function sharedInbox(orgId = ORG): Promise<NotificationChannel | undefined> {
  return (await listNotificationChannels(orgId)).find((row) => row.config?.sharedApprovalApp === true);
}

function noSecrets(value: unknown) {
  const blob = JSON.stringify(value);
  for (const secret of [BOT, SIGNING, CLIENT_SECRET, "SECRET"]) expect(blob).not.toContain(secret);
}

function sign(body: string, secret = SIGNING, ts = Math.floor(Date.now() / 1000)): { timestamp: string; signature: string } {
  const timestamp = String(ts);
  return { timestamp, signature: `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}` };
}

async function approveTicket(approvalId: string, orgId = ORG) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_human_shared_app" });
  return fulfillApprovedAdmin(approved!);
}

async function installAndSetApprover(): Promise<NotificationChannel> {
  const installed = await completeSharedApprovalInstall({ orgId: ORG, code: "code-1", deps: deps(goodExchange()) });
  expect(installed.ok).toBe(true);
  const queued = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
  expect(queued).toMatchObject({ code: "needs_approval", always_human: true });
  const done = await approveTicket(String(queued.approvalId));
  expect(done).toMatchObject({ ok: true, tool: "setup.slackApprover.set" });
  return (await sharedInbox())!;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
  process.env.SLACK_SHARED_APPROVAL_APP_ID = APP;
  process.env.SLACK_SHARED_APPROVAL_CLIENT_ID = "111.222";
  process.env.SLACK_SHARED_APPROVAL_CLIENT_SECRET = CLIENT_SECRET;
  process.env.SLACK_SHARED_APPROVAL_SIGNING_SECRET = SIGNING;
  process.env.SLACK_CLIENT_SECRET = "app-a-client-secret-fixture";
  delete process.env.APPROVAL_DELIVERY_FAILURE_ALERT;
  delete process.env.SLACK_APPROVAL_DM_AUTO_OPEN;
  savedFetch = globalThis.fetch;
  installFetch();
  team = newTeam();
  usersInfoTeam = null;
  revoked.length = 0;
  resetDemoNotificationChannels(ORG);
  resetDemoNotificationChannels(OTHER_ORG);
  resetDemoSlackOAuthStateUses();
  resetApprovalAlertThrottleForTests();
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  globalThis.fetch = savedFetch;
});

describe("install (Add to Slack callback core)", () => {
  test("org with NO per-tenant approval app installs directly: xoxb in this org's inbox secrets (botToken), no signing secret, default inbox", async () => {
    expect((await listNotificationChannels(ORG)).length).toBe(0);
    const result = await completeSharedApprovalInstall({ orgId: ORG, code: "code-1", actorEmail: "owner@example.com", deps: deps(goodExchange()) });
    expect(result).toMatchObject({ ok: true, code: "installed", teamId: team, reinstall: false });
    const inbox = (await sharedInbox())!;
    expect(inbox).toMatchObject({ provider: "slack", enabled: true, isDefault: true });
    expect(inbox.config).toMatchObject({ sharedApprovalApp: true, apiAppId: APP, teamId: team, expectedTeamId: team, channelId: "", allowedUserIds: [] });
    const secrets = await getNotificationChannelSecretsById(ORG, inbox.id);
    expect(secrets.botToken).toBe(BOT);
    expect(secrets.signingSecret).toBeUndefined();
    noSecrets(result);
    noSecrets(await listAuditEvents(ORG, 20));
    noSecrets(inbox);
  });

  test("flag OFF / env missing → refused, nothing saved", async () => {
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: false, code: "flag_off" });
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    delete process.env.SLACK_SHARED_APPROVAL_SIGNING_SECRET;
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: false, code: "unconfigured" });
    expect(await sharedInbox()).toBeUndefined();
  });

  test("workspace already bound to ANOTHER org (its approval inbox) → refused with the ops message; other org's binding unchanged; token revoked", async () => {
    const other = await upsertNotificationChannel({
      orgId: OTHER_ORG,
      provider: "slack",
      label: "other tenant approval app",
      enabled: true,
      config: { channelId: "COTHER1", allowedUserIds: ["UOTHER1"], expectedTeamId: team },
      secrets: { botToken: "xoxb-other-tenant", signingSecret: "other-signing" },
    });
    const result = await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    expect(result).toMatchObject({ ok: false, code: "team_bound_to_other_org" });
    expect(result.messageJa).toBe("このSlackワークスペースは別の組織に接続済みです。運営に連絡してください。");
    expect(await sharedInbox()).toBeUndefined();
    const after = (await listNotificationChannels(OTHER_ORG)).find((row) => row.id === other.id)!;
    expect(after.config).toEqual(other.config);
    expect(after.enabled).toBe(true);
    expect(revoked).toEqual([BOT]);
    const audit = (await listAuditEvents(ORG, 20)).find((e) => (e.metadata as Record<string, unknown>)?.event === "shared_approval_app.install_rejected");
    expect((audit?.metadata as Record<string, unknown>)?.code).toBe("team_bound_to_other_org");
    expect(JSON.stringify(audit)).not.toContain(OTHER_ORG);
  });

  test("workspace bound to another org via its Slack conversation adapter (App A bot) → refused", async () => {
    await upsertConversationAdapter({ orgId: `${OTHER_ORG}_adapter`, surface: "slack", enabled: true, config: { teamId: team }, secrets: { botToken: "xoxb-other-adapter" } });
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: false, code: "team_bound_to_other_org" });
    expect(await sharedInbox()).toBeUndefined();
  });

  test("another org's shared install for the same workspace → second org refused (one org per workspace)", async () => {
    expect((await completeSharedApprovalInstall({ orgId: OTHER_ORG, code: "c", deps: deps(goodExchange()) })).ok).toBe(true);
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: false, code: "team_bound_to_other_org" });
    expect((await sharedInbox(OTHER_ORG))?.enabled).toBe(true);
  });

  test("Enterprise Grid org-wide install (is_enterprise_install=true) → refused, nothing saved, token revoked", async () => {
    const result = await completeSharedApprovalInstall({
      orgId: ORG,
      code: "c",
      deps: deps(goodExchange({ is_enterprise_install: true, enterprise: { id: "EGRID1", name: "Grid" } })),
    });
    expect(result).toMatchObject({ ok: false, code: "enterprise_install_not_supported" });
    expect(result.messageJa).toContain("Enterprise Grid");
    expect(await sharedInbox()).toBeUndefined();
    expect(revoked).toEqual([BOT]);
  });

  test("enterprise only, no team → refused (fail-closed)", async () => {
    const result = await completeSharedApprovalInstall({
      orgId: ORG,
      code: "c",
      deps: deps(goodExchange({ team: null, enterprise: { id: "EGRID1" }, is_enterprise_install: false })),
    });
    expect(result).toMatchObject({ ok: false, code: "enterprise_install_not_supported" });
    expect(await sharedInbox()).toBeUndefined();
  });

  test("non-bot token / other app_id / auth.test other team / exchange failure → refused, nothing saved", async () => {
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange({ access_token: "xoxp-user-SECRET", token_type: "user" })) })).toMatchObject({ ok: false, code: "not_bot_token" });
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange({ app_id: "AOTHERAPP1" })) })).toMatchObject({ ok: false, code: "app_mismatch" });
    expect(
      await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: { ...deps(goodExchange()), authTest: async () => ({ ok: true, team_id: "TELSEWHERE1" }) } })
    ).toMatchObject({ ok: false, code: "auth_failed" });
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps({ ok: false, error: "invalid_code" }) })).toMatchObject({ ok: false, code: "exchange_failed" });
    expect(await sharedInbox()).toBeUndefined();
  });

  test("this org already uses a DIFFERENT workspace → refused (re-install cannot move the org)", async () => {
    await upsertNotificationChannel({
      orgId: ORG,
      provider: "slack",
      label: "own per-tenant app",
      enabled: true,
      config: { channelId: "COWN1", allowedUserIds: ["UOWN1"], expectedTeamId: "TOWNWORKSPACE1" },
      secrets: { botToken: "xoxb-own", signingSecret: "own-signing" },
    });
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: false, code: "team_mismatch_org" });
    expect(await sharedInbox()).toBeUndefined();
  });

  test("per-tenant approval app in the SAME workspace keeps working in parallel; shared inbox is added, not default", async () => {
    const own = await upsertNotificationChannel({
      orgId: ORG,
      provider: "slack",
      label: "own per-tenant app",
      enabled: true,
      config: { channelId: "COWN1", allowedUserIds: ["UOWN1"], expectedTeamId: team },
      secrets: { botToken: "xoxb-own", signingSecret: "own-signing" },
    });
    expect((await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).ok).toBe(true);
    const rows = await listNotificationChannels(ORG);
    expect(rows.find((row) => row.id === own.id)).toMatchObject({ enabled: true, isDefault: true });
    expect(rows.find((row) => row.config?.sharedApprovalApp === true)).toMatchObject({ enabled: true, isDefault: false });
  });

  test("re-install by the same org reuses the inbox and keeps the approver / DM", async () => {
    const inbox = await installAndSetApprover();
    const again = await completeSharedApprovalInstall({ orgId: ORG, code: "c2", deps: deps(goodExchange()) });
    expect(again).toMatchObject({ ok: true, reinstall: true, inboxId: inbox.id });
    expect((await sharedInbox())!.config).toMatchObject({ allowedUserIds: [APPROVER], channelId: DM });
  });

  test("dashboard save cannot overwrite the shared inbox markers", async () => {
    // Guard lives in the settings route; here: the data layer still requires a signing
    // secret for any Slack inbox WITHOUT the marker (unchanged behaviour).
    await expect(
      upsertNotificationChannel({ orgId: ORG, provider: "slack", enabled: true, config: { channelId: "C1" }, secrets: { botToken: "xoxb-x" } })
    ).rejects.toThrow("slack_credentials_incomplete");
  });
});

describe("signed state", () => {
  test("round trip; tampered / wrong nonce / expired / App A bot-install state are refused", () => {
    const state = signSharedApprovalInstallState({ orgId: ORG, nonce: "nonce-1" });
    expect(verifySharedApprovalInstallState(state, "nonce-1")).toMatchObject({ orgId: ORG, purpose: "shared_approval_install" });
    expect(verifySharedApprovalInstallState(state, "nonce-2")).toBeNull();
    const [encoded, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, "base64url").toString()), orgId: OTHER_ORG })).toString("base64url");
    expect(verifySharedApprovalInstallState(`${forged}.${sig}`, "nonce-1")).toBeNull();
    expect(verifySharedApprovalInstallState(state, "nonce-1", Date.now() + 11 * 60_000)).toBeNull();
    expect(verifySharedApprovalInstallState(signSlackBotInstallState({ orgId: ORG, nonce: "nonce-1" }), "nonce-1")).toBeNull();
  });

  test("single use: the same nonce is consumed only once", async () => {
    const input = { purpose: "shared_approval_install", nonce: "nonce-once", orgId: ORG, expiresAtMs: Date.now() + 60_000 };
    expect(await consumeSlackOAuthStateNonce(input)).toBe(true);
    expect(await consumeSlackOAuthStateNonce(input)).toBe(false);
  });

  test("authorize URL: shared client id, bot scopes only, our callback, team hint", () => {
    const url = new URL(sharedApprovalAuthorizeUrl("st", { teamId: team }));
    expect(url.searchParams.get("client_id")).toBe("111.222");
    expect(url.searchParams.get("scope")).toBe("chat:write,im:write,im:read,users:read");
    expect(url.searchParams.get("user_scope")).toBeNull();
    expect(String(url.searchParams.get("redirect_uri")).endsWith("/api/slack/approval-app/callback")).toBe(true);
    expect(url.searchParams.get("team")).toBe(team);
  });
});

describe("setup.slackApprover.set (always_human)", () => {
  test("not installed → shared_app_not_installed with the install URL; flag OFF → feature_disabled", async () => {
    const out = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
    expect(out).toMatchObject({ ok: false, code: "shared_app_not_installed" });
    expect(String(out.installUrl).endsWith("/api/slack/approval-app/install/start")).toBe(true);
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect(data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()))).toMatchObject({ ok: false, code: "feature_disabled" });
  });

  test("install refused because the workspace belongs to another org → the MCP result carries the same ops message", async () => {
    await completeSharedApprovalInstall({ orgId: OTHER_ORG, code: "c", deps: deps(goodExchange()) });
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    const out = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
    expect(out).toMatchObject({ ok: false, code: "team_bound_to_other_org" });
    expect(out.message).toBe(SHARED_APPROVAL_INSTALL_MESSAGES.team_bound_to_other_org);
    const status = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    const block = status.sharedApprovalApp as Record<string, unknown>;
    expect(block.lastInstallError).toMatchObject({ code: "team_bound_to_other_org", messageJa: SHARED_APPROVAL_INSTALL_MESSAGES.team_bound_to_other_org });
    expect((status.nextStepsJa as string[]).join("\n")).toContain("このSlackワークスペースは別の組織に接続済みです。運営に連絡してください。");
  });

  test("queues a human ticket; fulfillment opens the DM and posts 「設定しました」 with the SHARED bot token, then saves approver + D…", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    const queued = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
    expect(queued).toMatchObject({ code: "needs_approval", always_human: true });
    expect((await sharedInbox())!.config.allowedUserIds).toEqual([]);
    calls = [];
    const done = await approveTicket(String(queued.approvalId));
    expect(done).toMatchObject({ ok: true });
    const slackCalls = calls.filter((c) => ["auth.test", "users.info", "conversations.open", "chat.postMessage"].includes(c.method));
    expect(slackCalls.map((c) => c.method)).toEqual(["auth.test", "users.info", "conversations.open", "chat.postMessage"]);
    for (const c of slackCalls) expect(c.auth).toBe(`Bearer ${BOT}`);
    expect(String(slackCalls[3].body.text)).toContain("設定しました");
    expect((await sharedInbox())!.config).toMatchObject({ allowedUserIds: [APPROVER], channelId: DM, expectedTeamId: team });
    noSecrets(done);
  });

  test("approver in another workspace → nothing saved", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    const queued = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
    usersInfoTeam = "TFOREIGN1";
    expect(await approveTicket(String(queued.approvalId))).toMatchObject({ ok: false });
    expect((await sharedInbox())!.config).toMatchObject({ allowedUserIds: [], channelId: "" });
  });

  test("tokens / unknown args (orgId) refused", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    expect(data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER, botToken: "xoxb-x" }, cred()))).toMatchObject({ ok: false, code: "secret_not_accepted" });
    expect(data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER, orgId: OTHER_ORG }, cred()))).toMatchObject({ ok: false, code: "unexpected_argument" });
    expect(data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: "not-a-user" }, cred()))).toMatchObject({ ok: false, code: "invalid_slack_user_id" });
  });

  test("bot / guest approver → refused at fulfillment, nothing saved", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    const queued = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
    const saveFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("users.info")) {
        return new Response(JSON.stringify({ ok: true, user: { id: APPROVER, team_id: team, is_restricted: true } }), { status: 200 });
      }
      return saveFetch(url, init);
    }) as unknown as typeof fetch;
    expect(await approveTicket(String(queued.approvalId))).toMatchObject({ ok: false, error: "approval_user_guest" });
    globalThis.fetch = saveFetch;
    expect((await sharedInbox())!.config).toMatchObject({ allowedUserIds: [] });
  });

  test("cross-org: org B's credential never sees / changes org A's shared inbox", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    expect(data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred(OTHER_ORG)))).toMatchObject({ ok: false, code: "shared_app_not_installed" });
    const inbox = (await sharedInbox())!;
    expect(data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER, inboxId: inbox.id }, cred(OTHER_ORG)))).toMatchObject({ ok: false });
  });
});

describe("end-to-end: org without a per-tenant app — install → approver → real approval → button via shared signing secret", () => {
  test("approval card is posted with the shared xoxb to the approver DM, and the press resolves it", async () => {
    const inbox = await installAndSetApprover();
    const employee = getRuntimeEmployees().find((e) => e.orgId === ORG && e.status === "active")!;
    const { approval } = await createApproval({
      orgId: ORG,
      employeeId: employee.id,
      credentialId: "cred_shared_e2e",
      title: "共通承認アプリ E2E",
      purpose: "fixture",
      summary: "fixture",
      risk: "medium",
    });
    calls = [];
    const results = await sendApprovalNotifications(approval, employee);
    expect(results.find((r) => r.ok)).toMatchObject({ ok: true, provider: "slack", channelId: inbox.id });
    const post = calls.find((c) => c.method === "chat.postMessage")!;
    expect(post.auth).toBe(`Bearer ${BOT}`);
    expect(post.body.channel).toBe(DM);
    const ts = `17000000${calls.indexOf(post) + 1}.0001`;

    const payload = {
      type: "block_actions",
      api_app_id: APP,
      team: { id: team },
      user: { id: APPROVER, team_id: team },
      channel: { id: DM },
      message: { ts },
      response_url: "",
      actions: [{ action_id: "staffpass_approve", value: approval.telegramRef || approval.id.slice(0, 12) }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const press = (secret: string) => {
      const { timestamp, signature } = sign(body, secret);
      return new Request("http://localhost/api/webhooks/slack/interactivity", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        body,
      });
    };
    // Wrong secret (e.g. a per-tenant secret) → 401, approval untouched.
    expect((await interactivityPOST(press("per-tenant-signing-secret"))).status).toBe(401);
    expect((await getApprovalById(approval.id, ORG))!.status).toBe("pending");
    // Flag OFF → the shared app is unknown to the per-tenant path → 401.
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect((await interactivityPOST(press(SIGNING))).status).toBe(401);
    expect((await getApprovalById(approval.id, ORG))!.status).toBe("pending");
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    // Shared signing secret → resolved for THIS org.
    expect((await interactivityPOST(press(SIGNING))).status).toBe(200);
    expect((await getApprovalById(approval.id, ORG))!.status).toBe("approved");
  });

  test("cross-org: a press through workspace X (bound to org B) can never resolve org A's approval", async () => {
    // Org B owns this workspace through the shared app; org A has a pending approval.
    expect((await completeSharedApprovalInstall({ orgId: OTHER_ORG, code: "c", deps: deps(goodExchange()) })).ok).toBe(true);
    const otherInbox = (await sharedInbox(OTHER_ORG))!;
    await upsertNotificationChannel({
      id: otherInbox.id,
      orgId: OTHER_ORG,
      provider: "slack",
      label: otherInbox.label,
      enabled: true,
      config: { ...otherInbox.config, allowedUserIds: [APPROVER], channelId: DM },
      secrets: {},
    });
    const employee = getRuntimeEmployees().find((e) => e.orgId === ORG && e.status === "active")!;
    const { approval } = await createApproval({
      orgId: ORG,
      employeeId: employee.id,
      credentialId: "cred_cross",
      title: "org A approval",
      purpose: "fixture",
      summary: "fixture",
      risk: "medium",
    });
    expect(approval.orgId).toBe(ORG);
    const payload = {
      type: "block_actions",
      api_app_id: APP,
      team: { id: team },
      user: { id: APPROVER, team_id: team },
      channel: { id: DM },
      message: { ts: "1.1" },
      response_url: "",
      actions: [{ action_id: "staffpass_approve", value: approval.telegramRef || approval.id.slice(0, 12) }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const { timestamp, signature } = sign(body);
    const res = await interactivityPOST(
      new Request("http://localhost/api/webhooks/slack/interactivity", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        body,
      })
    );
    expect(res.status).toBe(200);
    expect((await getApprovalById(approval.id, ORG))!.status).toBe("pending");
  });

  test("resolver: signature first; unknown team → 403; disabled inbox → 403", async () => {
    const inbox = await installAndSetApprover();
    const body = "payload=%7B%7D";
    const bad = sign(body, "nope");
    expect(await resolveSharedApprovalInteractivity({ apiAppId: APP, teamId: team, rawBody: body, ...bad })).toMatchObject({ ok: false, status: 401 });
    const good = sign(body);
    expect(await resolveSharedApprovalInteractivity({ apiAppId: APP, teamId: "TUNKNOWN99", rawBody: body, ...good })).toMatchObject({ ok: false, status: 403, error: "unknown_team" });
    const ok = await resolveSharedApprovalInteractivity({ apiAppId: APP, teamId: team, rawBody: body, ...good });
    expect(ok).toMatchObject({ ok: true, channel: { id: inbox.id, orgId: ORG, allowedUserIds: [APPROVER], signingSecret: "" } });
    await upsertNotificationChannel({ id: inbox.id, orgId: ORG, provider: "slack", label: inbox.label, enabled: false, config: inbox.config, secrets: {} });
    expect(await resolveSharedApprovalInteractivity({ apiAppId: APP, teamId: team, rawBody: body, ...good })).toMatchObject({ ok: false, status: 403 });
  });

  test("#240 contract: resolveApprovalAppBotToken (replicated) returns the shared xoxb, and the link DM is sent with it", async () => {
    const inbox = await installAndSetApprover();
    // Exact replica of #240 lib/slack/authorize-link.ts resolveApprovalAppBotToken(orgId, inboxId)
    // (head de313e4): owned + provider slack + enabled → secrets.botToken (xoxb- only).
    async function resolveApprovalAppBotToken(orgId: string, inboxId: string): Promise<string> {
      const owned = (await listNotificationChannels(orgId)).some(
        (channel) => channel.id === inboxId && channel.orgId === orgId && channel.provider === "slack" && channel.enabled
      );
      if (!owned) return "";
      const token = String((await getNotificationChannelSecretsById(orgId, inboxId))?.botToken || "").trim();
      return token.startsWith("xoxb-") ? token : "";
    }
    // #240 resolveSlackApprovalInbox: the org's unique enabled Slack inbox.
    const enabled = (await listNotificationChannels(ORG)).filter((row) => row.provider === "slack" && row.enabled);
    expect(enabled.map((row) => row.id)).toEqual([inbox.id]);
    const token = await resolveApprovalAppBotToken(ORG, inbox.id);
    expect(token).toBe(BOT);
    expect(await resolveApprovalAppBotToken(OTHER_ORG, inbox.id)).toBe("");
    // #240 delivery: openApprovalDeliveryDm(token, inbox allowedUserIds) → chat.postMessage(D…).
    calls = [];
    const opened = await openApprovalDeliveryDm({ botToken: token, allowedUserIds: enabled[0].config.allowedUserIds as string[] });
    expect(opened).toMatchObject({ ok: true, channelId: DM, userId: APPROVER, teamId: team });
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: DM, text: "link", unfurl_links: false }),
    });
    expect(calls.map((c) => c.method)).toEqual(["auth.test", "users.info", "conversations.open", "chat.postMessage"]);
    for (const c of calls) expect(c.auth).toBe(`Bearer ${BOT}`);
    // After uninstall the inbox is disabled → #240 gets no token (fail-closed).
    await handleSharedApprovalAppEvent((() => {
      const rawBody = JSON.stringify({ type: "event_callback", api_app_id: APP, team_id: team, event: { type: "app_uninstalled" } });
      return { rawBody, ...sign(rawBody) };
    })());
    expect(await resolveApprovalAppBotToken(ORG, inbox.id)).toBe("");
  });
});

describe("events (app_uninstalled / tokens_revoked)", () => {
  async function event(payload: Record<string, unknown>, opts: { secret?: string; ts?: number } = {}) {
    const rawBody = JSON.stringify(payload);
    const { timestamp, signature } = sign(rawBody, opts.secret ?? SIGNING, opts.ts);
    return handleSharedApprovalAppEvent({ rawBody, timestamp, signature });
  }

  test("url_verification: challenge only after a valid signature", async () => {
    expect(await event({ type: "url_verification", challenge: "abc" })).toEqual({ status: 200, body: { challenge: "abc" } });
    expect((await event({ type: "url_verification", challenge: "abc" }, { secret: "wrong" })).status).toBe(401);
  });

  test("bad signature / stale timestamp → 401; flag OFF → 404", async () => {
    await installAndSetApprover();
    const payload = { type: "event_callback", api_app_id: APP, team_id: team, event: { type: "app_uninstalled" } };
    expect((await event(payload, { secret: "wrong" })).status).toBe(401);
    expect((await event(payload, { ts: Math.floor(Date.now() / 1000) - 10 * 60 })).status).toBe(401);
    expect((await sharedInbox())!.enabled).toBe(true);
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect((await event(payload)).status).toBe(404);
  });

  test("unknown team → 200 ignored; other events → 200 ignored", async () => {
    await installAndSetApprover();
    expect(await event({ type: "event_callback", api_app_id: APP, team_id: "TUNKNOWN77", event: { type: "app_uninstalled" } })).toMatchObject({ status: 200, body: { ignored: true, reason: "unknown_team" } });
    expect(await event({ type: "event_callback", api_app_id: APP, team_id: team, event: { type: "message" } })).toMatchObject({ status: 200, body: { ignored: true } });
    expect(await event({ type: "event_callback", api_app_id: APP, team_id: team, event: { type: "tokens_revoked", tokens: { oauth: ["UX"] } } })).toMatchObject({ status: 200, body: { ignored: true } });
    expect((await sharedInbox())!.enabled).toBe(true);
  });

  test("app_uninstalled → that org's shared inbox disabled + admin audit + #236 alert; binding kept", async () => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    await installAndSetApprover();
    const result = await event({ type: "event_callback", api_app_id: APP, team_id: team, event: { type: "app_uninstalled" } });
    expect(result).toMatchObject({ status: 200, body: { ok: true, disabled: 1 } });
    const inbox = (await sharedInbox())!;
    expect(inbox.enabled).toBe(false);
    expect(inbox.config).toMatchObject({ teamId: team, disabledReason: "app_uninstalled" });
    const audits = (await listAuditEvents(ORG, 30)).map((e) => (e.metadata as Record<string, unknown>)?.event);
    expect(audits).toContain("shared_approval_app.disabled");
    expect(audits).toContain("approval_delivery.failed");
    // Another org still cannot take the workspace.
    expect(await completeSharedApprovalInstall({ orgId: OTHER_ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: false, code: "team_bound_to_other_org" });
    // Same org re-installs → enabled again.
    expect((await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).ok).toBe(true);
    expect((await sharedInbox())!.enabled).toBe(true);
  });

  test("tokens_revoked (bot) → disabled", async () => {
    await installAndSetApprover();
    expect(await event({ type: "event_callback", api_app_id: APP, team_id: team, event: { type: "tokens_revoked", tokens: { bot: ["USHAREDBOT1"] } } })).toMatchObject({ status: 200, body: { disabled: 1 } });
    expect((await sharedInbox())!.enabled).toBe(false);
  });
});

describe("setup.slackDmApprovalStatus (shared app block)", () => {
  test("flag ON, not installed: install step first; OFF: no shared block", async () => {
    const on = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    expect(on.sharedApprovalApp).toMatchObject({ enabled: true, configured: true, installed: false });
    expect((on.nextStepsJa as string[])[0]).toContain("/api/slack/approval-app/install/start");
    expect((on.nextStepsJa as string[]).join("\n")).not.toContain("Slack App B");
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    const off = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    expect(off.sharedApprovalApp).toEqual({ enabled: false });
  });

  test("installed, no approver → points at setup.slackApprover.set; done → no shared step", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) });
    const before = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    expect((before.nextStepsJa as string[]).join("\n")).toContain("setup.slackApprover.set");
    const queued = data(await callAdminMcpTool("setup.slackApprover.set", { slackUserId: APPROVER }, cred()));
    await approveTicket(String(queued.approvalId));
    const after = data(await callAdminMcpTool("setup.slackDmApprovalStatus", {}, cred()));
    expect((after.nextStepsJa as string[]).join("\n")).not.toContain("setup.slackApprover.set");
    expect(after.sharedApprovalApp).toMatchObject({ installed: true, inboxEnabled: true, approverSlackUserIds: [APPROVER], destinationKind: "dm", setupNoticeSent: true });
    noSecrets(after);
  });
});
