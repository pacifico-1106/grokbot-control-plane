/**
 * Each surface's real webhook entry point hands join events to the shared
 * flow (PR-B): Slack Events (member_joined_channel), LINE webhook (join),
 * Telegram per-inbox webhook (my_chat_member). Signature / secret checks stay
 * first; flag OFF → nothing new happens.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

const realData = await import("@/lib/data");
const LINE_CHANNEL = {
  id: "nc_line_fixture", orgId: "org_demo_placeholder", provider: "line", label: "line", enabled: true, isDefault: false,
  config: { destinationId: "Capprovalgroup01", allowedUserIds: [] },
  secrets: { channelSecret: "line-secret-fixture", channelAccessToken: "line-token-fixture" },
};
const TG_CHANNEL = {
  id: "nc_tg_fixture", orgId: "org_demo_placeholder", provider: "telegram", label: "tg", enabled: true, isDefault: false,
  config: { chatId: "-100111", allowedUserIds: ["9001"] },
  secrets: { botToken: "tg-token-fixture", webhookSecret: "tg-secret-fixture" },
};
mock.module("@/lib/data", () => ({
  ...realData,
  getNotificationChannelByWebhookRef: async (provider: string, ref: string) =>
    provider === "line" && ref === "lineref" ? LINE_CHANNEL : provider === "telegram" && ref === "tgref" ? TG_CHANNEL : null,
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
LINE_CHANNEL.orgId = DEMO_ORG.id;
TG_CHANNEL.orgId = DEMO_ORG.id;
const { getApprovalById, listApprovals } = realData;
const { processSlackMentionEnvelope } = await import("@/lib/slack/mention-ingress");
const { POST: linePost } = await import("@/app/api/webhooks/line/[ref]/route");
const { POST: telegramPost } = await import("@/app/api/webhooks/telegram/[ref]/route");
const { setJoinDepsForTests } = await import("@/lib/channel-classify/join");
const { setChannelFactsDepsForTests } = await import("@/lib/channel-classify/facts");
const { setProposalDepsForTests } = await import("@/lib/channel-classify/proposals");
const { resetDemoChannelClassifyStore } = await import("@/lib/data/channel-classify");

function proposalsFor(all: Awaited<ReturnType<typeof listApprovals>>, externalId: string) {
  return all.filter((a) => (a.metadata?.channelClassifyProposal as { externalId?: string } | undefined)?.externalId === externalId);
}

beforeEach(() => {
  process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED = "true";
  resetDemoChannelClassifyStore();
  setProposalDepsForTests({ notifyApproval: async () => true });
  setChannelFactsDepsForTests({
    resolveToken: async () => "xoxb-fixture",
    homeTeamIds: async () => ["T0WIRETEAM"],
    slackApi: async (method, params) => {
      if (method === "conversations.info") return { ok: true, channel: { id: params.channel, is_channel: true, is_private: false, is_shared: false, is_ext_shared: false } };
      if (method === "conversations.members") return { ok: true, members: ["U0WIREEMP"], response_metadata: { next_cursor: "" } };
      if (method === "users.info") return { ok: true, user: { id: params.user, team_id: "T0WIRETEAM" } };
      return { ok: false };
    },
  });
  setJoinDepsForTests({
    findEmployeeOrgsBySlackUser: async (userId) => (userId === "U0WIREEMP" ? [{ orgId: DEMO_ORG.id, employeeId: "emp_comm" }] : []),
    findOrgsBySlackTeam: async () => [],
    adapterBotIdentity: async () => ({ appId: "A0WIREAPP", botUserId: "U0WIREBOT", teamId: "T0WIRETEAM" }),
  });
});

afterEach(() => {
  delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
  setProposalDepsForTests(null);
  setChannelFactsDepsForTests(null);
  setJoinDepsForTests(null);
});

describe("Slack Events → shared flow", () => {
  const envelope = (channel: string) => ({
    type: "event_callback",
    team_id: "T0WIRETEAM",
    api_app_id: "A0WIREAPP",
    authorizations: [{ team_id: "T0WIRETEAM", user_id: "U0WIREBOT", is_bot: true }],
    event_id: `EvWire${channel}`,
    event: { type: "member_joined_channel", user: "U0WIREEMP", channel, channel_type: "C", team: "T0WIRETEAM" },
  });

  test("member_joined_channel creates a proposal (no wake)", async () => {
    const outcome = await processSlackMentionEnvelope(envelope("C0WIRE0001") as never);
    expect(outcome.woke).toBe(0);
    expect(outcome.skipReason).toBe("channel_join");
    expect(proposalsFor(await listApprovals(DEMO_ORG.id), "C0WIRE0001").length).toBe(1);
  });

  test("flag OFF → unsupported_event_type as before, nothing created", async () => {
    delete process.env.CHANNEL_CLASSIFY_PROPOSALS_ENABLED;
    const outcome = await processSlackMentionEnvelope(envelope("C0WIRE0002") as never);
    expect(outcome.skipReason).toBe("unsupported_event_type");
    expect(proposalsFor(await listApprovals(DEMO_ORG.id), "C0WIRE0002").length).toBe(0);
  });
});

describe("LINE webhook → shared flow", () => {
  function lineRequest(body: unknown, signature?: string) {
    const raw = JSON.stringify(body);
    const sig = signature ?? createHmac("sha256", "line-secret-fixture").update(raw).digest("base64");
    return new Request("https://example.test/api/webhooks/line/lineref", { method: "POST", body: raw, headers: { "x-line-signature": sig } });
  }

  test("join to a new group (not the approval group) → proposal", async () => {
    const res = await linePost(lineRequest({ events: [{ type: "join", source: { type: "group", groupId: "Cwirelinegroup1" } }] }), { params: Promise.resolve({ ref: "lineref" }) });
    expect(res.status).toBe(200);
    const rows = proposalsFor(await listApprovals(DEMO_ORG.id), "Cwirelinegroup1");
    expect(rows.length).toBe(1);
    expect((await getApprovalById(rows[0].id, DEMO_ORG.id))?.metadata?.adminTool).toBe("channels.classify");
  });

  test("bad signature → 401 and nothing; the approval group itself is not proposed", async () => {
    const bad = await linePost(lineRequest({ events: [{ type: "join", source: { type: "group", groupId: "Cwirelinegroup2" } }] }, "bad"), { params: Promise.resolve({ ref: "lineref" }) });
    expect(bad.status).toBe(401);
    await linePost(lineRequest({ events: [{ type: "join", source: { type: "group", groupId: "Capprovalgroup01" } }] }), { params: Promise.resolve({ ref: "lineref" }) });
    const all = await listApprovals(DEMO_ORG.id);
    expect(proposalsFor(all, "Cwirelinegroup2").length).toBe(0);
    expect(proposalsFor(all, "Capprovalgroup01").length).toBe(0);
  });
});

describe("Telegram webhook → shared flow", () => {
  function tgRequest(body: unknown, secret = "tg-secret-fixture") {
    return new Request("https://example.test/api/webhooks/telegram/tgref", { method: "POST", body: JSON.stringify(body), headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" } });
  }
  const added = (chatId: number, fromId = 9001) => ({
    my_chat_member: {
      chat: { id: chatId, type: "group" },
      from: { id: fromId, is_bot: false },
      old_chat_member: { status: "left", user: { id: 7, is_bot: true } },
      new_chat_member: { status: "member", user: { id: 7, is_bot: true } },
    },
  });

  test("my_chat_member (bot added to a group) → proposal", async () => {
    const res = await telegramPost(tgRequest(added(-100222)), { params: Promise.resolve({ ref: "tgref" }) });
    expect(res.status).toBe(200);
    expect(proposalsFor(await listApprovals(DEMO_ORG.id), "-100222").length).toBe(1);
  });

  test("follow-up H1: an adder who is not a known member → 200, nothing proposed", async () => {
    const res = await telegramPost(tgRequest(added(-100444, 123456)), { params: Promise.resolve({ ref: "tgref" }) });
    expect(res.status).toBe(200);
    expect(proposalsFor(await listApprovals(DEMO_ORG.id), "-100444").length).toBe(0);
  });

  test("wrong secret → 401; the approval chat itself is not proposed", async () => {
    const bad = await telegramPost(tgRequest(added(-100333), "nope"), { params: Promise.resolve({ ref: "tgref" }) });
    expect(bad.status).toBe(401);
    await telegramPost(tgRequest(added(-100111)), { params: Promise.resolve({ ref: "tgref" }) });
    const all = await listApprovals(DEMO_ORG.id);
    expect(proposalsFor(all, "-100333").length).toBe(0);
    expect(proposalsFor(all, "-100111").length).toBe(0);
  });
});
