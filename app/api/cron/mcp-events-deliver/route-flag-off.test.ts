/**
 * D6 (八坂 GO 2026-10-05): the cron runs every minute from vercel.json. With
 * MCP_EVENTS_ENABLED off it must be a pure no-op — "skipped", no Supabase
 * client constructed, the service / store modules never loaded. Production-like
 * env (non-placeholder dummy Supabase values) so a DB touch could not hide
 * behind demo mode; the client factory is a spy.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

let adminClients = 0;
let serverClients = 0;
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => { adminClients++; throw new Error("DB must not be touched with the flag off"); },
  createSupabaseServerClient: () => { serverClients++; throw new Error("DB must not be touched with the flag off"); },
}));
let serviceLoaded = 0;
mock.module("@/lib/mcp-events/service", () => {
  serviceLoaded++;
  return {
    deliverDueEvents: async () => { throw new Error("must not run"); },
    pruneFinishedDeliveries: async () => { throw new Error("must not run"); },
    pruneVerificationWindows: async () => { throw new Error("must not run"); },
  };
});
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test-project.supabase.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "unit-test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "unit-test-service-role-key";
process.env.CRON_SECRET = "cron-secret-test-value";
afterAll(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "MCP_EVENTS_ENABLED"]) delete process.env[k];
});
const { GET, POST } = await import("@/app/api/cron/mcp-events-deliver/route");
const req = () => new NextRequest("https://staffpass.test/api/cron/mcp-events-deliver", { headers: { authorization: "Bearer cron-secret-test-value" } });

describe("D6: mcp-events-deliver cron schedule", () => {
  test("registered in vercel.json every minute, exactly once", () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const mine = cfg.crons.filter((c) => c.path === "/api/cron/mcp-events-deliver");
    expect(mine).toEqual([{ path: "/api/cron/mcp-events-deliver", schedule: "* * * * *" }]);
  });
  for (const value of [undefined, "", "false", "0", "off", "no"]) {
    test(`flag ${JSON.stringify(value)} → skipped, no DB client, service never loaded (GET + POST)`, async () => {
      if (value === undefined) delete process.env.MCP_EVENTS_ENABLED; else process.env.MCP_EVENTS_ENABLED = value;
      for (const handler of [GET, POST]) {
        const res = await handler(req());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "skipped", reason: "feature_disabled" });
      }
      expect(adminClients).toBe(0);
      expect(serverClients).toBe(0);
      expect(serviceLoaded).toBe(0);
    });
  }
});
