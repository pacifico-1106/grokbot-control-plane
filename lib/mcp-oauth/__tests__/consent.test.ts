import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConsentView, processConsentDecision, type ConsentDeps, type ConsentSession } from "@/lib/mcp-oauth/consent";
import { mintConsentCsrf, verifyConsentCsrf } from "@/lib/mcp-oauth/csrf";
import { mintRidBinding, ridBindingCookieName } from "@/lib/mcp-oauth/browser-binding";
import { sha256Hex } from "@/lib/mcp-oauth/tokens";
import type { Employee, OrgMember } from "@/lib/types";
import { CLAUDE_CLIENT, ISSUER, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";

const SECRET = "s".repeat(40);
const CB = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const member = (over: Partial<OrgMember> = {}): OrgMember =>
  ({
    id: "mem_1",
    orgId: "org_a",
    userId: "user_1",
    email: "owner@tokyo307.example",
    displayName: "Owner",
    role: "owner",
    status: "active",
    capabilities: ["hire_issue_credentials"],
    ...over,
  }) as OrgMember;

const emp = (over: Partial<Employee> = {}): Employee =>
  ({ id: "emp_1", orgId: "org_a", displayName: "営業AI", roleLabel: "営業", status: "active", scopes: ["mail:draft"], allowedPurposes: ["sales"], ...over }) as Employee;

let store = freshStore();
let session: ConsentSession;
let employees: Map<string, Employee>;
let audits: Array<{ action: string; metadata: Record<string, unknown>; orgId: string }>;
let notified: number;
let rateAllowed: boolean;
let aal: string | null;
let now: Date;
/** Cookie jar of the browser that hit /oauth/authorize (rid binding, hardening 2). */
let jar: Map<string, string>;

function deps(): ConsentDeps {
  return {
    store,
    getSession: async () => session,
    getEmployeeById: async (id) => employees.get(id) ?? null,
    listEmployees: async (orgId) => [...employees.values()].filter((e) => e.orgId === orgId),
    getBinding: async () => ({ status: "linked" }),
    getCurrentCredential: async () => ({ credentialId: "cred_1", expiresAt: null }),
    getOrgName: async () => "トーキョーサンマルサンマルナナ株式会社",
    getAal: async () => aal,
    audit: async (e) => {
      audits.push({ action: e.action, metadata: e.metadata, orgId: e.orgId });
    },
    notify: async () => {
      notified++;
    },
    rateLimit: async () => ({ allowed: rateAllowed, count: 1, retryAfterSec: 60 }),
    stateSecret: () => SECRET,
    getCookie: async (name) => jar.get(name) ?? null,
    now: () => now,
  };
}

async function seedRequest(id = "rid_" + "a".repeat(40)) {
  await store.upsertClient({
    clientId: CLAUDE_CLIENT,
    registrationType: "cimd",
    clientName: "Claude",
    clientUri: null,
    logoUri: null,
    redirectUris: [CB],
    tokenEndpointAuthMethod: "none",
    metadata: {},
    metadataFetchedAt: null,
    metadataExpiresAt: null,
    status: "active",
    createdIpHash: null,
  });
  await store.createAuthRequest({
    id,
    clientId: CLAUDE_CLIENT,
    redirectUri: CB,
    state: "st_1",
    codeChallenge: CHALLENGE,
    resource: RESOURCE,
    scope: ["staffpass.employee", "offline_access"],
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
  });
  jar.set(ridBindingCookieName(id), mintRidBinding(SECRET, id));
  return id;
}

const ENV = ["MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_CONSENT_REQUIRE_MFA", "MCP_OAUTH_ISSUER"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  delete process.env.MCP_OAUTH_CONSENT_REQUIRE_MFA;
  delete process.env.MCP_OAUTH_ISSUER;
  store = freshStore();
  now = new Date("2026-10-03T00:00:00Z");
  session = { userId: "user_1", email: "owner@tokyo307.example", orgId: "org_a", member: member(), lastSignInAt: new Date(now.getTime() - 5 * 60_000).toISOString() };
  employees = new Map([
    ["emp_1", emp()],
    ["emp_x", emp({ id: "emp_x", orgId: "org_b", displayName: "他社AI" })],
  ]);
  audits = [];
  jar = new Map();
  notified = 0;
  rateAllowed = true;
  aal = "aal1";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const allow = async (rid: string, over: Partial<{ csrf: string; employeeId: string; confirmed: boolean; decision: string }> = {}) =>
  processConsentDecision(
    {
      rid,
      csrf: over.csrf ?? mintConsentCsrf(SECRET, rid, "user_1", now),
      decision: over.decision ?? "allow",
      employeeId: over.employeeId ?? "emp_1",
      confirmed: over.confirmed ?? true,
    },
    deps()
  );

describe("consent CSRF token", () => {
  test("bound to rid + user, expires", () => {
    const t = mintConsentCsrf(SECRET, "rid1", "u1", now);
    expect(verifyConsentCsrf(SECRET, t, "rid1", "u1", now)).toBe(true);
    expect(verifyConsentCsrf(SECRET, t, "rid2", "u1", now)).toBe(false);
    expect(verifyConsentCsrf(SECRET, t, "rid1", "u2", now)).toBe(false);
    expect(verifyConsentCsrf("x".repeat(40), t, "rid1", "u1", now)).toBe(false);
    expect(verifyConsentCsrf(SECRET, t, "rid1", "u1", new Date(now.getTime() + 601_000))).toBe(false);
    expect(verifyConsentCsrf(SECRET, "garbage", "rid1", "u1", now)).toBe(false);
  });
});

describe("consent view", () => {
  test("not signed in → login_required", async () => {
    session = { userId: null, email: null, orgId: null, member: null };
    expect((await loadConsentView(await seedRequest(), deps())).type).toBe("login_required");
  });

  test("shows org name, email, client host, only same-org eligible employees", async () => {
    const out = await loadConsentView(await seedRequest(), deps());
    if (out.type !== "view") throw new Error(JSON.stringify(out));
    expect(out.view.orgName).toBe("トーキョーサンマルサンマルナナ株式会社");
    expect(out.view.email).toBe("owner@tokyo307.example");
    expect(out.view.client.redirectHost).toBe("claude.ai");
    expect(out.view.client.verifiedHost).toBe(true);
    expect(out.view.employees.map((e) => e.id)).toEqual(["emp_1"]);
    expect(out.view.blockedReason).toBeNull();
  });

  test("blocked reasons: role, org allowlist, stale login, MFA", async () => {
    const rid = await seedRequest();
    session.member = member({ role: "member" });
    expect((await loadConsentView(rid, deps())).type === "view" && (await loadConsentView(rid, deps()))).toMatchObject({ view: { blockedReason: "role" } });
    session.member = member();
    process.env.MCP_OAUTH_ORG_ALLOWLIST = "92f3617c-33fc-4dac-b9b4-d4f42e8522ac";
    expect(await loadConsentView(rid, deps())).toMatchObject({ view: { blockedReason: "org_not_allowed" } });
    process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
    session.lastSignInAt = new Date(now.getTime() - 16 * 60_000).toISOString();
    expect(await loadConsentView(rid, deps())).toMatchObject({ view: { blockedReason: "login_too_old" } });
    session.lastSignInAt = new Date(now.getTime() - 60_000).toISOString();
    process.env.MCP_OAUTH_CONSENT_REQUIRE_MFA = "true";
    expect(await loadConsentView(rid, deps())).toMatchObject({ view: { blockedReason: "mfa_required" } });
    aal = "aal2";
    expect(await loadConsentView(rid, deps())).toMatchObject({ view: { blockedReason: null } });
  });

  test("expired / unknown / consumed rid → error page", async () => {
    expect(await loadConsentView("nope", deps())).toMatchObject({ type: "page", status: 400 });
    const rid = await seedRequest();
    now = new Date(now.getTime() + 601_000);
    expect(await loadConsentView(rid, deps())).toMatchObject({ type: "page", status: 400 });
  });

  test("missing state secret → 503 (fail closed)", async () => {
    const d = { ...deps(), stateSecret: () => null };
    expect(await loadConsentView(await seedRequest(), d)).toMatchObject({ type: "page", status: 503 });
  });
});

describe("consent decision", () => {
  test("allow → grant + 60s one-time code bound to redirect/PKCE/resource; redirect carries code, state, iss", async () => {
    const rid = await seedRequest();
    const out = await allow(rid);
    if (out.type !== "redirect") throw new Error(JSON.stringify(out));
    const loc = new URL(out.location);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("state")).toBe("st_1");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    const code = loc.searchParams.get("code")!;
    expect(code).toBeTruthy();
    const consumed = await store.consumeCode(sha256Hex(code), now.toISOString());
    if (!consumed.ok) throw new Error("code missing");
    expect(consumed.record.redirectUri).toBe(CB);
    expect(consumed.record.codeChallenge).toBe(CHALLENGE);
    expect(consumed.record.resource).toBe(RESOURCE);
    expect(Date.parse(consumed.record.expiresAt) - now.getTime()).toBe(60_000);
    const grant = await store.getGrant(consumed.record.grantId);
    expect(grant).toMatchObject({ orgId: "org_a", employeeId: "emp_1", clientId: CLAUDE_CLIENT, grantedByMemberId: "mem_1", credentialIdAtGrant: "cred_1" });
    expect(Date.parse(grant!.expiresAt) - now.getTime()).toBe(90 * 86400_000);
    expect(audits.map((a) => a.action)).toEqual(["oauth.consent_granted"]);
    expect(JSON.stringify(audits)).not.toContain(code);
    expect(audits[0].metadata.clientHost).toBe("claude.ai");
    expect(notified).toBe(1);
  });

  test("rid is one-time: second allow fails, no second grant", async () => {
    const rid = await seedRequest();
    expect((await allow(rid)).type).toBe("redirect");
    expect(await allow(rid)).toMatchObject({ type: "page", status: 400 });
    expect(audits.length).toBe(1);
  });

  test("deny → access_denied + state + iss, audit consent_denied, no grant", async () => {
    const rid = await seedRequest();
    const out = await allow(rid, { decision: "deny", employeeId: "", confirmed: false });
    if (out.type !== "redirect") throw new Error(JSON.stringify(out));
    const loc = new URL(out.location);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st_1");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(loc.searchParams.get("code")).toBeNull();
    expect(audits.map((a) => a.action)).toEqual(["oauth.consent_denied"]);
    expect(await store.listGrantsForEmployee("org_a", "emp_1")).toEqual([]);
  });

  test("bad / missing / other-user CSRF → 403, rid untouched", async () => {
    const rid = await seedRequest();
    expect(await allow(rid, { csrf: "" })).toMatchObject({ status: 403 });
    expect(await allow(rid, { csrf: mintConsentCsrf(SECRET, rid, "user_2", now) })).toMatchObject({ status: 403 });
    expect(await allow(rid, { csrf: mintConsentCsrf(SECRET, "other", "user_1", now) })).toMatchObject({ status: 403 });
    expect((await store.getAuthRequest(rid))?.consumedAt).toBeNull();
  });

  test("IDOR: employee of another org → 403, no grant", async () => {
    const rid = await seedRequest();
    expect(await allow(rid, { employeeId: "emp_x" })).toMatchObject({ type: "page", status: 403 });
    expect(await store.listGrantsForEmployee("org_b", "emp_x")).toEqual([]);
    expect((await store.getAuthRequest(rid))?.consumedAt).toBeNull();
  });

  test("role/capability: member role, or admin without hire_issue_credentials → 403", async () => {
    const rid = await seedRequest();
    session.member = member({ role: "member" });
    expect(await allow(rid)).toMatchObject({ status: 403 });
    session.member = member({ role: "admin", capabilities: [] });
    expect(await allow(rid)).toMatchObject({ status: 403 });
    session.member = member({ role: "admin" });
    expect((await allow(rid)).type).toBe("redirect");
  });

  test("no real session (owner fallback must not apply) → 401", async () => {
    const rid = await seedRequest();
    session = { userId: "user_1", email: "x@y", orgId: "org_a", member: null };
    expect(await allow(rid)).toMatchObject({ status: 401 });
    session = { userId: "user_1", email: "x@y", orgId: "org_a", member: member({ orgId: "org_b" }) };
    expect(await allow(rid)).toMatchObject({ status: 401 });
  });

  test("login older than 15 min → 401; MFA flag ON requires aal2", async () => {
    const rid = await seedRequest();
    session.lastSignInAt = new Date(now.getTime() - 16 * 60_000).toISOString();
    expect(await allow(rid)).toMatchObject({ status: 401, error: "login_required" });
    session.lastSignInAt = null;
    expect(await allow(rid)).toMatchObject({ status: 401 });
    session.lastSignInAt = new Date(now.getTime() - 60_000).toISOString();
    process.env.MCP_OAUTH_CONSENT_REQUIRE_MFA = "true";
    expect(await allow(rid)).toMatchObject({ status: 403, error: "mfa_required" });
    aal = "aal2";
    expect((await allow(rid)).type).toBe("redirect");
  });

  test("org not on allowlist (Q5 pilot) → 403", async () => {
    const rid = await seedRequest();
    process.env.MCP_OAUTH_ORG_ALLOWLIST = "92f3617c-33fc-4dac-b9b4-d4f42e8522ac";
    expect(await allow(rid)).toMatchObject({ status: 403 });
  });

  test("unchecked confirmation → 400", async () => {
    expect(await allow(await seedRequest(), { confirmed: false })).toMatchObject({ status: 400 });
  });

  test("grant never outlives the employee credential", async () => {
    const rid = await seedRequest();
    const credExp = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const d = { ...deps(), getCurrentCredential: async () => ({ credentialId: "cred_1", expiresAt: credExp }) };
    const out = await processConsentDecision({ rid, csrf: mintConsentCsrf(SECRET, rid, "user_1", now), decision: "allow", employeeId: "emp_1", confirmed: true }, d);
    if (out.type !== "redirect") throw new Error("expected redirect");
    const code = new URL(out.location).searchParams.get("code")!;
    const c = await store.consumeCode(sha256Hex(code), now.toISOString());
    if (!c.ok) throw new Error("no code");
    expect((await store.getGrant(c.record.grantId))?.expiresAt).toBe(credExp);
  });

  test("revoked binding / no credential / suspended employee → refused", async () => {
    const rid = await seedRequest();
    expect(await processConsentDecision({ rid, csrf: mintConsentCsrf(SECRET, rid, "user_1", now), decision: "allow", employeeId: "emp_1", confirmed: true }, { ...deps(), getBinding: async () => ({ status: "revoked" }) })).toMatchObject({ status: 403 });
    expect(await processConsentDecision({ rid, csrf: mintConsentCsrf(SECRET, rid, "user_1", now), decision: "allow", employeeId: "emp_1", confirmed: true }, { ...deps(), getCurrentCredential: async () => null })).toMatchObject({ status: 400 });
    employees.set("emp_1", emp({ status: "suspended" }));
    expect(await allow(rid)).toMatchObject({ status: 400 });
  });

  test("client blocked after authorize → refused", async () => {
    const rid = await seedRequest();
    const c = await store.getClient(CLAUDE_CLIENT);
    await store.upsertClient({ ...c!, status: "blocked" });
    expect(await allow(rid)).toMatchObject({ status: 400, error: "invalid_client" });
  });

  test("rate limited → 429; notify failure does not break consent", async () => {
    const rid = await seedRequest();
    rateAllowed = false;
    expect(await allow(rid)).toMatchObject({ status: 429 });
    rateAllowed = true;
    const out = await processConsentDecision(
      { rid, csrf: mintConsentCsrf(SECRET, rid, "user_1", now), decision: "allow", employeeId: "emp_1", confirmed: true },
      { ...deps(), notify: async () => { throw new Error("smtp down"); } }
    );
    expect(out.type).toBe("redirect");
  });
});

describe("hardening 2: rid bound to the browser that started /oauth/authorize", () => {
  test("consent GET without the binding cookie → 403 page (no CSRF minted)", async () => {
    const rid = await seedRequest();
    jar.clear();
    const out = await loadConsentView(rid, deps());
    expect(out).toMatchObject({ type: "page", status: 403, error: "access_denied" });
    expect(JSON.stringify(out)).not.toContain(rid);
  });

  test("consent POST (allow AND deny) without / with a forged / other-rid cookie → 403, rid untouched, no grant", async () => {
    const rid = await seedRequest();
    const other = await seedRequest("rid_" + "b".repeat(40));
    const name = ridBindingCookieName(rid);
    for (const v of [null, "forged", mintRidBinding(SECRET, other), mintRidBinding("t".repeat(40), rid)]) {
      if (v === null) jar.delete(name);
      else jar.set(name, v);
      expect(await allow(rid)).toMatchObject({ type: "page", status: 403 });
      expect(await allow(rid, { decision: "deny" })).toMatchObject({ type: "page", status: 403 });
    }
    expect((await store.getAuthRequest(rid))?.consumedAt).toBeNull();
    expect(audits.map((a) => a.action)).not.toContain("oauth.consent_granted");
    jar.set(name, mintRidBinding(SECRET, rid));
    expect(await allow(rid)).toMatchObject({ type: "redirect" });
  });

  test("a different rid's cookie name with this rid's value does not help (name is per-rid)", async () => {
    const rid = await seedRequest();
    const v = jar.get(ridBindingCookieName(rid))!;
    jar.clear();
    jar.set(ridBindingCookieName("rid_" + "c".repeat(40)), v);
    expect(await loadConsentView(rid, deps())).toMatchObject({ type: "page", status: 403 });
  });

  test("'only approve if you started this yourself' warning is shown for every client, not only loopback", async () => {
    const out = await loadConsentView(await seedRequest(), deps());
    expect(out.type).toBe("view");
    if (out.type === "view") {
      expect(out.view.client.loopback).toBe(false);
      expect(out.view.startedYourselfWarningJa).toContain("自分で開始");
    }
  });
});

describe("hardening 2b: mitigations for the forwarded-authorize-URL variant", () => {
  test("not-started-here page is a 403 with reason not_started_here (page.tsx turns it into an HTTP 403)", async () => {
    const rid = await seedRequest();
    jar.clear();
    expect(await loadConsentView(rid, deps())).toMatchObject({ type: "page", status: 403, reason: "not_started_here" });
    expect(await allow(rid)).toMatchObject({ type: "page", status: 403, reason: "not_started_here" });
  });

  test("view prominently names the client host and the AI employee(s), and says not to approve a link someone sent you", async () => {
    const out = await loadConsentView(await seedRequest(), deps());
    expect(out.type).toBe("view");
    if (out.type === "view") {
      expect(out.view.approvalSummaryJa).toContain("claude.ai");
      expect(out.view.approvalSummaryJa).toContain("営業AI");
      expect(out.view.approvalSummaryJa).not.toContain("他社AI");
      expect(out.view.startedYourselfWarningJa).toContain("送られてきた");
      expect(out.view.startedYourselfWarningJa).toContain("許可しないでください");
    }
  });

  test("fresh Staffpass login (≤15 min) is required to approve — view blocks and POST refuses a 16-min-old login", async () => {
    const rid = await seedRequest();
    session = { ...session, lastSignInAt: new Date(now.getTime() - 16 * 60_000).toISOString() };
    const out = await loadConsentView(rid, deps());
    expect(out.type === "view" && out.view.blockedReason).toBe("login_too_old");
    expect(await allow(rid)).toMatchObject({ type: "page", status: 401 });
    expect((await store.getAuthRequest(rid))?.consumedAt).toBeNull();
  });

  test("owner/admin notification is sent for EVERY new grant (no dedupe across grants)", async () => {
    expect(await allow(await seedRequest())).toMatchObject({ type: "redirect" });
    expect(await allow(await seedRequest("rid_" + "d".repeat(40)))).toMatchObject({ type: "redirect" });
    expect(notified).toBe(2);
    expect(audits.filter((a) => a.action === "oauth.consent_granted").length).toBe(2);
  });
});

describe("#318 follow-up: touchClient on a successful authorization (consent allow)", () => {
  test("allow sets the client's last_used_at; deny and refused requests do not", async () => {
    const rid = await seedRequest();
    expect((await allow(rid, { decision: "deny", employeeId: "", confirmed: false })).type).toBe("redirect");
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBeNull();
    const rid2 = await seedRequest("rid_" + "b".repeat(40));
    expect(await allow(rid2, { csrf: "bad" })).toMatchObject({ type: "page" });
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBeNull();
    const rid3 = await seedRequest("rid_" + "c".repeat(40));
    expect((await allow(rid3)).type).toBe("redirect");
    expect((await store.getClient(CLAUDE_CLIENT))?.lastUsedAt).toBe(now.toISOString());
  });
});
