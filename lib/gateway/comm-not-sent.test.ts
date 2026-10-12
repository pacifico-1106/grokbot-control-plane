/**
 * H1 (LINE / LINE WORKS design 10/12 §6): comm.reply / comm.send / slack.post
 * to a destination the gateway cannot post to (LINE, mail, …) used to answer
 * ok:true, accepted:true although nothing was sent, so the AI believed it had
 * sent. Now: ok:false, code channel_not_supported, sent:false, Japanese
 * nextStep, before any ledger / lease / provider call.
 *
 * Post-approval: an approved reply that stops at slack_channel_required is
 * reported as NOT SENT to the AI (status poll / MCP status / re-invoke) and to
 * the approver (the resolved Slack / LINE / Telegram card says so).
 *
 * Lock-in: real Slack sends and LINE / Telegram card deliveries still send.
 * Demo mode, dummy values, every provider fetch recorded, no network.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { listAuditEvents } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { demoCommReplySendsForTests, resetDemoCommReplySends } from "@/lib/data/comm-reply-sends";
import { createApproval, getApprovalById, resolveApproval } from "@/lib/data/approvals";
import { buildInvokeSnapshot, fulfillIfApproved } from "@/lib/approvals/fulfill";
import { parseConversationContext } from "@/lib/gateway/audience";
import { recordNotificationDelivery, type NotificationChannelRuntime } from "@/lib/data/notification-channels";
import { editSlackApprovalForChannel } from "@/lib/notify/slack";
import { resolveLineApprovalMessage } from "@/lib/notify/line";
import { editTelegramApprovalForChannel } from "@/lib/notify/telegram";
import { GET as statusGET } from "@/app/api/approvals/status/route";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";

const DM = "D0NOTSENT01";
const LINE_USER = "Uaaaabbbbccccddddeeeeffff00001111";
const TEXT = "明日の打ち合わせは10時からでお願いします";
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
    if (url.includes("chat.postMessage")) return Response.json({ ok: true, channel: body.channel, ts: `1791105${String(calls.length).padStart(3, "0")}.000001` });
    if (url.includes("chat.update")) return Response.json({ ok: true, channel: body.channel, ts: body.ts });
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.includes("api.line.me")) return Response.json({});
    if (url.includes("api.telegram.org")) return Response.json({ ok: true, result: { message_id: 1 } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const providerSends = () => calls.filter((c) => /chat\.postMessage|api\.line\.me|api\.telegram\.org/.test(c.url));

const FLAGS = ["COMM_REPLY_DEDUP_ENABLED", "THREAD_SINGLE_FLIGHT_ENABLED"];
const envBackup = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "line", identifier: LINE_USER, audience: "internal" });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-notsent-test" } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of FLAGS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  resetDemoCommReplySends();
});

const jid = (p: string) => `job_notsent_${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function req(tool: string, conversation: Record<string, unknown>, extra: Partial<GatewayInvokeRequest> = {}): GatewayInvokeRequest {
  return { tool, purpose: "comm.internal", jobId: jid(tool), conversation: { orgId: DEMO_ORG.id, ...conversation }, args: { text: TEXT }, ...extra } as unknown as GatewayInvokeRequest;
}
const LINE = { surface: "line", lineId: LINE_USER };
const MAIL = { surface: "mail", email: "yamada@example.com" };
const SLACK_DM = { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" };
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });

function expectNotSent(body: Record<string, unknown>) {
  expect(body.ok).toBe(false);
  expect(body.sent).toBe(false);
  expect(body.accepted).not.toBe(true);
  expect(JSON.stringify(body.result ?? null)).not.toContain('"accepted":true');
  expect(String(body.message)).toContain("送信していません");
  expect(String(body.nextStep)).toMatch(/[ぁ-ん]/);
  expect(JSON.stringify(body)).not.toContain(TEXT);
}

describe("direct invoke: non-Slack destination → channel_not_supported (nothing sent)", () => {
  for (const tool of ["comm.reply", "slack.post"]) {
    test(`${tool} to LINE (egress allow) → 409 channel_not_supported, sent:false, no provider call, audit without body`, async () => {
      recordProviders();
      const res = await invoke(req(tool, LINE));
      expect(res.httpStatus).toBe(409);
      expect(res.body.code).toBe("channel_not_supported");
      expect(res.body.surface).toBe("line");
      expectNotSent(res.body as Record<string, unknown>);
      expect(providerSends()).toHaveLength(0);
      const audit = (await listAuditEvents(DEMO_ORG.id, 50)).find((e) => e.metadata?.jobId === res.body.jobId && e.action === "comm.not_sent");
      expect(audit?.metadata).toMatchObject({ tool, code: "channel_not_supported", surface: "line" });
      expect(JSON.stringify(audit)).not.toContain(TEXT);
    });
  }

  test("with COMM_REPLY_DEDUP_ENABLED and THREAD_SINGLE_FLIGHT_ENABLED ON: still not sent, nothing recorded as sent", async () => {
    process.env.COMM_REPLY_DEDUP_ENABLED = "true";
    process.env.THREAD_SINGLE_FLIGHT_ENABLED = "true";
    recordProviders();
    const res = await invoke(req("comm.reply", LINE));
    expect(res.httpStatus).toBe(409);
    expect(res.body.code).toBe("channel_not_supported");
    expectNotSent(res.body as Record<string, unknown>);
    expect(demoCommReplySendsForTests().filter((r) => r.state === "sent")).toHaveLength(0);
    // A second identical try is the same answer (not duplicate_reply_suppressed: nothing was sent the first time).
    expect((await invoke(req("comm.reply", LINE))).body.code).toBe("channel_not_supported");
  });

  test("MCP staffpass_invoke (the AI's path) gets the same error", async () => {
    recordProviders();
    const out = await callStaffpassMcpTool(
      "staffpass_invoke",
      { tool: "comm.reply", purpose: "comm.internal", jobId: jid("mcp"), conversation: { orgId: DEMO_ORG.id, ...LINE }, payload: { text: TEXT } },
      cred()
    );
    const data = out.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("channel_not_supported");
    expectNotSent(data);
    expect(providerSends()).toHaveLength(0);
  });

  test("lock-in: Slack DM reply still posts once and answers accepted:true with delivery slack", async () => {
    recordProviders();
    const res = await invoke(req("comm.reply", SLACK_DM));
    expect(res.httpStatus).toBe(200);
    expect(res.body.ok).toBe(true);
    const result = res.body.result as Record<string, unknown>;
    expect(result.accepted).toBe(true);
    expect(result.delivery).toBe("slack");
    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);
  });
});

function cred(): ResolvedEmployeeCredential {
  return {
    employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialId: "cred_comm", generation: 1,
    fingerprint: "fixture-hash", secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked", employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialGeneration: 1,
      grokBotAgentId: "agent_test", grokBotWorkspaceId: null, credentialFingerprint: null,
      lastSuccessAt: null, lastError: null, wakeWebhookUrl: null, hasWakeWebhook: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  } as unknown as ResolvedEmployeeCredential;
}

/**
 * A ticket filed BEFORE the #351 follow-up (the gateway now refuses these sends
 * before any card, so it is seeded the way invoke used to file it). Such legacy
 * tickets still exist and must keep answering "not sent" after approval.
 */
