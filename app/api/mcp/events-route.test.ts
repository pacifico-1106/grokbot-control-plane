/**
 * /api/mcp with MCP_EVENTS_ENABLED: events/* behind the employee badge,
 * capabilities.events advertised only when ON; admin MCP has no events.
 * The negotiated protocolVersion is unchanged (2024-11-05) — 2026-07-28 is a
 * separate change (docs/mcp-events-approval-wake-20261005.md).
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
const rpc = (method: string, params: Record<string, unknown> = {}, auth = true, fn = POST) => fn(new Request("https://staffpass.test/api/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
}));

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
  test("initialize unchanged; events/* not found", async () => {
    const init = await (await rpc("initialize", { protocolVersion: "2026-07-28" }, false)).json();
    expect(init.result.protocolVersion).toBe("2024-11-05");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect((await (await rpc("events/list")).json()).error.code).toBe(-32601);
  });
});

describe("flag ON", () => {
  test("initialize advertises capabilities.events (version still 2024-11-05)", async () => {
    process.env.MCP_EVENTS_ENABLED = "true";
    const init = await (await rpc("initialize", { protocolVersion: "2024-11-05" }, false)).json();
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true }, events: {} });
    expect(init.result.protocolVersion).toBe("2024-11-05");
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
