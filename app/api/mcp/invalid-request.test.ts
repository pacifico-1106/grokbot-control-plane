/**
 * Malformed JSON-RPC envelopes on /api/mcp and /api/mcp/admin must answer a
 * JSON-RPC error (4xx), never an unhandled TypeError → HTTP 500.
 *
 * - non-string `method` (number / object / array / true) → -32600 Invalid Request, HTTP 400
 * - `id` is echoed only when it is a valid JSON-RPC id (string | number), else null
 * - missing / non-JSON / non-object bodies and non-object `params` never 500
 */
import { beforeAll, describe, expect, test } from "bun:test";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { rotateCredential } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { DEMO_ADMIN_SECRET, resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const employeeRoute = await import("@/app/api/mcp/route");
const adminRoute = await import("@/app/api/mcp/admin/route");

const EMP_TOKEN = "gb_emp_invalid_request_test_0123456789abcdef";

beforeAll(async () => {
  await rotateCredential("emp_sales", DEMO_ORG.id, fingerprintSecret(EMP_TOKEN));
  resetDemoAdminAgent({ grokBotAgentId: "agent_admin_demo", status: "linked" });
});

type Surface = "employee" | "admin";
const POSTS = { employee: employeeRoute.POST, admin: adminRoute.POST };
const URLS = { employee: "https://staffpass.test/api/mcp", admin: "https://staffpass.test/api/mcp/admin" };
const AUTH: Record<Surface, Record<string, string>> = {
  employee: { authorization: `Bearer ${EMP_TOKEN}` },
  admin: { authorization: `Bearer ${DEMO_ADMIN_SECRET}` },
};

type RpcError = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code: number; message: string } };

async function postRaw(surface: Surface, rawBody: string | undefined, headers: Record<string, string> = {}) {
  const res = await POSTS[surface](
    new Request(URLS[surface], {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      ...(rawBody === undefined ? {} : { body: rawBody }),
    })
  );
  const text = await res.text();
  let json: RpcError | null = null;
  try {
    json = text ? (JSON.parse(text) as RpcError) : null;
  } catch {
    json = null;
  }
  return { res, json };
}

const post = (surface: Surface, body: unknown, headers: Record<string, string> = {}) =>
  postRaw(surface, JSON.stringify(body), headers);

for (const surface of ["employee", "admin"] as const) {
  describe(`${surface} MCP — malformed JSON-RPC envelopes never 500`, () => {
    for (const method of [42, { name: "tools/list" }, ["tools/list"], true]) {
      test(`non-string method ${JSON.stringify(method)} → 400 -32600 Invalid Request`, async () => {
        const { res, json } = await post(surface, { jsonrpc: "2.0", id: 7, method });
        expect(res.status).toBe(400);
        expect(json?.jsonrpc).toBe("2.0");
        expect(json?.error?.code).toBe(-32600);
        expect(json?.error?.message).toMatch(/^Invalid Request/);
        expect(json?.id).toBe(7);
        expect(json?.result).toBeUndefined();
      });
    }

    test("non-string method on a notification-shaped request (no id) → 400 -32600, id null", async () => {
      const { res, json } = await post(surface, { jsonrpc: "2.0", method: { notifications: "initialized" } });
      expect(res.status).toBe(400);
      expect(json?.error?.code).toBe(-32600);
      expect(json?.id).toBeNull();
    });

    test("falsy non-string method (0 / false / null) still → 400 -32600", async () => {
      for (const method of [0, false, null]) {
        const { res, json } = await post(surface, { jsonrpc: "2.0", id: 1, method });
        expect(res.status).toBe(400);
        expect(json?.error?.code).toBe(-32600);
      }
    });

    test("invalid request echoes id only when it is a string or number", async () => {
      const cases: Array<[unknown, unknown]> = [
        ["req-1", "req-1"],
        [0, 0],
        [12.5, 12.5],
        [{ evil: "<script>" }, null],
        [["a"], null],
        [true, null],
        [null, null],
      ];
      for (const [id, echoed] of cases) {
        for (const method of [99, undefined]) {
          const { res, json } = await post(surface, { jsonrpc: "2.0", id, ...(method === undefined ? {} : { method }) });
          expect(res.status).toBe(400);
          expect(json?.error?.code).toBe(-32600);
          expect(json?.id).toEqual(echoed);
        }
      }
    });

    test("missing body / invalid JSON / JSON null → 400 -32700 Parse error", async () => {
      for (const raw of [undefined, "", "{not json", "null"]) {
        const { res, json } = await postRaw(surface, raw);
        expect(res.status).toBe(400);
        expect(json?.error?.code).toBe(-32700);
        expect(json?.id).toBeNull();
      }
    });

    test("non-object JSON bodies (number / string / boolean) → 4xx JSON-RPC error, never 500", async () => {
      for (const raw of ["42", '"tools/list"', "true", "0", "false", '""']) {
        const { res, json } = await postRaw(surface, raw);
        expect(res.status).toBe(400);
        expect([-32700, -32600]).toContain(json?.error?.code ?? 0);
        expect(json?.id).toBeNull();
      }
    });

    test("batch (array) body still → 400 -32600", async () => {
      const { res, json } = await post(surface, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
      expect(res.status).toBe(400);
      expect(json?.error?.code).toBe(-32600);
    });

    test("non-object params on initialize / ping do not crash", async () => {
      for (const params of ["abc", 5, [], true, null]) {
        const init = await post(surface, { jsonrpc: "2.0", id: 1, method: "initialize", params });
        expect(init.res.status).toBe(200);
        expect(typeof (init.json?.result as Record<string, unknown>)?.protocolVersion).toBe("string");
        const ping = await post(surface, { jsonrpc: "2.0", id: 2, method: "ping", params });
        expect(ping.res.status).toBe(200);
        expect(ping.json?.result).toEqual({});
      }
    });

    test("non-object params on tools/call: unauthenticated → 401, authenticated → -32602 (not 500)", async () => {
      for (const params of ["staffpass_whoami", 7, ["staffpass_whoami"], true]) {
        const unauth = await post(surface, { jsonrpc: "2.0", id: 3, method: "tools/call", params });
        expect(unauth.res.status).toBe(401);
        expect(unauth.json?.error?.code).toBe(-32001);
        const authed = await post(surface, { jsonrpc: "2.0", id: 4, method: "tools/call", params }, AUTH[surface]);
        expect(authed.res.status).toBeLessThan(500);
        expect(authed.json?.error?.code).toBe(-32602);
      }
    });

    test("valid requests are unchanged (ping, unknown method)", async () => {
      const ping = await post(surface, { jsonrpc: "2.0", id: "p", method: "ping" });
      expect(ping.res.status).toBe(200);
      expect(ping.json).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
      const unknown = await post(surface, { jsonrpc: "2.0", id: 9, method: "nope/nope" });
      expect(unknown.res.status).toBe(200);
      expect(unknown.json?.error?.code).toBe(-32601);
    });
  });
}
