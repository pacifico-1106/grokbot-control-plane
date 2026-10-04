/**
 * /api/mcp with MCP_EVENTS_ENABLED: events/* behind the employee badge,
 * capabilities.events advertised only when ON; admin MCP has no events.
 * Since #268 (D1): initialize negotiates per lib/mcp/protocol-negotiation.ts
 * (a 2026-07-28 request is answered with 2025-11-25, the latest initialize-era
 * version); capabilities come from the one serverCapabilities() builder, so
 * initialize and server/discover advertise events identically; events/* go
 * through reply() (modern 2026-07-28 requests get resultType + _meta
 * serverInfo); an unknown method is still the last branch (modern → HTTP 404).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-mcpevents";
const { DEMO_ORG } = await import("@/lib/demo-data");
const { rotateCredential } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { POST } = await import("@/app/api/mcp/route");
const { POST: ADMIN_POST } = await import("@/app/api/mcp/admin/route");
const svc = await import("@/lib/mcp-events/service");
const store = await import("@/lib/mcp-events/store");

const TOKEN = "gb_emp_mcp_events_route_test_0123456789";
const rpc = (method: string, params: Record<string, unknown> = {}, auth = true, fn = POST, extraHeaders: Record<string, string> = {}) => fn(new Request("https://staffpass.test/api/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...extraHeaders },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
}));
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "events-route-test", version: "1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
/** A 2026-07-28 (_meta + mirrored headers) request. */
const modernRpc = (method: string, params: Record<string, unknown> = {}, auth = true) =>
  rpc(method, { ...params, _meta: MODERN_META }, auth, POST, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method });
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

beforeAll(async () => {
  await rotateCredential("emp_sales", DEMO_ORG.id, fingerprintSecret(TOKEN));
  svc.__setMcpEventsTransportForTests({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (req) => {
      const body = JSON.parse(req.body.toString()) as Record<string, unknown>;
      return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
    },
  });
});
afterEach(() => { delete process.env.MCP_EVENTS_ENABLED; store.__resetMcpEventsStoreForTests(); });
afterAll(() => svc.__setMcpEventsTransportForTests(null));

