import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { directory, freshStore, seedClientAndGrant, ISSUER } from "./fixtures";

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
let legacyCalls = 0;
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: () => null,
  resolveEmployeeCredential: async () => {
    legacyCalls++;
    return { ok: false, code: "invalid_credential", message: "credential must start with gb_emp_", httpStatus: 401 };
  },
}));

const { __setOAuthStoreForTests } = await import("@/lib/data/oauth");
const { resolveMcpCredential } = await import("../resource-server");
const hold = await import("@/lib/safety/hold");

let store = freshStore();
const ENV = ["MCP_OAUTH_ENABLED", "MCP_OAUTH_ORG_ALLOWLIST", "MCP_OAUTH_ORG_ALLOWLIST_REQUIRED", "MCP_OAUTH_ISSUER", "MCP_OAUTH_DCR_ENABLED"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_OAUTH_ENABLED = "1";
  process.env.MCP_OAUTH_ORG_ALLOWLIST = "org_a";
  store = freshStore();
  __setOAuthStoreForTests(store);
  directory.reset();
  legacyCalls = 0;
  hold.__setHoldReaderForTests(null);
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  __setOAuthStoreForTests(null);
});

const req = (token: string) => new Request("https://staffpass.test/api/mcp", { headers: { authorization: `Bearer ${token}` } });
const HID = "00000000-0000-4000-8000-0000000000a1";
const reader = (emp: string | null, org: string | null): import("@/lib/safety/hold").HoldReader => ({
  employee: async () => ({ state: "found", orgId: "org_a", holdState: emp, holdId: emp ? HID : null }),
  org: async () => ({ state: "found", orgId: "org_a", holdState: org, holdId: org ? HID : null }),
});

// S2 G2 (design §2.3): an OAuth access token of a held employee stops on the next request.
// 403 without invalid_token: the grant / tokens are NOT revoked (release restores access).
test("G2 resource server: no hold → ok; employee held → employee_held 403; org held → org_held; unreadable → hold_state_unavailable", async () => {
  const { accessToken, accessHash } = await seedClientAndGrant(store);
  hold.__setHoldReaderForTests(reader(null, null));
  expect((await resolveMcpCredential(req(accessToken))).ok).toBe(true);
  hold.__setHoldReaderForTests(reader("stopped", null));
  const r = await resolveMcpCredential(req(accessToken));
  expect(r.ok === false && [r.code, r.httpStatus, r.oauthError ?? null]).toEqual(["employee_held", 403, null]);
  expect(await store.getAccessToken(accessHash)).toBeTruthy();
  hold.__setHoldReaderForTests(reader(null, "stopped"));
  const o = await resolveMcpCredential(req(accessToken));
  expect(o.ok === false && o.code).toBe("org_held");
  hold.__setHoldReaderForTests({ employee: async () => { throw new Error("db"); }, org: async () => { throw new Error("db"); } });
  const u = await resolveMcpCredential(req(accessToken));
  expect(u.ok === false && u.code).toBe("hold_state_unavailable");
  hold.__setHoldReaderForTests(null);
});
