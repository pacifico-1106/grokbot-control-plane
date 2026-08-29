import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { bindingPublicView } from "@/lib/bindings";
import {
  bindEmployeeSlackIdentity,
  getEmployeesBySlackUserIds,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { getBinding, updateWakeWebhook } from "@/lib/data";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { handleSlackEventsRequest } from "@/lib/slack/mention-ingress";

const SIGNING_SECRET = "slack-events-signing-secret-for-tests";
const WAKE_URL = "https://example.test/wake/ando";
const WAKE_SECRET = "sender-key-ando";
const BOUND_USER = "U_ANDO";
const SPEAKER = "U_HUMAN";
const TEAM = "T_DEMO";
const THREAD_TS = "1787911797.502889";
const CHANNEL = "C_CLOUD";

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

async function bindAndo() {
  const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({
    employeeId: emp.id,
    orgId: DEMO_ORG.id,
    slackUserId: BOUND_USER,
    slackTeamId: TEAM,
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

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});