describe("flag OFF (default)", () => {
  test("initialize: no events capability; events/* not found", async () => {
    const init = await (await rpc("initialize", { protocolVersion: "2026-07-28" }, false)).json();
    // #268: 2026-07-28 has no initialize → answered with the latest initialize-era version.
    expect(init.result.protocolVersion).toBe("2025-11-25");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect((await (await rpc("events/list")).json()).error.code).toBe(-32601);
  });
  test("(1) server/discover does NOT advertise events (legacy and modern)", async () => {
    const legacy = await (await rpc("server/discover", {}, false)).json();
    expect(legacy.result.capabilities).toEqual({ tools: { listChanged: true } });
    const modern = await (await modernRpc("server/discover", {}, false)).json();
    expect(modern.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(modern.result.capabilities.events).toBeUndefined();
  });
  test("(2) events/* on a modern request: unknown method → -32601 with HTTP 404", async () => {
    for (const m of ["events/list", "events/subscribe", "events/unsubscribe"]) {
      const res = await modernRpc(m);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe(-32601);
    }
  });
});

describe("flag ON", () => {
  test("initialize advertises capabilities.events (negotiated version per #268)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const init = await (await rpc("initialize", { protocolVersion: "2024-11-05" }, false)).json();
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true }, events: {} });
    expect(init.result.protocolVersion).toBe("2024-11-05");
    const init2 = await (await rpc("initialize", { protocolVersion: "2026-07-28" }, false)).json();
    expect(init2.result.protocolVersion).toBe("2025-11-25");
    expect(init2.result.capabilities).toEqual({ tools: { listChanged: true }, events: {} });
  });
  test("(1) server/discover advertises the same capabilities as initialize (events: {})", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const init = await (await rpc("initialize", { protocolVersion: "2025-11-25" }, false)).json();
    const legacy = await (await rpc("server/discover", {}, false)).json();
    const modern = await (await modernRpc("server/discover", {}, false)).json();
    expect(legacy.result.capabilities).toEqual({ tools: { listChanged: true }, events: {} });
    expect(modern.result.capabilities).toEqual(init.result.capabilities);
    expect(legacy.result.capabilities).toEqual(init.result.capabilities);
  });
  test("(3) events/* on a modern request have the reply() shape (resultType + _meta serverInfo)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const list = await (await modernRpc("events/list")).json();
    expect(list.result.resultType).toBe("complete");
    expect(list.result._meta[SERVER_INFO_KEY]).toEqual({ name: expect.any(String), version: expect.any(String) });
    expect(list.result.events.map((e: { name: string }) => e.name)).toEqual(["approval.decided", "approval.expired"]);
    // Same serverInfo as tools/list on the same era.
    const tools = await (await modernRpc("tools/list")).json();
    expect(list.result._meta[SERVER_INFO_KEY]).toEqual(tools.result._meta[SERVER_INFO_KEY]);
    const delivery = { mode: "webhook", url: "https://hooks.example.com/modern", secret: `whsec_${randomBytes(32).toString("base64")}` };
    const sub = await (await modernRpc("events/subscribe", { name: "approval.decided", arguments: {}, delivery })).json();
    expect(sub.result.id).toMatch(/^sub_/);
    expect(sub.result.resultType).toBe("complete");
    expect(sub.result._meta[SERVER_INFO_KEY]).toBeDefined();
    const unsub = await (await modernRpc("events/unsubscribe", { name: "approval.decided", arguments: {}, delivery: { url: delivery.url } })).json();
    expect(unsub.result.resultType).toBe("complete");
    expect(unsub.result._meta[SERVER_INFO_KEY]).toBeDefined();
    // Errors are unchanged (JSON-RPC error, no result shape).
    const bad = await (await modernRpc("events/subscribe", { name: "approval.decided", arguments: {}, delivery: { ...delivery, url: "http://x.example.com" } })).json();
    expect(bad.error.code).toBe(-32602);
    expect(bad.result).toBeUndefined();
  });
  test("(3) legacy events/* results are unchanged (no resultType / _meta)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const list = await (await rpc("events/list")).json();
    expect(list.result.resultType).toBeUndefined();
    expect(list.result._meta).toBeUndefined();
  });
  test("(2) unknown method is still the last branch: modern → HTTP 404, legacy → HTTP 200 (-32601)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const modern = await modernRpc("events/nope");
    expect(modern.status).toBe(404);
    expect((await modern.json()).error.code).toBe(-32601);
    const modern2 = await modernRpc("resources/list");
    expect(modern2.status).toBe(404);
    const legacy = await rpc("events/nope");
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).error.code).toBe(-32601);
  });
  test("events/* require the badge (-32012 Forbidden, HTTP 401)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    for (const m of ["events/list", "events/subscribe", "events/unsubscribe"]) {
      const res = await rpc(m, {}, false);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe(-32012);
    }
  });
  test("list → subscribe → unsubscribe with the badge", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const list = await (await rpc("events/list")).json();
    expect(list.result.events.map((e: { name: string }) => e.name)).toEqual(["approval.decided", "approval.expired"]);
    const delivery = { mode: "webhook", url: "https://hooks.example.com/route", secret: `whsec_${randomBytes(32).toString("base64")}` };
    const subRes = await (await rpc("events/subscribe", { name: "approval.decided", arguments: {}, delivery })).json();
    expect(subRes.result.id).toMatch(/^sub_/);
    const bad = await (await rpc("events/subscribe", { name: "approval.decided", arguments: {}, delivery: { ...delivery, url: "http://x.example.com" } })).json();
    expect(bad.error.code).toBe(-32602);
    const unsub = await (await rpc("events/unsubscribe", { name: "approval.decided", arguments: {}, delivery: { url: delivery.url } })).json();
    expect(unsub.result).toEqual({});
  });
  test("admin MCP has no events/*", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const res = await (await rpc("events/list", {}, false, ADMIN_POST)).json();
    expect(res.error.code).toBe(-32601);
    const init = await (await rpc("initialize", {}, false, ADMIN_POST)).json();
    expect(init.result.capabilities.events).toBeUndefined();
  });
});
