/**
 * Duplicate post guard v2 (DUPLICATE_GUARD_V2_ENABLED, default OFF) — unit rules.
 *  (1) longer default window; same jobId → once (job key)
 *  (2) channel-level key: top-level and thread posts in one channel compare
 *  (3) cross-employee: v1 warns, v2 blocks by default (env may choose warn)
 *  (4) short bodies: v2 normalization (mentions / emoji / shortcodes / width)
 *      and the short-body tier (exact only, same thread, short window)
 *  (5) failed post → kept unless the provider confirms it never went out
 *  (6) every outbound-send tool has a posting-path inventory decision
 * Dummy values only; no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  commReplyDedupSettings,
  COMM_REPLY_DEDUP_DEFAULTS,
} from "./config";
import { fingerprintReplyBody, normalizeReplyBody, normalizeReplyBodyV2 } from "./fingerprint";
import { channelKey, conversationKey, conversationKeyInputFromBody } from "./conversation-key";
import { failedPostOutcome, sendTierOf } from "./guard";
import { POSTING_PATH_INVENTORY, DUPLICATE_GUARDED_TOOL_IDS } from "./inventory";
import { isCommReplyDedupEnabled, isDuplicateGuardV2Enabled } from "@/lib/feature-flags";
import { OUTBOUND_SEND_TOOL_IDS, isDuplicateGuardedTool } from "@/lib/gateway/tools";
import type { GatewayInvokeRequest } from "@/lib/types";

const KEY = Buffer.from("test-only-duplicate-guard-v2-key-0123456789", "utf8");
const ENV = [
  "COMM_REPLY_DEDUP_ENABLED",
  "DUPLICATE_GUARD_V2_ENABLED",
  "COMM_REPLY_DEDUP_WINDOW_MINUTES",
  "COMM_REPLY_DEDUP_SHORT_WINDOW_MINUTES",
  "COMM_REPLY_DEDUP_CROSS_EMPLOYEE",
  "COMM_REPLY_DEDUP_JOB_RETENTION_DAYS",
];
const backup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe("flags and defaults", () => {
  test("v2 OFF (default): v1 settings unchanged; cross-employee is warn-only", () => {
    delete process.env.DUPLICATE_GUARD_V2_ENABLED;
    expect(isDuplicateGuardV2Enabled()).toBe(false);
    const s = commReplyDedupSettings();
    expect(s.v2).toBe(false);
    expect(s.windowMinutes).toBe(COMM_REPLY_DEDUP_DEFAULTS.windowMinutes);
    expect(s.windowMinutes).toBe(30);
    expect(s.crossThread).toBe(false);
    expect(s.crossEmployee).toBe("warn");
  });

  test("v2 ON: 6 h window, 2 min short window, cross-thread, cross-employee block, 30 day job retention", () => {
    process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
    const s = commReplyDedupSettings();
    expect(s.v2).toBe(true);
    expect(s.windowMinutes).toBe(360);
    expect(s.shortWindowMinutes).toBe(2);
    expect(s.crossThread).toBe(true);
    expect(s.crossEmployee).toBe("block");
    expect(s.jobRetentionDays).toBe(30);
  });

  test("v2 ON alone turns the guard on (v2 implies the ledger)", () => {
    delete process.env.COMM_REPLY_DEDUP_ENABLED;
    process.env.DUPLICATE_GUARD_V2_ENABLED = "1";
    expect(isCommReplyDedupEnabled()).toBe(true);
  });

  test("env overrides stay bounded; cross-employee may be set back to warn", () => {
    process.env.DUPLICATE_GUARD_V2_ENABLED = "true";
    process.env.COMM_REPLY_DEDUP_CROSS_EMPLOYEE = "warn";
    process.env.COMM_REPLY_DEDUP_SHORT_WINDOW_MINUTES = "999";
    process.env.COMM_REPLY_DEDUP_JOB_RETENTION_DAYS = "400";
    const s = commReplyDedupSettings();
    expect(s.crossEmployee).toBe("warn");
    expect(s.shortWindowMinutes).toBe(60);
    expect(s.jobRetentionDays).toBe(30);
    process.env.COMM_REPLY_DEDUP_CROSS_EMPLOYEE = "off";
    expect(commReplyDedupSettings().crossEmployee).toBe("block");
  });
});

describe("(4) v2 normalization: trivial variants of short bodies", () => {
  test("Slack mention label, emoji, shortcode, full width and punctuation are trivial", () => {
    const a = normalizeReplyBodyV2("<@U0NOGI|野木> 了解です 👍");
    expect(normalizeReplyBodyV2("<@U0NOGI> 了解です！")).toBe(a);
    expect(normalizeReplyBodyV2("<@U0NOGI>　了解です :+1::skin-tone-2:")).toBe(a);
    expect(normalizeReplyBodyV2("<@U0NOGI> 了解です 👍🏻")).toBe(a);
    expect(normalizeReplyBodyV2("ＯＫ❤️")).toBe(normalizeReplyBodyV2("ok"));
    expect(normalizeReplyBodyV2("<!here|@here> 了解")).toBe(normalizeReplyBodyV2("<!here> 了解"));
    expect(normalizeReplyBodyV2("<#C0GEN|general> 見ました")).toBe(normalizeReplyBodyV2("<#C0GEN> 見ました"));
  });

  test("the addressee is not trivial: another mention is another message", () => {
    expect(normalizeReplyBodyV2("<@U0NOGI> 了解です")).not.toBe(normalizeReplyBodyV2("<@U0YASAKA> 了解です"));
  });

  test("v1 normalization is unchanged (shortcodes still differ there)", () => {
    expect(normalizeReplyBody("了解です :+1:")).not.toBe(normalizeReplyBody("了解です"));
  });

  test("short tier = normalized length < 20; emoji-only bodies are short", () => {
    const v2 = (t: string) => fingerprintReplyBody(t, KEY, 20, 2);
    expect(sendTierOf(v2("OK"))).toBe("short");
    expect(sendTierOf(v2("了解です"))).toBe("short");
    expect(sendTierOf(v2("👍"))).toBe("short");
    expect(sendTierOf(v2("本日15時からの打ち合わせ資料をカレンダーに共有しました。"))).toBe("long");
  });
});

describe("(2) channel-level key", () => {
  const b = (conversation: Record<string, unknown>) =>
    ({ tool: "comm.reply", purpose: "comm.internal", jobId: "j", conversation, args: { text: "x" } }) as GatewayInvokeRequest;
  test("top-level and thread posts in one channel share the channel key, not the conversation key", () => {
    const top = conversationKeyInputFromBody(b({ surface: "slack", slackChannelId: "C0CHAN" }), "org_a")!;
    const thread = conversationKeyInputFromBody(b({ surface: "slack", slackChannelId: "C0CHAN", threadId: "1791104000.000001" }), "org_a")!;
    expect(conversationKey(top, KEY)).not.toBe(conversationKey(thread, KEY));
    expect(channelKey(top, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(channelKey(top, KEY)).toBe(channelKey(thread, KEY));
    const other = conversationKeyInputFromBody(b({ surface: "slack", slackChannelId: "C0OTHER" }), "org_a")!;
    expect(channelKey(other, KEY)).not.toBe(channelKey(top, KEY));
    const otherOrg = conversationKeyInputFromBody(b({ surface: "slack", slackChannelId: "C0CHAN" }), "org_b")!;
    expect(channelKey(otherOrg, KEY)).not.toBe(channelKey(top, KEY));
  });
});

describe("(5) failed post outcome", () => {
  test("only a provider-confirmed not-sent (or never-submitted) failure releases the claim", () => {
    expect(failedPostOutcome({ ok: false, error: "channel_not_found", sendState: "not_sent" })).toBe("failed");
    expect(failedPostOutcome({ ok: false, error: "The operation timed out.", sendState: "unknown" })).toBe("uncertain");
    // No classification at all → unknown → kept (fail closed).
    expect(failedPostOutcome({ ok: false, error: "slack_http_502" })).toBe("uncertain");
  });
});

describe("(6) posting-path inventory", () => {
  test("every outbound-send tool has a decision; conversation + SNS tools are guarded", () => {
    const covered = new Set(POSTING_PATH_INVENTORY.flatMap((p) => p.tools));
    for (const tool of OUTBOUND_SEND_TOOL_IDS) expect(covered.has(tool)).toBe(true);
    for (const tool of ["comm.reply", "comm.send", "slack.post", "slack.post_external", "sns.publish"]) {
      expect(DUPLICATE_GUARDED_TOOL_IDS).toContain(tool);
      expect(isDuplicateGuardedTool(tool)).toBe(true);
    }
    for (const p of POSTING_PATH_INVENTORY) {
      expect(["guarded", "own_idempotency", "no_live_send", "not_ai_posting"]).toContain(p.coverage);
      expect(p.noteJa.length).toBeGreaterThan(5);
    }
    const ids = POSTING_PATH_INVENTORY.map((p) => p.id);
    for (const id of ["invoke.slack_post", "invoke.caller_delivered", "invoke.file_upload", "invoke.sns_publish", "fulfill.slack_post", "fulfill.sns_publish"]) {
      expect(ids).toContain(id);
      expect(POSTING_PATH_INVENTORY.find((p) => p.id === id)?.coverage).toBe("guarded");
    }
  });
});
