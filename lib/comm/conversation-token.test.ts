/**
 * H2–H4: the server, not the AI, decides where a LINE reply goes and who the
 * counterparty is. At wake the server signs a conversation token that pins
 * org × employee × account × conversation × counterparty × expiry; comm.reply
 * resolves its destination ONLY from that token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONVERSATION_TOKEN_MAX_TTL_SECONDS,
  issueConversationToken,
  resolveConversationTarget,
  verifyConversationToken,
} from "@/lib/comm/conversation-token";

const KEY = "COMM_CONVERSATION_TOKEN_SECRET";
const PREV = "COMM_CONVERSATION_TOKEN_SECRET_PREVIOUS";
const saved = { k: process.env[KEY], p: process.env[PREV] };
beforeEach(() => {
  process.env[KEY] = "c".repeat(48);
  delete process.env[PREV];
});
afterEach(() => {
  for (const [k, v] of [[KEY, saved.k], [PREV, saved.p]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const ACCT = "ec200000-0000-4000-8000-000000000001";
const USER = "U" + "a".repeat(32);
const OTHER = "U" + "b".repeat(32);
const NOW = 1_800_000_000_000;
const base = { orgId: ORG, employeeId: EMP, accountId: ACCT, surface: "line" as const, conversationType: "dm" as const, conversationId: USER, counterpartyId: USER };
const who = { orgId: ORG, employeeId: EMP };

function issue(over: Partial<typeof base> & { ttlSeconds?: number } = {}) {
  const r = issueConversationToken({ ...base, ...over }, NOW);
  if (!r.ok) throw new Error(r.reason);
  return r.token;
}

describe("conversation token (H2–H4)", () => {
  test("round trip: verify returns the pinned destination", () => {
    const t = issue();
    expect(t).toMatch(/^spc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const v = verifyConversationToken(t, who, NOW + 1000);
    expect(v).toEqual({ ok: true, target: { ...base, expiresAt: new Date(NOW + 24 * 3600_000).toISOString() } });
  });

  test("a token is only good for the org AND employee whose credential presents it", () => {
    const t = issue();
    expect(verifyConversationToken(t, { orgId: "ec000000-0000-4000-8000-000000000002", employeeId: EMP }, NOW)).toEqual({ ok: false, reason: "conversation_token_wrong_org" });
    expect(verifyConversationToken(t, { orgId: ORG, employeeId: "ec100000-0000-4000-8000-000000000002" }, NOW)).toEqual({ ok: false, reason: "conversation_token_wrong_employee" });
  });

  test("tampered payload or signature, or a token signed with another key, is refused", () => {
    const t = issue();
    const [p, payload, sig] = t.split(".");
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    body.cp = OTHER;
    body.cid = OTHER;
    const forged = `${p}.${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
    expect(verifyConversationToken(forged, who, NOW)).toEqual({ ok: false, reason: "conversation_token_invalid" });
    const flipped = `${p}.${payload}.${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`;
    expect(verifyConversationToken(flipped, who, NOW)).toEqual({ ok: false, reason: "conversation_token_invalid" });
    process.env[KEY] = "d".repeat(48);
    expect(verifyConversationToken(t, who, NOW)).toEqual({ ok: false, reason: "conversation_token_invalid" });
  });

  test("key rotation: the previous key still verifies; new tokens use the current key", () => {
    const t = issue();
    process.env[PREV] = "c".repeat(48);
    process.env[KEY] = "e".repeat(48);
    expect(verifyConversationToken(t, who, NOW).ok).toBe(true);
    delete process.env[PREV];
    expect(verifyConversationToken(t, who, NOW).ok).toBe(false);
  });

  test("expiry: default 24 h, capped, refused after", () => {
    const t = issue();
    expect(verifyConversationToken(t, who, NOW + 24 * 3600_000 - 1).ok).toBe(true);
    expect(verifyConversationToken(t, who, NOW + 24 * 3600_000 + 1)).toEqual({ ok: false, reason: "conversation_token_expired" });
    const long = issue({ ttlSeconds: 10 * CONVERSATION_TOKEN_MAX_TTL_SECONDS } as never);
    const v = verifyConversationToken(long, who, NOW);
    expect(v.ok && Date.parse(v.target.expiresAt) - NOW).toBe(CONVERSATION_TOKEN_MAX_TTL_SECONDS * 1000);
  });

  test("no / short key fails closed on issue and verify", () => {
    const t = issue();
    process.env[KEY] = "short";
    expect(issueConversationToken(base, NOW)).toEqual({ ok: false, reason: "conversation_token_key_missing" });
    expect(verifyConversationToken(t, who, NOW)).toEqual({ ok: false, reason: "conversation_token_key_missing" });
  });

  test("bad input refused at issue; PoC is 1:1 only (group refused)", () => {
    expect(issueConversationToken({ ...base, counterpartyId: "U123" }, NOW).ok).toBe(false);
    expect(issueConversationToken({ ...base, surface: "slack" as never }, NOW).ok).toBe(false);
    expect(issueConversationToken({ ...base, conversationType: "group", conversationId: "C" + "1".repeat(32) }, NOW)).toEqual({ ok: false, reason: "group_not_supported" });
    // a 1:1 conversation is with its counterparty — nothing else
    expect(issueConversationToken({ ...base, conversationId: OTHER }, NOW)).toEqual({ ok: false, reason: "dm_counterparty_mismatch" });
  });

  test("garbage tokens refused without throwing", () => {
    for (const g of ["", "spc1", "spc1..", "spc0.a.b", "spc1.@@@.b", `spc1.${Buffer.from("[]").toString("base64url")}.${"A".repeat(43)}`, "x".repeat(5000)]) {
      const v = verifyConversationToken(g, who, NOW);
      expect(v.ok).toBe(false);
    }
  });
});

describe("resolveConversationTarget: AI arguments never pick the destination (H2/H3)", () => {
  test("destination and counterparty come from the token", () => {
    const r = resolveConversationTarget({ token: issue(), args: { text: "hi" }, ...who }, NOW);
    expect(r.ok && r.target.conversationId).toBe(USER);
    expect(r.ok && r.target.counterpartyId).toBe(USER);
  });

  test("no token on a non-Slack surface → refused (not sent)", () => {
    expect(resolveConversationTarget({ token: null, args: { lineId: USER }, ...who }, NOW)).toEqual({ ok: false, reason: "conversation_token_required" });
  });

  test("AI-supplied lineId / userId / channel / to that differ from the token are refused, not silently used", () => {
    const t = issue();
    for (const args of [{ lineId: OTHER }, { userId: OTHER }, { user: OTHER }, { channel: OTHER }, { channelId: OTHER }, { to: OTHER }, { groupId: "C" + "1".repeat(32) }]) {
      expect(resolveConversationTarget({ token: t, args, ...who }, NOW)).toEqual({ ok: false, reason: "conversation_target_mismatch" });
    }
  });

  test("the same value as the token is tolerated (AI echoing the id is harmless)", () => {
    const r = resolveConversationTarget({ token: issue(), args: { lineId: USER }, ...who }, NOW);
    expect(r.ok).toBe(true);
  });

  test("an internal-looking AI value cannot make the counterparty internal: the target carries no audience", () => {
    const r = resolveConversationTarget({ token: issue(), args: { audience: "internal", internal: true }, ...who }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.target).sort()).toEqual(
      ["accountId", "conversationId", "conversationType", "counterpartyId", "employeeId", "expiresAt", "orgId", "surface"]
    );
  });
});
