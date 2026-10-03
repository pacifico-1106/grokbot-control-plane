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
  getEnabledNotificationChannels,
  getNotificationChannelSecretsById,
  listAllEnabledNotificationChannels,
  listNotificationChannels,
  resolveEmployeeApprovalChannel,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { consumeSlackOAuthStateNonce, resetDemoSlackOAuthStateUses } from "@/lib/data/slack-oauth-state-uses";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { sendApprovalNotifications } from "@/lib/notify/channels";
import { alertApprovalDeliveryFailure, resetApprovalAlertThrottleForTests, setApprovalAlertDepsForTests } from "@/lib/notify/delivery-failure-alert";
import { diagnoseSlackDmApprovalSetup, fulfillApprovalDeliveryAutoResolve } from "@/lib/admin-mcp/slack-dm-setup";
import { fulfillSlackApproverSet, sharedApprovalAppStatus } from "@/lib/admin-mcp/slack-approver";
import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import { resolveApprovalAppBotToken } from "@/lib/slack/authorize-link";
import { SHARED_APPROVAL_CONNECTION_LOST_NEXT_STEP_JA } from "@/lib/slack/shared-approval-revoke";
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
import type { Employee, NotificationChannel } from "@/lib/types";

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
  "SLACK_AUTHORIZE_LINK_ENABLED",
  "SLACK_USER_SCOPE_IM_WRITE",
  "SLACK_CLIENT_ID",
] as const;

let saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let calls: Array<{ method: string; auth: string; body: Record<string, unknown> }> = [];
let team = "";
let seq = 0;
let usersInfoTeam: string | null = null;
/** chat.postMessage failure code for the delivery-path revocation tests. */
let postMessageError: string | null = null;

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
    if (method === "chat.postMessage") {
      if (postMessageError) return json({ ok: false, error: postMessageError });
      return json({ ok: true, channel: String(body.channel || DM), ts: `17000000${calls.length}.0001` });
    }
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
  postMessageError = null;
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

