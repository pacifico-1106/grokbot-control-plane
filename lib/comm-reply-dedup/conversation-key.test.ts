/**
 * Channel-independent conversation key: surface + destination (+ thread for
 * group conversations). Same key from the gateway request and from the
 * approval snapshot. Keyed hash only — raw ids never appear in the key.
 */
import { describe, expect, test } from "bun:test";
import {
  conversationKey,
  conversationKeyInputFromBody,
  conversationKeyInputFromSnapshot,
} from "./conversation-key";
import { buildInvokeSnapshot } from "@/lib/approvals/fulfill";
import type { GatewayInvokeRequest } from "@/lib/types";

const KEY = Buffer.from("test-only-comm-reply-dedup-key-0123456789", "utf8");
const ORG = "org_key_a";
const ORG_B = "org_key_b";

function body(conversation: Record<string, unknown>, args: Record<string, unknown> = {}): GatewayInvokeRequest {
  return { tool: "comm.reply", purpose: "comm.internal", jobId: "j", conversation, args: { text: "x", ...args } } as GatewayInvokeRequest;
}
const keyOf = (b: GatewayInvokeRequest, org = ORG) => {
  const input = conversationKeyInputFromBody(b, org);
  return input ? conversationKey(input, KEY) : null;
};

describe("conversation key", () => {
  test("Slack channel: different threads are different conversations", () => {
    const a = keyOf(body({ surface: "slack", slackChannelId: "C0CHAN", threadId: "1787911797.000001" }));
    const b = keyOf(body({ surface: "slack", slackChannelId: "C0CHAN", threadId: "1787911797.000002" }));
    const top = keyOf(body({ surface: "slack", slackChannelId: "C0CHAN" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(top);
    expect(keyOf(body({ surface: "slack", slackChannelId: "C0CHAN", threadId: "1787911797.000001" }))).toBe(a);
  });

  test("Slack DM (D…): 1:1, so thread vs main flow is the same conversation", () => {
    const main = keyOf(body({ surface: "slack", slackChannelId: "D0C1UE4A14X", slackUserId: "U0PEER" }));
    const thread = keyOf(body({ surface: "slack", slackChannelId: "D0C1UE4A14X", slackUserId: "U0PEER", threadId: "1787911797.000001" }));
    expect(main).toBe(thread);
  });

  test("LINE and Telegram destinations have keys; surfaces never collide", () => {
    const line = keyOf(body({ surface: "line", lineId: "U1234567890abcdef" }));
    const lineGroup1 = keyOf(body({ surface: "line", lineId: "C1234567890abcdef", threadId: "t1" }));
    const lineGroup2 = keyOf(body({ surface: "line", lineId: "C1234567890abcdef", threadId: "t2" }));
    const tg = keyOf(body({ surface: "telegram", telegramChatId: "123456789" }));
    const tgArgs = keyOf(body({ surface: "telegram" }, { chatId: "123456789" }));
    const tgGroupA = keyOf(body({ surface: "telegram", telegramChatId: "-100200300", telegramThreadId: "7" }));
    const tgGroupB = keyOf(body({ surface: "telegram", telegramChatId: "-100200300", telegramThreadId: "8" }));
    const slackSameId = keyOf(body({ surface: "slack", slackChannelId: "U1234567890abcdef" }));
    for (const k of [line, lineGroup1, tg, tgGroupA]) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(tg).toBe(tgArgs);
    expect(lineGroup1).not.toBe(lineGroup2);
    expect(tgGroupA).not.toBe(tgGroupB);
    expect(line).not.toBe(slackSameId);
  });

  test("org is part of the key; raw ids are not readable from it", () => {
    const a = keyOf(body({ surface: "slack", slackChannelId: "C0SHARED" }), ORG);
    const b = keyOf(body({ surface: "slack", slackChannelId: "C0SHARED" }), ORG_B);
    expect(a).not.toBe(b);
    expect(a?.includes("C0SHARED")).toBe(false);
  });

  test("no destination → no key (dedup is skipped, not guessed)", () => {
    expect(keyOf(body({ surface: "slack" }))).toBeNull();
  });

  test("approval snapshot gives the same key as the original request", () => {
    for (const conv of [
      { surface: "slack", orgId: ORG, slackChannelId: "D0C1UE4A14X", slackUserId: "U0PEER" },
      { surface: "slack", orgId: ORG, slackChannelId: "C0CHAN", threadId: "1787911797.000001" },
      { surface: "line", orgId: ORG, lineId: "U1234567890abcdef" },
    ]) {
      const b = body(conv);
      const snap = buildInvokeSnapshot({ tool: "comm.send", purpose: "comm.internal", jobId: "j", employeeId: "e", orgId: ORG, body: b });
      const fromSnap = conversationKeyInputFromSnapshot(snap, ORG);
      expect(fromSnap ? conversationKey(fromSnap, KEY) : null).toBe(keyOf(b));
    }
  });
});
