/**
 * staffpass_whoami credential info on /api/mcp and /api/mcp/employee.
 * Flag WHOAMI_CREDENTIAL_INFO_ENABLED default OFF. Both mouths must agree.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant } from "@/lib/mcp-oauth/__tests__/fixtures";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const actualData = await import("@/lib/data");
const orgLookups: string[] = [];
mock.module("@/lib/data", () => ({
  ...actualData,
  getEmployeeById: async (id: string) => directory.employees.get(id) ?? null,
  getBinding: async (id: string) => directory.bindings.get(id) ?? undefined,
  listOrgProjects: async () => [],
}));
mock.module("@/lib/mcp-oauth/employee-state", () => ({
  getCurrentEmployeeCredential: async (id: string) => directory.credentials.get(id) ?? null,
}));
mock.module("@/lib/mcp-oauth/org-info", () => ({
  getOrgName: async (orgId: string) => {
    orgLookups.push(orgId);
    if (orgId === "org_a") return "TOKYO307";
    if (orgId === "org_b") return "OTHER_TENANT_LEAK";
    return null;
  },
  getSessionAal: async () => null,
}));

const GB = "gb_emp_whoami_cred_info_fixture";
const GB_EXPIRED = "gb_emp_whoami_expired_fixture";
function extractEmployeeSecretForTests(r: Request): string | null {
  const alt = (r.headers.get("x-staffpass-credential") || "").trim();
  if (alt) return alt;
  return /^Bearer\s+(.+)$/i.exec((r.headers.get("authorization") || "").trim())?.[1]?.trim() || null;
}
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: extractEmployeeSecretForTests,
  resolveEmployeeCredential: async (r: Request) => {
    const raw = extractEmployeeSecretForTests(r);
    if (raw === GB)
      return {
        ok: true,
        credential: {
          employeeId: "emp_1",
          orgId: "org_a",
          generation: 3,
          credentialId: "cred_1",
          fingerprint: "fp_whoami_secret",
          binding: null,
          secretPrefix: "gb_emp_",
          authMethod: "gb_emp",
        },
      };
    if (raw === GB_EXPIRED)
      return { ok: false, code: "expired", message: "credential expired (fail-closed)", httpStatus: 401 };
    return {
      ok: false,
      code: raw ? "invalid_credential" : "missing_credential",
      message: "nope",
      httpStatus: 401,
    };
  },
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const shared = await import("./route");
const employee = await import("./employee/route");

let store = freshStore();
const ENV = [
  "WHOAMI_CREDENTIAL_INFO_ENABLED",
  "MCP_OAUTH_ENABLED",
  "MCP_OAUTH_DCR_ENABLED",
  "MCP_OAUTH_ISSUER",
  "MCP_OAUTH_ORG_ALLOWLIST",
  "MCP_OAUTH_ORG_ALLOWLIST_REQUIRED",
  "MCP_EMPLOYEE_BADGE_MCP_ENABLED",
];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  store = freshStore();
  __setOAuthStoreForTests(store);
  directory.reset();
  directory.employees.set("emp_2", {
    id: "emp_2",
    orgId: "org_b",
    status: "active",
    credentialId: "cred_other",
    displayName: "他社AI",
    roleLabel: "漏洩チェック",
  });
  directory.credentials.set("emp_2", { credentialId: "cred_other", expiresAt: "2099-01-01T00:00:00.000Z" });
  orgLookups.length = 0;
  const h = await import("@/lib/safety/hold");
  h.__setHoldReaderForTests(h.NO_HOLD_READER_FOR_TESTS);
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});

const whoamiBody = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "staffpass_whoami", arguments: {} } };

const rpc = (
  handler: (req: Request) => Promise<Response>,
  url: string,
  headers: Record<string, string> = {}
) =>
  handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(whoamiBody),
    })
  );

function payloadOf(body: { result?: { structuredContent?: Record<string, unknown>; content?: Array<{ text: string }> } }) {
  const structured = body.result?.structuredContent;
  const text = body.result?.content?.[0]?.text;
  expect(text).toBe(JSON.stringify(structured, null, 2));
  return structured as Record<string, unknown>;
}

const FORBIDDEN = [
  "cred_1",
  "cred_other",
  "fp_whoami_secret",
  "gb_emp_whoami_cred_info_fixture",
  "OTHER_TENANT_LEAK",
  "emp_2",
  "他社AI",
  "secretPrefix",
  "fingerprint",
];

test("flag OFF: /api/mcp whoami bytes have no credential info keys", async () => {
  const res = await rpc(shared.POST, "https://staffpass.test/api/mcp", { authorization: `Bearer ${GB}` });
  expect(res.status).toBe(200);
  const body = await res.json();
  const parsed = payloadOf(body);
  expect(parsed.credential).toBeUndefined();
  expect(parsed.org).toBeUndefined();
  expect(parsed.expiringSoon).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('"expiresAt"');
});

test("flag ON: gb_emp_ whoami on /api/mcp and /api/mcp/employee is the same (caller only)", async () => {
  process.env.WHOAMI_CREDENTIAL_INFO_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const soon = new Date(Date.now() + 6 * 86_400_000).toISOString();
  directory.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: soon });
  const sharedRes = await rpc(shared.POST, "https://staffpass.test/api/mcp", { authorization: `Bearer ${GB}` });
  const empRes = await rpc(employee.POST, "https://staffpass.test/api/mcp/employee", { authorization: `Bearer ${GB}` });
  expect(sharedRes.status).toBe(200);
  expect(empRes.status).toBe(200);
  const a = payloadOf(await sharedRes.json());
  const b = payloadOf(await empRes.json());
  expect(a.credential).toEqual({ kind: "gb_emp", expiresAt: soon });
  expect(a.org).toEqual({ name: "TOKYO307" });
  expect(a.expiringSoon).toBe(true);
  expect(String(a.nextStepJa)).toMatch(
    /^社員証の期限が近づいています（\d{4}-\d{2}-\d{2} まで）。管理者に再発行を依頼してください。$/
  );
  expect(b.credential).toEqual(a.credential);
  expect(b.org).toEqual(a.org);
  expect(b.expiringSoon).toBe(a.expiringSoon);
  expect(b.nextStepJa).toBe(a.nextStepJa);
  expect(b.employeeId).toBe("emp_1");
  expect(orgLookups.every((id) => id === "org_a")).toBe(true);
  const dumped = JSON.stringify(a) + JSON.stringify(b);
  for (const needle of FORBIDDEN) expect(dumped).not.toContain(needle);
});

test("flag ON: OAuth whoami uses 社員証 expiry when present, kind oauth; both mouths still match on gb_emp", async () => {
  process.env.WHOAMI_CREDENTIAL_INFO_ENABLED = "1";
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString();
  directory.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: later });
  const { accessToken } = await seedClientAndGrant(store);
  const oauthRes = await rpc(shared.POST, "https://staffpass.test/api/mcp", {
    authorization: `Bearer ${accessToken}`,
  });
  expect(oauthRes.status).toBe(200);
  const oauth = payloadOf(await oauthRes.json());
  expect(oauth.credential).toEqual({ kind: "oauth", expiresAt: later });
  expect(oauth.org).toEqual({ name: "TOKYO307" });
  expect(oauth.expiringSoon).toBeUndefined();
  const dumped = JSON.stringify(oauth);
  expect(dumped).not.toContain(accessToken);
  for (const needle of FORBIDDEN) expect(dumped).not.toContain(needle);
});

test("flag ON: OAuth with no 社員証 expiry → expiresAt null, kind oauth", async () => {
  process.env.WHOAMI_CREDENTIAL_INFO_ENABLED = "1";
  process.env.MCP_OAUTH_ENABLED = "1";
  directory.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: null });
  const { accessToken } = await seedClientAndGrant(store);
  const oauth = payloadOf(
    await (
      await rpc(shared.POST, "https://staffpass.test/api/mcp", { authorization: `Bearer ${accessToken}` })
    ).json()
  );
  expect(oauth.credential).toEqual({ kind: "oauth", expiresAt: null });
  expect(oauth.expiringSoon).toBeUndefined();
});

test("expired 社員証 never reaches whoami (401) on both mouths and OAuth", async () => {
  process.env.WHOAMI_CREDENTIAL_INFO_ENABLED = "1";
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const sharedExpired = await rpc(shared.POST, "https://staffpass.test/api/mcp", {
    authorization: `Bearer ${GB_EXPIRED}`,
  });
  const empExpired = await rpc(employee.POST, "https://staffpass.test/api/mcp/employee", {
    authorization: `Bearer ${GB_EXPIRED}`,
  });
  expect(sharedExpired.status).toBe(401);
  expect(empExpired.status).toBe(401);
  directory.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: new Date(Date.now() - 1000).toISOString() });
  const { accessToken } = await seedClientAndGrant(store);
  const oauthExpired = await rpc(shared.POST, "https://staffpass.test/api/mcp", {
    authorization: `Bearer ${accessToken}`,
  });
  expect(oauthExpired.status).toBe(401);
  for (const res of [sharedExpired, empExpired, oauthExpired]) {
    const dumped = JSON.stringify(await res.json());
    expect(dumped).not.toContain("TOKYO307");
    expect(dumped).not.toContain("expiresAt");
    expect(dumped).not.toContain(accessToken);
    expect(dumped).not.toContain("cred_1");
  }
});

test("flag ON: tenant isolation — org_b name is never looked up or returned", async () => {
  process.env.WHOAMI_CREDENTIAL_INFO_ENABLED = "1";
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  directory.credentials.set("emp_1", { credentialId: "cred_1", expiresAt: null });
  const body = await (
    await rpc(shared.POST, "https://staffpass.test/api/mcp", { authorization: `Bearer ${GB}` })
  ).json();
  const parsed = payloadOf(body);
  expect(parsed.org).toEqual({ name: "TOKYO307" });
  expect(orgLookups).toEqual(["org_a"]);
  expect(JSON.stringify(body)).not.toContain("OTHER_TENANT_LEAK");
  expect(JSON.stringify(body)).not.toContain("emp_2");
});