describe("revocation → the shared app's encrypted secrets are deleted (要判断 4)", () => {
  async function event(type: "app_uninstalled" | "tokens_revoked", teamId = team) {
    const payload =
      type === "app_uninstalled"
        ? { type: "event_callback", api_app_id: APP, team_id: teamId, event: { type } }
        : { type: "event_callback", api_app_id: APP, team_id: teamId, event: { type, tokens: { bot: ["USHAREDBOT1"] } } };
    const rawBody = JSON.stringify(payload);
    return handleSharedApprovalAppEvent({ rawBody, ...sign(rawBody) });
  }
  // Exact replica of #240 resolveApprovalAppBotToken (head de313e4).
  async function resolveApprovalAppBotToken(orgId: string, inboxId: string): Promise<string> {
    const owned = (await listNotificationChannels(orgId)).some(
      (channel) => channel.id === inboxId && channel.orgId === orgId && channel.provider === "slack" && channel.enabled
    );
    if (!owned) return "";
    const token = String((await getNotificationChannelSecretsById(orgId, inboxId))?.botToken || "").trim();
    return token.startsWith("xoxb-") ? token : "";
  }
  // Demo audit is shared across tests → scope to this test's inbox(es).
  async function purgeAudits(orgId = ORG, inboxId?: string) {
    const id = inboxId ?? (await sharedInbox(orgId))?.id;
    return (await listAuditEvents(orgId, 200)).filter(
      (e) => (e.metadata as Record<string, unknown>)?.event === "shared_approval_app.secrets_purged" && (!id || (e.metadata as Record<string, unknown>)?.inboxId === id)
    );
  }

  test("app_uninstalled → botToken deleted; audit has only teamId / deletedAt / reason / key names (no token)", async () => {
    const inbox = await installAndSetApprover();
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({ botToken: BOT });
    const result = await event("app_uninstalled");
    expect(result).toMatchObject({ status: 200, body: { ok: true, disabled: 1, purged: 1 } });
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    const after = (await sharedInbox())!;
    expect(after.enabled).toBe(false);
    expect(after.hasCredentials).toBe(false);
    expect(after.config).toMatchObject({ teamId: team, disabledReason: "app_uninstalled" });
    const audits = await purgeAudits();
    expect(audits.length).toBe(1);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ teamId: team, reason: "app_uninstalled", deletedKeys: ["botToken"], inboxId: inbox.id });
    expect(typeof meta.deletedAt).toBe("string");
    expect(Number.isNaN(Date.parse(String(meta.deletedAt)))).toBe(false);
    noSecrets(audits);
    expect(JSON.stringify(audits)).not.toContain("xoxb-");
  });

  test("tokens_revoked (bot) → deleted with reason tokens_revoked", async () => {
    const inbox = await installAndSetApprover();
    expect(await event("tokens_revoked")).toMatchObject({ status: 200, body: { purged: 1 } });
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    expect((await purgeAudits())[0].metadata).toMatchObject({ reason: "tokens_revoked", deletedKeys: ["botToken"] });
  });

  test("idempotent: the same event twice → second is a no-op (one disable audit, one purge audit, still no secrets)", async () => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    const inbox = await installAndSetApprover();
    expect(await event("app_uninstalled")).toMatchObject({ status: 200, body: { disabled: 1, purged: 1 } });
    expect(await event("app_uninstalled")).toMatchObject({ status: 200, body: { ok: true, disabled: 0, purged: 0 } });
    expect(await event("tokens_revoked")).toMatchObject({ status: 200, body: { ok: true, disabled: 0, purged: 0 } });
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    expect((await purgeAudits()).length).toBe(1);
    const disabledAudits = (await listAuditEvents(ORG, 200)).filter(
      (e) => (e.metadata as Record<string, unknown>)?.event === "shared_approval_app.disabled" && (e.metadata as Record<string, unknown>)?.inboxId === inbox.id
    );
    expect(disabledAudits.length).toBe(1);
    expect((await sharedInbox())!.config).toMatchObject({ disabledReason: "app_uninstalled" });
  });

  test("other orgs' secrets and this org's per-tenant Slack inbox are never touched", async () => {
    // Other org: its own per-tenant Slack app in another workspace.
    const otherTeam = newTeam();
    const otherInbox = await upsertNotificationChannel({
      orgId: OTHER_ORG,
      provider: "slack",
      enabled: true,
      label: "other org app",
      config: { channelId: "", allowedUserIds: ["UOTHER0001"], teamId: otherTeam, expectedTeamId: otherTeam },
      secrets: { botToken: "xoxb-other-org-SECRET-9", signingSecret: "other-sign-SECRET" },
    });
    const inbox = await installAndSetApprover();
    // This org's per-tenant approval app in the SAME workspace (allowed in parallel).
    const tenantInbox = await upsertNotificationChannel({
      orgId: ORG,
      provider: "slack",
      enabled: true,
      label: "tenant app",
      config: { channelId: "", allowedUserIds: [APPROVER], teamId: team, expectedTeamId: team },
      secrets: { botToken: "xoxb-tenant-app-SECRET-8", signingSecret: "tenant-sign-SECRET" },
    });
    expect(await event("app_uninstalled")).toMatchObject({ status: 200, body: { purged: 1 } });
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    expect(await getNotificationChannelSecretsById(OTHER_ORG, otherInbox.id)).toEqual({ botToken: "xoxb-other-org-SECRET-9", signingSecret: "other-sign-SECRET" });
    expect(await getNotificationChannelSecretsById(ORG, tenantInbox.id)).toEqual({ botToken: "xoxb-tenant-app-SECRET-8", signingSecret: "tenant-sign-SECRET" });
    expect((await listNotificationChannels(ORG)).find((r) => r.id === tenantInbox.id)!.enabled).toBe(true);
    // An event for the other org's workspace never reaches its (non-shared) inbox.
    expect(await event("app_uninstalled", otherTeam)).toMatchObject({ status: 200, body: { ignored: true, reason: "unknown_team" } });
    expect(await getNotificationChannelSecretsById(OTHER_ORG, otherInbox.id)).toEqual({ botToken: "xoxb-other-org-SECRET-9", signingSecret: "other-sign-SECRET" });
    expect((await purgeAudits(OTHER_ORG, otherInbox.id)).length).toBe(0);
  });

  test("after deletion the #240 resolver gets no token (fail-closed), even if the row were enabled again; re-enable without a token is refused", async () => {
    const inbox = await installAndSetApprover();
    expect(await resolveApprovalAppBotToken(ORG, inbox.id)).toBe(BOT);
    await event("app_uninstalled");
    expect(await resolveApprovalAppBotToken(ORG, inbox.id)).toBe("");
    // Token absence alone is enough: the secrets read returns nothing for the row.
    expect(String((await getNotificationChannelSecretsById(ORG, inbox.id)).botToken || "")).toBe("");
    // Turning the row back on without a new install is refused (no bot token).
    const row = (await sharedInbox())!;
    await expect(
      upsertNotificationChannel({ id: row.id, orgId: ORG, provider: "slack", label: row.label, enabled: true, config: row.config, secrets: {} })
    ).rejects.toThrow("slack_credentials_incomplete");
    // The approver DM cannot be opened with no token.
    expect(await openApprovalDeliveryDm({ botToken: await resolveApprovalAppBotToken(ORG, inbox.id), allowedUserIds: [APPROVER] })).toMatchObject({ ok: false, code: "bot_token_required" });
  });

  test("re-install by the same org restores it: new xoxb stored, inbox enabled, approver kept, #240 resolver returns the new token", async () => {
    const inbox = await installAndSetApprover();
    await event("app_uninstalled");
    const NEW_BOT = "xoxb-shared-approval-reinstalled-SECRET-4";
    const again = await completeSharedApprovalInstall({ orgId: ORG, code: "c2", deps: deps(goodExchange({ access_token: NEW_BOT })) });
    expect(again.ok).toBe(true);
    const restored = (await sharedInbox())!;
    expect(restored.id).toBe(inbox.id);
    expect(restored.enabled).toBe(true);
    expect(restored.config.disabledReason).toBeUndefined();
    expect(restored.config.allowedUserIds).toEqual([APPROVER]);
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({ botToken: NEW_BOT });
    expect(await resolveApprovalAppBotToken(ORG, inbox.id)).toBe(NEW_BOT);
  });

  test("delivery path: Slack answers token_revoked to a real approval → same disable + delete; other errors delete nothing", async () => {
    const inbox = await installAndSetApprover();
    const employee = getRuntimeEmployees().find((e) => e.orgId === ORG && e.status === "active")!;
    const make = async (title: string) =>
      (await createApproval({ orgId: ORG, employeeId: employee.id, credentialId: "cred_shared_revoke", title, purpose: "fixture", summary: "fixture", risk: "medium" })).approval;
    // A non-revocation error (e.g. channel_not_found) keeps the token.
    postMessageError = "channel_not_found";
    await sendApprovalNotifications(await make("not revoked"), employee);
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({ botToken: BOT });
    expect((await sharedInbox())!.enabled).toBe(true);
    // token_revoked from Slack → disabled + deleted.
    postMessageError = "token_revoked";
    await sendApprovalNotifications(await make("revoked"), employee);
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    const after = (await sharedInbox())!;
    expect(after.enabled).toBe(false);
    expect(after.config).toMatchObject({ disabledReason: "token_revoked", teamId: team });
    expect((await purgeAudits())[0].metadata).toMatchObject({ teamId: team, reason: "token_revoked", deletedKeys: ["botToken"] });
    noSecrets(await purgeAudits());
  });

  test("delivery path: flag OFF → nothing is deleted even on token_revoked", async () => {
    const inbox = await installAndSetApprover();
    const employee = getRuntimeEmployees().find((e) => e.orgId === ORG && e.status === "active")!;
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    postMessageError = "token_revoked";
    const { approval } = await createApproval({ orgId: ORG, employeeId: employee.id, credentialId: "cred_shared_revoke", title: "off", purpose: "fixture", summary: "fixture", risk: "medium" });
    await sendApprovalNotifications(approval, employee);
    // Flag OFF withholds the token (review M1); it is still stored — visible again once ON.
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({ botToken: BOT });
  });
});

