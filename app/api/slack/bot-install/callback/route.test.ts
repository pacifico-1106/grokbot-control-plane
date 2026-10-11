/**
 * PR-SEC2: the workspace bot-install callback writes a tenant-level Slack bot
 * token. The start route is owner/admin only; the callback now also requires
 * the CURRENT session to be an owner/admin of the org in the signed state
 * (same pattern as the shared approval-app callback), so a state cannot be
 * finished by a different / non-admin session.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realHeaders from "next/headers";
import type { SessionContext } from "@/lib/auth/session";
import {
  ORG_A,
  OWNER_A,
  OWNER_B,
  PLAIN_A,
  UNAUTHENTICATED,
  makeCookieJar,
  member,
  sessionAs,
} from "@/tests/helpers/identity-link-fixtures";

const realCookies = realHeaders.cookies;
let cookiesActive = true;
const { jar, fake } = makeCookieJar();
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: (...args: unknown[]) =>
    cookiesActive ? Promise.resolve(fake) : (realCookies as (...a: unknown[]) => unknown)(...args),
}));
let session: SessionContext = UNAUTHENTICATED;
const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
const upserts: Array<Record<string, unknown>> = [];
const realData = await import("@/lib/data");
mock.module("@/lib/data", () => ({
  ...realData,
  upsertConversationAdapter: async (input: Record<string, unknown>) => {
    upserts.push(input);
    return input;
  },
  appendAuditEvent: async () => undefined,
}));
afterAll(() => {
  cookiesActive = false;
});

const { GET } = await import("./route");
const { SLACK_BOT_INSTALL_COOKIE, signSlackBotInstallState } = await import("@/lib/slack/oauth");

let savedFetch: typeof globalThis.fetch;
let exchanges = 0;
const savedSecret = process.env.SLACK_CLIENT_SECRET;

beforeEach(() => {
  process.env.SLACK_CLIENT_SECRET = "test-client-secret-at-least-32-characters";
  jar.clear();
  upserts.length = 0;
  exchanges = 0;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const json = (p: unknown) => new Response(JSON.stringify(p), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "oauth.v2.access") {
      exchanges++;
      return json({ ok: true, access_token: "xoxb-test-bot", team: { id: "T1", name: "Team" } });
    }
    if (method === "auth.test") return json({ ok: true, team_id: "T1", team: "Team" });
    return json({ ok: false });
  }) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  if (savedSecret === undefined) delete process.env.SLACK_CLIENT_SECRET;
  else process.env.SLACK_CLIENT_SECRET = savedSecret;
});

function callback(orgId = ORG_A) {
  const nonce = `nonce-${Math.random()}`;
  jar.set(SLACK_BOT_INSTALL_COOKIE, nonce);
  const state = signSlackBotInstallState({ orgId, nonce });
  const url = new URL("https://staffpass.test/api/slack/bot-install/callback");
  url.searchParams.set("state", state);
  url.searchParams.set("code", "code-1");
  return GET(new Request(url));
}

function status(res: Response) {
  return new URL(res.headers.get("location") || "https://x/").searchParams.get("status");
}

describe("GET /api/slack/bot-install/callback session binding", () => {
  test("owner of the state's org → installed", async () => {
    session = sessionAs(OWNER_A);
    const res = await callback();
    expect(status(res)).toBe("ok");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].orgId).toBe(ORG_A);
  });

  test("admin of the state's org → installed", async () => {
    session = sessionAs(member("77777777-7777-4777-8777-777777777777", ORG_A, "admin", ["view_dashboard"]));
    expect(status(await callback())).toBe("ok");
  });

  test("plain member / unauthenticated / another org's owner → refused before the code exchange", async () => {
    for (const s of [sessionAs(PLAIN_A), UNAUTHENTICATED, sessionAs(OWNER_B)]) {
      session = s;
      const res = await callback();
      expect(status(res)).toBe("error_forbidden");
    }
    expect(upserts).toHaveLength(0);
    expect(exchanges).toBe(0);
  });
});
