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
const CAL_TEXT_1 = "本日の打ち合わせ資料をカレンダーに共有しました。ご確認ください。";
const CAL_TEXT_2 = "本日の打ち合わせ資料をカレンダーで共有しました。お手すきの際にご確認ください。";
const REPLY_TEXT = "カレンダーに資料を共有しました。ご確認お願いします。";

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
    expect(
      events.some((e) => e.action === "approval.superseded" && e.metadata?.approvalId === id && e.metadata?.reason === "replied_after_approval")
    ).toBe(true);

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
