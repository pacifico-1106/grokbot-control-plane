/**
 * 2026-10-04 (木村 decision 3): a re-run after approval posts ONLY the approved text.
 *
 * Hole found in #249: approval time had no Slack token → fulfillment was recorded
 * as `{ ok:true, delivery:"stub" }` (nothing sent). By the re-run a token exists,
 * `conversationDeliveryFromFulfillment` returns null for a stub, and invoke then
 * posted the re-run REQUEST's text instead of the approved snapshot.
 *
 * Locked in for comm.reply / comm.send / slack.post / slack.post_external:
 *  A. approval-time stub + token at re-run + replacement text → request text is never posted.
 *  B. production no-token at approval (simulated: postConversationMessage → slack_token_missing)
 *     → failure recorded on the approval; re-run without token → 409 slack_token_missing;
 *     re-run with token → the APPROVED text is posted once, never the replacement.
 * Plus decision 4: the always_human 402 wording fits conversation tools.
 * Demo mode, dummy values, Slack fetch recorded, no network.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as realSlack from "@/lib/gateway/adapters/slack";

let simulateProdTokenMissing = false;
let simulatedCode = "slack_token_missing";
const realPost = realSlack.postConversationMessage; // captured before the mock replaces the binding
mock.module("@/lib/gateway/adapters/slack", () => ({
  ...realSlack,
  postConversationMessage: async (input: Parameters<typeof realPost>[0]) =>
    simulateProdTokenMissing ? { ok: false as const, error: simulatedCode } : realPost(input),
}));

const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { fulfillIfApproved, parseFulfillment } = await import("@/lib/approvals/fulfill");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;

const APPROVED_TEXT = "承認された本文です（ダミー）";
const REPLACEMENT_TEXT = "差し替えた本文です（承認されていない）";
const TOOLS = ["comm.reply", "comm.send", "slack.post", "slack.post_external"] as const;

const originalFetch = globalThis.fetch;
let posts: string[] = [];
function recordSlack() {
  posts = [];
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("chat.postMessage")) {
      posts.push(String((JSON.parse(String(init?.body || "{}")) as { text?: string }).text || ""));
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000099" });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) =>
  upsertConversationAdapter({
    orgId: DEMO_ORG.id,
    surface: "slack",
    enabled,
    secrets: enabled ? { botToken: "xoxb-rerun-test" } : {},
  });

const restorers: Array<() => void> = [];
afterEach(async () => {
  simulateProdTokenMissing = false;
  simulatedCode = "slack_token_missing";
  while (restorers.length) restorers.pop()!();
  globalThis.fetch = originalFetch;
  await setToken(false).catch(() => undefined);
});

const jid = (s: string) => `job_rerun_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function commBody(tool: string, text = APPROVED_TEXT): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId: jid(tool.replace(".", "_")),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text, threadId: "1787911797.502889" },
  };
}
const invokeComm = (body: GatewayInvokeRequest) =>
  runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });

async function queueAndApprove(tool: string) {
  const body = commBody(tool);
  const queued = await invokeComm(body);
  expect(queued.httpStatus).toBe(402);
  const approvalId = String(queued.body.approvalId);
  const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
  expect(approved?.status).toBe("approved");
  // Same entry point as the approval callbacks (Slack / Telegram / LINE / web).
  const fulfillment = await fulfillIfApproved(approved!, "approved");
  return { body, approvalId, fulfillment };
}

const rerunWithReplacement = (body: GatewayInvokeRequest, approvalId: string) =>
  invokeComm({ ...body, args: { ...(body.args as Record<string, unknown>), text: REPLACEMENT_TEXT }, approvalId });

describe("A. approval-time stub, token present at re-run: the request text is never posted", () => {
  for (const tool of TOOLS) {
    test(`${tool}: re-run with a replacement text posts nothing from the request (before: posted it)`, async () => {
      recordSlack();
      const { body, approvalId, fulfillment } = await queueAndApprove(tool);
      expect(fulfillment).toMatchObject({ ok: true, delivery: "stub" }); // demo: nothing sent, no token
      await setToken(true);
      const rerun = await rerunWithReplacement(body, approvalId);
      expect(posts.filter((text) => text.includes(REPLACEMENT_TEXT))).toEqual([]);
      expect(posts.every((text) => text.includes(APPROVED_TEXT))).toBe(true);
      expect(rerun.httpStatus).toBe(200);
    });
  }
});

describe("B. production no-token at approval: recorded failure, re-run posts the approved text only", () => {
  for (const tool of TOOLS) {
    test(`${tool}: failure recorded → re-run w/o token 409 → re-run with token posts the approved text once`, async () => {
      recordSlack();
      simulateProdTokenMissing = true;
      const { body, approvalId, fulfillment } = await queueAndApprove(tool);
      expect(fulfillment).toMatchObject({ ok: false, error: "slack_token_missing" });

      const stored = await getApprovalById(approvalId, DEMO_ORG.id);
      expect(parseFulfillment(stored?.metadata)).toMatchObject({ ok: false, error: "slack_token_missing" });
      const events = await listAuditEvents(DEMO_ORG.id, 500);
      expect(events.some((e) => e.action === "slack.post_failed" && e.metadata?.approvalId === approvalId)).toBe(true);
      expect((stored?.metadata as { stuckWatch?: { w2?: { firstDetectedAt?: string } } })?.stuckWatch?.w2?.firstDetectedAt).toBeTruthy();

      // Still no token: the re-run is a clear failure, not a fake ok.
      const stillMissing = await rerunWithReplacement(body, approvalId);
      expect(stillMissing.httpStatus).toBe(409);
      expect(stillMissing.body.code).toBe("slack_token_missing");
      expect(posts).toEqual([]);

      // Token registered: the claim was "failed" (retryable), so the snapshot is posted.
      simulateProdTokenMissing = false;
      await setToken(true);
      const rerun = await rerunWithReplacement(body, approvalId);
      expect(rerun.httpStatus).toBe(200);
      expect(posts.length).toBe(1);
      expect(posts[0]).toContain(APPROVED_TEXT);
      expect(posts[0]).not.toContain(REPLACEMENT_TEXT);
      const after = await getApprovalById(approvalId, DEMO_ORG.id);
      expect(parseFulfillment(after?.metadata)).toMatchObject({ ok: true, delivery: "slack" });

      // A further re-run is idempotent: nothing new is posted.
      const again = await rerunWithReplacement(body, approvalId);
      expect(again.httpStatus).toBe(200);
      expect(posts.length).toBe(1);
    });
  }
});

describe("B'. shared-approval-only org (#248 code) is retryable too", () => {
  test("comm.reply: slack_conversation_bot_token_missing at approval → re-run with a token posts the approved text", async () => {
    recordSlack();
    simulateProdTokenMissing = true;
    simulatedCode = "slack_conversation_bot_token_missing";
    const { body, approvalId, fulfillment } = await queueAndApprove("comm.reply");
    expect(fulfillment).toMatchObject({ ok: false, error: "slack_conversation_bot_token_missing" });
    simulateProdTokenMissing = false;
    await setToken(true);
    // Before: the claim was left "uncertain" → approval_execution_uncertain, never retried.
    const rerun = await rerunWithReplacement(body, approvalId);
    expect(rerun.httpStatus).toBe(200);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain(APPROVED_TEXT);
    expect(posts[0]).not.toContain(REPLACEMENT_TEXT);
  });
});

describe("decision 1 at invoke: a direct post with no token is a clear failure", () => {
  for (const tool of TOOLS) {
    test(`${tool}: production no-token → 502 code slack_token_missing (before: code slack_post_failed)`, async () => {
      recordSlack();
      simulateProdTokenMissing = true;
      const r = await invokeComm({ ...commBody(tool), informationClass: "internal" });
      if (tool === "comm.send") {
        // comm.send to this channel needs approval in the demo fixture; its no-token path is B above.
        expect(r.httpStatus).toBe(402);
        return;
      }
      expect(r.httpStatus).toBe(502);
      expect(r.body.ok).toBe(false);
      expect(r.body.code).toBe("slack_token_missing");
      expect(r.body.error).toBe("slack_token_missing");
      expect(String(r.body.message)).toContain("トークン");
      expect(posts).toEqual([]);
      const events = await listAuditEvents(DEMO_ORG.id, 200);
      expect(events.some((e) => e.action === "slack.post_failed" && e.metadata?.jobId === r.body.jobId && e.metadata?.code === "slack_token_missing")).toBe(true);
    });
  }
});

describe("decision 4: always_human 402 wording fits conversation tools", () => {
  test("comm.reply under always_human no longer says 'default for confirm/send/order'", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
    const previous = emp.approvalPolicy;
    emp.approvalPolicy = "always_human";
    restorers.push(() => { emp.approvalPolicy = previous; });
    recordSlack();
    const body: GatewayInvokeRequest = { ...commBody("comm.reply"), informationClass: "internal" };
    const r = await invokeComm(body);
    expect(r.httpStatus).toBe(402);
    const message = String(r.body.message || "");
    expect(message).not.toContain("default for confirm/send/order");
    expect(message).toContain("comm.reply requires human approval (always_human");
    expect(message).toContain("conversation posts");
    expect(posts).toEqual([]);
  });
});