async function approvedNotSent(conversation: Record<string, unknown>) {
  recordProviders();
  const first = req("comm.send", conversation);
  expect((await invoke(req("comm.send", conversation))).body.code).toBe("channel_not_supported");
  const created = await createApproval({
    orgId: DEMO_ORG.id, employeeId: "emp_comm", credentialId: "cred_comm",
    title: "comm.send", purpose: first.purpose, summary: "送信の承認", risk: "high", tool: "comm.send", jobId: String(first.jobId),
    metadata: {
      invoke: buildInvokeSnapshot({
        tool: "comm.send", purpose: first.purpose, jobId: String(first.jobId), employeeId: "emp_comm", orgId: DEMO_ORG.id,
        body: first, conversation: parseConversationContext(first, DEMO_ORG.id),
      }),
    },
  });
  const approvalId = created.approval.id;
  const statusToken = String(created.statusToken);
  const approved = await resolveApproval(approvalId, "approved", "slack:U_APPROVER", DEMO_ORG.id);
  expect(approved).toBeTruthy();
  const fulfillment = await fulfillIfApproved(approved as ApprovalRequest, "approved");
  expect(fulfillment?.ok).toBe(false);
  expect(fulfillment?.error).toBe("slack_channel_required");
  expect(providerSends().filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(0);
  return { approvalId, statusToken, jobId: first.jobId, approval: (await getApprovalById(approvalId, DEMO_ORG.id)) as ApprovalRequest };
}

describe("post-approval stop at slack_channel_required is reported as NOT SENT", () => {
  for (const [name, conv] of [["LINE", LINE], ["mail", MAIL]] as const) {
    test(`${name}: status poll says not sent (pollHint abort_job, never "fulfilled")`, async () => {
      const { approvalId, statusToken } = await approvedNotSent(conv);
      const res = await statusGET(new Request(`https://staffpass.example/api/approvals/status?id=${approvalId}&token=${statusToken}`));
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
      expect(body.pollHint).toBe("abort_job");
      const f = body.fulfillment as Record<string, unknown>;
      expect(f.fulfilled).not.toBe(true);
      expect(f.sent).toBe(false);
      const notSent = f.notSent as Record<string, unknown>;
      expect(notSent.code).toBe("slack_channel_required");
      expect(String(notSent.messageJa)).toContain("送信していません");
      expect(String(notSent.nextStep)).toMatch(/[ぁ-ん]/);
    });
  }

  test("MCP staffpass_get_approval_status: same not-sent answer", async () => {
    const { approvalId, statusToken } = await approvedNotSent(LINE);
    const out = await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId, statusToken }, cred());
    const data = out.structuredContent as Record<string, unknown>;
    expect(data.pollHint).toBe("abort_job");
    expect((data.fulfillment as Record<string, unknown>).sent).toBe(false);
    expect(((data.fulfillment as Record<string, unknown>).notSent as Record<string, unknown>).code).toBe("slack_channel_required");
  });

  test("re-invoke with approvalId: ok:false, sent:false, Japanese nextStep, nothing posted", async () => {
    const { approvalId, jobId } = await approvedNotSent(LINE);
    recordProviders();
    const res = await invoke(req("comm.send", LINE, { approvalId, jobId }));
    expect(res.httpStatus).toBe(409);
    expectNotSent(res.body as Record<string, unknown>);
    expect(providerSends()).toHaveLength(0);
  });

  test("lock-in: an approved Slack post is still pollHint=fulfilled", async () => {
    recordProviders();
    const pending = await invoke(req("comm.send", SLACK_DM));
    if (pending.body.code !== "needs_approval") {
      // comm.send to an internal DM is allowed directly: it must really have posted.
      expect(pending.httpStatus).toBe(200);
      expect((pending.body.result as Record<string, unknown>).delivery).toBe("slack");
      expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);
      return;
    }
    const approved = await resolveApproval(String(pending.body.approvalId), "approved", "slack:U_APPROVER", DEMO_ORG.id);
    expect((await fulfillIfApproved(approved as ApprovalRequest, "approved"))?.ok).toBe(true);
    const res = await statusGET(new Request(`https://staffpass.example/api/approvals/status?id=${pending.body.approvalId}&token=${pending.body.statusToken}`));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pollHint).toBe("fulfilled");
    expect((body.fulfillment as Record<string, unknown>).sent).not.toBe(false);
  });
});

