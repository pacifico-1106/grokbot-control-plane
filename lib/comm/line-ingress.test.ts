/**
 * L-4: per-employee LINE webhook (design §2-4, §2-6, §5; H7, H10, H11).
 * ref → ACTIVE account → that account's channel secret → signature → JSON →
 * destination check → per event: webhookEventId dedup, stale drop, 1:1 only,
 * emergency-stop check (phase "wake") → dispatch. The org and employee come from
 * the account row only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createCommAccount, resetDemoCommAccounts, setCommAccountSecrets, type CommAccount } from "@/lib/comm/accounts";
import { handleLineAccountWebhook, type NormalizedLineEvent } from "@/lib/comm/line-ingress";
import type { OperableResult } from "@/lib/safety/hold";

const ENV = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const BOT = "U" + "1".repeat(32);
const USER = "U" + "a".repeat(32);
const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;

let account: CommAccount;
let dispatched: NormalizedLineEvent[];
let holdCalls: Array<{ orgId?: string | null; employeeId?: string | null; phase: string }>;
let hold: OperableResult | "throw";

beforeEach(async () => {
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  resetDemoCommAccounts();
  const r = await createCommAccount({ orgId: ORG, employeeId: EMP, surface: "line", externalAccountId: BOT, createdByMemberId: "m1" });
  if (!r.ok) throw new Error(r.reason);
  account = r.account;
  const s = await setCommAccountSecrets({ orgId: ORG, accountId: account.id, secrets: { channelAccessToken: "A".repeat(120), channelSecret: SECRET }, memberId: "m1" });
  if (!s.ok) throw new Error(s.reason);
  dispatched = [];
  holdCalls = [];
  hold = { ok: true };
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const deps = () => ({
  now: () => NOW,
  checkOperable: async (i: { orgId?: string | null; employeeId?: string | null; phase: "wake" }) => {
    holdCalls.push(i);
    if (hold === "throw") throw new Error("db down");
    return hold;
  },
  dispatch: async (e: NormalizedLineEvent) => { dispatched.push(e); },
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
const sig = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("base64");
async function call(raw: string, signature = sig(raw), ref = account.webhookRef) {
  return handleLineAccountWebhook({ ref, rawBody: raw, signature }, deps());
}

describe("before any event is read", () => {
  test("LINE conversation flag OFF → 404, nothing dispatched", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const raw = body([ev()]);
    expect((await call(raw)).status).toBe(404);
    expect(dispatched).toEqual([]);
  });

  test("unknown / malformed ref → 404", async () => {
    const raw = body([ev()]);
    expect((await call(raw, sig(raw), "x".repeat(43))).status).toBe(404);
    expect((await call(raw, sig(raw), "../etc")).status).toBe(404);
  });

  test("bad signature → 401 and nothing recorded (the real delivery still goes through once)", async () => {
    const raw = body([ev()]);
    expect((await call(raw, sig(raw, "f".repeat(32)))).status).toBe(401);
    expect((await call(raw, "")).status).toBe(401);
    expect(dispatched).toEqual([]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched.length).toBe(1);
  });

  test("signed body for another bot (destination mismatch) → 401", async () => {
    const raw = body([ev()], "U" + "9".repeat(32));
    expect((await call(raw)).status).toBe(401);
    expect(dispatched).toEqual([]);
  });

  test("invalid JSON after a valid signature → 400", async () => {
    const raw = "{not json";
    expect((await call(raw)).status).toBe(400);
  });
});

describe("events", () => {
  test("1:1 text → dispatched once; org / employee / account from the account row, not the body", async () => {
    const raw = body([ev({ orgId: "ec000000-0000-4000-8000-0000000000ff", employeeId: "x" })]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched).toEqual([{
      orgId: ORG, employeeId: EMP, accountId: account.id, surface: "line", conversationType: "dm",
      conversationId: USER, senderId: USER, text: "こんにちは", eventKey: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
      replyToken: "rt-1", receivedAt: new Date(NOW).toISOString(),
    }]);
    expect(holdCalls).toEqual([{ orgId: ORG, employeeId: EMP, phase: "wake" }]);
  });

  test("redelivery of the same webhookEventId → not dispatched again (still 200)", async () => {
    const raw = body([ev()]);
    await call(raw);
    const again = body([ev({ deliveryContext: { isRedelivery: true } })]);
    expect((await call(again)).status).toBe(200);
    expect(dispatched.length).toBe(1);
  });

  test("no webhookEventId → never processed (H7)", async () => {
    const raw = body([ev({ webhookEventId: undefined })]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched).toEqual([]);
  });

  test("stale (> 1 h, not a redelivery) or from the future (> 10 min) → dropped; an old redelivery is processed", async () => {
    await call(body([ev({ timestamp: NOW - 3600_000 - 1, webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ2" })]));
    await call(body([ev({ timestamp: NOW + 600_001, webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ3" })]));
    expect(dispatched).toEqual([]);
    await call(body([ev({ timestamp: NOW - 3 * 3600_000, webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ4", deliveryContext: { isRedelivery: true } })]));
    expect(dispatched.map((e) => e.eventKey)).toEqual(["01HZZZZZZZZZZZZZZZZZZZZZZ4"]);
  });

  test("groups / rooms / non-text / standby mode are not dispatched in the PoC", async () => {
    await call(body([
      ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ5", source: { type: "group", groupId: "C" + "1".repeat(32), userId: USER } }),
      ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ6", source: { type: "room", roomId: "R" + "1".repeat(32), userId: USER } }),
      ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ7", message: { type: "image", id: "m2" } }),
      ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ8", mode: "standby" }),
      ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ9", type: "follow", message: undefined }),
    ]));
    expect(dispatched).toEqual([]);
  });

  test("employee on hold → not dispatched, and not woken later (the event is consumed)", async () => {
    hold = { ok: false, code: "employee_on_hold", holdId: "h1", kind: "stopped" };
    const raw = body([ev()]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched).toEqual([]);
    hold = { ok: true };
    await call(body([ev({ deliveryContext: { isRedelivery: true } })]));
    expect(dispatched).toEqual([]);
  });

  test("hold state unknown or the check throws → not dispatched (fail stop)", async () => {
    hold = { ok: false, code: "hold_state_unavailable", holdId: null, kind: null };
    await call(body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZA" })]));
    hold = "throw";
    await call(body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZB" })]));
    expect(dispatched).toEqual([]);
  });

  test("a message that is a link code is never dispatched to the AI", async () => {
    await call(body([ev({ message: { type: "text", id: "m3", text: "SP-ABCD-EFGH" } })]));
    expect(dispatched).toEqual([]);
  });

  test("a dispatch error does not fail the webhook (no LINE retry storm) and is not re-run", async () => {
    const d = deps();
    d.dispatch = async () => { throw new Error("wake failed"); };
    const raw = body([ev()]);
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: raw, signature: sig(raw) }, d)).status).toBe(200);
  });

  test("too many events in one body → only the first 100 are looked at", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ev({ webhookEventId: `01HZZZZZZZZZZZZZZZZZZ${String(i).padStart(5, "0")}` }));
    await call(body(many));
    expect(dispatched.length).toBe(100);
  });
});
