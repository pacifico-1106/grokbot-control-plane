/**
 * COMM_REPLY_DEDUP_ENABLED, approval fulfill: the hash-only ledger claim taken
 * by the dedup gate must never outlive a fulfill that did not post (木村 review
 * on #260). A leaked 'reserved' row would make every identical / similar body
 * in that conversation a duplicate for the whole window, so similar approvals
 * would be superseded without anything having been sent.
 *
 * Every exit between the claim and the post is pinned:
 *  - destination validation fails (slack_channel_required)   → no row
 *  - a throw before the post (thread / reply-policy lookup)   → row released
 *  - the post returns ok:false (provider error)               → row released
 *  - the post itself throws (outcome unknown)                 → row kept as 'uncertain'
 *  - the gate closes the approval (superseded)                → no row claimed
 * Plus: when the gate's DB close fails, the caller's in-memory copy keeps its
 * status (no approval.superseded audit for a close that did not happen).
 * Demo mode, dummy values, Slack fetch recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realSlack from "@/lib/gateway/adapters/slack";
import * as realReplyPolicy from "@/lib/data/reply-policy";
import * as realApprovals from "@/lib/data/approvals";

let postMode: "ok" | "fail" | "throw" = "ok";
const realPost = realSlack.postConversationMessage;
mock.module("@/lib/gateway/adapters/slack", () => ({
  ...realSlack,
  postConversationMessage: async (input: Parameters<typeof realPost>[0]) => {
    if (postMode === "throw") throw new Error("slack_socket_reset");
    if (postMode === "fail") return { ok: false as const, error: "slack_token_missing" };
    return realPost(input);
  },
}));
let replyPolicyThrows = false;
const realGetPolicy = realReplyPolicy.getEffectiveReplyPolicy;
mock.module("@/lib/data/reply-policy", () => ({
  ...realReplyPolicy,
  getEffectiveReplyPolicy: async (...args: Parameters<typeof realGetPolicy>) => {
    if (replyPolicyThrows) throw new Error("reply_policy_unavailable");
    return realGetPolicy(...args);
  },
}));
let closeFails = false;
const realClose = realApprovals.closeApprovalWithoutSend;
mock.module("@/lib/data/approvals", () => ({
  ...realApprovals,
  closeApprovalWithoutSend: async (input: Parameters<typeof realClose>[0]) => {
    if (closeFails) throw new Error("approval_close_failed");
    return realClose(input);
  },
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { fulfillApprovedInvoke } = await import("@/lib/approvals/fulfill");
const { getApprovalById, listAuditEvents, resolveApproval, updateApprovalMetadata } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { upsertOrgChannel } = await import("@/lib/data/directory");
const { demoCommReplySendsForTests, resetDemoCommReplySends } = await import("@/lib/data/comm-reply-sends");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type ApprovalRequest = import("@/lib/types").ApprovalRequest;

const FLAG = "COMM_REPLY_DEDUP_ENABLED";
const DM_A = "D0CLAIMLEAKA";
const DM_B = "D0CLAIMLEAKB";
const USER_ONLY = "U0CLAIMLEAK1";
// Re-written pair (3-gram Jaccard 0.720; keyed sketch ≥ 0.6) — same fixtures as comm-reply-supersede.
const TEXT_1 =
  "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しました。議題は来期の予算配分と採用計画の2点です。事前にお目通しいただき、ご不明点があればこのDMでお知らせください。";
const TEXT_2 =
  "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しております。議題は来期の予算配分と採用計画の2点です。事前にご確認いただき、ご不明な点があればこのDMでお知らせください。";

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string }> = [];
function recordSlack() {
  posts = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: `1791105${String(posts.length).padStart(3, "0")}.000001` });
    }
    if (url.includes("conversations.open")) return Response.json({ ok: true, channel: { id: "D0CLAIMLEAKU" } });
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}

beforeAll(async () => {
  for (const dm of [DM_A, DM_B]) {
    await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: dm, classification: "internal", mixed: false, skipInspect: true });
  }
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-claim-leak-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  postMode = "ok";
  replyPolicyThrows = false;
  closeFails = false;
  delete process.env[FLAG];
  resetDemoCommReplySends();
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_claimleak_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function convBody(tool: "comm.send" | "comm.reply", dm: string, text: string): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId: jid(tool.replace(".", "_")),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: dm, speakerId: "U_YAMADA" } as GatewayInvokeRequest["conversation"],
    args: { text },
  } as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });

async function queueApproved(dm: string, text: string): Promise<ApprovalRequest> {
  const res = await invoke(convBody("comm.send", dm, text)); // confidential default → needs approval
  expect(res.httpStatus).toBe(402);
  const approved = await resolveApproval(String(res.body.approvalId), "approved", "slack:U_APPROVER", DEMO_ORG.id);
  expect(approved?.status).toBe("approved");
  return approved!;
}
/** Re-point the stored snapshot at a user ID only (no channel), optionally with an explicit DM intent. */
async function retargetToUser(approval: ApprovalRequest, dmIntent: boolean): Promise<ApprovalRequest> {
  const invokeSnap = approval.metadata.invoke as Record<string, unknown>;
  const conversation = { ...(invokeSnap.conversation as Record<string, unknown>), slackUserId: USER_ONLY };
  delete conversation.slackChannelId;
  const args = { ...(invokeSnap.args as Record<string, unknown>), ...(dmIntent ? { dm: true } : {}) };
  const updated = await updateApprovalMetadata(approval, { invoke: { ...invokeSnap, conversation, args } });
  expect(updated).toBeTruthy();
  return (await getApprovalById(approval.id, DEMO_ORG.id))!;
}
const ledger = () => demoCommReplySendsForTests();

