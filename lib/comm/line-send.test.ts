/**
 * L-5: the LINE send path for a per-employee official account.
 * token → target (AI args can't steer) → audience from the ledger (linked = internal)
 * → external needs the caller's explicit permission (approval / policy) → secrets →
 * checkLineSendAllowed (right before the API) → Reply (fresh, pinned replyToken) or
 * Push (X-Line-Retry-Key) → sent / not_sent / unknown. The text is never logged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCommAccount, resetDemoCommAccounts, setCommAccountSecrets, type CommAccount } from "@/lib/comm/accounts";
import { issueConversationToken } from "@/lib/comm/conversation-token";
import { sendLineConversationMessage, __resetLineSendForTests, classifyLine429, type LineSendDeps } from "@/lib/comm/line-send";
import type { PreSendResult } from "@/lib/comm/pre-send";

const ENV = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "COMM_ACCOUNTS_ORG_IDS", "LINE_CONVERSATION_ORG_IDS", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "COMM_CONVERSATION_TOKEN_SECRET"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const BOT = "U" + "1".repeat(32);
const USER = "U" + "a".repeat(32);
const TOKEN = "A".repeat(120);
const NOW = 1_800_000_000_000;

let account: CommAccount;
let calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
let responses: Array<number | "throw" | { status: number; body: string }>;
let link: { status: string } | null | "throw";
let preSend: PreSendResult;
let preSendArgs: unknown[];
let now: number;
const origFetch = globalThis.fetch;

beforeEach(async () => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  process.env.COMM_CONVERSATION_TOKEN_SECRET = "t".repeat(48);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  resetDemoCommAccounts();
  __resetLineSendForTests();
  const r = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
  if (!r.ok) throw new Error(r.reason);
  account = r.account;
  const s = await setCommAccountSecrets({ orgId: ORG, accountId: account.id, secrets: { channelAccessToken: TOKEN, channelSecret: "0123456789abcdef0123456789abcdef" }, memberId: "m1" });
  if (!s.ok) throw new Error(s.reason);
  calls = [];
  responses = [200];
  link = null;
  preSend = { ok: true };
  preSendArgs = [];
  now = NOW;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(Object.entries((init.headers || {}) as Record<string, string>)), body: JSON.parse(String(init.body)) });
    const r = responses.shift() ?? 200;
    if (r === "throw") throw new Error("network");
    if (typeof r === "object") return new Response(r.body, { status: r.status });
    return new Response("{}", { status: r });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const deps = (): Partial<LineSendDeps> => ({
  now: () => now,
  getLink: async () => { if (link === "throw") throw new Error("db"); return link; },
  checkLineSendAllowed: async (t) => { preSendArgs.push(t); return preSend; },
});
function tok(replyToken?: string, at = NOW) {
  const t = issueConversationToken({ orgId: ORG, employeeId: EMP, accountId: account.id, surface: "line", conversationType: "dm", conversationId: USER, counterpartyId: USER, replyToken }, at);
  if (!t.ok) throw new Error(t.reason);
  return t.token;
}
const send = (over: Partial<Parameters<typeof sendLineConversationMessage>[0]> = {}) =>
  sendLineConversationMessage({ token: tok(), args: {}, text: "お世話になっております", orgId: ORG, employeeId: EMP, externalSendAllowed: false, retryKey: "0b0a0000-0000-4000-8000-000000000001", ...over }, deps());

describe("target and audience", () => {
  test("linked (internal) counterparty → Push to the pinned userId with the account's own token", async () => {
    link = { status: "active" };
    const r = await send();
    expect(r).toMatchObject({ status: "accepted", audience: "internal", mode: "push", lineAccepted: true });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.line.me/v2/bot/message/push");
    expect(calls[0].body).toEqual({ to: USER, messages: [{ type: "text", text: "お世話になっております" }] });
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].headers["x-line-retry-key"]).toBe("0b0a0000-0000-4000-8000-000000000001");
    expect(preSendArgs).toEqual([{ orgId: ORG, employeeId: EMP, accountId: account.id, counterpartyId: USER, requiresLink: true }]);
  });

  test("not linked → external; refused unless the caller passed approval / policy (default)", async () => {
    const r = await send();
    expect(r).toMatchObject({ status: "not_sent", reason: "external_send_needs_approval", audience: "external" });
    expect(calls).toEqual([]);
    const ok = await send({ externalSendAllowed: true });
    expect(ok).toMatchObject({ status: "accepted", audience: "external", mode: "push", lineAccepted: true });
    expect(preSendArgs.at(-1)).toMatchObject({ requiresLink: false });
  });

  test("an AI argument steering elsewhere → refused, nothing sent", async () => {
    link = { status: "active" };
    const r = await send({ args: { lineUserId: "U" + "b".repeat(32) } });
    expect(r).toMatchObject({ status: "not_sent", reason: "conversation_target_mismatch" });
    expect(calls).toEqual([]);
  });

  test("no token / another employee's token → refused", async () => {
    expect(await send({ token: "" })).toMatchObject({ status: "not_sent", reason: "conversation_token_required" });
    expect(await send({ employeeId: "ec100000-0000-4000-8000-000000000002" })).toMatchObject({ status: "not_sent", reason: "conversation_token_wrong_employee" });
    expect(calls).toEqual([]);
  });

  test("link read failure → refused (never guessed as external or internal)", async () => {
    link = "throw";
    expect(await send({ externalSendAllowed: true })).toMatchObject({ status: "not_sent", reason: "counterparty_link_unavailable" });
    expect(calls).toEqual([]);
  });
});

describe("right-before-send check (checkLineSendAllowed)", () => {
  test("stop / leave / account disabled at send time → not sent, even with an unexpired token", async () => {
    link = { status: "active" };
    for (const reason of ["employee_on_hold", "org_on_hold", "comm_account_inactive", "counterparty_link_removed", "hold_state_unavailable"] as const) {
      preSend = { ok: false, reason };
      expect(await send()).toMatchObject({ status: "not_sent", reason });
    }
    expect(calls).toEqual([]);
  });

  test("the check runs after the secrets are read, as the last step before the API", async () => {
    link = { status: "active" };
    const order: string[] = [];
    const d = deps();
    const r = await sendLineConversationMessage(
      { token: tok(), args: {}, text: "x", orgId: ORG, employeeId: EMP, externalSendAllowed: false, retryKey: "0b0a0000-0000-4000-8000-000000000001" },
      { ...d, readSecrets: async (o, a) => { order.push("secrets"); const { readCommAccountSecretsForServer } = await import("@/lib/comm/accounts"); return readCommAccountSecretsForServer(o, a); },
        checkLineSendAllowed: async () => { order.push("pre_send"); return { ok: true }; } }
    );
    expect(r.status).toBe("accepted");
    expect(order).toEqual(["secrets", "pre_send"]);
  });

  test("secrets unreadable → not sent", async () => {
    link = { status: "active" };
    const r = await sendLineConversationMessage(
      { token: tok(), args: {}, text: "x", orgId: ORG, employeeId: EMP, externalSendAllowed: false, retryKey: "0b0a0000-0000-4000-8000-000000000001" },
      { ...deps(), readSecrets: async () => ({ ok: false, reason: "storage_error" }) }
    );
    expect(r).toMatchObject({ status: "not_sent", reason: "comm_account_secret_unavailable" });
    expect(calls).toEqual([]);
  });

  test("flag OFF → not sent", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    expect(await send()).toMatchObject({ status: "not_sent", reason: "line_conversation_disabled" });
  });
});

describe("Reply first, then Push; sent / not_sent / unknown", () => {
  test("fresh pinned replyToken (< 50 s) → Reply (free); used once only — second send never Push", async () => {
    link = { status: "active" };
    const token = tok("rtok0123456789abcdef");
    now = NOW + 10_000;
    expect(await send({ token })).toMatchObject({ status: "sent", mode: "reply" });
    expect(calls[0].url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(calls[0].body).toEqual({ replyToken: "rtok0123456789abcdef", messages: [{ type: "text", text: "お世話になっております" }] });
    expect(await send({ token, retryKey: "0b0a0000-0000-4000-8000-000000000002" })).toMatchObject({
      status: "unknown",
      reason: "reply_token_already_claimed",
      mode: "reply",
    });
    expect(calls.length).toBe(1);
    expect(calls.some((c) => c.url.includes("/push"))).toBe(false);
  });

  test("claim claimed:false (already in our ledger) → unknown, never Push", async () => {
    link = { status: "active" };
    const r = await sendLineConversationMessage(
      { token: tok("rtok0123456789abcdef"), args: {}, text: "お世話になっております", orgId: ORG, employeeId: EMP, externalSendAllowed: false, retryKey: "0b0a0000-0000-4000-8000-000000000001" },
      { ...deps(), claimReplyToken: async () => ({ ok: true, claimed: false }) }
    );
    expect(r).toMatchObject({ status: "unknown", reason: "reply_token_already_claimed", mode: "reply" });
    expect(calls).toEqual([]);
  });

  test("parallel direct sends of the same token → exactly one LINE API call", async () => {
    link = { status: "active" };
    const token = tok("rtok-parallel-aaaaaaaa");
    const [a, b] = await Promise.all([
      send({ token, retryKey: "0b0a0000-0000-4000-8000-0000000000a1" }),
      send({ token, retryKey: "0b0a0000-0000-4000-8000-0000000000a2" }),
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(calls.some((c) => c.url.includes("/push"))).toBe(false);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["sent", "unknown"]);
    expect([a, b].filter((r) => r.status === "unknown")[0]).toMatchObject({
      reason: "reply_token_already_claimed",
      mode: "reply",
    });
  });

  test("old replyToken (≥ 50 s) → Push", async () => {
    link = { status: "active" };
    const token = tok("rtok0123456789abcdef");
    now = NOW + 50_000;
    expect(await send({ token })).toMatchObject({ status: "accepted", mode: "push", lineAccepted: true });
  });

  test("claim ok:false (ledger unavailable) → not_sent, never Push", async () => {
    link = { status: "active" };
    const r = await sendLineConversationMessage(
      { token: tok("rtok0123456789abcdef"), args: {}, text: "お世話になっております", orgId: ORG, employeeId: EMP, externalSendAllowed: false, retryKey: "0b0a0000-0000-4000-8000-000000000001" },
      { ...deps(), claimReplyToken: async () => ({ ok: false, reason: "storage_error" }) }
    );
    expect(r).toMatchObject({ status: "not_sent", reason: "storage_error" });
    expect(calls).toEqual([]);
  });

  test("Reply refused with 400 (token expired) → falls back to Push", async () => {
    link = { status: "active" };
    responses = [400, 200];
    expect(await send({ token: tok("rtok0123456789abcdef") })).toMatchObject({ status: "accepted", mode: "push", lineAccepted: true });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["reply", "push"]);
  });

  test("Reply with 5xx or a network error → unknown, and NO Push (could double-send)", async () => {
    link = { status: "active" };
    for (const r of [500, "throw"] as const) {
      __resetLineSendForTests();
      calls = [];
      responses = [r];
      expect(await send({ token: tok("rtok0123456789abcdef") })).toMatchObject({ status: "unknown", mode: "reply" });
      expect(calls.length).toBe(1);
    }
  });

  test("Push: 409 with the retry key (already accepted) → accepted, not 届いた; 429 classified by official body; 403 → not_sent; 5xx / network → unknown", async () => {
    link = { status: "active" };
    const cases: Array<[number | "throw" | { status: number; body: string }, string, string | undefined]> = [
      [409, "accepted", undefined],
      [{ status: 429, body: JSON.stringify({ message: "You have reached your monthly limit." }) }, "not_sent", "line_monthly_quota_exceeded"],
      [{ status: 429, body: JSON.stringify({ message: "The API rate limit has been exceeded. Try again later." }) }, "not_sent", "line_rate_limited"],
      [429, "not_sent", "line_not_sent_429"],
      [403, "not_sent", "line_http_4xx"],
      [503, "unknown", "line_http_5xx"],
      ["throw", "unknown", "line_network_error"],
    ];
    for (const [code, status, reason] of cases) {
      responses = [code];
      const r = await send();
      expect(r.status).toBe(status as never);
      if (reason) expect((r as { reason?: string }).reason).toBe(reason);
      if (status === "accepted") expect((r as { lineAccepted?: boolean }).lineAccepted).toBe(true);
    }
  });

  test("U-03: Push 200 is LINE受付 — status accepted, never sent / 届いた", async () => {
    link = { status: "active" };
    const r = await send();
    expect(r).toEqual({ status: "accepted", audience: "internal", mode: "push", lineAccepted: true });
    expect(JSON.stringify(r)).not.toContain("届いた");
    expect(r.status).not.toBe("sent");
  });

  test("U-04: official LINE 429 messages map to quota vs rate; unknown 429 is fail-closed not_sent", () => {
    expect(classifyLine429('{"message":"You have reached your monthly limit."}')).toBe("line_monthly_quota_exceeded");
    expect(classifyLine429("The API rate limit has been exceeded. Try again later.")).toBe("line_rate_limited");
    expect(classifyLine429("{}")).toBe("line_not_sent_429");
    expect(classifyLine429("")).toBe("line_not_sent_429");
    expect(classifyLine429(undefined)).toBe("line_not_sent_429");
  });

  test("text: empty or over 5000 characters → not sent (never truncated silently)", async () => {
    link = { status: "active" };
    expect(await send({ text: "" })).toMatchObject({ status: "not_sent", reason: "invalid_text" });
    expect(await send({ text: "あ".repeat(5001) })).toMatchObject({ status: "not_sent", reason: "invalid_text" });
    expect(calls).toEqual([]);
  });

  test("the message text and the access token are never logged", async () => {
    link = { status: "active" };
    const logs: unknown[] = [];
    const o = { e: console.error, w: console.warn, l: console.log };
    console.error = console.warn = console.log = (...a: unknown[]) => { logs.push(a); };
    try {
      responses = [500];
      await send({ text: "秘密の本文 0901234567" });
      responses = ["throw"];
      await send({ text: "秘密の本文 0901234567", retryKey: "0b0a0000-0000-4000-8000-000000000003" });
    } finally {
      console.error = o.e; console.warn = o.w; console.log = o.l;
    }
    const s = JSON.stringify(logs);
    expect(s).not.toContain("秘密の本文");
    expect(s).not.toContain(TOKEN);
  });
});
