import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConsentView, processConsentDecision, type ConsentDeps, type ConsentSession } from "@/lib/mcp-oauth/consent";
import { mintConsentCsrf, verifyConsentCsrf } from "@/lib/mcp-oauth/csrf";
import { mintRidBinding, ridBindingCookieName } from "@/lib/mcp-oauth/browser-binding";
import { sha256Hex } from "@/lib/mcp-oauth/tokens";
import type { Employee, OrgMember } from "@/lib/types";
import { CLAUDE_CLIENT, RESOURCE, freshStore } from "@/lib/mcp-oauth/__tests__/fixtures";
import { __setHoldReaderForTests, type HoldReader } from "@/lib/safety/hold";

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

const allow = async (rid: string, employeeId = "emp_1") =>
  processConsentDecision({ rid, csrf: mintConsentCsrf(SECRET, rid, "user_1", now), decision: "allow", employeeId, confirmed: true }, deps());
const HID = "00000000-0000-4000-8000-0000000000a1";
const heldReader = (held: Set<string>): HoldReader => ({
  employee: async (id) => ({ state: "found", orgId: id === "emp_x" ? "org_b" : "org_a", holdState: held.has(id) ? "stopped" : null, holdId: held.has(id) ? HID : null }),
  org: async (orgId) => ({ state: "found", orgId, holdState: null, holdId: null }),
});
afterEach(() => __setHoldReaderForTests(null));

describe("S2 G2 consent: a held employee is not a candidate and cannot be granted", () => {
  test("held employee is dropped from the candidates; unreadable hold drops everyone (no_employees)", async () => {
    employees.set("emp_2", emp({ id: "emp_2", displayName: "経理AI" }));
    const rid = await seedRequest();
    __setHoldReaderForTests(heldReader(new Set(["emp_1"])));
    const out = await loadConsentView(rid, deps());
    expect(out.type).toBe("view");
    if (out.type === "view") expect(out.view.employees.map((e) => e.id)).toEqual(["emp_2"]);
    __setHoldReaderForTests({ employee: async () => { throw new Error("db"); }, org: async () => { throw new Error("db"); } });
    const u = await loadConsentView(rid, deps());
    if (u.type === "view") {
      expect(u.view.employees).toEqual([]);
      expect(u.view.blockedReason).toBe("no_employees");
    }
  });
  test("allow for a held employee (forged form) is refused, no grant", async () => {
    const rid = await seedRequest();
    __setHoldReaderForTests(heldReader(new Set(["emp_1"])));
    const r = await allow(rid, "emp_1");
    expect(r.type).toBe("page");
    expect(JSON.stringify(r)).not.toContain("code=");
    expect((await store.listGrantsForEmployee("org_a", "emp_1")).length).toBe(0);
  });
});
