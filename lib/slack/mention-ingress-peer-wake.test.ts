import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
} from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import { resetDemoAiPeerWake, upsertAllowlist } from "@/lib/data/ai-peer-wake";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import {
  handleSlackEventsRequest,
  setSlackMentionClaimInsertForTests,
} from "@/lib/slack/mention-ingress";
import {
  deleteSlackImEmployeeRoute,
  syncSlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";

const SIGNING_SECRET = "slack-events-signing-secret-for-tests";
const TEAM = "T_DEMO";
const CHANNEL = "C_CLOUD";
const ANDO = "U_ANDO";
const YASAKA = "U_YASAKA";
const HUMAN = "U_HUMAN";
const THREAD = "1787911797.502889";

const FLAG_KEYS = [
  "AI_PEER_WAKE_ALLOWLIST_ENABLED",
  "AI_PEER_WAKE_THREAD_GUARD_ENABLED",
  "P0_USER_CHANNEL_MENTION_INGRESS",
  "SLACK_SIGNING_SECRET",
] as const;

let savedFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

function sign(rawBody: string, timestamp: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

function signedRequest(body: unknown) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { rawBody, timestamp, signature: sign(rawBody, timestamp) };
}

function mockWake() {
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), payload: JSON.parse(String(init?.body || "{}")) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { calls: () => calls };
}

