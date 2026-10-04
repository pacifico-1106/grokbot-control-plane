/** Retry cron for MCP Events deliveries: CRON_SECRET required, no-op with the flag OFF. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const { GET } = await import("@/app/api/cron/mcp-events-deliver/route");
const req = (headers: Record<string, string> = {}) => new NextRequest("https://staffpass.test/api/cron/mcp-events-deliver", { headers });
afterEach(() => { delete process.env.CRON_SECRET; delete process.env.MCP_EVENTS_ENABLED; });

describe("cron /api/cron/mcp-events-deliver: shared helper (lib/security/cron-secret.ts, #264)", () => {
  const src = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  test("uses rejectUnauthorizedCron and no route-local secret comparison", () => {
    expect(src).toMatch(/import \{[^}]*\brejectUnauthorizedCron\b[^}]*\} from "@\/lib\/security\/cron-secret"/);
    expect(src).toMatch(/rejectUnauthorizedCron\(req\)/);
    expect(src).not.toContain("process.env.CRON_SECRET");
    expect(src).not.toContain("x-cron-secret");
    expect(src).not.toContain("timingSafeEqual");
  });
  test("unset → 503 cron_not_configured; placeholder → 401; Bearer only (x-cron-secret / raw / lowercase refused)", async () => {
    let res = await GET(req({ authorization: "Bearer x" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "cron_not_configured" });
    process.env.CRON_SECRET = "replace_me_with_a_secret";
    expect((await GET(req({ authorization: "Bearer replace_me_with_a_secret" }))).status).toBe(401);
    process.env.CRON_SECRET = "cron-secret-test-value";
    const refused: Array<Record<string, string>> = [{ "x-cron-secret": "cron-secret-test-value" }, { authorization: "cron-secret-test-value" }, { authorization: "bearer cron-secret-test-value" }];
    for (const h of refused) {
      res = await GET(req(h));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
  });
  test("flag ON → also prunes finished delivery rows (retention)", async () => {
    process.env.CRON_SECRET = "cron-secret-test-value";
    process.env.MCP_EVENTS_ENABLED = "true";
    const body = await (await GET(req({ authorization: "Bearer cron-secret-test-value" }))).json();
    expect(body).toMatchObject({ status: "completed", attempted: 0, deferred: 0, pruned: 0 });
  });
});

describe("cron /api/cron/mcp-events-deliver", () => {
  test("401 without / with a wrong CRON_SECRET", async () => {
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
