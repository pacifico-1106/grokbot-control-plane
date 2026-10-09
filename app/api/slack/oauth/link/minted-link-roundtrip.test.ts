/**
 * #284 follow-up (木村 2026-10-09): `mintSetupLink` built `…/api/slack/oauth/link?setup_token=…`
 * but the link route reads `?t=`, and the route only accepts a hashed,
 * single-use token issued by setup.slackAuthorizeLink.issue (one human
 * approval). A stateless setup-link token can never be valid there.
 *
 * Fix: the setup-link minter refuses kind slack_authorize (guidance only, no
 * URL); the only URL for the route is built by the issuer's own builder with
 * the param the route reads. Tests:
 * - a minted (issuer-built) link round-trips through the link route;
 * - a used link is refused; an expired link is refused;
 * - a link for an employee of another org is refused;
 * - a setup-link token is never accepted by the link route (either param).
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
const authorizeLink = await import("@/lib/slack/authorize-link");
const { hashAuthorizeLinkToken } = authorizeLink;
const setupLinks = await import("@/lib/security/setup-links");
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


const LINK_PATH = "/api/slack/oauth/link";

function requestFor(url: string) {
  const u = new URL(url);
  return linkGET(new Request(`https://staffpass.test${u.pathname}${u.search}`));
}

async function mintedUrl(opts: { employeeId?: string; expiresAt?: string } = {}) {
  const { token, linkId } = await issueLink(opts);
  return { url: authorizeLink.slackAuthorizeLinkUrl(token), token, linkId };
}

describe("setup-link minter never produces a re-authorize URL", () => {
  test("mintSetupLink(slack_authorize) is refused: no URL, the error names setup.slackAuthorizeLink.issue", () => {
    let error: unknown = null;
    try {
      setupLinks.mintSetupLink({ kind: "slack_authorize", orgId: ORG, employeeId: "emp_1" });
    } catch (e) {
      error = e;
    }
    expect(error instanceof setupLinks.SetupLinkKindNotMintableError).toBe(true);
    expect((error as { code?: string }).code).toBe("slack_authorize_requires_issue");
    expect(String((error as Error).message)).not.toContain("setup_token");
  });

  test("buildSetupGuidance(slack_authorize, mintLink) → guidance only (no setupUrl), next step = setup.slackAuthorizeLink.issue", () => {
    const guidance = setupLinks.buildSetupGuidance("slack_authorize", { mintLink: true, orgId: ORG, employeeId: "emp_1" });
    expect(guidance.setupUrl).toBeUndefined();
    expect(guidance.expiresAt).toBeUndefined();
    expect(guidance.nextStepJa).toContain("setup.slackAuthorizeLink.issue");
  });

  test("other kinds are unchanged (still minted)", () => {
    const link = setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: ORG });
    expect(new URL(link.url).pathname).toBe("/app/getting-started");
  });
});

describe("issuer-built link ↔ link route", () => {
  test("the issuer's URL uses the exact param the route reads", async () => {
    const { url, token } = await mintedUrl();
    const u = new URL(url);
    expect(u.pathname).toBe(LINK_PATH);
    expect(authorizeLink.SLACK_AUTHORIZE_LINK_TOKEN_PARAM).toBe("t");
    expect(u.searchParams.get(authorizeLink.SLACK_AUTHORIZE_LINK_TOKEN_PARAM)).toBe(token);
    expect(u.searchParams.has("setup_token")).toBe(false);
  });

  test("a minted link round-trips: open → Slack authorize redirect → callback links the employee", async () => {
    const { url, linkId } = await mintedUrl();
    const started = await requestFor(url);
    expect(started.status).toBe(307);
    const location = new URL(started.headers.get("location")!);
    expect(location.hostname).toBe("slack.com");
    const state = location.searchParams.get("state")!;
    const done = await callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`));
    expect(done.status).toBe(200);
    expect(await getLinkedSlackUserToken(emp.id)).toBe(NEW);
    expect((await getSlackAuthorizeLink(linkId, ORG))?.status).toBe("completed");
  });

  test("a used link is refused (410, no redirect)", async () => {
    const { url } = await mintedUrl();
    const started = await requestFor(url);
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    expect((await callbackGET(new Request(`https://staffpass.test/api/slack/oauth/callback?code=abc&state=${encodeURIComponent(state)}`))).status).toBe(200);
    const again = await requestFor(url);
    expect(again.status).toBe(410);
    expect(again.headers.get("location")).toBeNull();
  });

  test("an expired link is refused (410, no redirect, no cookie)", async () => {
    const { url } = await mintedUrl({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await requestFor(url);
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
  });

  test("a link for an employee in another org is refused (410, nothing bound)", async () => {
    const { url } = await mintedUrl({ employeeId: otherOrgEmp.id });
    const res = await requestFor(url);
    expect(res.status).toBe(410);
    expect(res.headers.get("location")).toBeNull();
    expect(await getLinkedSlackUserToken(otherOrgEmp.id)).not.toBe(NEW);
  });

  test("a stateless setup-link token is never accepted by the link route (as ?t= or ?setup_token=)", async () => {
    const other = setupLinks.mintSetupLink({ kind: "org_kickoff", orgId: ORG });
    for (const q of [`t=${encodeURIComponent(other.token)}`, `setup_token=${encodeURIComponent(other.token)}`]) {
      const res = await linkGET(new Request(`https://staffpass.test${LINK_PATH}?${q}`));
      expect(res.status).toBe(410);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});

describe("static guard", () => {
  test("no non-test code builds the link path with ?setup_token=; the route reads the exported param", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const setupLinksSrc = readFileSync(`${root}lib/security/setup-links.ts`, "utf8");
    expect(setupLinksSrc).not.toMatch(/oauth\/link[^\n]*setup_token/);
    const route = readFileSync(`${root}app/api/slack/oauth/link/route.ts`, "utf8");
    expect(route).toContain("SLACK_AUTHORIZE_LINK_TOKEN_PARAM");
  });
});
