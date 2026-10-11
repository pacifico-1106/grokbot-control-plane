/**
 * PR-SEC2: Slack identity linking (session flow) is an identity-connection
 * change for an AI employee → hire_issue_credentials, same gate as
 * PATCH / DELETE /api/employees/[id]/slack-identity.
 *
 * - start: unauthenticated 401, plain member 403 (code / nextStep / retryable),
 *   another org's employee 404, privileged member → Slack authorize redirect.
 * - callback: the signed state is bound to the initiating member, org and
 *   employee; the callback re-checks the CURRENT session (same member, same
 *   org, still holds the capability, employee still in the org) before the
 *   code is exchanged. A plain member cannot finish a link they could not start.
 *
 * Production path (isDemoMode() = false) with the session mocked; one demo
 * describe at the end checks the demo actor convention.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realHeaders from "next/headers";
import type { SessionContext } from "@/lib/auth/session";
import type { Employee } from "@/lib/types";
import {
  EMP_A,
  EMP_B,
  HIRER_A,
  HIRER_A2,
  ORG_A,
  ORG_B,
  OWNER_A,
  OWNER_B,
  PLAIN_A,
  UNAUTHENTICATED,
  makeCookieJar,
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

let demo = false;
let session: SessionContext = UNAUTHENTICATED;
const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
const realMode = await import("@/lib/mode");
mock.module("@/lib/mode", () => ({ ...realMode, isDemoMode: () => demo }));

let employees: Array<Pick<Employee, "id" | "orgId" | "displayName">> = [];
const realData = await import("@/lib/data");
const realGetEmployee = realData.getEmployee;
mock.module("@/lib/data", () => ({
  ...realData,
  getEmployee: async (id: string, orgId?: string | null) => {
    if (demo) return realGetEmployee(id, orgId);
    return (employees.find((e) => e.id === id && e.orgId === orgId) as Employee | undefined) ?? null;
  },
}));

const binds: Array<Record<string, unknown>> = [];
const realIdentities = await import("@/lib/data/slack-identities");
mock.module("@/lib/data/slack-identities", () => ({
  ...realIdentities,
  bindEmployeeSlackIdentity: async (input: Record<string, unknown>) => {
    binds.push(input);
    return { ...input, status: "linked" };
  },
}));

afterAll(() => {
  cookiesActive = false;
});

const { GET: startGET } = await import("./start/route");
const { GET: callbackGET } = await import("./callback/route");
const { SLACK_OAUTH_COOKIE, signSlackOAuthState, verifySlackOAuthState } = await import("@/lib/slack/oauth");

const ENV = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_DM_AUTOROUTE_ENABLED"] as const;
let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;
let slackCalls: string[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.SLACK_CLIENT_ID = "test-client-id";
  process.env.SLACK_CLIENT_SECRET = "test-client-secret-at-least-32-characters";
  delete process.env.SLACK_DM_AUTOROUTE_ENABLED;
  demo = false;
  session = UNAUTHENTICATED;
  jar.clear();
  binds.length = 0;
  employees = [
    { id: EMP_A, orgId: ORG_A, displayName: "営業AI" },
    { id: EMP_B, orgId: ORG_B, displayName: "別会社AI" },
  ];
  slackCalls = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const method = String(url).replace("https://slack.com/api/", "");
    slackCalls.push(method);
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "oauth.v2.access") {
      return json({ ok: true, authed_user: { id: "UEMPA0001", access_token: "xoxp-test-user-token" }, team: { id: "TTEAM0001" } });
    }
    if (method === "auth.test") return json({ ok: true, user_id: "UEMPA0001", team_id: "TTEAM0001", user: "emp" });
    return json({ ok: false, error: "unexpected" });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function startReq(employeeId: string, opts: { headers?: Record<string, string>; as?: string } = {}) {
  const url = new URL("https://staffpass.test/api/slack/oauth/start");
  url.searchParams.set("employeeId", employeeId);
  if (opts.as) url.searchParams.set("as", opts.as);
  return new Request(url, { headers: opts.headers });
}

function callbackReq(state: string, code = "code-1") {
  const url = new URL("https://staffpass.test/api/slack/oauth/callback");
  url.searchParams.set("state", state);
  url.searchParams.set("code", code);
  return new Request(url);
}

/** Starts the flow as `who` and returns the signed state from the Slack redirect. */
async function startAs(who: SessionContext, employeeId = EMP_A): Promise<string> {
  session = who;
  const res = await startGET(startReq(employeeId));
  expect(res.status).toBe(307);
  const location = new URL(res.headers.get("location") || "");
  expect(location.hostname).toBe("slack.com");
  return location.searchParams.get("state") || "";
}

async function expectForbiddenJson(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("capability_denied");
  expect(typeof body.code).toBe("string");
  expect(body.code.length).toBeGreaterThan(0);
  expect(body.requiredCapability).toBe("hire_issue_credentials");
  expect(typeof body.nextStep).toBe("string");
  expect(body.nextStep.length).toBeGreaterThan(0);
  expect(body.retryable).toBe(false);
}

