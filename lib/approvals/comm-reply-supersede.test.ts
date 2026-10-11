/**
 * COMM_REPLY_DEDUP_ENABLED: held conversation approvals never go out after the
 * conversation already moved on.
 *
 * Reproduction of the 2026-10-04 incident (any tenant): an AI employee queued
 * comm.send approvals to two DMs (twice each, re-written), then sent comm.reply
 * to the same DMs (auto-allowed). 18 min later the held approvals were approved
 * and fulfilled → 4 extra messages. With the flag ON:
 *  - a newer approval request supersedes the older pending one (same conversation)
 *  - a sent reply supersedes pending approvals for that conversation
 *  - fulfill re-checks: a reply already sent after the approval was created → superseded, not sent
 *  - pending conversation approvals expire (default 24 h)
 * 木村 (2026-10-04): superseding needs the bodies to be similar (the same keyed
 * check as duplicate replies: exact, or sketch similarity ≥ 0.6). A pending
 * approval about another matter in the same conversation stays pending and is
 * still sent when approved; the fulfill re-check uses the same criterion.
 * The incident texts are not stored anywhere; the fixtures below are synthetic
 * re-writes with the measured shape (normalized length ~90, 3-gram Jaccard
 * 0.72 between the two queued versions, 0.74 between the second one and the
 * reply). The reply ↔ approval similarity of the real incident is unknown.
 * Demo mode, dummy values, Slack fetch recorded, no network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realSlack from "@/lib/gateway/adapters/slack";

let failPosts = false;
const realPost = realSlack.postConversationMessage;
mock.module("@/lib/gateway/adapters/slack", () => ({
  ...realSlack,
  postConversationMessage: async (input: Parameters<typeof realPost>[0]) =>
    failPosts ? { ok: false as const, error: "slack_token_missing" } : realPost(input),
}));

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { fulfillIfApproved, fulfillApprovedInvoke } = await import("@/lib/approvals/fulfill");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { upsertOrgChannel } = await import("@/lib/data/directory");
const { resetDemoCommReplySends } = await import("@/lib/data/comm-reply-sends");
const { setCommReplyDedupClockForTests } = await import("@/lib/comm-reply-dedup/config");
const { expireStaleConversationApprovals } = await import("@/lib/comm-reply-dedup/approvals");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type ResolvedEmployeeCredential = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;

const FLAG = "COMM_REPLY_DEDUP_ENABLED";
const DM_A = "D0SUPERSEDEA"; // 野木さん DM shape
const DM_B = "D0SUPERSEDEB"; // 八坂さん DM shape
// 3-gram Jaccard (normalized): TEXT_1 ↔ TEXT_2 0.720, TEXT_2 ↔ REPLY 0.737, TEXT_1 ↔ REPLY 0.683.
const CAL_TEXT_1 =
  "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しました。議題は来期の予算配分と採用計画の2点です。事前にお目通しいただき、ご不明点があればこのDMでお知らせください。";
const CAL_TEXT_2 =
  "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しております。議題は来期の予算配分と採用計画の2点です。事前にご確認いただき、ご不明な点があればこのDMでお知らせください。";
const REPLY_TEXT =
  "山田さん、明日10時からの定例会議の資料をカレンダーの予定に添付しております。議題は来期の予算配分と採用の2点です。事前にお目通しいただき、ご不明な点があればこちらでお知らせください。";
// Another matter in the same DM (Jaccard ≈ 0 with all of the above).
const OTHER_TOPIC_TEXT =
  "経費精算の締め切りが今週金曜日に変更になりました。領収書の提出がまだの場合は、木曜日までに経理部へ提出をお願いします。";
const OTHER_TOPIC_TEXT_2 = "来週月曜の全社朝礼は会議室Bに変更です。オンライン参加のURLは前回と同じものをご利用ください。";

const originalFetch = globalThis.fetch;
let posts: Array<{ channel?: string; text?: string }> = [];
function recordSlack() {
  posts = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      const payload = JSON.parse(String(init?.body || "{}"));
      posts.push(payload);
      return Response.json({ ok: true, channel: payload.channel, ts: `1791104${String(posts.length).padStart(3, "0")}.000001` });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setFlag = (on: boolean) => (on ? (process.env[FLAG] = "true") : delete process.env[FLAG]);

beforeAll(async () => {
  for (const dm of [DM_A, DM_B]) {
    await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: dm, classification: "internal", mixed: false, skipInspect: true });
  }
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-supersede-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  failPosts = false;
  delete process.env[FLAG];
  setCommReplyDedupClockForTests(null);
  resetDemoCommReplySends();
});
afterAll(async () => {
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_supersede_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function convBody(tool: "comm.send" | "comm.reply", dm: string, text: string, extra: Record<string, unknown> = {}): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId: jid(tool.replace(".", "_")),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: dm, speakerId: "U_YAMADA", ...extra } as GatewayInvokeRequest["conversation"],
    args: { text },
  } as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });

async function queue(dm: string, text: string) {
  const res = await invoke(convBody("comm.send", dm, text)); // comm.send defaults to confidential → needs approval
  expect(res.httpStatus).toBe(402);
  return String(res.body.approvalId);
}
async function status(id: string) {
  return (await getApprovalById(id, DEMO_ORG.id))?.status;
}
async function approveAndFulfill(id: string) {
  const approved = await resolveApproval(id, "approved", "slack:U_APPROVER", DEMO_ORG.id);
  return approved ? fulfillIfApproved(approved, "approved") : null;
}

describe("incident reproduction (flag ON)", () => {
  test("re-written second approval supersedes the first; the auto reply supersedes the rest; approving later sends nothing", async () => {
    setFlag(true);
    recordSlack();
    const a1 = await queue(DM_A, CAL_TEXT_1);
    const b1 = await queue(DM_B, CAL_TEXT_1);
    const a2 = await queue(DM_A, CAL_TEXT_2);
    const b2 = await queue(DM_B, CAL_TEXT_2);
    expect(await status(a1)).toBe("superseded");
    expect(await status(b1)).toBe("superseded");
    expect(await status(a2)).toBe("pending");

    // comm.reply (internal summary → auto) to the same two DMs.
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    expect((await invoke(convBody("comm.reply", DM_B, REPLY_TEXT))).httpStatus).toBe(200);
    expect(posts.length).toBe(2);
    expect(await status(a2)).toBe("superseded");
    expect(await status(b2)).toBe("superseded");

    // 18 minutes later the approver presses the old cards: nothing resolves, nothing is sent.
    for (const id of [a1, b1, a2, b2]) {
      expect(await resolveApproval(id, "approved", "slack:U_APPROVER", DEMO_ORG.id)).toBeNull();
    }
    expect(posts.length).toBe(2);

    const events = await listAuditEvents(DEMO_ORG.id, 200);
    const sup = events.filter((e) => e.action === "approval.superseded");
    expect(sup.find((e) => e.metadata?.approvalId === a1)?.metadata?.reason).toBe("newer_approval_requested");
    expect(sup.find((e) => e.metadata?.approvalId === a2)?.metadata?.reason).toBe("newer_reply_sent");
  });

  test("held approval approved AFTER the same reply already went out → superseded at fulfill, not sent", async () => {
    setFlag(true);
    recordSlack();
    const id = await queue(DM_A, CAL_TEXT_1);
    // Approved, but the first fulfill could not post (e.g. token missing) → approved & unfulfilled.
    failPosts = true;
    const first = await approveAndFulfill(id);
    expect(first).toMatchObject({ ok: false, error: "slack_token_missing" });
    expect(await status(id)).toBe("approved");
    failPosts = false;

    // The employee then replies directly in the same DM.
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    expect(posts.length).toBe(1);

    // W2 / re-run fulfills the held approval later: re-check stops it.
    const approval = await getApprovalById(id, DEMO_ORG.id);
    const retry = await fulfillApprovedInvoke(approval!);
    expect(retry).toMatchObject({ ok: false, error: "approval_superseded" });
    expect(posts.length).toBe(1);
    expect(await status(id)).toBe("superseded");
    const events = await listAuditEvents(DEMO_ORG.id, 200);
    const atFulfill = events.find(
      (e) => e.action === "approval.superseded" && e.metadata?.approvalId === id && e.metadata?.reason === "replied_after_approval"
    );
    expect(atFulfill).toBeTruthy();
    // the later reply was a re-write of this approval's body (same keyed check as duplicates)
    expect(atFulfill?.metadata?.match).toBe("similar");
    expect(Number(atFulfill?.metadata?.similarity)).toBeGreaterThanOrEqual(0.6);

    // The employee's approved re-run with approvalId does not post either.
    const rerun = await invoke({ ...convBody("comm.send", DM_A, CAL_TEXT_1), approvalId: id });
    expect(posts.length).toBe(1);
    expect(rerun.httpStatus).not.toBe(200);
  });

  test("status poll: superseded is terminal (abort_job), not 'pending'", async () => {
    setFlag(true);
    recordSlack();
    const res = await invoke(convBody("comm.send", DM_A, CAL_TEXT_1));
    const id = String(res.body.approvalId);
    await queue(DM_A, CAL_TEXT_2);
    const url = `https://staffpass.test/api/approvals/status?id=${encodeURIComponent(id)}&token=${encodeURIComponent(String(res.body.statusToken))}`;
    const polled = await (await statusGET(new Request(url))).json();
    expect(polled.status).toBe("superseded");
    expect(polled.pollHint).toBe("abort_job");
    expect(polled.closedWithoutSend).toEqual({ reason: "newer_approval_requested" });
    // MCP staffpass_get_approval_status must not report it as pending either.
    const now = new Date().toISOString();
    const cred = {
      employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialId: "cred_emp_comm", generation: 1,
      fingerprint: "fixture-hash", secretPrefix: "gb_emp_fixture",
      binding: { status: "linked", employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialGeneration: 1,
        grokBotAgentId: "agent_test", grokBotWorkspaceId: null, credentialFingerprint: null, lastSuccessAt: null,
        lastError: null, wakeWebhookUrl: null, hasWakeWebhook: false, createdAt: now, updatedAt: now },
    } as ResolvedEmployeeCredential;
    const mcp = await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId: id, statusToken: String(res.body.statusToken) }, cred);
    const out = mcp.structuredContent as Record<string, unknown>;
    expect(out.status).toBe("superseded");
    expect(out.pollHint).toBe("abort_job");
  });
});

describe("scope of superseding", () => {
  test("another conversation (other DM / other channel thread) stays pending", async () => {
    setFlag(true);
    recordSlack();
    const other = await queue(DM_B, CAL_TEXT_1);
    const threadA = await invoke(convBody("comm.send", "C_INTERNAL", CAL_TEXT_1, { threadId: "1791104000.000001" }));
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    expect((await invoke(convBody("comm.reply", "C_INTERNAL", REPLY_TEXT, { threadId: "1791104000.000002" }))).httpStatus).toBe(200);
    expect(await status(other)).toBe("pending");
    expect(await status(String(threadA.body.approvalId))).toBe("pending");
  });
});

describe("supersede only when the bodies are similar (木村, 2026-10-04)", () => {
  test("a pending approval about another matter in the same DM survives a new reply and is still sent when approved", async () => {
    setFlag(true);
    recordSlack();
    const id = await queue(DM_A, CAL_TEXT_1);
    expect((await invoke(convBody("comm.reply", DM_A, OTHER_TOPIC_TEXT))).httpStatus).toBe(200);
    expect(posts.length).toBe(1);
    expect(await status(id)).toBe("pending");
    const result = await approveAndFulfill(id);
    expect(result?.ok).toBe(true);
    expect(posts.length).toBe(2);
    expect(posts[1]?.text).toContain("定例会議");
    expect(await status(id)).toBe("approved");
    const events = await listAuditEvents(DEMO_ORG.id, 200);
    expect(events.some((e) => e.action === "approval.superseded" && e.metadata?.approvalId === id)).toBe(false);
  });

  test("a newer approval request about another matter leaves the older one pending (both sent when approved)", async () => {
    setFlag(true);
    recordSlack();
    const first = await queue(DM_A, CAL_TEXT_1);
    const second = await queue(DM_A, OTHER_TOPIC_TEXT_2);
    expect(await status(first)).toBe("pending");
    expect(await status(second)).toBe("pending");
    expect((await approveAndFulfill(first))?.ok).toBe(true);
    expect((await approveAndFulfill(second))?.ok).toBe(true);
    expect(posts.length).toBe(2);
  });

  test("a similar reply supersedes; the audit carries match + similarity, never the body", async () => {
    setFlag(true);
    recordSlack();
    const id = await queue(DM_A, CAL_TEXT_2);
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    expect(await status(id)).toBe("superseded");
    expect(await resolveApproval(id, "approved", "slack:U_APPROVER", DEMO_ORG.id)).toBeNull();
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 200);
    const sup = events.find((e) => e.action === "approval.superseded" && e.metadata?.approvalId === id);
    expect(sup?.metadata?.reason).toBe("newer_reply_sent");
    expect(sup?.metadata?.match).toBe("similar");
    expect(Number(sup?.metadata?.similarity)).toBeGreaterThanOrEqual(0.6);
    const raw = JSON.stringify(sup);
    expect(raw).not.toContain("定例会議");
    expect(raw).not.toContain("山田さん");
  });

  test("the same body requested again supersedes with match exact; a different matter in the same DM is untouched", async () => {
    setFlag(true);
    recordSlack();
    const other = await queue(DM_A, OTHER_TOPIC_TEXT);
    const first = await queue(DM_A, CAL_TEXT_1);
    const again = await queue(DM_A, CAL_TEXT_1);
    expect(await status(first)).toBe("superseded");
    expect(await status(again)).toBe("pending");
    expect(await status(other)).toBe("pending");
    const events = await listAuditEvents(DEMO_ORG.id, 200);
    const sup = events.find((e) => e.action === "approval.superseded" && e.metadata?.approvalId === first);
    expect(sup?.metadata).toMatchObject({ reason: "newer_approval_requested", match: "exact", similarity: 1 });
  });

  test("fulfill re-check: a reply about another matter sent after the approval was created does not stop it", async () => {
    setFlag(true);
    recordSlack();
    const id = await queue(DM_A, CAL_TEXT_1);
    failPosts = true;
    expect(await approveAndFulfill(id)).toMatchObject({ ok: false, error: "slack_token_missing" });
    failPosts = false;
    expect((await invoke(convBody("comm.reply", DM_A, OTHER_TOPIC_TEXT))).httpStatus).toBe(200);
    expect(posts.length).toBe(1);
    const approval = await getApprovalById(id, DEMO_ORG.id);
    expect(approval?.status).toBe("approved");
    const retry = await fulfillApprovedInvoke(approval!);
    expect(retry?.ok).toBe(true);
    expect(posts.length).toBe(2);
    expect(await status(id)).toBe("approved");
  });

  test("fulfill re-check: the same body already sent after the approval (outside the 30 min window) → superseded", async () => {
    setFlag(true);
    recordSlack();
    const base = Date.now();
    const id = await queue(DM_A, CAL_TEXT_1);
    failPosts = true;
    expect(await approveAndFulfill(id)).toMatchObject({ ok: false, error: "slack_token_missing" });
    failPosts = false;
    setCommReplyDedupClockForTests(() => base + 5 * 60_000);
    expect((await invoke(convBody("comm.reply", DM_A, CAL_TEXT_1))).httpStatus).toBe(200);
    // 45 min after that reply: the duplicate window (30 min) has passed, the approval is still < 24 h old.
    setCommReplyDedupClockForTests(() => base + 50 * 60_000);
    const retry = await fulfillApprovedInvoke((await getApprovalById(id, DEMO_ORG.id))!);
    expect(retry).toMatchObject({ ok: false, error: "approval_superseded" });
    expect(posts.length).toBe(1);
    const events = await listAuditEvents(DEMO_ORG.id, 200);
    const sup = events.find((e) => e.action === "approval.superseded" && e.metadata?.approvalId === id);
    expect(sup?.metadata).toMatchObject({ reason: "replied_after_approval", match: "exact" });
  });
});

describe("expiry of pending conversation approvals (default 24 h)", () => {
  test("sweep expires an old pending approval; younger ones stay", async () => {
    setFlag(true);
    recordSlack();
    const old = await queue(DM_A, CAL_TEXT_1);
    const young = await queue(DM_B, CAL_TEXT_1);
    const base = Date.now();
    setCommReplyDedupClockForTests(() => base + 25 * 3600_000);
    const expired = await expireStaleConversationApprovals({ orgId: DEMO_ORG.id, phase: "sweep" });
    expect(expired).toContain(old);
    expect(await status(old)).toBe("expired");
    expect(await status(young)).toBe("expired"); // both older than 24 h at the moved clock
    setCommReplyDedupClockForTests(null);
    const fresh = await queue(DM_A, CAL_TEXT_2);
    expect(await expireStaleConversationApprovals({ orgId: DEMO_ORG.id, phase: "sweep" })).not.toContain(fresh);
    expect(await status(fresh)).toBe("pending");
  });

  test("approving an expired-but-not-yet-swept approval → not sent, closed as expired", async () => {
    setFlag(true);
    recordSlack();
    const id = await queue(DM_A, CAL_TEXT_1);
    const approved = await resolveApproval(id, "approved", "slack:U_APPROVER", DEMO_ORG.id);
    const base = Date.now();
    setCommReplyDedupClockForTests(() => base + 25 * 3600_000);
    const result = await fulfillIfApproved(approved!, "approved");
    expect(result).toMatchObject({ ok: false, error: "approval_expired" });
    expect(posts.length).toBe(0);
    expect(await status(id)).toBe("expired");
    const events = await listAuditEvents(DEMO_ORG.id, 100);
    expect(events.some((e) => e.action === "approval.expired" && e.metadata?.approvalId === id)).toBe(true);
  });
});

describe("flag OFF: unchanged behaviour", () => {
  test("similar and different-topic approvals plus replies: nothing is closed, every approval still posts", async () => {
    setFlag(false);
    recordSlack();
    const a1 = await queue(DM_A, CAL_TEXT_1);
    const a2 = await queue(DM_A, CAL_TEXT_2);
    const other = await queue(DM_A, OTHER_TOPIC_TEXT);
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    for (const id of [a1, a2, other]) expect(await status(id)).toBe("pending");
    for (const id of [a1, a2, other]) expect((await approveAndFulfill(id))?.ok).toBe(true);
    expect(posts.length).toBe(5);
    const events = await listAuditEvents(DEMO_ORG.id, 300);
    for (const id of [a1, a2, other]) {
      expect(events.some((e) => e.action === "approval.superseded" && e.metadata?.approvalId === id)).toBe(false);
    }
  });

  test("held approval approved after a reply still posts (legacy behaviour kept)", async () => {
    setFlag(false);
    recordSlack();
    const id = await queue(DM_A, CAL_TEXT_1);
    expect((await invoke(convBody("comm.reply", DM_A, REPLY_TEXT))).httpStatus).toBe(200);
    expect(await status(id)).toBe("pending");
    const result = await approveAndFulfill(id);
    expect(result?.ok).toBe(true);
    expect(posts.length).toBe(2);
  });
});
