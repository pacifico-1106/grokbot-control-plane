import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { bindingPublicView } from "@/lib/bindings";
import {
  bindEmployeeSlackIdentity,
  getEmployeesBySlackUserIds,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { getBinding, updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import {
  deleteSlackImEmployeeRoute,
  resolveSlackImWakeTarget,
  resolveSlackUserTokenImWakeTarget,
  syncSlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import {
  acknowledgeSlackEventsRequest,
  handleSlackEventsRequest,
  processSlackMentionEnvelope,
  setSlackMentionClaimInsertForTests,
} from "@/lib/slack/mention-ingress";

const SIGNING_SECRET = "slack-events-signing-secret-for-tests";
const WAKE_URL = "https://example.test/wake/ando";
const WAKE_SECRET = "sender-key-ando";
const BOUND_USER = "U_ANDO";
const SPEAKER = "U_HUMAN";
const TEAM = "T_DEMO";
const THREAD_TS = "1787911797.502889";
const CHANNEL = "C_CLOUD";
const INTERNAL_IM = "DSTAFFPASSINTERNAL";
const UNKNOWN_IM = "DSTAFFPASSUNKNOWN";
const HUMAN_DM = "D0BSWG1804F";

const originalFetch = globalThis.fetch;
const savedSigning = process.env.SLACK_SIGNING_SECRET;

function sign(rawBody: string, timestamp: string, key = SIGNING_SECRET): string {
  return `v0=${createHmac("sha256", key).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function signedRequest(body: unknown) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    rawBody,
    timestamp,
    signature: sign(rawBody, timestamp),
  };
}

type WakeCall = { url: string; auth: string; payload: Record<string, unknown> };

function mockWake(): { calls: () => WakeCall[] } {
  const calls: WakeCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    const auth = String(
      (init?.headers as Record<string, string> | undefined)?.authorization || ""
    );
    calls.push({ url, auth, payload });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { calls: () => calls };
}

async function bindAndo(opts?: { slackTeamId?: string; slackUserId?: string }) {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  const previous = emp.allowedAccounts;
  const slackUserId = opts?.slackUserId || BOUND_USER;
  emp.allowedAccounts = [{ service: "slack", accountId: slackUserId }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({
    employeeId: emp.id,
    orgId: DEMO_ORG.id,
    slackUserId,
    slackTeamId: opts?.slackTeamId ?? TEAM,
    displayName: "安藤",
    userToken: "xoxp-test",
  });
  await updateWakeWebhook(emp.id, {
    orgId: DEMO_ORG.id,
    url: WAKE_URL,
    secret: WAKE_SECRET,
  });
  return {
    emp,
    restore: async () => {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
      emp.allowedAccounts = previous;
    },
  };
}

async function configureInternalIm(employeeId: string, channel = INTERNAL_IM) {
  await upsertOrgChannel({
    orgId: DEMO_ORG.id,
    surface: "slack",
    externalId: channel,
    classification: "internal",
    skipInspect: true,
  });
  await syncSlackImEmployeeRoute({
    orgId: DEMO_ORG.id,
    surface: "slack",
    slackChannelId: channel,
    slackTeamId: TEAM,
    classification: "internal",
    mixed: false,
    employeeId,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSlackMentionClaimInsertForTests(null);
  if (savedSigning === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = savedSigning;
});

describe("Slack mention ingress", () => {
  test("signature reject", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = await handleSlackEventsRequest({
      rawBody,
      timestamp,
      signature: sign(rawBody, timestamp, "wrong-secret"),
    });
    expect(result.status).toBe(401);
    expect(result.body.ok).toBe(false);
  });

  test("challenge echo", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const result = await handleSlackEventsRequest(
      signedRequest({ type: "url_verification", challenge: "challenge-xyz" })
    );
    expect(result.status).toBe(200);
    expect(result.body.challenge).toBe("challenge-xyz");
  });

  test("mention of bound U… POSTs to wake url with thread_ts preserved", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_thread_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: `こんにちは <@${BOUND_USER}>`,
            ts: "1787911800.000001",
            thread_ts: THREAD_TS,
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(1);
      const call = wake.calls()[0];
      expect(call.url).toBe(WAKE_URL);
      expect(call.auth).toBe(`Bearer ${WAKE_SECRET}`);
      expect(call.payload.channel).toBe(CHANNEL);
      expect(call.payload.ts).toBe("1787911800.000001");
      expect(call.payload.thread_ts).toBe(THREAD_TS);
      expect(call.payload.user).toBe(SPEAKER);
      expect(call.payload.slackUserId).toBe(BOUND_USER);
      expect(call.payload.teamId).toBe(TEAM);
      expect(call.payload.employeeId).toBe("emp_comm");
      expect(call.payload.text).toContain(`<@${BOUND_USER}>`);
    } finally {
      await restore();
    }
  });

  test("channel-level mention omits thread parent and keeps ts", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    try {
      const ts = "1787960001.111111";
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_channel_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: `<@${BOUND_USER}> 新しい話題です`,
            ts,
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(1);
      const payload = wake.calls()[0].payload;
      expect(payload.ts).toBe(ts);
      expect(payload.thread_ts).toBeNull();
    } finally {
      await restore();
    }
  });

  test("classified internal IM wakes its bound employee without a mention", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id);
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_internal_im_${Date.now()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: SPEAKER,
            text: "メンションなしでお願いします",
            ts: "1787911800.000020",
            channel: INTERNAL_IM,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(1);
      expect(wake.calls()[0].payload.employeeId).toBe(emp.id);
      expect(wake.calls()[0].payload.text).toBe("メンションなしでお願いします");
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
      await restore();
    }
  });

  test("unclassified IM does not wake any employee", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: UNKNOWN_IM,
      classification: "unknown",
      skipInspect: true,
    });
    await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: UNKNOWN_IM });
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_unknown_im_${Date.now()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: SPEAKER,
            text: "未分類DM",
            ts: "1787911800.000021",
            channel: UNKNOWN_IM,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("employee's own Slack user post does not wake the employee", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id);
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_self_im_${Date.now()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: BOUND_USER,
            text: "自分の投稿",
            ts: "1787911800.000022",
            channel: INTERNAL_IM,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(0);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
      await restore();
    }
  });

  test("D-prefixed bot event (no user token) without channel_type=im does not use the IM exception", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id);
    try {
      // Bot events (Path A) require channel_type=im to be treated as DM
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_not_message_im_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: "D-prefixだけでは起こさない（botイベント）",
            ts: "1787911800.000023",
            channel: INTERNAL_IM,
          },
          // No authorizations = bot event
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(0);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
      await restore();
    }
  });

  test("channels.classify sync without employee removes the IM ingress", async () => {
    const { emp, restore } = await bindAndo();
    await configureInternalIm(emp.id);
    try {
      const before = await resolveSlackImWakeTarget({
        slackChannelId: INTERNAL_IM,
        slackTeamId: TEAM,
      });
      expect(before?.employeeId).toBe(emp.id);
      const route = await syncSlackImEmployeeRoute({
        orgId: DEMO_ORG.id,
        surface: "slack",
        slackChannelId: INTERNAL_IM,
        slackTeamId: TEAM,
        classification: "internal",
        mixed: false,
      });
      expect(route).toBeNull();
      const after = await resolveSlackImWakeTarget({
        slackChannelId: INTERNAL_IM,
        slackTeamId: TEAM,
      });
      expect(after).toBeNull();
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
      await restore();
    }
  });

  test("unbound mention does not wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_unbound_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: "こんにちは <@U_STRANGER>",
            ts: "1787911800.000009",
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("duplicate event_id does not wake twice", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    const eventId = `Ev_dup_${Date.now()}`;
    const envelope = {
      type: "event_callback",
      team_id: TEAM,
      event_id: eventId,
      event: {
        type: "message",
        user: SPEAKER,
        text: `<@${BOUND_USER}> 再送`,
        ts: "1787911800.000010",
        thread_ts: THREAD_TS,
        channel: CHANNEL,
      },
    };
    try {
      const first = await handleSlackEventsRequest(signedRequest(envelope));
      const second = await handleSlackEventsRequest(signedRequest(envelope));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(wake.calls().length).toBe(1);
    } finally {
      await restore();
    }
  });

  test("missing wake url skips wake and does not 500", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    await updateWakeWebhook("emp_comm", { orgId: DEMO_ORG.id, url: null, secret: "" });
    const wake = mockWake();
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_nowake_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: `<@${BOUND_USER}>`,
            ts: "1787911800.000011",
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("binding public view never returns the wake secret", async () => {
    const { restore } = await bindAndo();
    try {
      const binding = await getBinding("emp_comm");
      expect(binding?.wakeWebhookUrl).toBe(WAKE_URL);
      expect(binding?.hasWakeWebhook).toBe(true);
      const view = bindingPublicView(binding!);
      expect(view.hasWakeWebhook).toBe(true);
      expect(view.wakeWebhookUrl).toBe(WAKE_URL);
      expect(JSON.stringify(view)).not.toContain(WAKE_SECRET);
      expect("wakeWebhookSecret" in view).toBe(false);
    } finally {
      await restore();
    }
  });

  test("claim failure other than unique 23505 still wakes", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    setSlackMentionClaimInsertForTests(async () => ({
      data: null,
      error: { code: "42P01" },
    }));
    const { restore } = await bindAndo();
    const wake = mockWake();
    try {
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_claimfail_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: `<@${BOUND_USER}> 起こして`,
            ts: "1788043788.305939",
            thread_ts: "1788040494.777309",
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(1);
    } finally {
      await restore();
    }
  });

  test("duplicate 23505 does not double-wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    let inserts = 0;
    setSlackMentionClaimInsertForTests(async (eventId) => {
      inserts += 1;
      if (inserts === 1) return { data: { event_id: eventId }, error: null };
      return { data: null, error: { code: "23505" } };
    });
    const { restore } = await bindAndo();
    const wake = mockWake();
    const envelope = {
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev_pgdup_${Date.now()}`,
      event: {
        type: "message",
        user: SPEAKER,
        text: `<@${BOUND_USER}> 再送`,
        ts: "1787911800.000012",
        thread_ts: THREAD_TS,
        channel: CHANNEL,
      },
    };
    try {
      const first = await handleSlackEventsRequest(signedRequest(envelope));
      const second = await handleSlackEventsRequest(signedRequest(envelope));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(wake.calls().length).toBe(1);
      expect(inserts).toBe(2);
    } finally {
      await restore();
    }
  });

  test("team mismatch still wakes the matching slack_user_id", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo({ slackTeamId: "T_STORED_OTHER" });
    const wake = mockWake();
    try {
      const rows = await getEmployeesBySlackUserIds([BOUND_USER], TEAM);
      expect(rows.length).toBe(1);
      expect(rows[0].employeeId).toBe("emp_comm");
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_teammiss_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: `<@${BOUND_USER}> ping`,
            ts: "1788043788.305939",
            thread_ts: "1788040494.777309",
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(1);
      expect(wake.calls()[0].payload.slackUserId).toBe(BOUND_USER);
    } finally {
      await restore();
    }
  });

  test("slack user id match is case-insensitive", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo({ slackUserId: "u_ando" });
    const wake = mockWake();
    try {
      const rows = await getEmployeesBySlackUserIds(["U_ANDO"], TEAM);
      expect(rows.length).toBe(1);
      expect(rows[0].slackUserId).toBe("u_ando");
      const result = await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_case_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: "<@U_ANDO> こんにちは",
            ts: "1787911800.000013",
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(wake.calls().length).toBe(1);
    } finally {
      await restore();
    }
  });

  test("acknowledge returns 200 without waiting on wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    try {
      const result = await acknowledgeSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_ack_${Date.now()}`,
          event: {
            type: "message",
            user: SPEAKER,
            text: `<@${BOUND_USER}>`,
            ts: "1787911800.000014",
            channel: CHANNEL,
          },
        })
      );
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(Boolean(result.envelope)).toBe(true);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("getEmployeesBySlackUserIds returns grokBotAgentId and wake url", async () => {
    const { restore } = await bindAndo();
    try {
      const rows = await getEmployeesBySlackUserIds([BOUND_USER], TEAM);
      expect(rows.length).toBe(1);
      expect(rows[0].employeeId).toBe("emp_comm");
      expect(rows[0].grokBotAgentId).toBeTruthy();
      expect(rows[0].wakeWebhookUrl).toBe(WAKE_URL);
      expect(rows[0].hasWakeWebhook).toBe(true);
    } finally {
      await restore();
    }
  });

  test("skipReason is returned for bot_message subtype", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const outcome = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev_bot_${Date.now()}`,
      event: {
        type: "message",
        subtype: "bot_message",
        user: SPEAKER,
        text: "bot message",
        ts: "1787911800.000030",
        channel: CHANNEL,
      },
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.woke).toBe(0);
    expect(outcome.skipReason).toBe("ignored_subtype:bot_message");
  });

  test("skipReason is returned for unbound mentions", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const outcome = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev_skip_unbound_${Date.now()}`,
      event: {
        type: "message",
        user: SPEAKER,
        text: "こんにちは <@U_STRANGER>",
        ts: "1787911800.000031",
        channel: CHANNEL,
      },
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.woke).toBe(0);
    expect(outcome.skipReason).toBe("mentioned_ids_not_bound");
  });

  test("skipReason is returned for IM without route", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: UNKNOWN_IM });
    const outcome = await processSlackMentionEnvelope({
      type: "event_callback",
      team_id: TEAM,
      event_id: `Ev_skip_im_${Date.now()}`,
      event: {
        type: "message",
        channel_type: "im",
        user: SPEAKER,
        text: "no route IM",
        ts: "1787911800.000032",
        channel: UNKNOWN_IM,
      },
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.woke).toBe(0);
    expect(outcome.skipReason).toBe("im_no_route_or_self");
  });

  test("skipReason is undefined on successful wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    mockWake();
    try {
      const outcome = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_success_${Date.now()}`,
        event: {
          type: "message",
          user: SPEAKER,
          text: `<@${BOUND_USER}> test`,
          ts: "1787911800.000033",
          channel: CHANNEL,
        },
      });
      expect(outcome.handled).toBe(true);
      expect(outcome.woke).toBe(1);
      expect(outcome.skipReason).toBeUndefined();
    } finally {
      await restore();
    }
  });
});