// ---------------------------------------------------------------------------
// Review M1 + (1)–(3): flag OFF stops every shared-app send; deletion alerts.
// ---------------------------------------------------------------------------
const CONNECTION_LOST_JA =
  "共通承認アプリの接続が切れました。owner/admin が Staffpass にログインした状態で install/start を開き、「許可する」を押せば戻ります";

async function channelAlerts(channelId: string, event = "approval_delivery.failed", orgId = ORG) {
  return (await listAuditEvents(orgId, 300)).filter((e) => {
    const meta = (e.metadata as Record<string, unknown>) || {};
    return meta.event === event && meta.channelId === channelId;
  });
}

async function seedTenantInbox(opts: { isDefault?: boolean; token?: string } = {}) {
  return upsertNotificationChannel({
    orgId: ORG,
    provider: "slack",
    enabled: true,
    ...(opts.isDefault !== undefined ? { isDefault: opts.isDefault } : {}),
    label: "tenant app",
    config: { channelId: "DTENANTDM01", allowedUserIds: [APPROVER], apiAppId: "ATENANTAPP1", teamId: team, expectedTeamId: team },
    secrets: { botToken: opts.token ?? "xoxb-tenant-app-SECRET-7", signingSecret: "tenant-sign-SECRET" },
  });
}

