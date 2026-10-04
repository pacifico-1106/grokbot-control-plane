import { afterEach, describe, expect, test } from "bun:test";
import {
  isSlackDmReplyInlineEnabled,
  isSlackDmReplyTarget,
  resolveSlackDmInlineThreadTs,
} from "@/lib/slack/dm-reply-inline";

const FLAG = "SLACK_DM_REPLY_INLINE_ENABLED";
const saved = process.env[FLAG];
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("SLACK_DM_REPLY_INLINE_ENABLED", () => {
  test("default OFF; accepts the usual truthy values", () => {
    delete process.env[FLAG];
    expect(isSlackDmReplyInlineEnabled()).toBe(false);
    for (const v of ["true", "1", "on", "enabled"]) {
      process.env[FLAG] = v;
      expect(isSlackDmReplyInlineEnabled()).toBe(true);
    }
    process.env[FLAG] = "false";
    expect(isSlackDmReplyInlineEnabled()).toBe(false);
  });
});

describe("isSlackDmReplyTarget", () => {
  test("D… channel id is a DM", () => {
    expect(isSlackDmReplyTarget({ channelId: "D0C2QP30VH6" })).toBe(true);
  });
  test("channel_type im (conversation or args) is a DM when the destination is not a C/G channel", () => {
    expect(isSlackDmReplyTarget({ channelId: "U07TXD9FVB8", conversation: { channel_type: "im" } })).toBe(true);
    expect(isSlackDmReplyTarget({ channelId: "U07TXD9FVB8", args: { channelType: "im" } })).toBe(true);
  });
  test("C/G channels are never DMs, even if a client claims channel_type im", () => {
    expect(isSlackDmReplyTarget({ channelId: "C_INTERNAL" })).toBe(false);
    expect(isSlackDmReplyTarget({ channelId: "G123", conversation: { channel_type: "im" } })).toBe(false);
    expect(isSlackDmReplyTarget({ channelId: "C_INTERNAL", conversation: { channelType: "im" } })).toBe(false);
  });
  test("empty destination is not a DM", () => {
    expect(isSlackDmReplyTarget({ channelId: "" })).toBe(false);
  });
});

describe("resolveSlackDmInlineThreadTs", () => {
  const ts = "1791000001.111111";
  const parent = "1791000000.000100";
  test("top-level DM message → no thread", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { ts, thread_ts: null } })).toEqual({ threadTs: undefined, source: "none" });
  });
  test("thread_ts equal to ts → no thread", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { ts, thread_ts: ts } }).threadTs).toBeUndefined();
  });
  test("messageTs-only fallback is not a thread", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { messageTs: ts } }).threadTs).toBeUndefined();
    // parsed ConversationContext shape: threadId already holds the messageTs fallback
    expect(resolveSlackDmInlineThreadTs({ conversation: { threadId: ts, messageTs: ts } }).threadTs).toBeUndefined();
  });
  test("message inside a thread (thread_ts ≠ ts) → that thread", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { ts, thread_ts: parent } })).toEqual({ threadTs: parent, source: "client" });
    expect(resolveSlackDmInlineThreadTs({ conversation: { threadId: parent, ts } }).threadTs).toBe(parent);
    expect(resolveSlackDmInlineThreadTs({ conversation: { ts }, args: { thread_ts: parent } }).threadTs).toBe(parent);
  });
  test("explicit thread_ts without a message ts is kept (cannot tell, respect the client)", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { thread_ts: parent } }).threadTs).toBe(parent);
  });
  test("messageTs fallback is not a thread even when ts and messageTs differ", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { ts, messageTs: parent } }).threadTs).toBeUndefined();
  });
  test("non-Slack-ts values are ignored", () => {
    expect(resolveSlackDmInlineThreadTs({ conversation: { ts, thread_ts: "thread-abc" } }).threadTs).toBeUndefined();
  });
});