async function bind(employeeId: string, slackUserId: string, slackTeamId = TEAM) {
  const emp = getRuntimeEmployees().find((e) => e.id === employeeId);
  if (!emp) throw new Error(`missing ${employeeId}`);
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: slackUserId }];
  await revokeEmployeeSlackIdentity({ employeeId, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({
    employeeId,
    orgId: DEMO_ORG.id,
    slackUserId,
    slackTeamId,
    displayName: emp.displayName,
    userToken: "xoxp-test",
  });
  await updateWakeWebhook(employeeId, {
    orgId: DEMO_ORG.id,
    url: `https://example.test/wake/${employeeId}`,
    secret: `s-${employeeId}`,
  });
  return async () => {
    await revokeEmployeeSlackIdentity({ employeeId, orgId: DEMO_ORG.id });
    await updateWakeWebhook(employeeId, { orgId: DEMO_ORG.id, url: null, secret: "" });
    emp.allowedAccounts = previous;
  };
}

function mention(from: string, to: string, eventId: string, extras?: { thread?: string; channel?: string }) {
  return signedRequest({
    type: "event_callback",
    team_id: TEAM,
    event_id: eventId,
    event: {
      type: "message",
      user: from,
      text: `hello <@${to}>`,
      ts: "1787911800.000100",
      thread_ts: extras?.thread ?? THREAD,
      channel: extras?.channel ?? CHANNEL,
    },
  });
}

beforeEach(() => {
  savedFetch = globalThis.fetch;
  for (const key of FLAG_KEYS) savedEnv[key] = process.env[key];
  delete process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED;
  delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  resetDemoAiPeerWake();
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  setSlackMentionClaimInsertForTests(null);
  resetDemoAiPeerWake();
  for (const key of FLAG_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("mention ingress: AI→AI peer-wake guard", () => {
  test("flags OFF: bound AI mentioning another bound AI still wakes (regression)", async () => {
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    const wake = mockWake();
    try {
      const result = await handleSlackEventsRequest(mention(ANDO, YASAKA, `Ev_reg_${Date.now()}`));
      expect(result.status).toBe(200);
      expect(wake.calls().some((c) => c.payload.employeeId === "emp_sns")).toBe(true);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON, no pair: AI→AI does not wake; human→AI still wakes", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    const wake = mockWake();
    try {
      await handleSlackEventsRequest(mention(ANDO, YASAKA, `Ev_ai_${Date.now()}`));
      expect(wake.calls().length).toBe(0);
      await handleSlackEventsRequest(mention(HUMAN, YASAKA, `Ev_hu_${Date.now()}`));
      expect(wake.calls().some((c) => c.payload.employeeId === "emp_sns")).toBe(true);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("allowlist ON with pair: AI→AI wakes", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "member:mem_1",
    });
    const wake = mockWake();
    try {
      await handleSlackEventsRequest(mention(ANDO, YASAKA, `Ev_pair_${Date.now()}`));
      expect(wake.calls().some((c) => c.payload.employeeId === "emp_sns")).toBe(true);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("Path B DM: AI speaker without pair does not wake; human speaker does", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    const im = "DPEERWAKE1";
    const restoreB = await bind("emp_sns", YASAKA);
    const restoreA = await bind("emp_comm", ANDO);
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: im,
      classification: "internal",
      skipInspect: true,
    });
    await syncSlackImEmployeeRoute({
      orgId: DEMO_ORG.id,
      surface: "slack",
      slackChannelId: im,
      slackTeamId: TEAM,
      classification: "internal",
      mixed: false,
      employeeId: "emp_sns",
    });
    const wake = mockWake();
    try {
      await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_im_ai_${Date.now()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: ANDO,
            text: "hi",
            ts: "1787911800.000200",
            channel: im,
          },
        })
      );
      expect(wake.calls().length).toBe(0);
      await handleSlackEventsRequest(
        signedRequest({
          type: "event_callback",
          team_id: TEAM,
          event_id: `Ev_im_hu_${Date.now()}`,
          event: {
            type: "message",
            channel_type: "im",
            user: HUMAN,
            text: "hi",
            ts: "1787911800.000201",
            channel: im,
          },
        })
      );
      expect(wake.calls().some((c) => c.payload.employeeId === "emp_sns")).toBe(true);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: im });
      await restoreA();
      await restoreB();
    }
  });

  test("Path C: AI speaker without pair does not wake; human speaker does", async () => {
    process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = "1";
    process.env.P0_USER_CHANNEL_MENTION_INGRESS = "1";
    const pathc = "C_PEER_PATHC";
    const restoreA = await bind("emp_comm", ANDO, TEAM);
    const restoreB = await bind("emp_sns", YASAKA, TEAM);
    await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: pathc,
      classification: "internal",
      skipInspect: true,
    });
    const wake = mockWake();
    const pathC = (speaker: string, eventId: string) =>
      signedRequest({
        type: "event_callback",
        team_id: TEAM,
        event_id: eventId,
        event: {
          type: "message",
          channel_type: "channel",
          user: speaker,
          text: `<@${YASAKA}> hello`,
          ts: "1787911800.000300",
          channel: pathc,
        },
        authorizations: [{ is_bot: false, user_id: YASAKA, team_id: TEAM }],
      });
    try {
      await handleSlackEventsRequest(pathC(ANDO, `Ev_pc_ai_${Date.now()}`));
      expect(wake.calls().length).toBe(0);
      await handleSlackEventsRequest(pathC(HUMAN, `Ev_pc_hu_${Date.now()}`));
      expect(wake.calls().some((c) => c.payload.employeeId === "emp_sns")).toBe(true);
    } finally {
      await restoreB();
      await restoreA();
    }
  });

  test("thread guard ON: 5th AI→AI mention in the thread is cut off and audited", async () => {
    process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = "1";
    const restoreA = await bind("emp_comm", ANDO);
    const restoreB = await bind("emp_sns", YASAKA);
    const wake = mockWake();
    try {
      for (let i = 1; i <= 4; i++) {
        await handleSlackEventsRequest(mention(ANDO, YASAKA, `Ev_loop_${Date.now()}_${i}`));
      }
      expect(wake.calls().filter((c) => c.payload.employeeId === "emp_sns").length).toBe(4);
      await handleSlackEventsRequest(mention(ANDO, YASAKA, `Ev_loop_${Date.now()}_5`));
      expect(wake.calls().filter((c) => c.payload.employeeId === "emp_sns").length).toBe(4);
      expect(getRuntimeAudit().some((e) => e.action === "slack.peer_wake.denied" && e.metadata?.reason === "thread_capped")).toBe(true);
    } finally {
      await restoreB();
      await restoreA();
    }
  });
});
