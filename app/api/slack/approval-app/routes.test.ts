/**
 * A: route-level checks for 「Staffpass承認」 install start / callback and the
 * events Request URL. next/headers cookies() is replaced only while this file runs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as realHeaders from "next/headers";

const realCookies = realHeaders.cookies;
let active = true;
const jar = new Map<string, string>();
const fakeJar = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string) => void jar.set(name, value),
  delete: (name: string) => void jar.delete(name),
};
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: (...args: unknown[]) => (active ? Promise.resolve(fakeJar) : (realCookies as (...a: unknown[]) => unknown)(...args)),
}));
afterAll(() => {
  active = false;
});

const { GET: startGET } = await import("./install/start/route");
const { GET: callbackGET } = await import("./callback/route");
const { PUT: settingsPUT } = await import("@/app/api/settings/notification-channels/route");
const { POST: eventsPOST } = await import("@/app/api/webhooks/slack/approval-app/events/route");
const { listNotificationChannels, resetDemoNotificationChannels, upsertNotificationChannel } = await import("@/lib/data/notification-channels");
const { resetDemoSlackOAuthStateUses } = await import("@/lib/data/slack-oauth-state-uses");
const { DEMO_ORG } = await import("@/lib/demo-data");
const { SHARED_APPROVAL_INSTALL_COOKIE, signSharedApprovalInstallState } = await import("@/lib/slack/shared-approval-app");

const ORG = DEMO_ORG.id;
const OTHER = "org_shared_route_other";
const APP = "ASHAREDROUTE1";
const SIGNING = "shared-route-signing-SECRET";
const BOT = "xoxb-shared-route-SECRET";
const ENV = [
  "SLACK_SHARED_APPROVAL_APP_ENABLED",
  "SLACK_SHARED_APPROVAL_APP_ID",
  "SLACK_SHARED_APPROVAL_CLIENT_ID",
  "SLACK_SHARED_APPROVAL_CLIENT_SECRET",
  "SLACK_SHARED_APPROVAL_SIGNING_SECRET",
] as const;
let saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let team = "";
let seq = 0;
let exchange: Record<string, unknown> = {};
const methods: string[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
  process.env.SLACK_SHARED_APPROVAL_APP_ID = APP;
  process.env.SLACK_SHARED_APPROVAL_CLIENT_ID = "999.888";
  process.env.SLACK_SHARED_APPROVAL_CLIENT_SECRET = "shared-route-client-SECRET";
  process.env.SLACK_SHARED_APPROVAL_SIGNING_SECRET = SIGNING;
  seq += 1;
  team = `TSHROUTE${Date.now().toString(36).toUpperCase()}${seq}`;
  exchange = { ok: true, app_id: APP, access_token: BOT, token_type: "bot", team: { id: team, name: "Route WS" } };
  methods.length = 0;
  jar.clear();
  resetDemoNotificationChannels(ORG);
  resetDemoNotificationChannels(OTHER);
  resetDemoSlackOAuthStateUses();
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const method = String(url).replace("https://slack.com/api/", "");
    methods.push(method);
    const json = (p: unknown) => new Response(JSON.stringify(p), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "oauth.v2.access") return json(exchange);
    if (method === "auth.test") return json({ ok: true, team_id: team, team: "Route WS", user_id: "UBOTROUTE1" });
    return json({ ok: true });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = savedFetch;
});

async function start(): Promise<{ state: string; url: URL }> {
  const res = await startGET();
  expect(res.status).toBe(307);
  const url = new URL(res.headers.get("location")!);
  return { state: url.searchParams.get("state")!, url };
}

function callback(params: Record<string, string>) {
  const u = new URL("http://localhost/api/slack/approval-app/callback");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return callbackGET(new Request(u));
}

describe("install start", () => {
  test("flag OFF → 404; ON → redirect to Slack with shared client id + bot scopes, nonce cookie set, no-store", async () => {
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "false";
    expect((await startGET()).status).toBe(404);
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    const res = await startGET();
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("999.888");
    expect(url.searchParams.get("scope")).toBe("chat:write,im:write,im:read,users:read");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(jar.get(SHARED_APPROVAL_INSTALL_COOKIE)).toBeTruthy();
  });

  test("env incomplete → 503 page, no redirect", async () => {
    delete process.env.SLACK_SHARED_APPROVAL_CLIENT_SECRET;
    const res = await startGET();
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("運営");
  });
});

describe("install callback", () => {
  test("happy path → inbox saved for the session org; HTML has no token; state cannot be reused", async () => {
    const { state } = await start();
    const nonce = jar.get(SHARED_APPROVAL_INSTALL_COOKIE)!;
    const res = await callback({ code: "code-1", state });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Staffpass承認 を追加しました");
    expect(html).not.toContain(BOT);
    // Success never shows an error code; it says what the person does next.
    expect(html).not.toContain("エラーコード");
    expect(html).not.toContain("問い合わせコード");
    expect(html).toContain("承認者の設定は AI が申請します。確認が届いたら 1 回押すだけです");
    expect(html).not.toContain(ORG);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await listNotificationChannels(ORG)).some((row) => row.config?.sharedApprovalApp === true)).toBe(true);
    jar.set(SHARED_APPROVAL_INSTALL_COOKIE, nonce);
    const replay = await callback({ code: "code-2", state });
    expect(replay.status).toBe(400);
    const replayHtml = await replay.text();
    expect(replayHtml).toContain("state_reused");
    expect(replayHtml).toContain("次にやること");
    expect(replayHtml).not.toContain(ORG);
  });

  test("bad / missing state or nonce → 400, nothing exchanged", async () => {
    await start();
    expect((await callback({ code: "c", state: "forged.sig" })).status).toBe(400);
    expect(methods).not.toContain("oauth.v2.access");
  });

  test("state signed for another org than the admin session → 403", async () => {
    const state = signSharedApprovalInstallState({ orgId: OTHER, nonce: "n-other" });
    jar.set(SHARED_APPROVAL_INSTALL_COOKIE, "n-other");
    const res = await callback({ code: "c", state });
    expect(res.status).toBe(403);
    expect(methods).not.toContain("oauth.v2.access");
  });

  test("workspace bound to another org → 409 page with the ops message; that org unchanged", async () => {
    const other = await upsertNotificationChannel({
      orgId: OTHER,
      provider: "slack",
      enabled: true,
      config: { channelId: "COTHER1", expectedTeamId: team },
      secrets: { botToken: "xoxb-other", signingSecret: "s" },
    });
    const { state } = await start();
    const res = await callback({ code: "c", state });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("この Slack ワークスペースは、別の組織ですでに使われています。");
    expect(html).toContain("Staffpass の運営に連絡してください");
    expect(html).toContain("<code>team_bound_to_other_org</code>");
    expect(html).not.toContain(OTHER);
    expect(html).not.toContain("xoxb-other");
    expect((await listNotificationChannels(ORG)).some((row) => row.config?.sharedApprovalApp === true)).toBe(false);
    expect((await listNotificationChannels(OTHER)).find((r) => r.id === other.id)?.config).toEqual(other.config);
    expect(methods).toContain("auth.revoke");
  });

  test("Enterprise Grid org-wide install → 400 page with explicit error; nothing saved", async () => {
    exchange = { ok: true, app_id: APP, access_token: BOT, token_type: "bot", team: null, enterprise: { id: "EGRID1" }, is_enterprise_install: true };
    const { state } = await start();
    const res = await callback({ code: "c", state });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("enterprise_install_not_supported");
    expect(html).toContain("Enterprise Grid");
    expect((await listNotificationChannels(ORG)).length).toBe(0);
  });

  test("user cancelled on Slack → denied page, nothing saved", async () => {
    const { state } = await start();
    const res = await callback({ error: "access_denied", state });
    expect(await res.text()).toContain("キャンセル");
    expect(methods).not.toContain("oauth.v2.access");
  });
});

describe("dashboard", () => {
  test("saving over the shared inbox from the dashboard is refused (markers / approver stay)", async () => {
    const { state } = await start();
    await callback({ code: "c", state });
    const inbox = (await listNotificationChannels(ORG)).find((row) => row.config?.sharedApprovalApp === true)!;
    const res = await settingsPUT(
      new Request("http://localhost/api/settings/notification-channels", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: inbox.id, provider: "slack", enabled: true, channelId: "CHIJACK1", allowedUserIds: ["UHIJACK1"], signingSecret: "x" }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "shared_app_inbox_managed" });
    expect((await listNotificationChannels(ORG)).find((row) => row.id === inbox.id)?.config).toEqual(inbox.config);
  });
});

describe("events Request URL", () => {
  function eventReq(payload: Record<string, unknown>, secret = SIGNING, ts = Math.floor(Date.now() / 1000)) {
    const body = JSON.stringify(payload);
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    return new Request("http://localhost/api/webhooks/slack/approval-app/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": sig },
      body,
    });
  }

  test("url_verification → challenge; bad signature → 401; stale timestamp → 401; unknown team → 200 ignored", async () => {
    const ok = await eventsPOST(eventReq({ type: "url_verification", challenge: "xyz" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ challenge: "xyz" });
    expect((await eventsPOST(eventReq({ type: "url_verification", challenge: "xyz" }, "wrong"))).status).toBe(401);
    expect((await eventsPOST(eventReq({ type: "url_verification", challenge: "xyz" }, SIGNING, Math.floor(Date.now() / 1000) - 600))).status).toBe(401);
    const unknown = await eventsPOST(eventReq({ type: "event_callback", api_app_id: APP, team_id: "TNOBODY1", event: { type: "app_uninstalled" } }));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ ignored: true, reason: "unknown_team" });
  });

  test("app_uninstalled after install → inbox disabled", async () => {
    const { state } = await start();
    await callback({ code: "c", state });
    const res = await eventsPOST(eventReq({ type: "event_callback", api_app_id: APP, team_id: team, event: { type: "app_uninstalled" } }));
    expect(await res.json()).toMatchObject({ ok: true, disabled: 1 });
    expect((await listNotificationChannels(ORG)).find((row) => row.config?.sharedApprovalApp === true)?.enabled).toBe(false);
  });
});
