/**
 * #351 (H1) follow-ups, 木村 10/12:
 * 1a) a send that can never happen (non-Slack destination, or a Slack user id
 *     without dm) is refused BEFORE an approval card is created, so approvers
 *     never approve something that cannot be sent.
 * 1b) the approval.resolved callback carries `sent` and the reason code.
 * 1c) a conversation send that really posted answers sent:true.
 * 2)  the Slack channel is also read from args.channelId and
 *     conversation.channelId (before: args.channelId alone → 403 egress_denied,
 *     conversation.channelId alone → 400); different channel ids in one request
 *     are refused.
 *
 * Demo mode, dummy values, every provider fetch recorded, no network.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { parseConversationContext } from "@/lib/gateway/audience";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { createApproval, getApprovalById, listApprovals, resolveApproval } from "@/lib/data/approvals";
import { buildInvokeSnapshot, fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import { minimalCallbackBody } from "@/lib/webhooks/approval-callback";
import type { ApprovalRequest, Employee, GatewayInvokeRequest } from "@/lib/types";

const DM = "D0FOLLOWUP1";
const OTHER = "C0FOLLOWOTHER";
const LINE_USER = "Uaaaabbbbccccddddeeeeffff00002222";
const TEXT = "フォローアップ確認のメッセージです";
const CALLBACK = "https://callback.example.com/approval-hook";
const originalFetch = globalThis.fetch;
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];

function recordProviders() {
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body || "{}")); } catch { /* form */ }
    calls.push({ url, body });
    if (url.includes("chat.postMessage")) return Response.json({ ok: true, channel: body.channel, ts: `1791106${String(calls.length).padStart(3, "0")}.000001` });
    if (url.includes("chat.update")) return Response.json({ ok: true, channel: body.channel, ts: body.ts });
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.startsWith(CALLBACK)) return new Response(null, { status: 204 });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const posts = () => calls.filter((c) => c.url.includes("chat.postMessage"));
const callbacks = () => calls.filter((c) => c.url.startsWith(CALLBACK)).map((c) => c.body);

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "line", identifier: LINE_USER, audience: "internal" });
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "slack_user", identifier: "U0INTERNAL01", audience: "internal" });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-followup-test" } });
});
afterEach(() => { globalThis.fetch = originalFetch; });