describe("User-token message.im wake (SLICE B)", () => {
  test("user-token event with valid route wakes employee (with channel_type)", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_wake_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          channel_type: "im",
          user: SPEAKER,
          text: "上司からの指示です",
          ts: "1787911800.000030",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(1);
      expect(result.userToken).toBe(true);
      expect(result.isDirectMessage).toBe(true);
      expect(wake.calls().length).toBe(1);
      expect(wake.calls()[0].payload.employeeId).toBe(emp.id);
      expect(wake.calls()[0].payload.channel).toBe(HUMAN_DM);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });

  test("user-token event WITHOUT channel_type but with D-prefixed channel wakes employee", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      // This is the key regression test: user-token message.im envelopes may omit channel_type
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_no_channel_type_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          // channel_type is intentionally omitted
          user: SPEAKER,
          text: "channel_typeなしで上司からの指示です",
          ts: "1787911800.000050",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(1);
      expect(result.userToken).toBe(true);
      expect(result.isDirectMessage).toBe(true);
      expect(wake.calls().length).toBe(1);
      expect(wake.calls()[0].payload.employeeId).toBe(emp.id);
      expect(wake.calls()[0].payload.channel).toBe(HUMAN_DM);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });

  test("user-token self-post WITHOUT channel_type still skipped", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      // Self-post must still be blocked even when channel_type is omitted
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_self_no_channel_type_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          // channel_type is intentionally omitted
          user: BOUND_USER, // self-post
          text: "自分の投稿（channel_typeなし）",
          ts: "1787911800.000051",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(0);
      expect(result.isDirectMessage).toBe(true);
      expect(wake.calls().length).toBe(0);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });

  test("user-token event with non-IM channel (C-prefix) does not use IM path", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    try {
      // C-prefixed channel should not be treated as DM even with user token
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_channel_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          user: SPEAKER,
          text: "チャンネルメッセージ",
          ts: "1787911800.000052",
          channel: CHANNEL, // C-prefixed, not D-prefixed
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(0);
      expect(result.isDirectMessage).toBe(false);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("user-token event where authorized user does not match route employee does not wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_mismatch_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: "U_OTHER_USER", team_id: TEAM }],
        event: {
          type: "message",
          channel_type: "im",
          user: SPEAKER,
          text: "誰かのDM",
          ts: "1787911800.000031",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(0);
      expect(result.userToken).toBe(true);
      expect(wake.calls().length).toBe(0);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });

  test("user-token event without a route does not wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_no_route_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          channel_type: "im",
          user: SPEAKER,
          text: "未設定のDM",
          ts: "1787911800.000032",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(0);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("user-token event with unclassified channel does not wake", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { restore } = await bindAndo();
    const wake = mockWake();
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: HUMAN_DM,
      classification: "unknown",
      skipInspect: true,
    });
    await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_unclassified_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          channel_type: "im",
          user: SPEAKER,
          text: "未分類DM",
          ts: "1787911800.000033",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(0);
      expect(wake.calls().length).toBe(0);
    } finally {
      await restore();
    }
  });

  test("employee's own post via user-token does not wake themselves", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_user_token_self_${Date.now()}`,
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        event: {
          type: "message",
          channel_type: "im",
          user: BOUND_USER,
          text: "自分の投稿",
          ts: "1787911800.000034",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(0);
      expect(wake.calls().length).toBe(0);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });

  test("bot-token event still uses Path A resolver", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id);
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_bot_token_${Date.now()}`,
        authorizations: [{ is_bot: true, user_id: "B_STAFFPASS_BOT", team_id: TEAM }],
        event: {
          type: "message",
          channel_type: "im",
          user: SPEAKER,
          text: "ボットDM経由",
          ts: "1787911800.000035",
          channel: INTERNAL_IM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.woke).toBe(1);
      expect(result.userToken).toBe(false);
      expect(wake.calls().length).toBe(1);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: INTERNAL_IM });
      await restore();
    }
  });

  test("resolveSlackUserTokenImWakeTarget returns target only when authorized user matches", async () => {
    const { emp, restore } = await bindAndo();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      const validTarget = await resolveSlackUserTokenImWakeTarget({
        slackChannelId: HUMAN_DM,
        slackTeamId: TEAM,
        authorizedSlackUserId: BOUND_USER,
      });
      expect(validTarget).not.toBeNull();
      expect(validTarget?.employeeId).toBe(emp.id);

      const invalidTarget = await resolveSlackUserTokenImWakeTarget({
        slackChannelId: HUMAN_DM,
        slackTeamId: TEAM,
        authorizedSlackUserId: "U_OTHER_USER",
      });
      expect(invalidTarget).toBeNull();
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });

  test("mixed-authorization envelope picks correct resolver based on is_bot", async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    const { emp, restore } = await bindAndo();
    const wake = mockWake();
    await configureInternalIm(emp.id, HUMAN_DM);
    try {
      const result = await processSlackMentionEnvelope({
        type: "event_callback",
        team_id: TEAM,
        event_id: `Ev_mixed_auth_${Date.now()}`,
        authorizations: [
          { is_bot: true, user_id: "B_STAFFPASS_BOT", team_id: TEAM },
          { is_bot: false, user_id: BOUND_USER, team_id: TEAM },
        ],
        event: {
          type: "message",
          channel_type: "im",
          user: SPEAKER,
          text: "複数認可",
          ts: "1787911800.000036",
          channel: HUMAN_DM,
        },
      });
      expect(result.handled).toBe(true);
      expect(result.userToken).toBe(true);
      expect(result.woke).toBe(1);
      expect(wake.calls().length).toBe(1);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: HUMAN_DM });
      await restore();
    }
  });
});
