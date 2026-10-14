/**
 * L-7 wiring: the per-employee LINE webhook's default dispatch wakes the AI
 * employee; a link code on that same 1:1 is redeemed (never handed to the AI).
 * Flag LINE_CONVERSATION_ENABLED default OFF. No message body is stored.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createCommAccount, resetDemoCommAccounts, setCommAccountSecrets, type CommAccount } from "@/lib/comm/accounts";

const wakes: unknown[] = [];
const links: Array<{ orgId: string; accountId: string; text: string; lineUserId: string; replyToken?: string | null }> = [];
mock.module("@/lib/comm/line-wake", () => ({
  dispatchLineConversationWake: async (e: unknown) => { wakes.push(e); },
}));
mock.module("@/lib/comm/line-link", () => ({
  redeemConversationLinkCode: async (i: { orgId: string; accountId: string; employeeId?: string; text: string; lineUserId: string; replyToken?: string | null }) => {
    links.push(i);
    return { handled: true, bound: true };
  },
}));

const { handleLineAccountWebhook } = await import("@/lib/comm/line-ingress");

const ENV = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "COMM_CONVERSATION_TOKEN_SECRET"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const BOT = "U" + "1".repeat(32);
const USER = "U" + "a".repeat(32);
const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;

let account: CommAccount;

beforeEach(async () => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  process.env.COMM_CONVERSATION_TOKEN_SECRET = "t".repeat(48);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  resetDemoCommAccounts();
  wakes.length = 0;
  links.length = 0;
  const r = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
  if (!r.ok) throw new Error(r.reason);
  account = r.account;
  const s = await setCommAccountSecrets({ orgId: ORG, accountId: account.id, secrets: { channelAccessToken: "A".repeat(120), channelSecret: SECRET }, memberId: "m1" });
  if (!s.ok) throw new Error(s.reason);
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function ev(over: Record<string, unknown> = {}) {
  return {
    type: "message", mode: "active", timestamp: NOW - 1000, webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
    deliveryContext: { isRedelivery: false }, replyToken: "rt-1",
    source: { type: "user", userId: USER }, message: { type: "text", id: "m1", text: "こんにちは" },
    ...over,
  };
}
function body(events: unknown[], destination = BOT) { return JSON.stringify({ destination, events }); }
const sig = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("base64");
async function call(raw: string) {
  return handleLineAccountWebhook({ ref: account.webhookRef, rawBody: raw, signature: sig(raw) }, { now: () => NOW });
}

describe("default dispatch (L-7)", () => {
  test("source: default dispatch is dispatchLineConversationWake; link codes go to redeemConversationLinkCode", () => {
    const src = readFileSync(join(process.cwd(), "lib/comm/line-ingress.ts"), "utf8");
    expect(src).toMatch(/dispatch:\s*\(?e\)?\s*=>\s*dispatchLineConversationWake/);
    expect(src).toContain("redeemConversationLinkCode(");
    expect(src).not.toMatch(/dispatch:\s*async\s*\(\)\s*=>\s*undefined/);
  });

  test("1:1 text with no deps.dispatch → the employee is woken (token + text, no custom stub)", async () => {
    const raw = body([ev()]);
    expect((await call(raw)).status).toBe(200);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      orgId: ORG,
      employeeId: EMP,
      accountId: account.id,
      conversationId: USER,
      senderId: USER,
      text: "こんにちは",
      eventKey: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
    });
    expect(typeof (wakes[0] as { conversationToken: string }).conversationToken).toBe("string");
    expect(links).toEqual([]);
  });

  test("hold / leave → link code is not redeemed (checkOperable before redeem)", async () => {
    const raw = body([ev({ message: { type: "text", id: "m3", text: "SP-ABCD-EFGH" } })]);
    const res = await handleLineAccountWebhook(
      { ref: account.webhookRef, rawBody: raw, signature: sig(raw) },
      {
        now: () => NOW,
        checkOperable: async () => ({ ok: false, code: "hold_state_unavailable", holdId: null, kind: null }),
      }
    );
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
    expect(links).toEqual([]);
  });

  test("a link code on the employee's own LINE is redeemed, never woken", async () => {
    const raw = body([ev({ message: { type: "text", id: "m3", text: "SP-ABCD-EFGH" } })]);
    expect((await call(raw)).status).toBe(200);
    expect(wakes).toEqual([]);
    expect(links).toEqual([
      { orgId: ORG, accountId: account.id, employeeId: EMP, text: "SP-ABCD-EFGH", lineUserId: USER, replyToken: "rt-1" },
    ]);
  });

  test("flag OFF → 404; nothing woken and no code redeemed", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const raw = body([ev()]);
    expect((await call(raw)).status).toBe(404);
    expect(wakes).toEqual([]);
    expect(links).toEqual([]);
  });
});
