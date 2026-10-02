import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/lp-handoff-outbox/route";

const URL_ = "https://example.test/api/cron/lp-handoff-outbox";
const saved = { CRON_SECRET: process.env.CRON_SECRET, LP_HANDOFF_ENABLED: process.env.LP_HANDOFF_ENABLED };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("LP handoff outbox cron", () => {
  test("is registered in vercel.json", () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
    expect(cfg.crons.some((c: { path: string }) => c.path === "/api/cron/lp-handoff-outbox")).toBe(true);
  });

  test("GET without the cron secret is 401", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    const res = await GET(new NextRequest(URL_, { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
  });

  test("GET with no CRON_SECRET configured is 401", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(new NextRequest(URL_, { headers: { authorization: "Bearer " } }));
    expect(res.status).toBe(401);
  });

  test("GET with the secret skips while LP_HANDOFF_ENABLED is off", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    delete process.env.LP_HANDOFF_ENABLED;
    const res = await GET(new NextRequest(URL_, { headers: { authorization: "Bearer s3cret-value" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "skipped", reason: "feature_disabled" });
  });
});
