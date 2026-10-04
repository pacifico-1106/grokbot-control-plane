/** Retry cron for MCP Events deliveries: CRON_SECRET required, no-op with the flag OFF. */
import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const { GET } = await import("@/app/api/cron/mcp-events-deliver/route");
const req = (headers: Record<string, string> = {}) => new NextRequest("https://staffpass.test/api/cron/mcp-events-deliver", { headers });
afterEach(() => { delete process.env.CRON_SECRET; delete process.env.MCP_EVENTS_ENABLED; });

describe("cron /api/cron/mcp-events-deliver", () => {
  test("401 without / with a wrong CRON_SECRET (and when unset)", async () => {
    expect((await GET(req({ authorization: "Bearer x" }))).status).toBe(401);
    process.env.CRON_SECRET = "cron-secret-test-value";
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req({ authorization: "Bearer wrong" }))).status).toBe(401);
  });
  test("flag OFF → skipped", async () => {
    process.env.CRON_SECRET = "cron-secret-test-value";
    const res = await GET(req({ authorization: "Bearer cron-secret-test-value" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "skipped", reason: "feature_disabled" });
  });
  test("flag ON → runs the deliverer", async () => {
    process.env.CRON_SECRET = "cron-secret-test-value";
    process.env.MCP_EVENTS_ENABLED = "true";
    const res = await GET(req({ authorization: "Bearer cron-secret-test-value" }));
    expect(await res.json()).toMatchObject({ status: "completed", attempted: 0 });
  });
});