async function fixtureApproval(title: string) {
  const employee = getRuntimeEmployees().find((e) => e.orgId === ORG && e.status === "active")!;
  const { approval } = await createApproval({ orgId: ORG, employeeId: employee.id, credentialId: "cred_shared_m1", title, purpose: "fixture", summary: "fixture", risk: "medium" });
  return { approval, employee };
}

describe("M1: SLACK_SHARED_APPROVAL_APP_ENABLED OFF after install stops every shared-app send", () => {
  test("approval delivery: no card with the shared xoxb; counted as a delivery failure; #236 alert fires", async () => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    const inbox = await installAndSetApprover();
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    resetApprovalAlertThrottleForTests();
    const { approval, employee } = await fixtureApproval("flag off");
    calls = [];
    const results = await sendApprovalNotifications(approval, employee);
    expect(calls.filter((c) => c.auth === `Bearer ${BOT}`)).toEqual([]);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toEqual([]);
    expect(results.some((r) => r.ok)).toBe(false);
    expect(results.find((r) => !r.ok && r.channelId === inbox.id)).toMatchObject({ ok: false, provider: "slack", channelId: inbox.id, error: "shared_approval_app_disabled" });
    const alerts = await channelAlerts(inbox.id);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect((alerts[0].metadata as Record<string, unknown>).reason).toBe("shared_approval_app_disabled");
  });

  test("data layer: shared inbox is not a runtime channel and its token is withheld (#240 resolver → \"\") + alert; bot-token fallback never returns it", async () => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    const inbox = await installAndSetApprover();
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    resetApprovalAlertThrottleForTests();
    expect((await getEnabledNotificationChannels(ORG)).map((c) => c.id)).not.toContain(inbox.id);
    expect((await listAllEnabledNotificationChannels()).map((c) => c.id)).not.toContain(inbox.id);
    expect((await resolveEmployeeApprovalChannel(ORG, { approvalChannelId: inbox.id }))?.id ?? null).not.toBe(inbox.id);
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    // #240 resolveApprovalAppBotToken (replica, head de313e4).
    const owned = (await listNotificationChannels(ORG)).some((c) => c.id === inbox.id && c.provider === "slack" && c.enabled);
    const token = owned ? String((await getNotificationChannelSecretsById(ORG, inbox.id)).botToken || "") : "";
    expect(token.startsWith("xoxb-") ? token : "").toBe("");
    expect(await resolveOrgSlackBotToken(ORG)).not.toBe(BOT);
    const alerts = await channelAlerts(inbox.id);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect((alerts[0].metadata as Record<string, unknown>).reason).toBe("shared_approval_app_disabled");
  });

  test("approval DM auto-open / approver set / status probe: no Slack call with the shared xoxb", async () => {
    process.env.SLACK_APPROVAL_DM_AUTO_OPEN = "true";
    const inbox = await installAndSetApprover();
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    calls = [];
    const opened = await fulfillApprovalDeliveryAutoResolve({ orgId: ORG, approvalId: "apr_m1_auto", args: { inboxId: inbox.id } });
    expect(opened).toMatchObject({ ok: false, code: "shared_approval_app_disabled" });
    const approver = await fulfillSlackApproverSet({ orgId: ORG, approvalId: "apr_m1_set", args: { slackUserId: APPROVER, inboxId: inbox.id } });
    expect(approver).toMatchObject({ ok: false, code: "feature_disabled" });
    const diag = await diagnoseSlackDmApprovalSetup(ORG);
    const row = (diag.approvalInboxes as Array<Record<string, unknown>>).find((r) => r.inboxId === inbox.id)!;
    expect(row).toMatchObject({ suspended: "shared_approval_app_flag_off" });
    expect(calls.filter((c) => c.auth === `Bearer ${BOT}`)).toEqual([]);
  });

  test("a press on an old card while OFF → 401 and a #236 button alert for that org", async () => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    const inbox = await installAndSetApprover();
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    resetApprovalAlertThrottleForTests();
    const payload = { type: "block_actions", api_app_id: APP, team: { id: team }, user: { id: APPROVER, team_id: team }, channel: { id: DM }, message: { ts: "1.1" }, response_url: "", actions: [{ action_id: "staffpass_approve", value: "x" }] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const { timestamp, signature } = sign(body);
    const res = await interactivityPOST(new Request("http://localhost/api/webhooks/slack/interactivity", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      body,
    }) as never);
    expect(res.status).toBe(401);
    const alerts = await channelAlerts(inbox.id, "approval_button.failed");
    expect(alerts.length).toBe(1);
    expect((alerts[0].metadata as Record<string, unknown>).reason).toBe("shared_approval_app_disabled");
    // A forged press (wrong secret) never raises an alert for the org.
    resetApprovalAlertThrottleForTests();
    const forged = sign(body, "wrong-secret");
    await interactivityPOST(new Request("http://localhost/api/webhooks/slack/interactivity", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": forged.timestamp, "x-slack-signature": forged.signature },
      body,
    }) as never);
    expect((await channelAlerts(inbox.id, "approval_button.failed")).length).toBe(1);
  });

  test("per-tenant approval app inbox is unaffected while OFF (card sent with ITS token, secrets readable, no alert)", async () => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    const tenant = await seedTenantInbox({ isDefault: true });
    await installAndSetApprover();
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    resetApprovalAlertThrottleForTests();
    const { approval, employee } = await fixtureApproval("tenant still works");
    calls = [];
    const results = await sendApprovalNotifications(approval, employee);
    expect(results.find((r) => r.ok)).toMatchObject({ ok: true, channelId: tenant.id });
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts.length).toBe(1);
    expect(posts[0].auth).toBe("Bearer xoxb-tenant-app-SECRET-7");
    expect(await getNotificationChannelSecretsById(ORG, tenant.id)).toEqual({ botToken: "xoxb-tenant-app-SECRET-7", signingSecret: "tenant-sign-SECRET" });
    expect((await getEnabledNotificationChannels(ORG)).map((c) => c.id)).toContain(tenant.id);
    expect((await channelAlerts(tenant.id)).length).toBe(0);
  });

  test("turning the flag back ON resumes the shared inbox (OFF is a real rollback switch)", async () => {
    const inbox = await installAndSetApprover();
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({ botToken: BOT });
    const { approval, employee } = await fixtureApproval("back on");
    calls = [];
    const results = await sendApprovalNotifications(approval, employee);
    expect(results.find((r) => r.ok)).toMatchObject({ ok: true, channelId: inbox.id });
    expect(calls.find((c) => c.method === "chat.postMessage")!.auth).toBe(`Bearer ${BOT}`);
  });
});

