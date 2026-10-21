/**
 * L-4: per-employee LINE webhook (design §2-4, §2-6, §5; H7, H10, H11).
 * ref → ACTIVE account → that account's channel secret → signature → JSON →
 * destination check → per event: webhookEventId dedup, stale drop, 1:1 only,
 * emergency-stop check (phase "wake") → dispatch. The org and employee come from
 * the account row only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createCommAccount, listCommAccounts, resetDemoCommAccounts, setCommAccountSecrets, type CommAccount } from "@/lib/comm/accounts";
import { handleLineAccountWebhook, type NormalizedLineEvent } from "@/lib/comm/line-ingress";
import type { OperableResult } from "@/lib/safety/hold";
import { __resetHoldAuditThrottleForTests, __setHoldReaderForTests } from "@/lib/safety/hold";
import { verifyConversationToken } from "@/lib/comm/conversation-token";

const ENV = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "LINE_CONVERSATION_ORG_IDS", "COMM_ACCOUNTS_ORG_IDS", "NOTIFICATION_CONFIG_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "COMM_CONVERSATION_TOKEN_SECRET", "COMM_CONVERSATION_TOKEN_SECRET_PREVIOUS"] as const;
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
const origFetch = globalThis.fetch;

beforeEach(async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "k".repeat(40);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.COMM_CONVERSATION_TOKEN_SECRET = "t".repeat(48);
  delete process.env.COMM_CONVERSATION_TOKEN_SECRET_PREVIOUS;
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
  globalThis.fetch = origFetch;
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
  return handleLineAccountWebhook({ ref, rawBody: new TextEncoder().encode(raw), signature }, deps());
}

describe("rawBody is Uint8Array only", () => {
  test("handleLineAccountWebhook type and source reject a string body path", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "lib/comm/line-ingress.ts"), "utf8");
    expect(src).toMatch(/rawBody:\s*Uint8Array/);
    expect(src).not.toMatch(/rawBody:\s*Uint8Array\s*\|\s*string/);
    expect(src).not.toMatch(/typeof input\.rawBody === ["']string["']/);
  });
});

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

  test("signed body for another bot (destination mismatch) → 403 (U-12)", async () => {
    const raw = body([ev()], "U" + "9".repeat(32));
    const r = await call(raw);
    expect(r).toEqual({ status: 403, body: { ok: false, error: "destination_mismatch" } });
    expect(dispatched).toEqual([]);
  });

  test("signed body with missing destination → 400 (U-12 / LP-UNK-07)", async () => {
    const raw = JSON.stringify({ events: [ev()] });
    const r = await call(raw);
    expect(r).toEqual({ status: 400, body: { ok: false, error: "destination_missing" } });
    expect(dispatched).toEqual([]);
    const empty = JSON.stringify({ destination: "", events: [ev()] });
    expect(await call(empty)).toEqual({ status: 400, body: { ok: false, error: "destination_missing" } });
    const nul = JSON.stringify({ destination: null, events: [ev()] });
    expect(await call(nul)).toEqual({ status: 400, body: { ok: false, error: "destination_missing" } });
  });

  test("L3: destination refuse does not write the inbound ledger", async () => {
    const miss = JSON.stringify({ events: [ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZLEDG1" })] });
    expect((await call(miss)).status).toBe(400);
    const mismatch = body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZLEDG1" })], "U" + "9".repeat(32));
    expect((await call(mismatch)).status).toBe(403);
    const ok = body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZLEDG1" })]);
    expect((await call(ok)).status).toBe(200);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.eventKey).toBe("01HZZZZZZZZZZZZZZZZZZLEDG1");
  });

  test("invalid JSON after a valid signature → 400", async () => {
    const raw = "{not json";
    expect((await call(raw)).status).toBe(400);
  });
});

describe("events", () => {
  test("COMM_CONVERSATION_TOKEN_SECRET missing + flag ON → no wake (fail-closed)", async () => {
    delete process.env.COMM_CONVERSATION_TOKEN_SECRET;
    const raw = body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZTOK1" })]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched).toEqual([]);
  });

  test("1:1 text → dispatched once; org / employee / account from the account row, not the body", async () => {
    const raw = body([ev({ orgId: "ec000000-0000-4000-8000-0000000000ff", employeeId: "x" })]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched).toEqual([{
      orgId: ORG, employeeId: EMP, accountId: account.id, surface: "line", conversationType: "dm",
      conversationId: USER, senderId: USER, text: "こんにちは", eventKey: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
      replyToken: "rt-1", receivedAt: new Date(NOW).toISOString(),
      conversationToken: dispatched[0]?.conversationToken, conversationTokenExpiresAt: new Date(NOW + 24 * 3600_000).toISOString(),
    }]);
    expect(typeof dispatched[0]?.conversationToken).toBe("string");
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
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(raw), signature: sig(raw) }, d)).status).toBe(200);
  });

  test("too many events in one body → only the first 100 are looked at", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ev({ webhookEventId: `01HZZZZZZZZZZZZZZZZZZ${String(i).padStart(5, "0")}` }));
    await call(body(many));
    expect(dispatched.length).toBe(100);
  });
});

describe("conversation token per counterparty message (木村 10/12)", () => {
  test("each new message gets a NEW token pinned to this org × employee × account × sender, 24 h", async () => {
    await call(body([ev()]));
    await call(body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ2", timestamp: NOW - 500 })]));
    expect(dispatched.length).toBe(2);
    const [a, b] = dispatched;
    expect(a.conversationToken).toBeTruthy();
    expect(a.conversationToken).not.toBe(b.conversationToken);
    for (const e of [a, b]) {
      const v = verifyConversationToken(e.conversationToken, { orgId: ORG, employeeId: EMP }, NOW);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.target).toMatchObject({ orgId: ORG, employeeId: EMP, accountId: account.id, conversationId: USER, counterpartyId: USER });
        expect(Date.parse(v.target.expiresAt) - NOW).toBe(24 * 3600_000);
      }
      expect(e.conversationTokenExpiresAt).toBe(new Date(NOW + 24 * 3600_000).toISOString());
    }
  });

  test("no token key → not woken (a wake without a token could not be answered safely); logged without the body", async () => {
    delete process.env.COMM_CONVERSATION_TOKEN_SECRET;
    const logs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logs.push(a); };
    try {
      expect((await call(body([ev()]))).status).toBe(200);
    } finally {
      console.error = orig;
    }
    expect(dispatched).toEqual([]);
    expect(JSON.stringify(logs)).toContain("line_wake_token_unavailable");
    expect(JSON.stringify(logs)).not.toContain("こんにちは");
  });
});

describe("emergency stop / leave at wake, with the real hold check", () => {
  test("employee on leave or stopped, or the org stopped → not woken (no token issued)", async () => {
    const real = { ...deps() } as Record<string, unknown>;
    delete real.checkOperable;
    for (const [emp, org] of [["leave", null], ["stopped", null], [null, "stopped"]] as const) {
      __setHoldReaderForTests({
        employee: async () => ({ state: "found", orgId: ORG, holdState: emp, holdId: emp ? "h1" : null }),
        org: async () => ({ state: "found", orgId: ORG, holdState: org, holdId: org ? "h2" : null }),
      });
      const raw = body([ev({ webhookEventId: `01HZZZZZZZZZZZZZZZZZZZZZ${emp ?? org}`.slice(0, 26) })]);
      await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(raw), signature: sig(raw) }, real as never);
    }
    __setHoldReaderForTests(null);
    expect(dispatched).toEqual([]);
  });
});

describe("U-06 same OA / U-19 hold: approval postback vs wake", () => {
  test("postback is dispatched even when the employee is held; wake is not", async () => {
    const approvals: Array<{ kind: string; type?: string }> = [];
    hold = { ok: false, code: "employee_on_hold", holdId: "h1", kind: "stopped" };
    const d = {
      ...deps(),
      dispatchApproval: async (_a: CommAccount, ev: { type?: string }, kind: string) => {
        approvals.push({ kind, type: ev.type });
        return true;
      },
    };
    const raw = body([ev({
      type: "postback",
      message: undefined,
      postback: { data: "a:aprvref01" },
      webhookEventId: "01HZZZZZZZZZZZZZZZZZZPOST",
    })]);
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(raw), signature: sig(raw) }, d)).status).toBe(200);
    expect(approvals).toEqual([{ kind: "postback", type: "postback" }]);
    expect(dispatched).toEqual([]);
    expect(holdCalls).toEqual([]);
  });

  test("1:1 text on hold is not woken and is not treated as a postback", async () => {
    hold = { ok: false, code: "employee_on_hold", holdId: "h1", kind: "stopped" };
    const raw = body([ev()]);
    expect((await call(raw)).status).toBe(200);
    expect(dispatched).toEqual([]);
  });

  test("M3: postback uses the LINE approval channel of the same OA, not the first channel", async () => {
    const { selectSameOaLineApprovalChannel } = await import("@/lib/comm/line-ingress");
    const other = {
      id: "ch-other", orgId: ORG, provider: "line" as const, enabled: true, isDefault: true,
      label: "other", config: { destinationId: "U" + "9".repeat(32) }, webhookRef: "w1",
      hasCredentials: true, webhookPath: "/x", createdAt: "", updatedAt: "", secrets: {},
    };
    const same = {
      ...other, id: "ch-same", isDefault: false, config: { destinationId: BOT },
    };
    expect(selectSameOaLineApprovalChannel(account, [other, same])?.id).toBe("ch-same");
    expect(selectSameOaLineApprovalChannel(account, [other])).toBeNull();
    const src = await import("node:fs").then((fs) => fs.readFileSync("lib/comm/line-ingress.ts", "utf8"));
    expect(src).not.toMatch(/const channel = channels\.find\(\(c\) => c\.provider === "line"\)/);
  });

  test("U-09: org not on LINE_CONVERSATION_ORG_IDS → 404, no dispatch", async () => {
    process.env.LINE_CONVERSATION_ORG_IDS = "aaaaaaaa-0000-4000-8000-000000000307";
    const raw = body([ev()]);
    expect((await call(raw)).status).toBe(404);
    expect(dispatched).toEqual([]);
    delete process.env.LINE_CONVERSATION_ORG_IDS;
  });
});

describe("U-02 unfollow unlink", () => {
  test("unfollow revokes that user only, does not wake, account stays active (LP-UNF-01)", async () => {
    const links = new Map<string, { status: string }>([[USER, { status: "active" }]]);
    const d = {
      ...deps(),
      getLink: async (_o: string, _k: string, userId: string) => links.get(userId) ?? null,
      revokeLink: async (_o: string, _k: string, userId: string) => {
        links.set(userId, { status: "revoked" });
      },
      forgetRevokedLink: async (_o: string, _k: string, userId: string) => {
        if (links.get(userId)?.status === "revoked") links.delete(userId);
      },
    };
    const raw = body([ev({ type: "unfollow", message: undefined, webhookEventId: "01HZZZZZZZZZZZZZZZZZZUNF1" })]);
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(raw), signature: sig(raw) }, d)).status).toBe(200);
    expect(dispatched).toEqual([]);
    expect(links.get(USER)).toEqual({ status: "revoked" });
    const rows = await listCommAccounts(ORG);
    const after = rows.find((r) => r.id === account.id);
    expect(after?.status).toBe("active");
    expect(after?.status).not.toBe("disabled");
  });

  test("after unfollow, 1:1 text does not wake (LP-UNF-03)", async () => {
    const links = new Map<string, { status: string }>([[USER, { status: "revoked" }]]);
    const d = {
      ...deps(),
      getLink: async (_o: string, _k: string, userId: string) => links.get(userId) ?? null,
    };
    const raw = body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZUNF2" })]);
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(raw), signature: sig(raw) }, d)).status).toBe(200);
    expect(dispatched).toEqual([]);
  });

  test("M2: unfollow revoke failure returns 500 and is not consumed", async () => {
    let attempts = 0;
    const d = {
      ...deps(),
      revokeLink: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("binding_store_down");
      },
    };
    const raw = body([ev({ type: "unfollow", message: undefined, webhookEventId: "01HZZZZZZZZZZZZZZZZZZUNF5" })]);
    const first = await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(raw), signature: sig(raw) }, d);
    expect(first.status).toBe(500);
    expect(first.body).toMatchObject({ ok: false });
    expect(dispatched).toEqual([]);
    const again = body([ev({ type: "unfollow", message: undefined, webhookEventId: "01HZZZZZZZZZZZZZZZZZZUNF5", deliveryContext: { isRedelivery: true } })]);
    const second = await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(again), signature: sig(again) }, d);
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("re-follow does not restore the link; later text wakes as unlinked (LP-UNF-04)", async () => {
    const links = new Map<string, { status: string }>([[USER, { status: "revoked" }]]);
    const d = {
      ...deps(),
      getLink: async (_o: string, _k: string, userId: string) => links.get(userId) ?? null,
      forgetRevokedLink: async (_o: string, _k: string, userId: string) => {
        if (links.get(userId)?.status === "revoked") links.delete(userId);
      },
    };
    const follow = body([ev({ type: "follow", message: undefined, webhookEventId: "01HZZZZZZZZZZZZZZZZZZFOL1" })]);
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(follow), signature: sig(follow) }, d)).status).toBe(200);
    expect(dispatched).toEqual([]);
    expect(links.has(USER)).toBe(false);
    const text = body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZFOL2" })]);
    expect((await handleLineAccountWebhook({ ref: account.webhookRef, rawBody: new TextEncoder().encode(text), signature: sig(text) }, d)).status).toBe(200);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.senderId).toBe(USER);
  });
});

describe("no message body is stored (§7 decision 6)", () => {
  test("the inbound ledger keeps the event key only; audit rows and logs never carry the text", async () => {
    const audits: unknown[] = [];
    const logs: unknown[] = [];
    const { __setAuditSinkForTests } = await import("@/lib/comm/line-ingress");
    __resetHoldAuditThrottleForTests();
    __setAuditSinkForTests(async (e) => { audits.push(e); });
    const origE = console.error, origW = console.warn, origL = console.log;
    console.error = (...a: unknown[]) => { logs.push(a); };
    console.warn = console.error;
    console.log = console.error;
    try {
      hold = { ok: false, code: "employee_on_hold", holdId: "h1", kind: "leave" } as never;
      await call(body([ev({ message: { type: "text", id: "m9", text: "秘密の本文 0901234567" } })]));
      hold = { ok: true };
      await call(body([ev({ webhookEventId: "01HZZZZZZZZZZZZZZZZZZZZZZ8", message: { type: "text", id: "m8", text: "秘密の本文 0901234567" } })]));
    } finally {
      console.error = origE; console.warn = origW; console.log = origL;
      __setAuditSinkForTests(null);
    }
    const { __demoInboundEventsForTests } = await import("@/lib/comm/accounts");
    const stored = JSON.stringify({ audits, logs, events: __demoInboundEventsForTests() });
    expect(stored).not.toContain("秘密の本文");
    expect(stored).not.toContain("0901234567");
    expect(audits.length).toBeGreaterThan(0); // the suppressed wake was audited, without the body
  });
});

