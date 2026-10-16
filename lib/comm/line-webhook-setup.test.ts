/**
 * L-8: owner/admin connect orchestrates bot/info → store userId → set webhook → test.
 * Fail-first against main. LINE is mocked. Token is never in the result or logs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createCommAccount,
  listCommAccounts,
  resetDemoCommAccounts,
  setCommAccountSecrets,
} from "@/lib/comm/accounts";
import { conversationWebhookUrl, setupLineConversationWebhook } from "@/lib/comm/line-webhook-setup";

const ENV = [
  "COMM_ACCOUNTS_ENABLED",
  "LINE_CONVERSATION_ENABLED",
  "LINE_WEBHOOK_AUTO_SETUP_ENABLED",
  "NOTIFICATION_CONFIG_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_ENV",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const BOT = `U${"b".repeat(32)}`;
const OTHER = `U${"c".repeat(32)}`;
const TOKEN = "A".repeat(120);
const SECRET = "0123456789abcdef0123456789abcdef";
const SECRETS = { channelAccessToken: TOKEN, channelSecret: SECRET };
const ORIGIN = "https://staffpass.sealith.com";

const origFetch = globalThis.fetch;
const origError = console.error;
let calls: Array<{ url: string; method: string; body: unknown; authorization: string }>;
let responses: Array<{ status: number; json?: unknown } | "throw">;
let errorLines: string[];

function on(info = true, set = true, testOk = true) {
  if (info) responses.push({ status: 200, json: { userId: BOT, displayName: "営業AI（AIスタッフ）" } });
  if (set) responses.push({ status: 200, json: {} });
  if (testOk) responses.push({ status: 200, json: { success: true } });
}

beforeEach(() => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.VERCEL_ENV;
  resetDemoCommAccounts();
  calls = [];
  responses = [];
  errorLines = [];
  console.error = (...args: unknown[]) => {
    errorLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers || {}) as Record<string, string>));
    calls.push({
      url: String(url),
      method: String(init?.method || "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: headers.authorization || "",
    });
    const next = responses.shift() ?? { status: 200, json: {} };
    if (next === "throw") throw new Error("network");
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  console.error = origError;
  resetDemoCommAccounts();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("setupLineConversationWebhook", () => {
  test("flag default / OFF → disabled (no LINE call, no account)", async () => {
    delete process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED;
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, secrets: SECRETS, createdByMemberId: "m1" });
    expect(r).toMatchObject({ ok: false, reason: "disabled" });
    expect(r.ok === false && r.messageJa).toContain("オフ");
    expect(calls).toEqual([]);
    expect(await listCommAccounts(ORG)).toEqual([]);
  });

  test("conversation flags without the new flag still refuse", async () => {
    process.env.LINE_WEBHOOK_AUTO_SETUP_ENABLED = "false";
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, secrets: SECRETS, createdByMemberId: "m1" });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("connect: GET bot/info → store userId → PUT webhook → POST test", async () => {
    on();
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, secrets: SECRETS, createdByMemberId: "m1" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.botUserId).toBe(BOT);
    expect(r.account.externalAccountId).toBe(BOT);
    expect(r.webhookUrl).toMatch(new RegExp(`^${ORIGIN}/api/webhooks/line/c/[A-Za-z0-9_-]{43}$`));
    expect(r.account.webhookPath).toBe(`/api/webhooks/line/c/${r.webhookUrl.slice(`${ORIGIN}/api/webhooks/line/c/`.length)}`);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.line.me/v2/bot/info",
      "PUT https://api.line.me/v2/bot/channel/webhook/endpoint",
      "POST https://api.line.me/v2/bot/channel/webhook/test",
    ]);
    expect(calls[1].body).toEqual({ endpoint: r.webhookUrl });
    expect(calls[2].body).toEqual({ endpoint: r.webhookUrl });
    const listed = await listCommAccounts(ORG);
    expect(listed[0]?.externalAccountId).toBe(BOT);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(errorLines.join("\n")).not.toContain(TOKEN);
  });

  test("bad secrets never call LINE", async () => {
    const r = await setupLineConversationWebhook({
      orgId: ORG,
      employeeId: EMP,
      secrets: { channelAccessToken: "short", channelSecret: SECRET },
      createdByMemberId: "m1",
    });
    expect(r).toMatchObject({ ok: false, reason: "invalid_secrets" });
    expect(r.ok === false && r.messageJa).toContain("形式");
    expect(calls).toEqual([]);
  });

  test("401 on bot/info → Japanese token error; nothing stored", async () => {
    responses.push({ status: 401, json: { message: "Invalid access token" } });
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, secrets: SECRETS, createdByMemberId: "m1" });
    expect(r).toMatchObject({ ok: false, reason: "token_unauthorized" });
    expect(r.ok === false && r.messageJa).toContain("チャネルアクセストークン");
    expect(await listCommAccounts(ORG)).toEqual([]);
  });

  test("non-https origin refuses before PUT (no SSRF / no localhost webhook)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    on(true, false, false);
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, secrets: SECRETS, createdByMemberId: "m1" });
    expect(r).toMatchObject({ ok: false, reason: "origin_not_https" });
    expect(calls.map((c) => c.url)).toEqual(["https://api.line.me/v2/bot/info"]);
    expect(await listCommAccounts(ORG)).toHaveLength(1);
  });

  test("re-setup decrypts the stored token and does not take a client token", async () => {
    const created = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
    if (!created.ok) throw new Error(created.reason);
    await setCommAccountSecrets({ orgId: ORG, accountId: created.account.id, secrets: SECRETS, memberId: "m1" });
    on();
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, createdByMemberId: "m1" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.webhookUrl).toBe(`${ORIGIN}${`/api/webhooks/line/c/${created.account.webhookRef}`}`);
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("re-setup refuses when bot/info userId differs from the stored account", async () => {
    const created = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
    if (!created.ok) throw new Error(created.reason);
    await setCommAccountSecrets({ orgId: ORG, accountId: created.account.id, secrets: SECRETS, memberId: "m1" });
    responses.push({ status: 200, json: { userId: OTHER, displayName: "other" } });
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, createdByMemberId: "m1" });
    expect(r).toMatchObject({ ok: false, reason: "bot_user_mismatch" });
    expect(r.ok === false && r.messageJa).toContain("一致しません");
    expect(calls.map((c) => c.url)).toEqual(["https://api.line.me/v2/bot/info"]);
  });

  test("webhook test success:false is a clear Japanese error after the URL is set", async () => {
    on(true, true, false);
    responses.push({ status: 200, json: { success: false, statusCode: 404 } });
    const r = await setupLineConversationWebhook({ orgId: ORG, employeeId: EMP, secrets: SECRETS, createdByMemberId: "m1" });
    expect(r).toMatchObject({ ok: false, reason: "webhook_test_rejected" });
    expect(r.ok === false && r.messageJa).toContain("Webhook テスト");
    expect(r.ok === false && r.botUserId).toBe(BOT);
    expect(await listCommAccounts(ORG)).toHaveLength(1);
  });
});

describe("conversationWebhookUrl", () => {
  test("production path is /api/webhooks/line/c/<ref> on the public origin", () => {
    const ref = "A".repeat(43);
    expect(conversationWebhookUrl(ref, ORIGIN)).toBe(`${ORIGIN}/api/webhooks/line/c/${ref}`);
    expect(conversationWebhookUrl("short", ORIGIN)).toBeNull();
    expect(conversationWebhookUrl(ref, "http://localhost:3000")).toBeNull();
  });
});
