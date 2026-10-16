import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant, ISSUER } from "@/lib/mcp-oauth/__tests__/fixtures";
import { BADGE_AUTH_NEXT_STEP_JA } from "@/lib/mcp/badge-auth-attempt";

/**
 * MCP_EMPLOYEE_BADGE_MCP_ENABLED (default OFF): when a request looks like a
 * static-badge attempt (empty / unexpanded Bearer, gb_emp_, or
 * x-staffpass-credential), /api/mcp must not advertise OAuth via
 * WWW-Authenticate resource_metadata. Unauthenticated requests (no header)
 * still get the challenge so Claude / ChatGPT discovery stays intact.
 */
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const actualData = await import("@/lib/data");
mock.module("@/lib/data", () => ({
  ...actualData,
  getEmployeeById: async (id: string) => directory.employees.get(id) ?? null,
  getBinding: async (id: string) => directory.bindings.get(id) ?? undefined,
}));
mock.module("@/lib/mcp-oauth/employee-state", () => ({
  getCurrentEmployeeCredential: async (id: string) => directory.credentials.get(id) ?? null,
}));
const GB = "gb_emp_badge_attempt_fixture";
const GB_EXPIRED = "gb_emp_badge_expired_fixture";
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: (r: Request) => {
    const alt = (r.headers.get("x-staffpass-credential") || "").trim();
    if (alt) return alt;
    return /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1]?.trim() || null;
  },
  resolveEmployeeCredential: async (r: Request) => {
    const alt = (r.headers.get("x-staffpass-credential") || "").trim();
    const raw = alt || /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1]?.trim() || null;
    if (raw === GB)
      return { ok: true, credential: { employeeId: "emp_1", orgId: "org_a", generation: 3, credentialId: "cred_1", fingerprint: "f", binding: null, secretPrefix: "gb_emp_" } };
    if (raw === GB_EXPIRED)
      return { ok: false, code: "expired", message: "credential expired (fail-closed)", httpStatus: 401 };
    return { ok: false, code: raw ? "invalid_credential" : "missing_credential", message: "nope", httpStatus: 401 };
  },
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const { GET, POST } = await import("./route");

let store = freshStore();
const ENV = [
  "MCP_OAUTH_ENABLED",
  "MCP_OAUTH_DCR_ENABLED",
  "MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE",
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
  const h = await import("@/lib/safety/hold");
  h.__setHoldReaderForTests(h.NO_HOLD_READER_FOR_TESTS);
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("https://staffpass.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

const list = { jsonrpc: "2.0", id: 1, method: "tools/list" } as const;

function oauthOn() {
  process.env.MCP_OAUTH_ENABLED = "1";
}

test("flag OFF (default): empty / unexpanded Bearer on tools/list still gets resource_metadata", async () => {
  oauthOn();
  for (const headers of [{ authorization: "Bearer" }, { authorization: "Bearer " }, { authorization: "Bearer ${env:STAFFPASS_MCP_TOKEN}" }]) {
    const res = await rpc(list, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
    const body = await res.json();
    expect(body.error?.data?.nextStepJa).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("STAFFPASS_MCP_TOKEN");
  }
});

test("flag OFF: no Authorization still 401 + challenge (Claude discovery)", async () => {
  oauthOn();
  const res = await rpc(list);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
});

test("flag ON: empty / unexpanded Bearer and x-staffpass-credential do not advertise OAuth", async () => {
  oauthOn();
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const cases: Record<string, string>[] = [
    { authorization: "Bearer" },
    { authorization: "Bearer " },
    { authorization: "Bearer ${env:STAFFPASS_MCP_TOKEN}" },
    { "x-staffpass-credential": "" },
    { "x-staffpass-credential": "gb_emp_not_this_one" },
  ];
  const nextSteps = new Set<string>();
  for (const headers of cases) {
    const res = await rpc(list, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = await res.json();
    expect(body.error.data.nextStepJa).toBe(BADGE_AUTH_NEXT_STEP_JA);
    expect(body.error.data._meta?.["mcp/www_authenticate"]).toBeUndefined();
    nextSteps.add(body.error.data.nextStepJa);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("resource_metadata");
    expect(dumped).not.toMatch(/gb_emp_[0-9a-f]{16}/);
  }
  expect(nextSteps.size).toBe(1);
});

test("flag ON: invalid vs expired badge attempts share the same nextStepJa (no existence leak)", async () => {
  oauthOn();
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const invalid = await (await rpc(list, { authorization: "Bearer gb_emp_unknown_fixture" })).json();
  const expired = await (await rpc(list, { authorization: `Bearer ${GB_EXPIRED}` })).json();
  expect(invalid.error.data.nextStepJa).toBe(expired.error.data.nextStepJa);
  expect(invalid.error.data.nextStepJa).toBe(BADGE_AUTH_NEXT_STEP_JA);
});

test("flag ON: no Authorization still advertises OAuth (Claude / ChatGPT)", async () => {
  oauthOn();
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const res = await rpc(list);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBe(
    `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`
  );
});

test("flag ON: valid gb_emp_ still works; GET card still has oauth for the shared endpoint", async () => {
  oauthOn();
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const res = await rpc(list, { authorization: `Bearer ${GB}` });
  expect(res.status).toBe(200);
  const card = await (await GET()).json();
  expect(card.auth.oauth).toBeDefined();
});

test("flag ON: bad sp_at_ still gets invalid_token + resource_metadata", async () => {
  oauthOn();
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const res = await rpc(list, { authorization: `Bearer sp_at_${"z".repeat(43)}` });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate") || "").toContain('error="invalid_token"');
  expect(res.headers.get("www-authenticate") || "").toContain("resource_metadata=");
  const dumped = JSON.stringify(await res.json());
  expect(dumped).not.toContain("z".repeat(43));
});

test("flag ON: valid sp_at_ still works", async () => {
  oauthOn();
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  const { accessToken } = await seedClientAndGrant(store);
  expect((await rpc(list, { authorization: `Bearer ${accessToken}` })).status).toBe(200);
});
