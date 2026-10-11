/**
 * 2026-10-10 (木村): setup.slackStatus reports the conversation bot token's REAL
 * scopes (auth.test x-oauth-scopes, via probeScopes in lib/admin-mcp/slack-dm-setup.ts)
 * and app id (bots.info with auth.test's bot_id), so the channel-classify scopes
 * can be checked after a reinstall and before CHANNEL_CLASSIFY_PROPOSALS goes ON.
 *
 * Read-only. Only the calling admin's own org adapter token is used; the token
 * never appears in the output or the logs; Slack errors are a status, not a throw.
 * Demo mode, dummy values, Slack fetch recorded, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { diagnoseSlackStatus, STAFFPASS_SLACK_APP_ID } from "@/lib/slack/slack-status-diagnose";

const STAFFPASS_APP = "A0BU8TABSV6";
const TOKEN_A = "xoxb-org-a-own-dummy-111";
const TOKEN_B = "xoxb-org-b-own-dummy-222";
const ORG_B = "org_status_scopes_b";
const BASE_SCOPES = ["chat:write", "files:write", "im:write", "reactions:write"];
const CLASSIFY_SCOPES = ["channels:read", "groups:read", "users:read", "im:read", "mpim:read"];

type Bot = { scopes: string[] | null; botId: string; appId: string; authError?: string; botsInfoError?: string; status429?: "auth" | "bots" };
const bots: Record<string, Bot> = {};
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; auth: string }> = [];
let logged: string[] = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  logged = [];
  for (const k of Object.keys(bots)) delete bots[k];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") || "";
    calls.push({ url, auth });
    const bot = bots[auth.replace(/^Bearer /, "")];
    if (!bot) return json({ ok: false, error: "invalid_auth" });
    if (url.includes("auth.test")) {
      if (bot.status429 === "auth") return json({ ok: false, error: "ratelimited" }, { "retry-after": "30" }, 429);
      if (bot.authError) return json({ ok: false, error: bot.authError });
      return json(
        { ok: true, bot_id: bot.botId, user_id: "UBOTUSER1", team_id: "TTEAM00001", team: "Fixture" },
        bot.scopes === null ? {} : { "x-oauth-scopes": bot.scopes.join(",") }
      );
    }
    if (url.includes("bots.info")) {
      if (bot.status429 === "bots") return json({ ok: false, error: "ratelimited" }, { "retry-after": "30" }, 429);
      if (bot.botsInfoError) return json({ ok: false, error: bot.botsInfoError, needed: "users:read" });
      return json({ ok: true, bot: { id: bot.botId, app_id: bot.appId, user_id: "UBOTUSER1", name: "staffpass" } });
    }
    // files:write probe and anything else
    return json({ ok: true, upload_url: "https://files.slack.com/upload/x", file_id: "F0001" });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Object.assign(console, originalConsole);
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

async function orgA(bot: Bot) {
  bots[TOKEN_A] = bot;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: TOKEN_A } });
}

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_status_scopes", status: "linked" });
  return {
    orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent,
  };
}

function noTokenAnywhere(value: unknown) {
  const out = JSON.stringify(value);
  expect(out).not.toContain(TOKEN_A);
  expect(out).not.toContain(TOKEN_B);
  expect(out).not.toContain("xoxb-");
  for (const line of logged) {
    expect(line).not.toContain(TOKEN_A);
    expect(line).not.toContain(TOKEN_B);
    expect(line).not.toContain("xoxb-");
  }
}

describe("setup.slackStatus: conversation bot scopes + app id", () => {
  test("Staffpass app id constant is the real app", () => {
    expect(STAFFPASS_SLACK_APP_ID).toBe(STAFFPASS_APP);
  });

  test("all channel-classify scopes present, Staffpass app → nothing missing, appId matches", async () => {
    await orgA({ scopes: [...BASE_SCOPES, ...CLASSIFY_SCOPES], botId: "BBOT000001", appId: STAFFPASS_APP });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botScopeCheck).toEqual({
      status: "ok",
      code: "",
      scopes: [...BASE_SCOPES, ...CLASSIFY_SCOPES],
      missingChannelClassifyScopes: [],
      channelClassifyScopesReady: true,
    });
    expect(s.missingChannelClassifyScopes).toEqual([]);
    expect(s.botApp).toEqual({ status: "ok", code: "", appId: STAFFPASS_APP, expectedAppId: STAFFPASS_APP, matchesStaffpassApp: true });
    expect(s.botAppIdMatchesStaffpass).toBe(true);
    const bi = calls.find((c) => c.url.includes("bots.info"));
    expect(bi?.url).toContain("bot=BBOT000001");
    expect(bi?.auth).toBe(`Bearer ${TOKEN_A}`);
    noTokenAnywhere(s);
  });

  test("some scopes missing (pre-reinstall token) → exactly those listed, not ready", async () => {
    await orgA({ scopes: [...BASE_SCOPES, "users:read", "im:read"], botId: "BBOT000001", appId: STAFFPASS_APP });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botScopeCheck.status).toBe("ok");
    expect(s.missingChannelClassifyScopes).toEqual(["channels:read", "groups:read", "mpim:read"]);
    expect(s.botScopeCheck.channelClassifyScopesReady).toBe(false);
    noTokenAnywhere(s);
  });

  test("appId mismatch (token from another Slack app) → matchesStaffpassApp false", async () => {
    await orgA({ scopes: [...BASE_SCOPES, ...CLASSIFY_SCOPES], botId: "BBOT000002", appId: "AOTHERAPP01" });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botApp).toMatchObject({ status: "ok", appId: "AOTHERAPP01", expectedAppId: STAFFPASS_APP, matchesStaffpassApp: false });
    expect(s.botAppIdMatchesStaffpass).toBe(false);
  });

  test("bots.info missing_scope → clear status, appId unknown (null), scopes still reported, no throw", async () => {
    await orgA({ scopes: BASE_SCOPES, botId: "BBOT000001", appId: STAFFPASS_APP, botsInfoError: "missing_scope" });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botApp).toEqual({ status: "bots_info_failed", code: "missing_scope", appId: null, expectedAppId: STAFFPASS_APP, matchesStaffpassApp: null });
    expect(s.botAppIdMatchesStaffpass).toBeNull();
    expect(s.missingChannelClassifyScopes).toEqual(CLASSIFY_SCOPES);
    noTokenAnywhere(s);
  });

  test("bots.info ratelimited (HTTP 429) → status, no throw", async () => {
    await orgA({ scopes: [...BASE_SCOPES, ...CLASSIFY_SCOPES], botId: "BBOT000001", appId: STAFFPASS_APP, status429: "bots" });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botApp).toMatchObject({ status: "bots_info_failed", code: "ratelimited", appId: null, matchesStaffpassApp: null });
  });

  test("auth.test invalid_auth → scope check auth_test_failed, nothing claimed, bots.info not called", async () => {
    await orgA({ scopes: CLASSIFY_SCOPES, botId: "BBOT000001", appId: STAFFPASS_APP, authError: "invalid_auth" });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botScopeCheck).toEqual({ status: "auth_test_failed", code: "invalid_auth", scopes: null, missingChannelClassifyScopes: null, channelClassifyScopesReady: false });
    expect(s.missingChannelClassifyScopes).toBeNull();
    expect(s.botApp).toMatchObject({ status: "not_probed", appId: null, matchesStaffpassApp: null });
    expect(calls.some((c) => c.url.includes("bots.info"))).toBe(false);
    noTokenAnywhere(s);
  });

  test("auth.test ratelimited (HTTP 429) → status, no throw", async () => {
    await orgA({ scopes: CLASSIFY_SCOPES, botId: "BBOT000001", appId: STAFFPASS_APP, status429: "auth" });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botScopeCheck).toMatchObject({ status: "auth_test_failed", code: "ratelimited", missingChannelClassifyScopes: null, channelClassifyScopesReady: false });
  });

  test("no x-oauth-scopes header → scopes_unavailable, missing unknown (null), never 'ready'", async () => {
    await orgA({ scopes: null, botId: "BBOT000001", appId: STAFFPASS_APP });
    const s = await diagnoseSlackStatus(DEMO_ORG.id);
    expect(s.botScopeCheck).toMatchObject({ status: "scopes_unavailable", scopes: null, missingChannelClassifyScopes: null, channelClassifyScopesReady: false });
  });

  test("no org token → token_missing, nothing probed, no Slack call", async () => {
    const s = await diagnoseSlackStatus("org_status_scopes_none");
    expect(s.botScopeCheck).toMatchObject({ status: "token_missing", scopes: null, missingChannelClassifyScopes: null, channelClassifyScopesReady: false });
    expect(s.botApp).toMatchObject({ status: "not_probed", appId: null, matchesStaffpassApp: null });
    expect(calls).toEqual([]);
  });

  test("Admin MCP: org isolation — admin of org A only ever uses A's token, gets A's data; orgId arg ignored", async () => {
    await orgA({ scopes: [...BASE_SCOPES, "users:read"], botId: "BBOTAAAAA1", appId: STAFFPASS_APP });
    bots[TOKEN_B] = { scopes: [...BASE_SCOPES, ...CLASSIFY_SCOPES], botId: "BBOTBBBBB1", appId: "AORGBAPP001" };
    await upsertConversationAdapter({ orgId: ORG_B, surface: "slack", enabled: true, secrets: { botToken: TOKEN_B } });
    const result = await callAdminMcpTool("setup.slackStatus", { orgId: ORG_B }, demoCred());
    const body = result.structuredContent as Record<string, unknown>;
    expect(body.missingChannelClassifyScopes).toEqual(["channels:read", "groups:read", "im:read", "mpim:read"]);
    expect((body.botApp as Record<string, unknown>).appId).toBe(STAFFPASS_APP);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.auth.includes(TOKEN_B))).toEqual([]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN_A}`)).toBe(true);
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).not.toContain("AORGBAPP001");
    expect(text).not.toContain("BBOTBBBBB1");
    noTokenAnywhere(body);
    noTokenAnywhere(text);
  });

  test("read-only: only auth.test / bots.info / the existing files:write probe are called", async () => {
    await orgA({ scopes: [...BASE_SCOPES, ...CLASSIFY_SCOPES], botId: "BBOT000001", appId: STAFFPASS_APP });
    await diagnoseSlackStatus(DEMO_ORG.id);
    const methods = [...new Set(calls.map((c) => new URL(c.url).pathname.replace("/api/", "")))].sort();
    for (const m of methods) expect(["auth.test", "bots.info", "files.getUploadURLExternal"]).toContain(m);
  });
});