function channel(provider: "slack" | "line" | "telegram"): NotificationChannelRuntime {
  const now = new Date().toISOString();
  return {
    id: `nc_${provider}_notsent`, orgId: DEMO_ORG.id, provider, label: provider, enabled: true, isDefault: true,
    config: provider === "slack" ? { channelId: "C_APPROVALS" } : provider === "line" ? { destinationId: "Cline_room_1" } : { chatId: "-100777" },
    webhookRef: "ref", hasCredentials: true, webhookPath: "/x", createdAt: now, updatedAt: now,
    secrets: provider === "slack" ? { botToken: "xoxb-card" } : provider === "line" ? { channelAccessToken: "line-token", channelSecret: "s" } : { botToken: "123:tg" },
  };
}

describe("approver card: the resolved card says nothing was sent", () => {
  const cardText = (c: Call | undefined) => JSON.stringify(c?.body ?? {});

  for (const provider of ["slack", "line", "telegram"] as const) {
    test(`${provider}: approved-but-not-sent card shows 送信していません; a sent one does not (and the card is still delivered)`, async () => {
      const { approval } = await approvedNotSent(LINE);
      const ch = channel(provider);
      await recordNotificationDelivery({ approval, channelId: ch.id, provider, externalMessageId: provider === "telegram" ? "42" : "1791105000.000001", context: { channel: "C_APPROVALS" } });
      recordProviders();
      const edit = provider === "slack" ? editSlackApprovalForChannel : provider === "line" ? resolveLineApprovalMessage : editTelegramApprovalForChannel;
      expect((await edit(approval, "approved", "approver@example.com", ch)).ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(cardText(calls[0])).toContain("送信していません");

      // Lock-in: same card for an approval whose send succeeded — delivered, no not-sent line.
      const sentApproval = { ...approval, metadata: { ...approval.metadata, fulfillment: { ok: true, delivery: "slack", at: new Date().toISOString() } } } as ApprovalRequest;
      recordProviders();
      expect((await edit(sentApproval, "approved", "approver@example.com", ch)).ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(cardText(calls[0])).not.toContain("送信していません");
    });
  }
});
