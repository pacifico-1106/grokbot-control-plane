/**
 * #284 decision 2 (木村 2026-10-05): the Slack setup links and the diagnose
 * template point at the admin-issued re-authorize link (/api/slack/oauth/link),
 * not at the session start route (which now requires hire_issue_credentials).
 *
 * The re-authorize link is authorized by the single-use token (issued after a
 * human approval), not by the opener's dashboard rights:
 * - a recipient WITHOUT hire_issue_credentials (or with no Staffpass session
 *   at all) who opens the link still links successfully;
 * - a used link and an expired link are refused;
 * - a link whose employee id belongs to another org is refused.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as realHeaders from "next/headers";
import type { SessionContext } from "@/lib/auth/session";
import type { Employee, OrgMember } from "@/lib/types";

const realCookies = realHeaders.cookies;
let cookiesActive = true;
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
  cookies: (...args: unknown[]) =>
    cookiesActive ? Promise.resolve(fakeJar) : (realCookies as (...a: unknown[]) => unknown)(...args),
}));

const ORG = "org_demo";
const PLAIN_MEMBER: OrgMember = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: ORG,
  email: "plain@example.com",
  displayName: "plain",
  role: "member",
  jobRole: "custom",
  capabilities: ["view_dashboard", "view_employees"],
  status: "active",
} as OrgMember;
const PLAIN_SESSION: SessionContext = { demo: false, userId: "user-plain", email: PLAIN_MEMBER.email, orgId: ORG, member: PLAIN_MEMBER };
const NO_SESSION: SessionContext = { demo: false, userId: null, email: null, orgId: null, member: null };
let session: SessionContext = PLAIN_SESSION;
const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
afterAll(() => {
  cookiesActive = false;
});

const { GET: linkGET } = await import("./route");
const { GET: callbackGET } = await import("../callback/route");
const { GET: sessionStartGET } = await import("../start/route");
const { hasCapability } = await import("@/lib/team/rbac");
const { hashAuthorizeLinkToken } = await import("@/lib/slack/authorize-link");
const { createSlackAuthorizeLink, getSlackAuthorizeLink, resetDemoSlackAuthorizeLinks } = await import(
  "@/lib/data/slack-authorize-links"
);
const { getLinkedSlackUserToken, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { getRuntimeEmployees } = await import("@/lib/demo-data");
const { SLACK_OAUTH_COOKIE } = await import("@/lib/slack/oauth");

const TEAM = "TRECIPIENT1";
const NEW = "xoxp-recipient-new-SECRET";
const FLAGS = ["SLACK_AUTHORIZE_LINK_ENABLED", "SLACK_DM_AUTOROUTE_ENABLED", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"] as const;
let saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let emp: Employee;
let otherOrgEmp: Employee;
let empSlack = "";
let seq = 0;

function installFetch() {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    const json = (payload: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "oauth.v2.access") return json({ ok: true, authed_user: { id: empSlack, access_token: NEW }, team: { id: TEAM } });
    if (method === "auth.test" && auth.endsWith(NEW)) {
      return json({ ok: true, user_id: empSlack, team_id: TEAM, user: "emp" }, { "x-oauth-scopes": "chat:write,users:read" });
    }
    if (method === "chat.postMessage") return json({ ok: true, ts: "1.1" });
    if (method === "conversations.open") return json({ ok: true, channel: { id: "DREC1", is_im: true } });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

async function issueLink(opts: { employeeId?: string; expiresAt?: string } = {}) {
  const token = randomBytes(32).toString("base64url");
  const link = await createSlackAuthorizeLink({
    orgId: ORG,
    employeeId: opts.employeeId ?? emp.id,
    tokenHash: hashAuthorizeLinkToken(token),
    expectedSlackUserId: empSlack,
    expectedTeamId: TEAM,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    deliveredInboxId: "inbox_recipient",
    deliveredChannelId: "DREC0",
    deliveredUserId: empSlack,
    deliveredTarget: "employee",
    approvalId: null,
    issuedVia: "ticket",
  });
  return { token, linkId: link.id };
}

function open(token: string) {
  return linkGET(new Request(`https://staffpass.test/api/slack/oauth/link?t=${encodeURIComponent(token)}`));
}

async function openAndCallback(token: string) {
  const started = await open(token);
  expect(started.status).toBe(307);
  const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
  return callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`));
}

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
  process.env.SLACK_CLIENT_ID = "recipient-client-id";
  process.env.SLACK_CLIENT_SECRET = "recipient-client-secret-at-least-32-chars";
  delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
  session = PLAIN_SESSION;
  jar.clear();
  resetDemoSlackAuthorizeLinks();
  savedFetch = globalThis.fetch;
  installFetch();
  seq += 1;
  empSlack = `URECIPEMP${seq}`;
  const base = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  emp = { ...base, id: `emp_recipient_${Date.now().toString(36)}_${seq}`, orgId: ORG, status: "active", allowedAccounts: [{ service: "slack", accountId: empSlack }] };
  otherOrgEmp = { ...emp, id: `emp_recipient_other_${seq}`, orgId: "org_recipient_other" };
  getRuntimeEmployees().push(emp, otherOrgEmp);
});

afterEach(async () => {
  emp.status = "suspended";
  otherOrgEmp.status = "suspended";
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
  globalThis.fetch = savedFetch;
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG });
});

describe("re-authorize link: authorized by the token, not by dashboard rights", () => {
  test("precondition: a capability-less member cannot use the session start route (403)", async () => {
    expect(hasCapability(PLAIN_MEMBER, "hire_issue_credentials")).toBe(false);
    // The data layer runs in demo mode here, so the start route's actor is the
    // demo roster member named by ?as= (mem_3 = 経理, no hire_issue_credentials).
    const res = await sessionStartGET(new Request(`https://staffpass.test/api/slack/oauth/start?employeeId=${emp.id}&as=mem_3`));
    expect(res.status).toBe(403);
  });

  test("capability-less recipient opens the link → linked successfully, link completed", async () => {
    const { token, linkId } = await issueLink();
    const res = await openAndCallback(token);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Slack 連携が完了しました");
    expect(await getLinkedSlackUserToken(emp.id)).toBe(NEW);
    expect((await getSlackAuthorizeLink(linkId, ORG))?.status).toBe("completed");
  });

  test("recipient with no Staffpass session at all → linked successfully", async () => {
    session = NO_SESSION;
    const { token } = await issueLink();
    const res = await openAndCallback(token);
    expect(res.status).toBe(200);
    expect(await getLinkedSlackUserToken(emp.id)).toBe(NEW);
  });
});

describe("re-authorize link refusals", () => {
  test("used link → refused at open and at a replayed callback; nothing re-bound", async () => {
    const { token } = await issueLink();
    const first = await open(token);
    const state = new URL(first.headers.get("location")!).searchParams.get("state")!;
    const nonce = jar.get(SLACK_OAUTH_COOKIE)!;
    const done = await callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(done.status).toBe(200);

    const reopen = await open(token);
    expect(reopen.status).toBe(410);
    expect(reopen.headers.get("location")).toBeNull();

    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: ORG });
    jar.set(SLACK_OAUTH_COOKIE, nonce);
    const replay = await callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc2&state=${encodeURIComponent(state)}`));
    expect(replay.status).toBe(400);
    expect(await getLinkedSlackUserToken(emp.id)).not.toBe(NEW);
  });

  test("expired link → refused at open, no Slack redirect, no cookie", async () => {
    const { token } = await issueLink({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await open(token);
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
  });

  test("link pointing at another org's employee id → refused at open, nothing bound", async () => {
    const { token } = await issueLink({ employeeId: otherOrgEmp.id });
    const res = await open(token);
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
    expect(await getLinkedSlackUserToken(otherOrgEmp.id)).not.toBe(NEW);
  });
});
