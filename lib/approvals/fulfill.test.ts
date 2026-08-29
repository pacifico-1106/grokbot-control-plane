import { afterEach, describe, expect, test } from "bun:test";
import {
  fulfillApprovedInvoke,
  fulfillIfApproved,
  parseFulfillment,
  parseInvokeSnapshot,
} from "@/lib/approvals/fulfill";
import {
  createApproval,
  getApprovalById,
  resolveApproval,
} from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { DEMO_ORG } from "@/lib/demo-data";
import type { GatewayInvokeRequest } from "@/lib/types";
import { runGatewayInvoke } from "@/lib/gateway/invoke";

const originalFetch = globalThis.fetch;
const savedEnv = {
  slack: process.env.SLACK_BOT_TOKEN,
  conversation: process.env.SLACK_CONVERSATION_BOT_TOKEN,
};

function restoreEnv() {
  if (savedEnv.slack === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = savedEnv.slack;
  if (savedEnv.conversation === undefined) {
    delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  } else {
    process.env.SLACK_CONVERSATION_BOT_TOKEN = savedEnv.conversation;
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restoreEnv();
  await upsertConversationAdapter({
    orgId: DEMO_ORG.id,
    surface: "slack",
    enabled: false,
    secrets: {},
  });
});

const THREAD_TS = "1787911797.502889";
const BODY_TEXT = "メンションへの返信本文です。承認後にそのまま投稿してください。";

async function queueMentionReply(text = BODY_TEXT) {
  const jobId = `job_fulfill_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const body = {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId,
    conversation: {
      surface: "slack" as const,
      orgId: DEMO_ORG.id,
      slackChannelId: "C_INTERNAL",
      threadId: THREAD_TS,
    },
    informationClass: "confidential" as const,
    args: {
      slackChannelId: "C_INTERNAL",
      text,
      threadId: THREAD_TS,
    },
  };
  const queued = await runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body,
  });
  return { queued, body, jobId };
}

function mockSlackPost(ts = "1787911800.000001") {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  let postCount = 0;
  let postedPayload: Record<string, unknown> = {};
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      postCount += 1;
      postedPayload = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return Response.json({
        ok: true,
        channel: "C_INTERNAL",
        ts,
      });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
  return {
    ts,
    posted: () => postedPayload,
    count: () => postCount,
  };
}

describe("approval invoke snapshot + fulfill", () => {
  test("creating needs_approval stores snapshot with channel + body", async () => {
    const { queued } = await queueMentionReply();
    expect(queued.httpStatus).toBe(402);
    expect(queued.body.needs_approval).toBe(true);
    const approvalId = String(queued.body.approvalId || "");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(stored).toBeTruthy();
    const snapshot = parseInvokeSnapshot(stored?.metadata);
    expect(snapshot?.tool).toBe("comm.reply");
    expect(snapshot?.conversation?.slackChannelId).toBe("C_INTERNAL");
    expect(snapshot?.conversation?.threadId).toBe(THREAD_TS);
    expect(snapshot?.args.text).toBe(BODY_TEXT);
    expect(snapshot?.postingAs).toBe("bot");
    expect(snapshot?.informationClass).toBe("confidential");
    expect(stored?.metadata.artifact).toBeTruthy();
    expect(stored?.metadata.egress).toBeTruthy();
    expect(stored?.metadata.sodVerdict).toBeTruthy();
  });

  test("approving calls chat.postMessage and stores ts", async () => {
    const { queued } = await queueMentionReply();
    const approvalId = String(queued.body.approvalId || "");
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-fulfill-test" },
    });
    const slack = mockSlackPost();
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    expect(approved?.status).toBe("approved");
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(slack.count()).toBe(1);
    expect(slack.posted().channel).toBe("C_INTERNAL");
    expect(slack.posted().thread_ts).toBe(THREAD_TS);
    expect(String(slack.posted().text)).toBe(BODY_TEXT);
    expect(String(slack.posted().text)).not.toContain("【要約のみ】");
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.delivery).toBe("slack");
    expect(fulfillment?.ts).toBe(slack.ts);
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(parseFulfillment(stored?.metadata)?.ts).toBe(slack.ts);
  });

  test("second approve / re-invoke does not post twice", async () => {
    const { queued, body } = await queueMentionReply();
    const approvalId = String(queued.body.approvalId || "");
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-fulfill-test" },
    });
    const slack = mockSlackPost("1787911801.000002");
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    await fulfillApprovedInvoke(approved!);
    expect(slack.count()).toBe(1);

    const secondFulfill = await fulfillApprovedInvoke(approved!);
    expect(secondFulfill?.ok).toBe(true);
    expect(slack.count()).toBe(1);

    const secondApprove = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    expect(secondApprove).toBeNull();
    expect(slack.count()).toBe(1);

    const sent = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: { ...body, approvalId },
    });
    expect(sent.body.ok).toBe(true);
    expect(slack.count()).toBe(1);
    const delivery = sent.body.conversationDelivery as
      | { delivery?: string; ts?: string }
      | undefined;
    expect(delivery?.delivery).toBe("slack");
    expect(delivery?.ts).toBe("1787911801.000002");
  });

  test("reject does not post", async () => {
    const { queued } = await queueMentionReply();
    const approvalId = String(queued.body.approvalId || "");
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-fulfill-test" },
    });
    const slack = mockSlackPost();
    const rejected = await resolveApproval(
      approvalId,
      "rejected",
      "ando@example.com",
      DEMO_ORG.id
    );
    expect(rejected?.status).toBe("rejected");
    const skipped = await fulfillIfApproved(rejected!, "rejected");
    expect(skipped).toBeNull();
    const guarded = await fulfillApprovedInvoke(rejected!);
    expect(guarded).toBeNull();
    expect(slack.count()).toBe(0);
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(parseFulfillment(stored?.metadata)).toBeNull();
  });

  test("missing snapshot does not throw", async () => {
    const created = await createApproval({
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      title: "legacy ticket",
      purpose: "comm.internal",
      summary: "old ticket without invoke snapshot",
      risk: "medium",
      tool: "comm.reply",
      jobId: `job_legacy_${Date.now()}`,
      metadata: { artifact: { body: "legacy body" } },
    });
    const approved = await resolveApproval(
      created.approval.id,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    expect(approved?.status).toBe("approved");
    const slack = mockSlackPost();
    const result = await fulfillApprovedInvoke(approved!);
    expect(result).toBeNull();
    expect(slack.count()).toBe(0);
  });

  test("slackThreadTs alias is snapshotted as threadId and posted on approve", async () => {
    const jobId = `job_fulfill_alias_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const queued = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
          slackThreadTs: THREAD_TS,
        } as GatewayInvokeRequest["conversation"],
        informationClass: "confidential",
        args: {
          slackChannelId: "C_INTERNAL",
          text: BODY_TEXT,
          slackThreadTs: THREAD_TS,
        },
      },
    });
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId || "");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    const snapshot = parseInvokeSnapshot(stored?.metadata);
    expect(snapshot?.conversation?.threadId).toBe(THREAD_TS);
    expect(snapshot?.args.slackThreadTs).toBe(THREAD_TS);

    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-fulfill-alias" },
    });
    const slack = mockSlackPost("1787960100.000010");
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(slack.count()).toBe(1);
    expect(slack.posted().thread_ts).toBe(THREAD_TS);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.delivery).toBe("slack");
  });

  test("fulfill snapshot preserves mention messageTs as thread_ts and posts into it", async () => {
    const mentionTs = "1787960001.111111";
    const jobId = `job_fulfill_mention_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const queued = await runGatewayInvoke({
      employeeId: "emp_comm",
      credentialId: "cred_comm",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId,
        conversation: {
          surface: "slack",
          orgId: DEMO_ORG.id,
          slackChannelId: "C_INTERNAL",
        },
        informationClass: "confidential",
        args: {
          slackChannelId: "C_INTERNAL",
          text: BODY_TEXT,
          messageTs: mentionTs,
        },
      },
    });
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId || "");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    const snapshot = parseInvokeSnapshot(stored?.metadata);
    expect(snapshot?.conversation?.threadId).toBe(mentionTs);
    expect(snapshot?.args.messageTs).toBe(mentionTs);

    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-fulfill-mention" },
    });
    const slack = mockSlackPost("1787960101.000011");
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(slack.count()).toBe(1);
    expect(slack.posted().thread_ts).toBe(mentionTs);
    expect(slack.posted().channel).toBe("C_INTERNAL");
    expect(fulfillment?.ok).toBe(true);
  });

  test("failed Slack post keeps approval approved and stores error", async () => {
    const { queued } = await queueMentionReply();
    const approvalId = String(queued.body.approvalId || "");
    await upsertConversationAdapter({
      orgId: DEMO_ORG.id,
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-fulfill-test" },
    });
    globalThis.fetch = (async (input) => {
      if (String(input).includes("chat.postMessage")) {
        return Response.json({ ok: false, error: "not_in_channel" });
      }
      return Response.json({ ok: false, error: "unexpected_fetch" });
    }) as typeof fetch;
    const approved = await resolveApproval(
      approvalId,
      "approved",
      "ando@example.com",
      DEMO_ORG.id
    );
    const fulfillment = await fulfillApprovedInvoke(approved!);
    expect(fulfillment?.ok).toBe(false);
    expect(fulfillment?.error).toBe("slack_not_in_channel");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(stored?.status).toBe("approved");
    expect(parseFulfillment(stored?.metadata)?.error).toBe("slack_not_in_channel");
  });
});