const jid = (p: string) => `job_h1fu_${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function req(tool: string, conversation: Record<string, unknown> | undefined, extra: Partial<GatewayInvokeRequest> & { args?: Record<string, unknown> } = {}): GatewayInvokeRequest {
  const { args, ...rest } = extra;
  return {
    tool, purpose: "comm.internal", jobId: jid(tool),
    ...(conversation ? { conversation: { orgId: DEMO_ORG.id, ...conversation } } : {}),
    args: { text: TEXT, ...(args ?? {}) }, ...rest,
  } as unknown as GatewayInvokeRequest;
}
const LINE = { surface: "line", lineId: LINE_USER };
const MAIL = { surface: "mail", email: "yamada@example.com" };
const SLACK_DM = { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" };
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });
const approvalsFor = async (jobId: string) => (await listApprovals(DEMO_ORG.id)).filter((a) => a.jobId === jobId);

describe("1a) refused before an approval card is created", () => {
  for (const [name, conv] of [["LINE", LINE], ["mail", MAIL]] as const) {
    test(`comm.send to ${name} → 409 channel_not_supported, sent:false, NO approval ticket`, async () => {
      recordProviders();
      const body = req("comm.send", conv);
      const res = await invoke(body);
      expect(res.httpStatus).toBe(409);
      expect(res.body.code).toBe("channel_not_supported");
      expect(res.body.sent).toBe(false);
      expect(res.body.needs_approval).toBe(false);
      expect(res.body.approvalId).toBeUndefined();
      expect(await approvalsFor(body.jobId)).toHaveLength(0);
      expect(String(res.body.nextStep)).toMatch(/[ぁ-ん]/);
      expect(JSON.stringify(res.body)).not.toContain(TEXT);
    });
  }

  test("comm.send to a Slack user id without dm → slack_channel_required before any approval ticket", async () => {
    recordProviders();
    const body = req("comm.send", { surface: "slack", slackUserId: "U0INTERNAL01" });
    const res = await invoke(body);
    expect(res.body.code).toBe("slack_channel_required");
    expect(res.body.sent).toBe(false);
    expect(await approvalsFor(body.jobId)).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  test("lock-in: a Slack DM send that needs approval still gets its ticket (or posts when allowed)", async () => {
    recordProviders();
    const body = req("comm.send", SLACK_DM);
    const res = await invoke(body);
    if (res.body.code === "needs_approval") {
      expect(await approvalsFor(body.jobId)).toHaveLength(1);
    } else {
      expect(res.httpStatus).toBe(200);
      expect(posts()).toHaveLength(1);
    }
  });
});

describe("1c) a real send answers sent:true", () => {
  test("comm.reply to a Slack DM → sent:true (top level and result)", async () => {
    recordProviders();
    const res = await invoke(req("comm.reply", SLACK_DM));
    expect(res.httpStatus).toBe(200);
    expect(res.body.sent).toBe(true);
    expect((res.body.result as Record<string, unknown>).sent).toBe(true);
    expect((res.body.result as Record<string, unknown>).accepted).toBe(true);
    expect(posts()).toHaveLength(1);
  });
});

/** An approval filed before 1a (legacy rows still exist): built the way invoke builds them. */
async function legacyApproval(conversation: Record<string, unknown>): Promise<ApprovalRequest> {
  const body = req("comm.send", conversation);
  const conv = parseConversationContext(body, DEMO_ORG.id);
  const created = await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm",
    title: "comm.send", purpose: body.purpose, summary: "送信の承認", risk: "high", tool: "comm.send", jobId: body.jobId,
    metadata: { invoke: buildInvokeSnapshot({ tool: "comm.send", purpose: body.purpose, jobId: body.jobId, employeeId: "emp_comm", orgId: DEMO_ORG.id, body, conversation: conv }) },
  });
  return created.approval;
}
const employeeWithCallback = { id: "emp_comm", orgId: DEMO_ORG.id, displayName: "テスト社員", callbackUrl: CALLBACK } as unknown as Employee;

describe("1b) approval.resolved callback carries sent + reason code", () => {
  test("approved but stopped at slack_channel_required → sent:false, reasonCode slack_channel_required", async () => {
    recordProviders();
    const pending = await legacyApproval(LINE);
    const approved = (await resolveApproval(pending.id, "approved", "slack:U_APPROVER", DEMO_ORG.id)) as ApprovalRequest;
    const f = await fulfillIfApproved(approved, "approved");
    expect(f?.error).toBe("slack_channel_required");
    await runApprovalResolveSideEffects({ approval: approved, decision: "approved", actorEmail: "slack:U_APPROVER", employee: employeeWithCallback, surface: "slack" });
    const [cb] = callbacks();
    expect(cb.type).toBe("approval.resolved");
    expect(cb.sent).toBe(false);
    expect(cb.reasonCode).toBe("slack_channel_required");
    expect(JSON.stringify(cb)).not.toContain(TEXT);
  });

  test("approved and posted → sent:true, reasonCode null", async () => {
    recordProviders();
    const pending = await legacyApproval(SLACK_DM);
    const approved = (await resolveApproval(pending.id, "approved", "slack:U_APPROVER", DEMO_ORG.id)) as ApprovalRequest;
    expect((await fulfillIfApproved(approved, "approved"))?.ok).toBe(true);
    await runApprovalResolveSideEffects({ approval: approved, decision: "approved", actorEmail: "slack:U_APPROVER", employee: employeeWithCallback, surface: "slack" });
    const [cb] = callbacks();
    expect(cb.sent).toBe(true);
    expect(cb.reasonCode).toBeNull();
  });

  test("rejected → sent:false, reasonCode rejected", async () => {
    recordProviders();
    const pending = await legacyApproval(SLACK_DM);
    const rejected = (await resolveApproval(pending.id, "rejected", "slack:U_APPROVER", DEMO_ORG.id)) as ApprovalRequest;
    await runApprovalResolveSideEffects({ approval: rejected, decision: "rejected", actorEmail: "slack:U_APPROVER", employee: employeeWithCallback, surface: "slack" });
    const [cb] = callbacks();
    expect(cb.sent).toBe(false);
    expect(cb.reasonCode).toBe("rejected");
    expect(posts()).toHaveLength(0);
  });

  test("hardened (minimal) callback body keeps sent and reasonCode", () => {
    const body = minimalCallbackBody({ type: "approval.resolved", status: "approved", approvalId: "a1", sent: false, reasonCode: "slack_channel_required", summary: "x" });
    expect(body.sent).toBe(false);
    expect(body.reasonCode).toBe("slack_channel_required");
    expect(body.summary).toBeUndefined();
  });
});

describe("2) channel from args.channelId / conversation.channelId", () => {
  test("args.channelId alone (no surface) → Slack, posts to that channel, sent:true", async () => {
    recordProviders();
    const res = await invoke(req("comm.reply", { speakerId: "U_YAMADA" }, { args: { channelId: DM } }));
    expect(res.httpStatus).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.channel).toBe(DM);
  });

  test("conversation.channelId alone → Slack, posts to that channel, sent:true", async () => {
    recordProviders();
    const res = await invoke(req("comm.reply", { channelId: DM, speakerId: "U_YAMADA" }));
    expect(res.httpStatus).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.channel).toBe(DM);
  });

  test("conversation.channelId and args.channelId agree → posts once", async () => {
    recordProviders();
    const res = await invoke(req("comm.reply", { channelId: DM, speakerId: "U_YAMADA" }, { args: { channelId: DM } }));
    expect(res.httpStatus).toBe(200);
    expect(posts()).toHaveLength(1);
  });

  for (const [name, conv, args] of [
    ["conversation.channelId ≠ args.channelId", { channelId: DM, speakerId: "U_YAMADA" }, { channelId: OTHER }],
    ["conversation.slackChannelId ≠ args.channelId", { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }, { channelId: OTHER }],
    ["conversation.channelId ≠ conversation.slackChannelId", { surface: "slack", slackChannelId: DM, channelId: OTHER, speakerId: "U_YAMADA" }, {}],
  ] as const) {
    test(`${name} → 400 conversation_channel_mismatch, nothing posted, no ticket`, async () => {
      recordProviders();
      const body = req("comm.reply", conv as Record<string, unknown>, { args: args as Record<string, unknown> });
      const res = await invoke(body);
      expect(res.httpStatus).toBe(400);
      expect(res.body.code).toBe("conversation_channel_mismatch");
      expect(res.body.sent).toBe(false);
      expect(posts()).toHaveLength(0);
      expect(await approvalsFor(body.jobId)).toHaveLength(0);
    });
  }
});