function expectRedirectTo(res: Response, path: string, slack: string) {
  expect([302, 303, 307]).toContain(res.status);
  const location = new URL(res.headers.get("location") || "");
  expect(location.pathname).toBe(path);
  expect(location.searchParams.get("slack")).toBe(slack);
}

describe("GET /api/slack/oauth/start", () => {
  test("unauthenticated → 401, no nonce cookie", async () => {
    const res = await startGET(startReq(EMP_A));
    expect(res.status).toBe(401);
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
  });

  test("plain member → 403 with code / nextStep / retryable, no nonce cookie, no Slack redirect", async () => {
    session = sessionAs(PLAIN_A);
    const res = await startGET(startReq(EMP_A));
    await expectForbiddenJson(res);
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
  });

  test("plain member naming the owner via ?as= / x-member-id → still 403 (no self-grant)", async () => {
    session = sessionAs(PLAIN_A);
    const res = await startGET(startReq(EMP_A, { as: OWNER_A.id, headers: { "x-member-id": OWNER_A.id } }));
    await expectForbiddenJson(res);
  });

  test("plain member, browser navigation → redirect back to the employee page with slack=forbidden", async () => {
    session = sessionAs(PLAIN_A);
    const res = await startGET(
      startReq(EMP_A, { headers: { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate" } })
    );
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(res.headers.get("location") || "").not.toContain("slack.com");
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);
  });

  test("privileged member (hire_issue_credentials) → Slack authorize; state bound to member / org / employee", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    const nonce = jar.get(SLACK_OAUTH_COOKIE) || "";
    expect(nonce).not.toBe("");
    const parsed = verifySlackOAuthState(state, nonce) as Record<string, unknown> | null;
    expect(parsed?.orgId).toBe(ORG_A);
    expect(parsed?.employeeId).toBe(EMP_A);
    expect(parsed?.actorMemberId).toBe(HIRER_A.id);
  });

  test("owner → Slack authorize", async () => {
    await startAs(sessionAs(OWNER_A));
  });

  test("BOLA: another org's employee → 404, no nonce cookie", async () => {
    session = sessionAs(HIRER_A);
    const res = await startGET(startReq(EMP_B));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("employee_not_found");
    expect(jar.has(SLACK_OAUTH_COOKIE)).toBe(false);

    session = sessionAs(OWNER_B);
    const res2 = await startGET(startReq(EMP_A));
    expect(res2.status).toBe(404);
  });
});

describe("GET /api/slack/oauth/callback (session flow)", () => {
  test("same privileged member completes → bound, slack=ok", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "ok");
    expect(binds).toHaveLength(1);
    expect(binds[0].orgId).toBe(ORG_A);
    expect(binds[0].employeeId).toBe(EMP_A);
  });

  test("owner starts, plain member session finishes → refused before the code exchange", async () => {
    const state = await startAs(sessionAs(OWNER_A));
    session = sessionAs(PLAIN_A);
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
    expect(slackCalls).not.toContain("oauth.v2.access");
  });

  test("state is bound to the initiating member: another privileged member cannot finish it", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    session = sessionAs(HIRER_A2);
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("initiator lost hire_issue_credentials before the callback → refused", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    session = sessionAs({ ...HIRER_A, capabilities: ["view_dashboard", "view_employees"] });
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("session gone at callback (unauthenticated) → refused", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    session = UNAUTHENTICATED;
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("callback in another org's session → refused (org bound)", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    session = sessionAs(OWNER_B);
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("employee removed from the org before the callback → refused", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    employees = employees.filter((e) => e.id !== EMP_A);
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("validly signed state without an initiating member (pre-change / forged shape) → refused", async () => {
    session = sessionAs(OWNER_A);
    const nonce = "legacy-nonce-1";
    jar.set(SLACK_OAUTH_COOKIE, nonce);
    const state = signSlackOAuthState({ orgId: ORG_A, employeeId: EMP_A, nonce });
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("tampered state still → slack=error (unchanged)", async () => {
    session = sessionAs(OWNER_A);
    jar.set(SLACK_OAUTH_COOKIE, "n");
    const res = await callbackGET(callbackReq("garbage.sig"));
    expectRedirectTo(res, "/app/employees", "error");
    expect(binds).toHaveLength(0);
  });
});

describe("demo mode (no Auth): demo actor convention", () => {
  test("?as= a demo member without hire_issue_credentials → 403; default owner → Slack authorize", async () => {
    demo = true;
    session = { demo: true, userId: null, email: null, orgId: "org_demo", member: null };
    const denied = await startGET(startReq("emp_sales", { as: "mem_3" }));
    await expectForbiddenJson(denied);
    const ok = await startGET(startReq("emp_sales"));
    expect(ok.status).toBe(307);
  });
});
