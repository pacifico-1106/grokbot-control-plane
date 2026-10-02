import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  runtimeModeLabel: () => "production",
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
}));
const { __setOAuthStoreForTests, createMemoryOAuthStore } = await import("@/lib/data/oauth");
const token = await import("./route");
const revoke = await import("@/app/api/oauth/revoke/route");
const purge = await import("@/app/api/cron/oauth-purge/route");

const ENV = ["MCP_OAUTH_ENABLED", "IP_HASH_KEY", "CRON_SECRET"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.IP_HASH_KEY = "i".repeat(40);
  process.env.CRON_SECRET = "cron-test-secret";
  __setOAuthStoreForTests(createMemoryOAuthStore());
});
afterEach(() => {
  __setOAuthStoreForTests(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const post = (h: { POST: (r: Request) => Promise<Response> }, body = "grant_type=authorization_code&client_id=x") =>
  h.POST(new Request("https://staffpass.sealith.com/api/oauth/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));

describe("token / revoke routes", () => {
  test("flag OFF → 404 (POST and OPTIONS)", async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    expect((await post(token)).status).toBe(404);
    expect((await post(revoke, "token=x&client_id=x")).status).toBe(404);
    expect((await token.OPTIONS()).status).toBe(404);
  });

  test("ON: errors are JSON with no-store; unknown client → 401 invalid_client", async () => {
    const res = await post(token);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  test("OPTIONS preflight → 204 with CORS (no credentials)", async () => {
    const res = await token.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("cron /api/cron/oauth-purge", () => {
  const get = (auth?: string) => purge.GET(new Request("https://x/api/cron/oauth-purge", { headers: auth ? { authorization: auth } : {} }));
  test("requires CRON_SECRET", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("Bearer wrong")).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await get("Bearer cron-test-secret")).status).toBe(503);
  });
  test("flag OFF → skipped; ON → purged counts", async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    expect(await (await get("Bearer cron-test-secret")).json()).toEqual({ ok: true, skipped: "oauth_disabled" });
    process.env.MCP_OAUTH_ENABLED = "true";
    expect(await (await get("Bearer cron-test-secret")).json()).toMatchObject({ ok: true, purged: { requests: 0, codes: 0 } });
  });
});
