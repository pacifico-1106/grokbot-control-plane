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
  notify.__setHoldNotifierForTests({ async tenant() {}, async ops() {} });
  notify.__setHoldSlackFetchForTests((async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch);
});
afterEach(() => {
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
