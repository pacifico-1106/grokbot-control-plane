import { afterEach, beforeEach, expect, test } from "bun:test";
import { __setOAuthStoreForTests, createMemoryOAuthStore } from "@/lib/data/oauth";
import { CIMD_MAX_BYTES, resolveCimdClient } from "../cimd";
import { isPrivateAddress } from "../net-guard";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import type { CimdTransport } from "../cimd";

/** Adapts a fetch-shaped fake + a string[] resolver to the pinned CIMD transport (reland-8). */
function tr(fetchImpl: typeof fetch, resolveHost: (host: string) => Promise<string[]>): CimdTransport {
  return {
    lookup: async (host) => (await resolveHost(host)).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    request: ((opts: RequestOptions, cb: (res: IncomingMessage) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => undefined;
      req.end = () => {
        const host = (opts.headers as Record<string, string>).host;
        Promise.resolve()
          .then(() => fetchImpl(`https://${host}${opts.path}`, { method: "GET" }))
          .then(async (r) => {
            const res = new PassThrough() as unknown as PassThrough & { statusCode: number; headers: Record<string, string> };
            res.statusCode = r.status;
            res.headers = Object.fromEntries(r.headers.entries());
            cb(res as unknown as IncomingMessage);
            res.end(Buffer.from(await r.arrayBuffer()));
          })
          .catch((e) => req.emit("error", e));
      };
      return req as unknown as ClientRequest;
    }) as CimdTransport["request"],
  };
}

const URL_OK = "https://claude.ai/oauth/mcp-client.json";
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: URL_OK,
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"],
  token_endpoint_auth_method: "none",
  ...over,
});
const publicDns = async () => ["160.79.104.10"];
let calls = 0;
const fetchJson = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  (async () => {
    calls++;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

beforeEach(() => {
  calls = 0;
  __setOAuthStoreForTests(createMemoryOAuthStore());
  delete process.env.MCP_OAUTH_CIMD_ALLOWED_HOSTS;
});
afterEach(() => __setOAuthStoreForTests(null));

test("valid document → client with only allowlisted redirects; cached on second call", async () => {
  const r = await resolveCimdClient(URL_OK, { transport: tr(fetchJson(doc(), { headers: { "cache-control": "max-age=60" } }), publicDns) });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.client.redirectUris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(r.client.registrationType).toBe("cimd");
    // max-age 60 clamped to 300s minimum
    expect(Date.parse(r.client.metadataExpiresAt!) - Date.parse(r.client.metadataFetchedAt!)).toBe(300_000);
  }
  const again = await resolveCimdClient(URL_OK, { transport: tr(fetchJson(doc()), publicDns) });
  expect(again.ok && again.cached).toBe(true);
  expect(calls).toBe(1);
});

test("host not on allowlist / http / no path / explicit port → refused without fetching", async () => {
  for (const id of ["https://evil.example/client.json", "http://claude.ai/client.json", "https://claude.ai/", "https://claude.ai:8443/c.json"]) {
    const r = await resolveCimdClient(id, { transport: tr(fetchJson(doc({ client_id: id })), publicDns) });
    expect(r.ok).toBe(false);
  }
  expect(calls).toBe(0);
});

test("private / loopback / metadata IPs refused (SSRF)", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "172.16.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    const r = await resolveCimdClient(URL_OK, { transport: tr(fetchJson(doc()), async () => [ip]) });
    expect([ip, r.ok]).toEqual([ip, false]);
  }
  const mixed = await resolveCimdClient(URL_OK, { transport: tr(fetchJson(doc()), async () => ["160.79.104.10", "10.0.0.1"]) });
  expect(mixed.ok).toBe(false);
  expect(calls).toBe(0);
  expect(isPrivateAddress("8.8.8.8")).toBe(false);
});

test("redirect responses are not followed", async () => {
  const r = await resolveCimdClient(URL_OK, { transport: tr(fetchJson("", { status: 302, headers: { location: "http://169.254.169.254/" } }), publicDns) });
  expect(r).toEqual({ ok: false, error: "redirect_refused" });
});

test("oversize, non-JSON, client_id mismatch, missing fields, auth method, no allowed redirect", async () => {
  const cases: Array<[typeof fetch, string]> = [
    [fetchJson("x".repeat(CIMD_MAX_BYTES + 1)), "too_large"],
    [fetchJson("<html>", { headers: { "content-type": "text/html" } }), "not_json"],
    [fetchJson("{not json"), "not_json"],
    [fetchJson(doc({ client_id: "https://claude.ai/other.json" })), "client_id_mismatch"],
    [fetchJson(doc({ client_name: "" })), "invalid_metadata"],
    [fetchJson(doc({ redirect_uris: [] })), "invalid_metadata"],
    [fetchJson(doc({ token_endpoint_auth_method: "private_key_jwt" })), "unsupported_auth_method"],
    [fetchJson(doc({ redirect_uris: ["https://evil.example/cb"] })), "no_allowed_redirect"],
  ];
  for (const [f, want] of cases) {
    __setOAuthStoreForTests(createMemoryOAuthStore());
    const r = await resolveCimdClient(URL_OK, { transport: tr(f, publicDns) });
    expect(r).toEqual({ ok: false, error: want as never });
  }
});

test("fetch failure with no cache → refused", async () => {
  const boom = (async () => {
    throw new Error("timeout");
  }) as unknown as typeof fetch;
  expect(await resolveCimdClient(URL_OK, { transport: tr(boom, publicDns) })).toEqual({ ok: false, error: "fetch_failed" });
});

test("hardening 3: a block applied while an expired-cache refetch is in flight is NOT undone by the refresh upsert", async () => {
  const { getOAuthStore } = await import("@/lib/data/oauth");
  const t0 = new Date("2026-10-03T00:00:00Z");
  const first = await resolveCimdClient(URL_OK, { transport: tr(fetchJson(doc()), publicDns), now: t0 });
  expect(first.ok).toBe(true);
  const store = getOAuthStore();
  // cache expired (TTL 300s); admin blocks the client while the refetch is running
  const racingFetch = (async () => {
    calls++;
    const c = (await store.getClient(URL_OK))!;
    await store.upsertClient({ ...c, status: "blocked" });
    return new Response(JSON.stringify(doc()), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const r = await resolveCimdClient(URL_OK, { transport: tr(racingFetch, publicDns), now: new Date(t0.getTime() + 400_000) });
  expect(r.ok).toBe(false);
  expect((await store.getClient(URL_OK))?.status).toBe("blocked");
  // and a later resolve still refuses without fetching
  const before = calls;
  expect((await resolveCimdClient(URL_OK, { transport: tr(fetchJson(doc()), publicDns), now: new Date(t0.getTime() + 800_000) })).ok).toBe(false);
  expect(calls).toBe(before);
});

test("hardening 3: memory store upsertClient({ preserveStatus }) keeps an existing status, inserts as given", async () => {
  const store = createMemoryOAuthStore();
  const base = { clientId: URL_OK, registrationType: "cimd" as const, clientName: "Claude", clientUri: null, logoUri: null, redirectUris: ["https://claude.ai/api/mcp/auth_callback"], tokenEndpointAuthMethod: "none" as const, metadata: {}, metadataFetchedAt: null, metadataExpiresAt: null, status: "active" as const, createdIpHash: null };
  expect((await store.upsertClient(base, { preserveStatus: true })).status).toBe("active");
  await store.upsertClient({ ...base, status: "blocked" });
  const after = await store.upsertClient({ ...base, clientName: "Claude 2" }, { preserveStatus: true });
  expect(after.status).toBe("blocked");
  expect(after.clientName).toBe("Claude 2");
});
