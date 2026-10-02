import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * /api/mcp route contract.
 * - Flag OFF (default): byte-for-byte legacy behavior (S15 regression guard).
 * - MCP_PROTOCOL_NEGOTIATION_ENABLED=1: legacy-era version negotiation.
 */

const GOOD = "gb_emp_route_test_fixture";
mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret: (req: Request) =>
    /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "")?.[1] ?? null,
  resolveEmployeeCredential: async (req: Request) => {
    const raw = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "")?.[1];
    if (!raw)
      return {
        ok: false,
        code: "missing_credential",
        message: "Authorization: Bearer gb_emp_… (or x-staffpass-credential) is required",
        httpStatus: 401,
      };
    if (raw !== GOOD)
      return { ok: false, code: "invalid_credential", message: "credential not found or rotated (fail-closed)", httpStatus: 401 };
    return {
      ok: true,
      credential: {
        employeeId: "emp_1",
        orgId: "org_a",
        generation: 1,
        credentialId: "cred_1",
        fingerprint: "f".repeat(64),
        binding: null,
        secretPrefix: "gb_emp_",
      },
    };
  },
}));

const { GET, POST } = await import("./route");

const ENV_KEYS = ["MCP_PROTOCOL_NEGOTIATION_ENABLED", "P1_CONFIG_CHANGE_REQUEST_ENABLED", "MCP_ALLOWED_ORIGINS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://staffpass.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

const LEGACY_INSTRUCTIONS_PREFIX =
  "Staffpass is a fail-closed AI employee control plane. Authenticate with Authorization: Bearer gb_emp_…";

test("flag OFF: initialize answers fixed 2024-11-05 regardless of requested version", async () => {
  for (const requested of ["2025-11-25", "2025-06-18", "1999-01-01", undefined]) {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: requested ? { protocolVersion: requested } : {},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = await res.json();
    expect(Object.keys(body.result).sort()).toEqual(["capabilities", "instructions", "protocolVersion", "serverInfo"]);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: true } });
    expect(body.result.serverInfo).toEqual({ name: "staffpass", version: "1.0.0" });
    expect(String(body.result.instructions).startsWith(LEGACY_INSTRUCTIONS_PREFIX)).toBe(true);
  }
});

test("flag OFF: unsupported MCP-Protocol-Version header is ignored (legacy)", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
  expect(res.status).toBe(200);
});

test("flag OFF: tools/list entries are exactly {name, description, inputSchema}", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: `Bearer ${GOOD}` });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.tools.length).toBeGreaterThan(3);
  for (const t of body.result.tools) {
    expect(Object.keys(t).sort()).toEqual(["description", "inputSchema", "name"]);
  }
});

test("flag OFF: unauthenticated tools/list → 401 JSON-RPC -32001, no WWW-Authenticate", async () => {
  const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toBeNull();
  const body = await res.json();
  expect(body.error.code).toBe(-32001);
  expect(body.error.data).toEqual({ code: "missing_credential" });
});

test("flag OFF: GET with Accept text/event-stream still returns the server card", async () => {
  const res = await GET(new Request("https://staffpass.test/api/mcp", { headers: { accept: "text/event-stream" } }));
  expect(res.status).toBe(200);
  const card = await res.json();
  expect(card.protocolVersion).toBe("2024-11-05");
  expect(card.auth.type).toBe("bearer");
});

test("flag OFF: notifications ack 202, unknown method -32601, batch 400", async () => {
  expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  const unknown = await (await rpc({ jsonrpc: "2.0", id: 9, method: "nope/x" })).json();
  expect(unknown.error.code).toBe(-32601);
  expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
});

test("flag ON: initialize echoes each supported legacy version", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  for (const v of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
    const body = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } })).json();
    expect(body.result.protocolVersion).toBe(v);
  }
});

test("flag ON: unknown requested version → latest legacy 2025-11-25", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  for (const v of ["2026-07-28", "1999-01-01", 42, undefined]) {
    const body = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } })).json();
    expect(body.result.protocolVersion).toBe("2025-11-25");
  }
});

test("flag ON: unsupported MCP-Protocol-Version header → 400; supported / absent → ok", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  const bad = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
  expect(bad.status).toBe(400);
  const badBody = await bad.json();
  expect(badBody.error.code).toBe(-32600);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-06-18" })).status).toBe(200);
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
});

test("flag ON: GET Accept text/event-stream → 405; browser GET → server card", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  const sse = await GET(new Request("https://staffpass.test/api/mcp", { headers: { accept: "text/event-stream" } }));
  expect(sse.status).toBe(405);
  expect(sse.headers.get("allow")).toContain("POST");
  const html = await GET(new Request("https://staffpass.test/api/mcp", { headers: { accept: "text/html" } }));
  expect(html.status).toBe(200);
});

test("flag ON: tools/list carries title + annotations; read-only vs write split", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  const body = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { authorization: `Bearer ${GOOD}` })).json();
  const byName = Object.fromEntries(body.result.tools.map((t: { name: string }) => [t.name, t]));
  for (const ro of ["staffpass_whoami", "staffpass_get_approval_status", "staffpass_health", "staffpass_stuck_list"]) {
    expect(byName[ro].annotations.readOnlyHint).toBe(true);
    expect(typeof byName[ro].title).toBe("string");
  }
  for (const w of ["staffpass_invoke", "staffpass_stuck_retry", "staffpass_decision_request"]) {
    expect(byName[w].annotations.readOnlyHint).toBe(false);
  }
  expect(byName.staffpass_invoke.annotations.destructiveHint).toBe(true);
});

test("flag ON: unexpected Origin is logged by host only and never blocks", async () => {
  process.env.MCP_PROTOCOL_NEGOTIATION_ENABLED = "1";
  process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai";
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { origin: "https://evil.example", authorization: `Bearer ${GOOD}` }
    );
    expect(res.status).toBe(200);
  } finally {
    console.warn = orig;
  }
  expect(logs.join("\n")).toContain("evil.example");
  expect(logs.join("\n")).not.toContain(GOOD);
});
