import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "@/app/api/cron/channel-scope-reconcile/route";

const URL_ = "https://example.test/api/cron/channel-scope-reconcile";
const saved = { CRON_SECRET: process.env.CRON_SECRET, P1_CHANNEL_SCOPE_ENABLED: process.env.P1_CHANNEL_SCOPE_ENABLED };
const savedFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("channel scope reconcile cron route", () => {
  test("is registered in vercel.json every 6 hours", () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8"));
    const entry = cfg.crons.find((c: { path: string }) => c.path === "/api/cron/channel-scope-reconcile");
    expect(entry?.schedule).toBe("17 */6 * * *");
  });

  test("no CRON_SECRET ⇒ 503; wrong secret ⇒ 401", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(new Request(URL_))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret-value";
    expect((await GET(new Request(URL_, { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });

  test("flag OFF (default) ⇒ 200 skipped, no Slack call", async () => {
    process.env.CRON_SECRET = "s3cret-value";
    delete process.env.P1_CHANNEL_SCOPE_ENABLED;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const res = await GET(new Request(URL_, { headers: { authorization: "Bearer s3cret-value" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "flag_off" });
    expect(calls).toBe(0);
  });
});
