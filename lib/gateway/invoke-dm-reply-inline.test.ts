/**
 * G4 (2026-10-04): SLACK_DM_REPLY_INLINE_ENABLED (default OFF).
 * ON: a comm.reply / slack.post into a Slack DM goes to the DM's main flow even
 * under reply_policy prefer_thread; a message that is already inside a thread
 * (thread_ts ≠ ts) is answered in that thread. Channels and flag OFF: unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel } from "@/lib/data/directory";
import { resetDemoReplyPolicy, setOrgReplyPolicy } from "@/lib/data/reply-policy";
import { clearStash, storeWakeParent } from "@/lib/data/wake-parent-stash";
import { DEMO_ORG } from "@/lib/demo-data";
import { fulfillApprovedInvoke, parseFulfillment } from "@/lib/approvals/fulfill";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { normalizeReplyPolicy } from "@/lib/gateway/reply-policy-validate";
import type { GatewayInvokeRequest } from "@/lib/types";

const FLAG = "SLACK_DM_REPLY_INLINE_ENABLED";
const DM = "D0DMINLINE1";
const MSG_TS = "1791000001.111111";
const THREAD_TS = "1791000000.000100";
const originalFetch = globalThis.fetch;
const savedFlag = process.env[FLAG];

type Posted = { channel?: string; thread_ts?: string };
let posts: Posted[] = [];

function mockSlack() {
  posts = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Posted;
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: "1791000099.000001" });
    }
    if (url.includes("conversations.info")) {
      return Response.json({ ok: true, channel: { is_ext_shared: false } });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

function setFlag(on: boolean) {
  if (on) process.env[FLAG] = "true";
  else delete process.env[FLAG];
}

async function preferThread() {
  await setOrgReplyPolicy(
    DEMO_ORG.id,
    normalizeReplyPolicy({
      policyId: "rpp_dm_inline",
      policyName: "Prefer Thread",
      rules: [
        {
          id: "rpr_dm_inline",
          surface: "slack",
          afterHoursMode: "allow_send",
          shortReplyMode: "allow",
          emojiMode: "allow",
          threadAffinity: "prefer_thread",
        },
      ],
    })
  );
}

type Conv = Record<string, unknown>;

async function reply(conversation: Conv, opts: { tool?: string; informationClass?: string } = {}) {
  return runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body: {
      tool: opts.tool || "comm.reply",
      purpose: "comm.internal",
      jobId: `job_dm_inline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversation: {
        surface: "slack",
        orgId: DEMO_ORG.id,
        speakerId: "U_YAMADA",
        ...conversation,
      } as unknown as GatewayInvokeRequest["conversation"],
      ...(opts.informationClass ? { informationClass: opts.informationClass } : {}),
      args: { text: "DM の返信テストです。" },
    } as GatewayInvokeRequest,
  });
}

beforeAll(async () => {
  await upsertOrgChannel({
    orgId: DEMO_ORG.id,
    surface: "slack",
    externalId: DM,
    classification: "internal",
    mixed: false,
    skipInspect: true,
  });
  await upsertConversationAdapter({
    orgId: DEMO_ORG.id,
    surface: "slack",
    enabled: true,
    secrets: { botToken: "xoxb-dm-inline-test" },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoReplyPolicy();
  clearStash();
  setFlag(false);
});

afterAll(async () => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} });
});

describe("flag ON: DM replies go to the DM's main flow", () => {
  test("comm.reply to a DM top-level message (thread_ts null) has no thread_ts under prefer_thread", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: null });
    expect(sent.body.ok).toBe(true);
    expect(posts.length).toBe(1);
    expect(posts[0].channel).toBe(DM);
    expect(posts[0].thread_ts).toBeUndefined();
  });

  test("slack.post to a DM also posts without thread_ts", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, ts: MSG_TS }, { tool: "slack.post" });
    expect(sent.body.ok).toBe(true);
    expect(posts.length).toBe(1);
    expect(posts[0].thread_ts).toBeUndefined();
  });

  test("thread_ts equal to ts (the message is not inside a thread) → no thread_ts", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: MSG_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBeUndefined();
  });

  test("only messageTs (no thread) → no thread_ts", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, messageTs: MSG_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBeUndefined();
  });

  test("the wake-parent stash is not used to thread a DM reply", async () => {
    setFlag(true);
    await preferThread();
    storeWakeParent({ orgId: DEMO_ORG.id, employeeId: "emp_comm", channelId: DM, parentTs: MSG_TS, eventId: "Ev_dm_inline" });
    mockSlack();
    const sent = await reply({ slackChannelId: DM });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBeUndefined();
  });

  test("a DM message already inside a thread (thread_ts ≠ ts) is answered in that thread", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: THREAD_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(THREAD_TS);
  });

  test("approved DM reply (fulfill path) also goes to the main flow", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const queued = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: null }, { informationClass: "confidential" });
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId || "");
    posts = [];
    const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(posts.length).toBe(1);
    expect(posts[0].thread_ts).toBeUndefined();
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(parseFulfillment(stored?.metadata)?.threadTsSource).toBeUndefined();
  });

  test("approved DM reply inside a thread stays in the thread", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const queued = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: THREAD_TS }, { informationClass: "confidential" });
    expect(queued.httpStatus).toBe(402);
    posts = [];
    const approved = await resolveApproval(String(queued.body.approvalId || ""), "approved", "ando@example.com", DEMO_ORG.id);
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(THREAD_TS);
  });
});

describe("flag ON: channels are unchanged", () => {
  test("channel reply under prefer_thread still threads under the message ts", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: "C_INTERNAL", ts: MSG_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].channel).toBe("C_INTERNAL");
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });

  test("channel reply with only messageTs still threads (existing fallback)", async () => {
    setFlag(true);
    mockSlack();
    const sent = await reply({ slackChannelId: "C_INTERNAL", messageTs: MSG_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });

  test("channel reply inside a thread keeps that thread", async () => {
    setFlag(true);
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: "C_INTERNAL", ts: MSG_TS, thread_ts: THREAD_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(THREAD_TS);
  });
});

describe("flag OFF: unchanged", () => {
  test("DM reply under prefer_thread threads under the message ts (as before)", async () => {
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: null });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });

  test("DM reply with thread_ts = ts threads (as before)", async () => {
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: MSG_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });

  test("DM reply uses the wake-parent stash under prefer_thread (as before)", async () => {
    await preferThread();
    storeWakeParent({ orgId: DEMO_ORG.id, employeeId: "emp_comm", channelId: DM, parentTs: MSG_TS, eventId: "Ev_dm_inline_off" });
    mockSlack();
    const sent = await reply({ slackChannelId: DM });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });

  test("approved DM reply threads under the message ts (as before)", async () => {
    await preferThread();
    mockSlack();
    const queued = await reply({ slackChannelId: DM, ts: MSG_TS, thread_ts: null }, { informationClass: "confidential" });
    expect(queued.httpStatus).toBe(402);
    posts = [];
    const approved = await resolveApproval(String(queued.body.approvalId || ""), "approved", "ando@example.com", DEMO_ORG.id);
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });

  test("channel reply under prefer_thread threads (as before)", async () => {
    await preferThread();
    mockSlack();
    const sent = await reply({ slackChannelId: "C_INTERNAL", ts: MSG_TS });
    expect(sent.body.ok).toBe(true);
    expect(posts[0].thread_ts).toBe(MSG_TS);
  });
});
