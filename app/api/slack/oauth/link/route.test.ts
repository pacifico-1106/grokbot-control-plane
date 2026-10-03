/**
 * B: route-level checks for the re-authorize link (start route + callback link branch).
 * next/headers cookies() is replaced only while this file runs (inactive → real).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realHeaders from "next/headers";

const realCookies = realHeaders.cookies;
let active = true;
const jar = new Map<string, string>();
const fakeJar = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string) => {
    jar.set(name, value);
  },
  delete: (name: string) => {
    jar.delete(name);
  },
};
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: (...args: unknown[]) => (active ? Promise.resolve(fakeJar) : (realCookies as (...a: unknown[]) => unknown)(...args)),
}));
afterAll(() => {
  active = false;
});

const { GET: startGET } = await import("./route");
const { GET: callbackGET } = await import("../callback/route");
const { resolveApproval } = await import("@/lib/data");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { upsertOrgParty } = await import("@/lib/data/directory");
const { resetDemoNotificationChannels, upsertNotificationChannel } = await import("@/lib/data/notification-channels");
const { getSlackAuthorizeLink, resetDemoSlackAuthorizeLinks } = await import("@/lib/data/slack-authorize-links");
const { bindEmployeeSlackIdentity, getLinkedSlackUserToken, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { SLACK_OAUTH_COOKIE, verifySlackOAuthState } = await import("@/lib/slack/oauth");
import type { Employee } from "@/lib/types";

const ORG = DEMO_ORG.id;
const TEAM = "TLINKROUTE1";
const OLD = "xoxp-route-old-SECRET-1";
const NEW = "xoxp-route-new-SECRET-2";
const BOT = "xoxb-route-bot-SECRET-3";
const APPROVER = "UROUTEAPPR1";
const COLLEAGUE = "UROUTECOLL1";
const FLAGS = ["SLACK_AUTHORIZE_LINK_ENABLED", "SLACK_USER_SCOPE_IM_WRITE", "SLACK_DM_AUTOROUTE_ENABLED", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"] as const;
let saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let calls: Array<{ method: string; auth: string; body: string }> = [];
let emp: Employee;
let empSlack = "";
let seq = 0;

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    const body = String(init?.body ?? "");
    calls.push({ method, auth, body });
    const json = (payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "oauth.v2.access") return json({ ok: true, authed_user: { id: empSlack, access_token: NEW }, team: { id: TEAM } });
    if (method === "auth.test") {
      if (auth.endsWith(NEW) || auth.endsWith(OLD)) return json({ ok: true, user_id: empSlack, team_id: TEAM, user: "emp" }, { "x-oauth-scopes": "chat:write,users:read,im:write" });
      return json({ ok: true, user_id: "UBOT", team_id: TEAM, app_id: "AROUTE0001" }, { "x-oauth-scopes": "chat:write,im:write,im:read,users:read" });
    }
    if (method === "users.info") {
      const user = JSON.parse(body || "{}").user ?? new URLSearchParams(body).get("user");
      return json({ ok: true, user: { id: String(user), team_id: TEAM } });
    }
    if (method === "conversations.open") return json({ ok: true, channel: { id: `DROUTE${calls.length}`, is_im: true } });
    if (method === "chat.postMessage") return json({ ok: true, ts: "1.1" });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

function cred() {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_route", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer" as const, agent };
}

async function issueToken(): Promise<string> {
  const queued = (await callAdminMcpTool("setup.slackAuthorizeLink.issue", { employeeId: emp.id }, cred())).structuredContent as Record<string, unknown>;
  const approved = await resolveApproval(String(queued.approvalId), "approved", "owner@example.com", ORG, { actorId: "mem_human_route" });
  await fulfillApprovedAdmin(approved!);
  const post = calls.find((c) => c.method === "chat.postMessage" && c.body.includes("/api/slack/oauth/link"));
  return (post?.body.match(/\?t=([A-Za-z0-9_-]{43})/) ?? [])[1] ?? "";
}

beforeEach(async () => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
  process.env.SLACK_USER_SCOPE_IM_WRITE = "true";
  process.env.SLACK_CLIENT_ID = "route-client-id";
  process.env.SLACK_CLIENT_SECRET = "route-client-secret-at-least-32-chars";
  delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
  jar.clear();
  savedFetch = globalThis.fetch;
  installFetch();
  resetDemoNotificationChannels();
  resetDemoSlackAuthorizeLinks();
  seq += 1;
  empSlack = `UROUTEEMP${seq}`;
  const base = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  emp = { ...base, id: `emp_linkroute_${Date.now().toString(36)}_${seq}`, orgId: ORG, status: "active", allowedAccounts: [{ service: "slack", accountId: empSlack }] };
  getRuntimeEmployees().push(emp);
  await bindEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG, slackUserId: empSlack, slackTeamId: TEAM, displayName: "E", userToken: OLD });
  await upsertNotificationChannel({
    orgId: ORG,
    provider: "slack",
    enabled: true,
    isDefault: true,
    label: "承認",
    config: { channelId: "", allowedUserIds: [APPROVER] },
    secrets: { botToken: BOT, signingSecret: "sig-SECRET" },
  });
  calls = [];
});

afterEach(async () => {
  emp.status = "suspended";
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG });
});

describe("/api/slack/oauth/link (start)", () => {
  test("valid link → redirect to Slack authorize (team pinned, im:write, linkId in signed state), no-store", async () => {
    const token = await issueToken();
    const res = await startGET(new Request(`https://staffpass.test/api/slack/oauth/link?t=${token}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(location.searchParams.get("team")).toBe(TEAM);
    expect(location.searchParams.get("user_scope")).toContain("im:write");
    const state = verifySlackOAuthState(location.searchParams.get("state")!, jar.get(SLACK_OAUTH_COOKIE)!);
    expect(state?.orgId).toBe(ORG);
    expect(state?.employeeId).toBe(emp.id);
    expect(typeof state?.linkId).toBe("string");
    expect(location.toString()).not.toContain(token);
  });

  test("flag OFF / bad token → HTML error, no redirect, no cookie", async () => {
    const token = await issueToken();
    const bad = await startGET(new Request("https://staffpass.test/api/slack/oauth/link?t=nope"));
    expect(bad.status).toBe(410);
    expect(bad.headers.get("location")).toBeNull();
    delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
    const off = await startGET(new Request(`https://staffpass.test/api/slack/oauth/link?t=${token}`));
    expect(off.status).toBe(404);
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
  });
});

describe("/api/slack/oauth/callback (link branch)", () => {
  async function begin(): Promise<{ state: string; linkId: string }> {
    const token = await issueToken();
    const res = await startGET(new Request(`https://staffpass.test/api/slack/oauth/link?t=${token}`));
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    const parsed = verifySlackOAuthState(state, jar.get(SLACK_OAUTH_COOKIE)!)!;
    return { state, linkId: parsed.linkId! };
  }

  test("success → HTML ok (no /app redirect), token rebound, existing DM auto-route runs", async () => {
    process.env.SLACK_DM_AUTOROUTE_ENABLED = "true";
    await upsertOrgParty({ orgId: ORG, kind: "slack_user", identifier: COLLEAGUE, audience: "internal" });
    const { state, linkId } = await begin();
    calls = [];
    const res = await callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("Slack 連携が完了しました");
    expect(await getLinkedSlackUserToken(emp.id)).toBe(NEW);
    expect((await getSlackAuthorizeLink(linkId, ORG))?.status).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.some((c) => c.method === "conversations.open" && c.auth.endsWith(NEW))).toBe(true);
  });

  test("flag OFF at callback → HTML invalid, link not consumed, nothing saved", async () => {
    const { state, linkId } = await begin();
    delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
    const res = await callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(calls.some((c) => c.method === "oauth.v2.access")).toBe(false);
    expect((await getSlackAuthorizeLink(linkId, ORG))?.status).toBe("issued");
    expect(await getLinkedSlackUserToken(emp.id)).toBe(OLD);
  });
});