describe("review 2: setup.slackApprover.set saves first, then posts 「設定しました」", () => {
  test("save fails → no notice is posted, failure returned + audited", async () => {
    const installed = await completeSharedApprovalInstall({ orgId: ORG, code: "code-1", deps: deps(goodExchange()) });
    expect(installed.ok).toBe(true);
    const inbox = (await sharedInbox())!;
    calls = [];
    const result = await fulfillSlackApproverSet({
      orgId: ORG,
      approvalId: "apr_save_fail",
      args: { slackUserId: APPROVER, inboxId: inbox.id },
      deps: { save: async () => { throw new Error("db down"); } },
    });
    expect(result).toMatchObject({ ok: false, code: "save_failed" });
    expect(calls.filter((c) => c.method === "chat.postMessage")).toEqual([]);
    expect((await sharedInbox())!.config.allowedUserIds).toEqual([]);
    const audits = (await listAuditEvents(ORG, 100)).filter((e) => (e.metadata as Record<string, unknown>)?.event === "shared_approval_app.approver_set_failed" && (e.metadata as Record<string, unknown>)?.approvalId === "apr_save_fail");
    expect(audits.length).toBe(1);
  });

  test("success → the save happens before the notice", async () => {
    await completeSharedApprovalInstall({ orgId: ORG, code: "code-1", deps: deps(goodExchange()) });
    const inbox = (await sharedInbox())!;
    const order: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("chat.postMessage")) order.push("notice");
      return realFetch(url, init);
    }) as unknown as typeof fetch;
    const result = await fulfillSlackApproverSet({
      orgId: ORG,
      approvalId: "apr_save_order",
      args: { slackUserId: APPROVER, inboxId: inbox.id },
      deps: { save: async (input) => { order.push("save"); return upsertNotificationChannel(input); } },
    });
    expect(result).toMatchObject({ ok: true });
    expect(order[0]).toBe("save");
    expect(order).toContain("notice");
    expect(order.indexOf("save")).toBeLessThan(order.indexOf("notice"));
    const saved = (await sharedInbox())!;
    expect(saved.config).toMatchObject({ allowedUserIds: [APPROVER], channelId: DM });
    expect(typeof saved.config.setupNoticeAt).toBe("string");
  });
});

