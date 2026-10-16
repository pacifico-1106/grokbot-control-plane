import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import { isInboundNoticeCandidate } from "@/lib/inbound-notice/slack-hook";

const TEAM = "T_DEMO";
const CHANNEL = "C_INBOUND_DUMMY";
const BOT = "B_AIC_DUMMY";
const APP = "A_AIC_DUMMY";
const BOUND_USER = "U_INBOUND_DUMMY";
const WAKE_URL = "https://example.test/wake/inbound-dummy";
const NOTICE = [
  "受電のお知らせ",
  "受電日時 2026/01/02 03:04",
  "電話番号 000-0000-1111",
  "相手先会社 DUMMY-CO",
  "相手先氏名 DUMMY-NAME",
  "カテゴリ 担当への取次",
  "折り返し要否 不要",
  "緊急 いいえ",
  "営業電話 いいえ",
  "要約 DUMMY-SUMMARY",
].join("\n");

const KEYS = [
  "INBOUND_CALL_NOTICE_ENABLED",
  "INBOUND_CALL_NOTICE_ORG_ID",
  "INBOUND_CALL_NOTICE_EMPLOYEE_ID",
  "INBOUND_CALL_NOTICE_SLACK_TEAM_ID",
  "INBOUND_CALL_NOTICE_SLACK_CHANNEL_IDS",
  "INBOUND_CALL_NOTICE_SLACK_BOT_IDS",
  "INBOUND_CALL_NOTICE_SLACK_APP_IDS",
  "SLACK_SIGNING_SECRET",
] as const;
const saved: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function envelope(over: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: TEAM,
    event_id: `Ev_inb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event: {
      type: "message",
      subtype: "bot_message",
      bot_id: BOT,
      bot_profile: { id: BOT, app_id: APP, name: "ai-concier-dummy" },
      text: NOTICE,
      ts: "1787911800.000099",
      channel: CHANNEL,
      channel_type: "channel",
    },
    ...over,
  };
}

describe("isInboundNoticeCandidate", () => {
  test("requires a bot identity and 受電のお知らせ", () => {
    expect(isInboundNoticeCandidate(envelope())).toBe(true);
    expect(
      isInboundNoticeCandidate(envelope({ event: { type: "message", text: NOTICE, channel: CHANNEL } }))
    ).toBe(false);
    expect(
      isInboundNoticeCandidate(
        envelope({
          event: { type: "message", subtype: "bot_message", bot_id: BOT, text: "hello", channel: CHANNEL },
        })
      )
    ).toBe(false);
  });
});

describe("mention-ingress hook", () => {
  test("flag OFF: bot_message 受電のお知らせ is still ignored_subtype:bot_message (no wake)", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async () => {
      calls.push("fetched");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const outcome = await processSlackMentionEnvelope(envelope());
    expect(outcome.handled).toBe(true);
    expect(outcome.woke).toBe(0);
    expect(outcome.skipReason).toBe("ignored_subtype:bot_message");
    expect(calls).toHaveLength(0);
  });

  test("flag ON: registered channel + expected bot wakes the designated employee", async () => {
    process.env.INBOUND_CALL_NOTICE_ENABLED = "true";
    process.env.INBOUND_CALL_NOTICE_ORG_ID = DEMO_ORG.id;
    process.env.INBOUND_CALL_NOTICE_EMPLOYEE_ID = "emp_comm";
    process.env.INBOUND_CALL_NOTICE_SLACK_TEAM_ID = TEAM;
    process.env.INBOUND_CALL_NOTICE_SLACK_CHANNEL_IDS = CHANNEL;
    process.env.INBOUND_CALL_NOTICE_SLACK_BOT_IDS = BOT;
    process.env.INBOUND_CALL_NOTICE_SLACK_APP_IDS = APP;

    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
    await bindEmployeeSlackIdentity({
      employeeId: emp.id,
      orgId: DEMO_ORG.id,
      slackUserId: BOUND_USER,
      slackTeamId: TEAM,
      displayName: "Dummy",
      userToken: "xoxp-test",
    });
    await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: WAKE_URL, secret: "dummy-secret" });
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: CHANNEL,
      classification: "internal",
      skipInspect: true,
    });

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const outcome = await processSlackMentionEnvelope(envelope());
      expect(outcome.handled).toBe(true);
      expect(outcome.woke).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(WAKE_URL);
      expect(calls[0].body.kind).toBe("inbound_notice");
      expect(calls[0].body.priority).toBe("normal");
      expect(calls[0].body.text).toBeUndefined();
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
      emp.allowedAccounts = previous;
    }
  });
});
