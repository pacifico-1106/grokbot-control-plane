/**
 * L-8: LINE Messaging API client — bot/info, webhook set, webhook test.
 * Fail-first against main (none of these paths existed). Host is pinned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchLineBotInfo,
  LINE_API_ORIGIN,
  LINE_MESSAGING_PATHS,
  setLineWebhookEndpoint,
  testLineWebhookEndpoint,
} from "@/lib/comm/line-messaging";

const TOKEN = "A".repeat(120);
const BOT = `U${"b".repeat(32)}`;
const ENDPOINT = "https://staffpass.sealith.com/api/webhooks/line/c/" + "x".repeat(43);

const origFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
let responses: Array<{ status: number; json?: unknown } | "throw">;

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers || {}) as Record<string, string>));
    calls.push({
      url: String(url),
      method: String(init?.method || "GET"),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = responses.shift() ?? { status: 200, json: {} };
    if (next === "throw") throw new Error("network");
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("LINE Messaging API client (fixed host)", () => {
  test("GET /v2/bot/info returns the bot userId", async () => {
    responses.push({ status: 200, json: { userId: BOT, displayName: "営業AI（AIスタッフ）" } });
    const r = await fetchLineBotInfo(TOKEN);
    expect(r).toEqual({ ok: true, bot: { userId: BOT, displayName: "営業AI（AIスタッフ）" } });
    expect(calls).toEqual([
      {
        url: `${LINE_API_ORIGIN}${LINE_MESSAGING_PATHS.botInfo}`,
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: null,
      },
    ]);
  });

  test("PUT webhook endpoint and POST webhook test use the same pinned host", async () => {
    responses.push({ status: 200, json: {} }, { status: 200, json: { success: true, statusCode: 200 } });
    expect(await setLineWebhookEndpoint(TOKEN, ENDPOINT)).toEqual({ ok: true });
    expect(await testLineWebhookEndpoint(TOKEN, ENDPOINT)).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      `${LINE_API_ORIGIN}${LINE_MESSAGING_PATHS.webhookEndpoint}`,
      `${LINE_API_ORIGIN}${LINE_MESSAGING_PATHS.webhookTest}`,
    ]);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toEqual({ endpoint: ENDPOINT });
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toEqual({ endpoint: ENDPOINT });
    expect(calls.every((c) => new URL(c.url).hostname === "api.line.me")).toBe(true);
    expect(calls.every((c) => new URL(c.url).protocol === "https:")).toBe(true);
  });

  test("401 → token_unauthorized; network → line_network; bad userId → bot_info_invalid", async () => {
    responses.push({ status: 401, json: { message: "Invalid access token" } });
    expect(await fetchLineBotInfo(TOKEN)).toEqual({ ok: false, reason: "token_unauthorized", httpStatus: 401 });
    responses.push("throw");
    expect(await setLineWebhookEndpoint(TOKEN, ENDPOINT)).toEqual({ ok: false, reason: "line_network" });
    responses.push({ status: 200, json: { userId: "not-a-bot" } });
    expect(await fetchLineBotInfo(TOKEN)).toEqual({ ok: false, reason: "bot_info_invalid" });
  });

  test("LINE test HTTP 200 with success:false → webhook_test_rejected", async () => {
    responses.push({ status: 200, json: { success: false, statusCode: 404, reason: "Not Found" } });
    expect(await testLineWebhookEndpoint(TOKEN, ENDPOINT)).toEqual({ ok: false, reason: "webhook_test_rejected" });
  });

  test("the token is never present except as the Authorization header (never in the URL or JSON body)", async () => {
    responses.push({ status: 200, json: { userId: BOT, displayName: "x" } });
    await fetchLineBotInfo(TOKEN);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(JSON.stringify(calls[0].body)).not.toContain(TOKEN);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});
