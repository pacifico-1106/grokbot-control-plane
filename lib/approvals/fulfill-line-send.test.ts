/**
 * L-6: post-approval LINE send goes through sendLineConversationMessage.
 * Slack post-approval send stays unchanged. An "unknown" outcome is recorded
 * and never retried automatically.
 */
import { mock } from "bun:test";

type LineSendCall = { token?: string | null; externalSendAllowed: boolean; retryKey: string; text: unknown };
type LineSendResult =
  | { status: "sent"; audience: "internal" | "external"; mode: "reply" | "push" }
  | { status: "not_sent"; reason: string }
  | { status: "unknown"; reason: string; audience: "internal" | "external"; mode: "reply" | "push" };

const sends: LineSendCall[] = [];
let nextSend: LineSendResult = { status: "sent", audience: "external", mode: "push" };
mock.module("@/lib/comm/line-send", () => ({
  sendLineConversationMessage: async (input: LineSendCall) => {
    sends.push(input);
    return nextSend;
  },
  __resetLineSendForTests: () => undefined,
}));

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { createApproval, getApprovalById, resolveApproval } from "@/lib/data/approvals";
import { buildInvokeSnapshot, fulfillIfApproved, parseFulfillment } from "@/lib/approvals/fulfill";
import { parseConversationContext } from "@/lib/gateway/audience";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel } from "@/lib/data/directory";
import { approvalSendOutcome } from "@/lib/approvals/not-sent";
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";

const DM = "D0L6FULFILL1";
const LINE_USER = "Uaaaabbbbccccddddeeeeffff0000l6f1";
const TEXT = "承認後に送る本文です。記録しないでください";
const TOKEN = `spc1.${"C".repeat(40)}.${"D".repeat(43)}`;
const originalFetch = globalThis.fetch;
let posts = 0;

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-l6-fulfill" } });
});
beforeEach(() => {
  sends.length = 0;
  nextSend = { status: "sent", audience: "external", mode: "push" };
  posts = 0;
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      posts += 1;
      const body = JSON.parse(String(init?.body || "{}")) as { channel?: string };
      return Response.json({ ok: true, channel: body.channel, ts: `1791300000.${String(posts).padStart(6, "0")}` });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.LINE_CONVERSATION_ENABLED;
  delete process.env.COMM_ACCOUNTS_ENABLED;
});

async function seedLineApproval(): Promise<ApprovalRequest> {
  const body = {
    tool: "comm.reply",
    purpose: "comm.internal",
    jobId: `job_l6f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversation: { orgId: DEMO_ORG.id, surface: "line", lineId: LINE_USER, token: TOKEN },
    args: { text: TEXT },
  } as unknown as GatewayInvokeRequest;
  const created = await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm",
    title: "comm.reply", purpose: body.purpose, summary: "LINE 送信の承認", risk: "high",
    tool: "comm.reply", jobId: String(body.jobId),
    metadata: {
      invoke: buildInvokeSnapshot({
        tool: "comm.reply", purpose: body.purpose, jobId: String(body.jobId),
        employeeId: "emp_comm", orgId: DEMO_ORG.id, body,
        conversation: parseConversationContext(body, DEMO_ORG.id),
      }),
    },
  });
  return (await resolveApproval(created.approval.id, "approved", "slack:U_APPROVER", DEMO_ORG.id)) as ApprovalRequest;
}

describe("post-approval LINE send", () => {
  test("approved LINE ticket → sendLineConversationMessage, delivery line, sent:true", async () => {
    const approved = await seedLineApproval();
    const f = await fulfillIfApproved(approved, "approved");
    expect(f?.ok).toBe(true);
    expect(f?.delivery).toBe("line");
    expect(sends).toHaveLength(1);
    expect(sends[0].externalSendAllowed).toBe(true);
    expect(sends[0].token).toBe(TOKEN);
    expect(posts).toBe(0);
    const row = await getApprovalById(approved.id, DEMO_ORG.id);
    expect(approvalSendOutcome(row!).sent).toBe(true);
    expect(approvalSendOutcome(row!).reasonCode).toBeNull();
    expect(JSON.stringify(f)).not.toContain(TEXT);
  });

  test("unknown → recorded, second fulfill does not send again", async () => {
    nextSend = { status: "unknown", reason: "line_network_error", audience: "external", mode: "reply" };
    const approved = await seedLineApproval();
    const first = await fulfillIfApproved(approved, "approved");
    expect(first?.ok).toBe(false);
    expect(first?.error).toBe("post_outcome_unknown");
    expect(sends).toHaveLength(1);
    const row = await getApprovalById(approved.id, DEMO_ORG.id);
    expect(parseFulfillment(row?.metadata)?.error).toBe("post_outcome_unknown");
    expect(approvalSendOutcome(row!).sent).toBe(false);
    expect(approvalSendOutcome(row!).reasonCode).toBe("post_outcome_unknown");
    const second = await fulfillIfApproved(row as ApprovalRequest, "approved");
    expect(second?.error).toBe("post_outcome_unknown");
    expect(sends).toHaveLength(1);
  });
});

describe("lock-in: Slack post-approval send unchanged", () => {
  test("approved Slack DM still posts once", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const body = {
      tool: "comm.reply", purpose: "comm.internal", jobId: `job_l6s_${Date.now()}`,
      conversation: { orgId: DEMO_ORG.id, surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" },
      args: { text: TEXT },
    } as unknown as GatewayInvokeRequest;
    const created = await createApproval({
      orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm",
      title: "comm.reply", purpose: body.purpose, summary: "Slack 送信", risk: "high",
      tool: "comm.reply", jobId: String(body.jobId),
      metadata: {
        invoke: buildInvokeSnapshot({
          tool: "comm.reply", purpose: body.purpose, jobId: String(body.jobId),
          employeeId: "emp_comm", orgId: DEMO_ORG.id, body,
          conversation: parseConversationContext(body, DEMO_ORG.id),
        }),
      },
    });
    const approved = await resolveApproval(created.approval.id, "approved", "slack:U_APPROVER", DEMO_ORG.id);
    expect((await fulfillIfApproved(approved as ApprovalRequest, "approved"))?.ok).toBe(true);
    expect(posts).toBe(1);
    expect(sends).toEqual([]);
  });
});
