import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/** PR-9: /api/mcp dual-era (2026-07-28) behind MCP_PROTOCOL_MODERN_ENABLED. */
mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const GB = "gb_emp_modern_fixture";
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: (r: Request) => /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1] ?? null,
  resolveEmployeeCredential: async (r: Request) => {
    const raw = /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") || "")?.[1];
    if (raw === GB)
      return { ok: true, credential: { employeeId: "emp_m", orgId: "org_m", generation: 1, credentialId: "c", fingerprint: "f", binding: null, secretPrefix: "gb_emp_" } };
    return { ok: false, code: raw ? "invalid_credential" : "missing_credential", message: "nope", httpStatus: 401 };
  },
}));
const { POST } = await import("./route");

const ENV = ["MCP_PROTOCOL_NEGOTIATION_ENABLED", "MCP_PROTOCOL_MODERN_ENABLED", "MCP_OAUTH_ENABLED", "MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
const on = () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  process.env.MCP_PROTOCOL_MODERN_ENABLED = "1";
};
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new Request("https://staffpass.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) }));
const modern = (method: string, extra: Record<string, string> = {}) => ({
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": method,
  authorization: `Bearer ${GB}`,
  ...extra,
});

test("flag OFF: server/discover is Method not found (200, legacy), tools/list has no resultType", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  const d = await post({ method: "server/discover", params: { _meta: META } }, modern("server/discover"));
  expect(d.status).toBe(400); // negotiation alone rejects the unknown 2026-07-28 header (pre-existing PR-1 behavior)
  delete process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED;
  const d2 = await post({ method: "server/discover" });
  expect(d2.status).toBe(200);
  expect((await d2.json()).error.code).toBe(-32601);
  const list = await (await post({ method: "tools/list" }, { authorization: `Bearer ${GB}` })).json();
  expect(list.result.resultType).toBeUndefined();
  expect(list.result.ttlMs).toBeUndefined();
});

test("ON: server/discover returns supportedVersions, serverInfo in _meta, cache hints", async () => {
  on();
  const res = await post({ method: "server/discover", params: { _meta: META } }, modern("server/discover"));
  expect(res.status).toBe(200);
  const r = (await res.json()).result;
  expect(r.resultType).toBe("complete");
  expect(r.supportedVersions[0]).toBe("2026-07-28");
  expect(r.supportedVersions).toContain("2025-11-25");
  expect(r.capabilities.tools).toEqual({});
  expect(r._meta["io.modelcontextprotocol/serverInfo"].name).toBeTruthy();
  expect(r.cacheScope).toBe("public");
  expect(typeof r.instructions).toBe("string");
  expect(res.headers.get("mcp-session-id")).toBeNull();
  expect(res.headers.get("access-control-allow-headers")).toContain("Mcp-Method");
});

test("ON: modern tools/list + tools/call carry resultType; list has ttlMs + private cacheScope", async () => {
  on();
  const list = (await (await post({ method: "tools/list", params: { _meta: META } }, modern("tools/list"))).json()).result;
  expect(list.resultType).toBe("complete");
  expect(list.cacheScope).toBe("private");
  expect(list.ttlMs).toBe(300000);
  expect(list.tools.length).toBeGreaterThan(0);
  const call = await post(
    { method: "tools/call", params: { _meta: META, name: "staffpass_nope", arguments: {} } },
    modern("tools/call", { "mcp-name": "staffpass_nope" })
  );
  const body = await call.json();
  expect(body.result.resultType).toBe("complete");
  expect(body.result.isError).toBe(true);
});

test("ON: Mcp-Name spoof (header routes one tool, body calls another) → 400 -32020 before auth/dispatch", async () => {
  on();
  const res = await post(
    { method: "tools/call", params: { _meta: META, name: "staffpass_invoke", arguments: {} } },
    modern("tools/call", { "mcp-name": "staffpass_whoami" })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe(-32020);
});

test("ON: unknown header version → 400 -32022 {supported, requested}", async () => {
  on();
  const res = await post({ method: "tools/list" }, { "mcp-protocol-version": "2099-01-01", authorization: `Bearer ${GB}` });
  expect(res.status).toBe(400);
  const e = (await res.json()).error;
  expect(e.code).toBe(-32022);
  expect(e.data.requested).toBe("2099-01-01");
  expect(e.data.supported).toContain("2026-07-28");
});

test("ON: modern unknown method → 404 -32601; legacy unknown method stays 200", async () => {
  on();
  const m = await post({ method: "resources/list", params: { _meta: META } }, modern("resources/list"));
  expect(m.status).toBe(404);
  expect((await m.json()).error.code).toBe(-32601);
  const l = await post({ method: "resources/list" }, { authorization: `Bearer ${GB}` });
  expect(l.status).toBe(200);
});

test("ON: legacy initialize still works (dual-era) and negotiates legacy versions", async () => {
  on();
  const res = await post({ method: "initialize", params: { protocolVersion: "2025-11-25" } }, { authorization: `Bearer ${GB}` });
  const r = (await res.json()).result;
  expect(r.protocolVersion).toBe("2025-11-25");
  expect(r.resultType).toBeUndefined();
});

test("ON + OAuth ON: unauthenticated modern server/discover → 401 challenge (hatch allows it)", async () => {
  on();
  process.env.MCP_OAUTH_ENABLED = "1";
  const h = { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" };
  const res = await post({ method: "server/discover", params: { _meta: META } }, h);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate") || "").toContain("resource_metadata=");
  process.env.MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE = "1";
  expect((await post({ method: "server/discover", params: { _meta: META } }, h)).status).toBe(200);
});
