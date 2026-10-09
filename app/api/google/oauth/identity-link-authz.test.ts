/**
 * PR-SEC2: Google Calendar identity linking / disconnect for an AI employee →
 * hire_issue_credentials (same gate as the Slack identity routes).
 *
 * - start / disconnect: unauthenticated 401, plain member 403 (code / nextStep /
 *   retryable), another org's employee 404, privileged member succeeds.
 * - callback: the signed state is bound to the initiating member, org and
 *   employee and re-checked against the CURRENT session before the code
 *   exchange; a plain member cannot finish a link they could not start.
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

let session: SessionContext = UNAUTHENTICATED;
const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
const realMode = await import("@/lib/mode");
mock.module("@/lib/mode", () => ({ ...realMode, isDemoMode: () => false }));

let employees: Array<Pick<Employee, "id" | "orgId" | "displayName">> = [];
const realData = await import("@/lib/data");
mock.module("@/lib/data", () => ({
  ...realData,
  getEmployee: async (id: string, orgId?: string | null) =>
    (employees.find((e) => e.id === id && e.orgId === orgId) as Employee | undefined) ?? null,
}));

const binds: Array<Record<string, unknown>> = [];
const revokes: Array<Record<string, unknown>> = [];
const realIdentities = await import("@/lib/data/google-identities");
mock.module("@/lib/data/google-identities", () => ({
  ...realIdentities,
  bindEmployeeGoogleIdentity: async (input: Record<string, unknown>) => {
    binds.push(input);
  },
  getEmployeeGoogleIdentity: async (employeeId: string) => ({
    employeeId,
    googleSub: `sub-${employeeId}`,
    googleEmail: `${employeeId}@example.com`,
    grantedScopes: "openid",
    status: "linked",
  }),
  getLinkedGoogleRefreshToken: async () => "refresh-token-test",
  revokeEmployeeGoogleIdentity: async (input: Record<string, unknown>) => {
    revokes.push(input);
  },
}));
const realAudit = await import("@/lib/data/audit");
mock.module("@/lib/data/audit", () => ({ ...realAudit, appendAuditEvent: async () => undefined }));

let exchanges = 0;
const realGoogle = await import("@/lib/google/oauth");
mock.module("@/lib/google/oauth", () => ({
  ...realGoogle,
  exchangeGoogleCode: async () => {
    exchanges++;
    return { access_token: "at", refresh_token: "rt", scope: "openid email", id_token: "x.y.z" };
  },
  decodeIdToken: () => ({ sub: "google-sub-1", email: "ai@example.com" }),
  validateIdToken: () => ({ valid: true }),
  revokeGoogleToken: async () => true,
}));
const realScopes = await import("@/lib/google/scopes");
mock.module("@/lib/google/scopes", () => ({ ...realScopes, validateGrantedScopes: () => ({ valid: true }) }));

afterAll(() => {
  cookiesActive = false;
});

const { GET: startGET } = await import("./start/route");
const { GET: callbackGET } = await import("./callback/route");
const { POST: disconnectPOST } = await import("./disconnect/route");
const { GOOGLE_OAUTH_COOKIE, GOOGLE_PKCE_COOKIE, signGoogleOAuthState, verifyGoogleOAuthState } = realGoogle;

const ENV = ["GOOGLE_CALENDAR_READ_ENABLED", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_STATE_SECRET"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.GOOGLE_CALENDAR_READ_ENABLED = "true";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-client-secret-at-least-32-chars";
  delete process.env.GOOGLE_OAUTH_STATE_SECRET;
  session = UNAUTHENTICATED;
  jar.clear();
  binds.length = 0;
  revokes.length = 0;
  exchanges = 0;
  employees = [
    { id: EMP_A, orgId: ORG_A, displayName: "営業AI" },
    { id: EMP_B, orgId: ORG_B, displayName: "別会社AI" },
  ];
});

afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function startReq(employeeId: string, headers?: Record<string, string>) {
  const url = new URL("https://staffpass.test/api/google/oauth/start");
  url.searchParams.set("employeeId", employeeId);
  return new Request(url, { headers });
}

function callbackReq(state: string) {
  const url = new URL("https://staffpass.test/api/google/oauth/callback");
  url.searchParams.set("state", state);
  url.searchParams.set("code", "code-1");
  return new Request(url);
}

function disconnectReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://staffpass.test/api/google/oauth/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function startAs(who: SessionContext, employeeId = EMP_A): Promise<string> {
  session = who;
  const res = await startGET(startReq(employeeId));
  expect(res.status).toBe(307);
  const location = new URL(res.headers.get("location") || "");
  expect(location.hostname).toBe("accounts.google.com");
  return location.searchParams.get("state") || "";
}

async function expectForbiddenJson(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("capability_denied");
  expect(typeof body.code).toBe("string");
  expect(body.requiredCapability).toBe("hire_issue_credentials");
  expect(typeof body.nextStep).toBe("string");
  expect(body.nextStep.length).toBeGreaterThan(0);
  expect(body.retryable).toBe(false);
}

function expectRedirectTo(res: Response, path: string, google: string) {
  expect([302, 303, 307]).toContain(res.status);
  const location = new URL(res.headers.get("location") || "");
  expect(location.pathname).toBe(path);
  expect(location.searchParams.get("google")).toBe(google);
}

describe("GET /api/google/oauth/start", () => {
  test("unauthenticated → 401, no cookies", async () => {
    const res = await startGET(startReq(EMP_A));
    expect(res.status).toBe(401);
    expect(jar.size).toBe(0);
  });

  test("plain member → 403 with code / nextStep / retryable, no cookies", async () => {
    session = sessionAs(PLAIN_A);
    await expectForbiddenJson(await startGET(startReq(EMP_A)));
    expect(jar.size).toBe(0);
  });

  test("plain member naming the owner via x-member-id → still 403", async () => {
    session = sessionAs(PLAIN_A);
    await expectForbiddenJson(await startGET(startReq(EMP_A, { "x-member-id": OWNER_A.id })));
  });

  test("plain member, browser navigation → employee page with google=forbidden", async () => {
    session = sessionAs(PLAIN_A);
    const res = await startGET(startReq(EMP_A, { accept: "text/html", "sec-fetch-mode": "navigate" }));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(jar.size).toBe(0);
  });

  test("privileged member → Google authorize; state bound to member / org / employee", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    const parsed = verifyGoogleOAuthState(state, jar.get(GOOGLE_OAUTH_COOKIE) || "") as Record<string, unknown> | null;
    expect(parsed?.orgId).toBe(ORG_A);
    expect(parsed?.employeeId).toBe(EMP_A);
    expect(parsed?.actorMemberId).toBe(HIRER_A.id);
  });

  test("BOLA: another org's employee → 404, no cookies", async () => {
    session = sessionAs(HIRER_A);
    const res = await startGET(startReq(EMP_B));
    expect(res.status).toBe(404);
    expect(jar.size).toBe(0);
  });
});

describe("GET /api/google/oauth/callback", () => {
  test("same privileged member completes → bound, google=ok", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "ok");
    expect(binds).toHaveLength(1);
    expect(binds[0].orgId).toBe(ORG_A);
  });

  test("owner starts, plain member finishes → refused before the code exchange", async () => {
    const state = await startAs(sessionAs(OWNER_A));
    session = sessionAs(PLAIN_A);
    const res = await callbackGET(callbackReq(state));
    expectRedirectTo(res, `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
    expect(exchanges).toBe(0);
  });

  test("another privileged member cannot finish the initiator's state", async () => {
    const state = await startAs(sessionAs(HIRER_A));
    session = sessionAs(HIRER_A2);
    expectRedirectTo(await callbackGET(callbackReq(state)), `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });

  test("initiator lost the capability / session gone / other org → refused", async () => {
    for (const next of [
      sessionAs({ ...HIRER_A, capabilities: ["view_dashboard"] }),
      UNAUTHENTICATED,
      sessionAs(OWNER_B),
    ]) {
      const state = await startAs(sessionAs(HIRER_A));
      session = next;
      expectRedirectTo(await callbackGET(callbackReq(state)), `/app/employees/${EMP_A}`, "forbidden");
    }
    expect(binds).toHaveLength(0);
    expect(exchanges).toBe(0);
  });

  test("validly signed state without an initiating member → refused", async () => {
    session = sessionAs(OWNER_A);
    jar.set(GOOGLE_OAUTH_COOKIE, "legacy-nonce");
    jar.set(GOOGLE_PKCE_COOKIE, "verifier");
    const state = signGoogleOAuthState({ orgId: ORG_A, employeeId: EMP_A, nonce: "legacy-nonce" });
    expectRedirectTo(await callbackGET(callbackReq(state)), `/app/employees/${EMP_A}`, "forbidden");
    expect(binds).toHaveLength(0);
  });
});

describe("POST /api/google/oauth/disconnect", () => {
  test("unauthenticated → 401", async () => {
    const res = await disconnectPOST(disconnectReq({ employeeId: EMP_A }));
    expect(res.status).toBe(401);
    expect(revokes).toHaveLength(0);
  });

  test("plain member → 403 with code / nextStep / retryable, nothing revoked", async () => {
    session = sessionAs(PLAIN_A);
    await expectForbiddenJson(await disconnectPOST(disconnectReq({ employeeId: EMP_A })));
    expect(revokes).toHaveLength(0);
  });

  test("plain member naming the owner via body actorMemberId / x-member-id → still 403", async () => {
    session = sessionAs(PLAIN_A);
    const res = await disconnectPOST(
      disconnectReq({ employeeId: EMP_A, actorMemberId: OWNER_A.id }, { "x-member-id": OWNER_A.id })
    );
    await expectForbiddenJson(res);
    expect(revokes).toHaveLength(0);
  });

  test("BOLA: another org's employee → 404, nothing revoked", async () => {
    session = sessionAs(HIRER_A);
    const res = await disconnectPOST(disconnectReq({ employeeId: EMP_B }));
    expect(res.status).toBe(404);
    expect(revokes).toHaveLength(0);
  });

  test("privileged member → 200, revoked in the caller's org", async () => {
    session = sessionAs(HIRER_A);
    const res = await disconnectPOST(disconnectReq({ employeeId: EMP_A }));
    expect(res.status).toBe(200);
    expect(revokes).toEqual([{ employeeId: EMP_A, orgId: ORG_A }]);
  });
});
