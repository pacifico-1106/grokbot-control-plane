/**
 * FLAGS-OFF REGRESSION: inbound call notice prototype.
 * Unset INBOUND_CALL_NOTICE_ENABLED → existing Slack bot_message skip is unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isInboundCallNoticeEnabled } from "@/lib/inbound-notice/flags";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";

const KEYS = [
  "INBOUND_CALL_NOTICE_ENABLED",
  "INBOUND_CALL_NOTICE_ORG_ID",
  "INBOUND_CALL_NOTICE_EMPLOYEE_ID",
  "INBOUND_CALL_NOTICE_SLACK_TEAM_ID",
  "INBOUND_CALL_NOTICE_SLACK_CHANNEL_IDS",
  "INBOUND_CALL_NOTICE_SLACK_BOT_IDS",
  "INBOUND_CALL_NOTICE_SLACK_APP_IDS",
  "INBOUND_CALL_NOTICE_PHONE_HASH_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("FLAGS-OFF REGRESSION: inbound call notice", () => {
  test("flag defaults to OFF", () => {
    expect(isInboundCallNoticeEnabled()).toBe(false);
  });

  test("bot_message inbound-looking text is still ignored (no wake)", async () => {
    const outcome = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: "T_DEMO",
      event_id: `Ev_flagoff_${Date.now()}`,
      event: {
        type: "message",
        subtype: "bot_message",
        bot_id: "B_AIC_DUMMY",
        text: "受電のお知らせ / 受電日時 2026/01/02 03:04 / 電話番号 000-0000-1111 / 要約 DUMMY",
        ts: "1787911800.000080",
        channel: "C_CLOUD",
      },
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.woke).toBe(0);
    expect(outcome.skipReason).toBe("ignored_subtype:bot_message");
  });
});
