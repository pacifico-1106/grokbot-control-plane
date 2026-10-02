import { afterEach, beforeEach, expect, test } from "bun:test";

/** /api/mcp/admin shares the negotiation helpers; flag OFF must stay legacy. */
const { GET, POST } = await import("./route");

const saved = process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED;
beforeEach(() => {
  delete process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED;
  else process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = saved;
});

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://staffpass.test/api/mcp/admin", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

test("flag OFF: admin initialize fixed 2024-11-05", async () => {
  const body = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })).json();
  expect(body.result.protocolVersion).toBe("2024-11-05");
});

test("flag OFF: admin tools/list without gb_adm_ → 401 and no WWW-Authenticate", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBeNull();
});

test("flag ON: admin initialize negotiates; bad header 400; SSE GET 405", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "true";
  const body = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  expect(body.result.protocolVersion).toBe("2025-06-18");
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "bogus" })).status).toBe(400);
  const sse = await GET(new Request("https://staffpass.test/api/mcp/admin", { headers: { accept: "text/event-stream" } }));
  expect(sse.status).toBe(405);
});
