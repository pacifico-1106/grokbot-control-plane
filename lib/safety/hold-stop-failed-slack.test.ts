/**
 * 木村 10/12 08:17 (#349 decision 2): when a STOP FAILS (only that case), also post to the
 * existing LP_HANDOFF_NOTIFY_SLACK_WEBHOOK (安藤). Skip if unset. IDs and reason codes only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as notify from "@/lib/safety/hold-notify";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMP = "22222222-2222-4222-8222-222222222222";
type Call = { url: string; body: string };
let calls: Call[] = [];
const prevHook = process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK;

beforeEach(() => {
  calls = [];
  // the post is production-only (木村 10/12 09:01); these tests exercise the production path
  notify.__setHoldSlackRuntimeForTests("production");
  notify.__resetHoldSlackThrottleForTests();
  notify.__setHoldNotifierForTests({ async tenant() {}, async ops() {} });
  notify.__setHoldSlackFetchForTests((async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch);
});
afterEach(() => {
  notify.__setHoldSlackRuntimeForTests(null);
  notify.__setHoldSlackClockForTests(null);
  notify.__resetHoldSlackThrottleForTests();
  notify.__setHoldNotifierForTests(null);
  notify.__setHoldSlackFetchForTests(null);
  if (prevHook === undefined) delete process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK;
  else process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = prevHook;
});

const failed = {
  event: "hold.start_failed" as const, orgId: ORG, employeeId: EMP, holdId: null,
  via: "web", sqlState: "40001", attempts: 3,
  // fields that must never reach Slack even if a caller passes them
  reason: "顧客 山田太郎 yamada@example.com 090-1234-5678", email: "yamada@example.com",
} as unknown as notify.HoldNotice;

describe("stop failed → LP handoff Slack webhook", () => {
  test("a stop failure posts to the webhook", async () => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = "https://hooks.slack.test/T/B/x";
    await notify.notifyHold(failed, { ops: true, tenant: true });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://hooks.slack.test/T/B/x");
    const text = JSON.parse(calls[0].body).text as string;
    expect(text).toContain("hold_start_failed");
    expect(text).toContain(ORG);
    expect(text).toContain(EMP);
    expect(text).toContain("40001");
  });

  test("unset webhook → skipped, no fetch, no throw", async () => {
    delete process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK;
    await notify.notifyHold(failed, { ops: true, tenant: true });
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = "   ";
    await notify.notifyHold(failed, { ops: true, tenant: true });
    expect(calls.length).toBe(0);
  });

  test("payload has no PII: only allow-listed IDs / codes", async () => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = "https://hooks.slack.test/T/B/x";
    await notify.notifyHold(failed, { ops: true });
    const body = calls[0].body;
    for (const bad of ["山田", "yamada", "@example.com", "090-1234"]) expect(body).not.toContain(bad);
    expect(JSON.parse(body).text).not.toMatch(/^(reason|email):/m);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["text", "unfurl_links", "unfurl_media"]);
    // every line is "key: value" where value is an id / code / number
    for (const line of (parsed.text as string).split("\n").slice(1)) expect(line).toMatch(/^[a-z_]+: [A-Za-z0-9_\-:.]+$/);
  });

  test("only on stop failure: other events never post", async () => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = "https://hooks.slack.test/T/B/x";
    for (const event of ["hold.started", "hold.upgraded", "hold.release_requested", "hold.released"] as const) {
      await notify.notifyHold({ ...failed, event }, { ops: true, tenant: true });
    }
    expect(calls.length).toBe(0);
  });

  test("the webhook fetch carries a 5 s timeout signal; a hanging webhook is aborted, not awaited forever", async () => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = "https://hooks.slack.test/T/B/x";
    let signal: AbortSignal | undefined;
    const realTimeout = AbortSignal.timeout;
    let requestedMs = 0;
    (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => { requestedMs = ms; return realTimeout.call(AbortSignal, 20); };
    notify.__setHoldSlackFetchForTests((async (_u: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return await new Promise<Response>((_, reject) => {
        if (!signal) return; // never settles without a signal
        signal.addEventListener("abort", () => reject(signal!.reason ?? new Error("aborted")));
      });
    }) as unknown as typeof fetch);
    try {
      const out = await Promise.race([
        notify.postStopFailedToHandoffSlack(failed),
        new Promise((r) => setTimeout(() => r("hung"), 500)),
      ]);
      expect(requestedMs).toBe(5000);
      expect(signal).toBeDefined();
      expect(out).toBe("failed");
    } finally {
      (AbortSignal as unknown as { timeout: typeof realTimeout }).timeout = realTimeout;
    }
  });
  test("webhook error never throws out of notifyHold", async () => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = "https://hooks.slack.test/T/B/x";
    notify.__setHoldSlackFetchForTests((async () => { throw new Error("down"); }) as unknown as typeof fetch);
    await notify.notifyHold(failed, { ops: true });
  });
});

describe("stop-failure Slack post: throttle (木村 10/12 09:01)", () => {
  const HOOK = "https://hooks.slack.test/T/B/x";
  let now = 1_800_000_000_000;
  beforeEach(() => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = HOOK;
    now = 1_800_000_000_000;
    notify.__setHoldSlackClockForTests(() => now);
  });

  test("at most 1 post per org × employee × reason per 10 minutes", async () => {
    for (let i = 0; i < 12; i++) await notify.notifyHold(failed, { ops: true });
    expect(calls.length).toBe(1);
    now += 9 * 60_000;
    await notify.notifyHold(failed, { ops: true });
    expect(calls.length).toBe(1);
  });

  test("the next post carries the suppressed count, then the count resets", async () => {
    await notify.notifyHold(failed, { ops: true });
    for (let i = 0; i < 4; i++) await notify.notifyHold(failed, { ops: true });
    now += 10 * 60_000 + 1;
    await notify.notifyHold(failed, { ops: true });
    expect(calls.length).toBe(2);
    expect(JSON.parse(calls[1].body).text).toContain("suppressed_since_last: 4");
    expect(JSON.parse(calls[0].body).text).not.toContain("suppressed_since_last");
    now += 10 * 60_000 + 1;
    await notify.notifyHold(failed, { ops: true });
    expect(JSON.parse(calls[2].body).text).not.toContain("suppressed_since_last");
  });

  test("another employee, another org, or org-wide is its own bucket", async () => {
    await notify.notifyHold(failed, { ops: true });
    await notify.notifyHold({ ...failed, employeeId: "33333333-3333-4333-8333-333333333333" }, { ops: true });
    await notify.notifyHold({ ...failed, orgId: "44444444-4444-4444-8444-444444444444" }, { ops: true });
    await notify.notifyHold({ ...failed, employeeId: null }, { ops: true });
    expect(calls.length).toBe(4);
  });

  test("the throttle map is capped", async () => {
    for (let i = 0; i < notify.HOLD_SLACK_THROTTLE_MAX_KEYS + 50; i++) {
      await notify.notifyHold({ ...failed, employeeId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}` }, { ops: true });
    }
    expect(notify.__holdSlackThrottleSizeForTests()).toBeLessThanOrEqual(notify.HOLD_SLACK_THROTTLE_MAX_KEYS);
  });
});

describe("stop-failure Slack post: production only (木村 10/12 09:01)", () => {
  const HOOK = "https://hooks.slack.test/T/B/x";
  const saved = { VERCEL_ENV: process.env.VERCEL_ENV, NODE_ENV: process.env.NODE_ENV, URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    ANON: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SR: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  beforeEach(() => {
    process.env.LP_HANDOFF_NOTIFY_SLACK_WEBHOOK = HOOK;
    notify.__setHoldSlackRuntimeForTests(null); // the real check
  });
  afterEach(() => {
    restore("VERCEL_ENV", saved.VERCEL_ENV);
    restore("NODE_ENV", saved.NODE_ENV);
    restore("NEXT_PUBLIC_SUPABASE_URL", saved.URL);
    restore("NEXT_PUBLIC_SUPABASE_ANON_KEY", saved.ANON);
    restore("SUPABASE_SERVICE_ROLE_KEY", saved.SR);
  });
  const liveSupabase = () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-real-looking";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-real-looking";
  };

  test("NODE_ENV=test → no post even with VERCEL_ENV=production and live Supabase", async () => {
    liveSupabase();
    process.env.VERCEL_ENV = "production";
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    expect(await notify.postStopFailedToHandoffSlack(failed)).toBe("skipped");
    expect(calls.length).toBe(0);
  });
  test("preview / development / unset VERCEL_ENV → no post", async () => {
    liveSupabase();
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    for (const v of ["preview", "development", undefined]) {
      restore("VERCEL_ENV", v);
      expect(await notify.postStopFailedToHandoffSlack(failed)).toBe("skipped");
    }
    expect(calls.length).toBe(0);
  });
  test("demo mode → no post", async () => {
    process.env.VERCEL_ENV = "production";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(await notify.postStopFailedToHandoffSlack(failed)).toBe("skipped");
    expect(calls.length).toBe(0);
  });
  test("real production (VERCEL_ENV=production, NODE_ENV=production, live Supabase) → posts", async () => {
    liveSupabase();
    process.env.VERCEL_ENV = "production";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(await notify.postStopFailedToHandoffSlack(failed)).toBe("posted");
    expect(calls.length).toBe(1);
  });
});