describe("decision: every token deletion raises #236 with the reconnect step; tenant tokens never deleted", () => {
  async function event(type: "app_uninstalled" | "tokens_revoked") {
    const payload =
      type === "app_uninstalled"
        ? { type: "event_callback", api_app_id: APP, team_id: team, event: { type } }
        : { type: "event_callback", api_app_id: APP, team_id: team, event: { type, tokens: { bot: ["USHAREDBOT1"] } } };
    const rawBody = JSON.stringify(payload);
    return handleSharedApprovalAppEvent({ rawBody, ...sign(rawBody) });
  }
  let mails: Array<{ text?: string }> = [];
  beforeEach(() => {
    process.env.APPROVAL_DELIVERY_FAILURE_ALERT = "true";
    mails = [];
    setApprovalAlertDepsForTests({ mailer: (async (input: { text?: string }) => { mails.push(input); return { ok: true }; }) as never });
  });
  afterEach(() => setApprovalAlertDepsForTests({ mailer: null }));

  function expectReconnectAlert(alerts: Awaited<ReturnType<typeof channelAlerts>>, reason: string) {
    const hit = alerts.find((a) => (a.metadata as Record<string, unknown>).reason === reason)!;
    expect(hit).toBeTruthy();
    expect((hit.metadata as Record<string, unknown>).nextStepJa).toBe(CONNECTION_LOST_JA);
    expect(JSON.stringify(hit)).not.toContain("https://");
  }

  for (const type of ["app_uninstalled", "tokens_revoked"] as const) {
    test(`${type}: deletion → alert with the reconnect step (text + mail, no URL); repeat → no new alert`, async () => {
      expect(SHARED_APPROVAL_CONNECTION_LOST_NEXT_STEP_JA).toBe(CONNECTION_LOST_JA);
      const inbox = await installAndSetApprover();
      // Setup itself may leave unrelated (approvalId-bearing) alerts; count the delta.
      const before = (await channelAlerts(inbox.id)).length;
      await event(type);
      const alerts = await channelAlerts(inbox.id);
      expect(alerts.length).toBe(before + 1);
      expectReconnectAlert(alerts, type);
      expect(mails.some((m) => String(m.text).includes(CONNECTION_LOST_JA))).toBe(true);
      expect(mails.some((m) => /https?:\/\/[^\s]*install\/start/.test(String(m.text)))).toBe(false);
      // Idempotent repeat: nothing deleted → no alert (throttle reset so suppression can't hide one).
      resetApprovalAlertThrottleForTests();
      mails = [];
      await event(type);
      expect((await channelAlerts(inbox.id)).length).toBe(before + 1);
      expect(mails.length).toBe(0);
    });
  }

  test("already disabled but token still stored → the deletion still alerts", async () => {
    const inbox = await installAndSetApprover();
    const row = (await sharedInbox())!;
    await upsertNotificationChannel({ id: row.id, orgId: ORG, provider: "slack", label: row.label, enabled: false, config: { ...row.config, disabledReason: "manual" }, secrets: {} });
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({ botToken: BOT });
    await event("app_uninstalled");
    expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
    expectReconnectAlert(await channelAlerts(inbox.id), "app_uninstalled");
  });

  for (const code of ["token_revoked", "invalid_auth", "account_inactive"] as const) {
    test(`delivery ${code}: only the shared inbox's token is deleted (tenant inbox in the same org kept) + alert, even right after a throttled delivery alert`, async () => {
      const inbox = await installAndSetApprover(); // shared = default
      const tenant = await seedTenantInbox({ isDefault: false });
      resetApprovalAlertThrottleForTests();
      // An earlier delivery alert already holds this inbox's 30-min slot: the
      // deletion alert must still go out (forced past the throttle).
      await alertApprovalDeliveryFailure({ orgId: ORG, kind: "delivery_failed", approvalId: null, provider: "slack", channelId: inbox.id, reason: "earlier_failure" });
      const before = (await channelAlerts(inbox.id)).length;
      postMessageError = code;
      const { approval, employee } = await fixtureApproval(`shared ${code}`);
      await sendApprovalNotifications(approval, employee);
      expect((await channelAlerts(inbox.id)).filter((a) => (a.metadata as Record<string, unknown>).reason === code).length).toBe(1);
      expect((await channelAlerts(inbox.id)).length).toBeGreaterThan(before);
      expect(await getNotificationChannelSecretsById(ORG, inbox.id)).toEqual({});
      expect(await getNotificationChannelSecretsById(ORG, tenant.id)).toEqual({ botToken: "xoxb-tenant-app-SECRET-7", signingSecret: "tenant-sign-SECRET" });
      expect((await listNotificationChannels(ORG)).find((c) => c.id === tenant.id)!.enabled).toBe(true);
      expectReconnectAlert(await channelAlerts(inbox.id), code);
    });
  }

  test("per-tenant inbox answering invalid_auth / token_revoked → nothing deleted, inbox stays enabled", async () => {
    const tenant = await seedTenantInbox({ isDefault: true });
    for (const code of ["invalid_auth", "token_revoked"]) {
      postMessageError = code;
      const { approval, employee } = await fixtureApproval(`tenant ${code}`);
      await sendApprovalNotifications(approval, employee);
      expect(await getNotificationChannelSecretsById(ORG, tenant.id)).toEqual({ botToken: "xoxb-tenant-app-SECRET-7", signingSecret: "tenant-sign-SECRET" });
      expect((await listNotificationChannels(ORG)).find((c) => c.id === tenant.id)!.enabled).toBe(true);
    }
    const purged = (await listAuditEvents(ORG, 300)).filter((e) => (e.metadata as Record<string, unknown>)?.event === "shared_approval_app.secrets_purged" && (e.metadata as Record<string, unknown>)?.inboxId === tenant.id);
    expect(purged.length).toBe(0);
  });

  test("status shows the deleted state + the reconnect step (no URL); re-install clears it", async () => {
    const inbox = await installAndSetApprover();
    await event("app_uninstalled");
    const { status, nextStepsJa } = await sharedApprovalAppStatus(ORG);
    expect(status).toMatchObject({ inboxId: inbox.id, inboxEnabled: false, tokenDeleted: true, tokenDeletedReason: "app_uninstalled", connectionLost: true });
    expect(typeof status.tokenDeletedAt).toBe("string");
    expect(nextStepsJa).toContain(CONNECTION_LOST_JA);
    expect(nextStepsJa.join("\n")).not.toContain("https://");
    const diag = await diagnoseSlackDmApprovalSetup(ORG);
    expect((diag.nextStepsJa as string[])).toContain(CONNECTION_LOST_JA);
    expect(diag.sharedApprovalApp).toMatchObject({ tokenDeleted: true, connectionLost: true });
    expect(await completeSharedApprovalInstall({ orgId: ORG, code: "c", deps: deps(goodExchange()) })).toMatchObject({ ok: true });
    const after = await sharedApprovalAppStatus(ORG);
    expect(after.status).toMatchObject({ inboxEnabled: true, tokenDeleted: false, connectionLost: false });
    expect(after.nextStepsJa).not.toContain(CONNECTION_LOST_JA);
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

describe("merged with #240 (main): the real resolveApprovalAppBotToken / link DM go through the flag-OFF token gate", () => {
  test("flag ON → the shared xoxb; flag OFF → \"\" and setup.slackAuthorizeLink.issue stops at bot_token_required with no shared-xoxb call", async () => {
    process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
    process.env.SLACK_USER_SCOPE_IM_WRITE = "true";
    process.env.SLACK_CLIENT_ID = "a.b";
    const inbox = await installAndSetApprover();
    expect(await resolveApprovalAppBotToken(ORG, inbox.id)).toBe(BOT);
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect(await resolveApprovalAppBotToken(ORG, inbox.id)).toBe("");
    const base = getRuntimeEmployees().find((e) => e.orgId === ORG && e.status === "active")!;
    const emp: Employee = { ...base, id: `emp_shared_x240_${Date.now()}`, status: "active", allowedAccounts: [{ service: "slack", accountId: "UEMPSHARED01" }] };
    getRuntimeEmployees().push(emp);
    try {
      calls = [];
      const queued = data(await callAdminMcpTool("setup.slackAuthorizeLink.issue", { employeeId: emp.id }, cred()));
      expect(queued).toMatchObject({ needs_approval: true });
      const done = await approveTicket(String(queued.approvalId));
      expect(done).toMatchObject({ ok: false, tool: "setup.slackAuthorizeLink.issue", error: "bot_token_required" });
      expect(calls.filter((c) => c.auth === `Bearer ${BOT}`)).toEqual([]);
    } finally {
      emp.status = "suspended";
    }
  });
});