describe("fulfill never leaks the dedup claim (flag ON)", () => {
  test("destination validation fails → no ledger row; a similar DM-intent approval to the same user is then sent", async () => {
    process.env[FLAG] = "true";
    recordSlack();
    const a = await retargetToUser(await queueApproved(DM_A, TEXT_1), false);
    const b = await retargetToUser(await queueApproved(DM_B, TEXT_2), true);
    expect(ledger().length).toBe(0);

    const first = await fulfillApprovedInvoke(a);
    expect(first).toMatchObject({ ok: false, error: "slack_channel_required" });
    expect(posts.length).toBe(0);
    expect(ledger()).toEqual([]);

    const second = await fulfillApprovedInvoke(b);
    expect(second?.ok).toBe(true);
    expect(posts.length).toBe(1);
    expect((await getApprovalById(b.id, DEMO_ORG.id))?.status).toBe("approved");
    expect(ledger().map((r) => r.state)).toEqual(["sent"]);
  });

  test("a throw before the post (reply-policy lookup) releases the claim — nothing was posted; a retry is not a duplicate", async () => {
    process.env[FLAG] = "true";
    recordSlack();
    const a = await queueApproved(DM_A, TEXT_1);
    replyPolicyThrows = true;
    const first = await fulfillApprovedInvoke(a);
    expect(first).toMatchObject({ ok: false, error: "reply_policy_unavailable" });
    expect(posts.length).toBe(0);
    expect(ledger()).toEqual([]);

    // A similar approval in the same DM is not blocked by a phantom send.
    replyPolicyThrows = false;
    const b = await queueApproved(DM_A, TEXT_2);
    expect((await fulfillApprovedInvoke(b))?.ok).toBe(true);
    expect(posts.length).toBe(1);
  });

  test("the post returns ok:false → the claim is released", async () => {
    process.env[FLAG] = "true";
    recordSlack();
    const a = await queueApproved(DM_A, TEXT_1);
    postMode = "fail";
    expect(await fulfillApprovedInvoke(a)).toMatchObject({ ok: false, error: "slack_token_missing" });
    expect(ledger()).toEqual([]);
  });

  test("the post itself throws (outcome unknown) → the claim is kept as 'uncertain' (never re-sent blindly)", async () => {
    process.env[FLAG] = "true";
    recordSlack();
    const a = await queueApproved(DM_A, TEXT_1);
    postMode = "throw";
    expect(await fulfillApprovedInvoke(a)).toMatchObject({ ok: false, error: "slack_socket_reset" });
    expect(ledger().map((r) => r.state)).toEqual(["uncertain"]);
  });

  test("the gate closes the approval (similar reply already sent) → no claim row for it", async () => {
    process.env[FLAG] = "true";
    recordSlack();
    const a = await queueApproved(DM_A, TEXT_1);
    expect((await invoke(convBody("comm.reply", DM_A, TEXT_2))).httpStatus).toBe(200);
    expect(ledger().length).toBe(1);
    expect(await fulfillApprovedInvoke(a)).toMatchObject({ ok: false, error: "approval_superseded" });
    expect(ledger().length).toBe(1);
    expect(posts.length).toBe(1);
  });
});

describe("closeAtFulfill: a failed DB close does not change the caller's copy", () => {
  test("superseded at fulfill but the close fails → nothing sent, status stays approved (memory and store), no superseded audit", async () => {
    process.env[FLAG] = "true";
    recordSlack();
    const a = await queueApproved(DM_A, TEXT_1);
    expect((await invoke(convBody("comm.reply", DM_A, TEXT_2))).httpStatus).toBe(200);
    closeFails = true;
    const result = await fulfillApprovedInvoke(a);
    expect(result).toMatchObject({ ok: false, error: "approval_superseded" });
    expect(posts.length).toBe(1);
    expect(a.status).toBe("approved");
    expect((await getApprovalById(a.id, DEMO_ORG.id))?.status).toBe("approved");
    const events = await listAuditEvents(DEMO_ORG.id, 200);
    expect(events.some((e) => e.action === "approval.superseded" && e.metadata?.approvalId === a.id)).toBe(false);
  });
});
