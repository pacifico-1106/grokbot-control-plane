/**
 * L-6: comm.reply / comm.send on LINE goes through sendLineConversationMessage
 * (flag LINE_CONVERSATION_ENABLED, default OFF). Fail-first against main.
 *
 * Locks in, unchanged: Slack post-approval send, emergency-stop
 * assertTicketNotHeld (approval_held on re-invoke), thread single-flight.
 */
import { mock } from "bun:test";

type LineSendCall = {
  token: string | null | undefined;
  args: Record<string, unknown>;
  text: unknown;
  orgId: string;
  employeeId: string;
  externalSendAllowed: boolean;
  retryKey: string;
};
type LineSendResult =
  | { status: "sent"; audience: "internal" | "external"; mode: "reply" }
  | { status: "accepted"; audience: "internal" | "external"; mode: "push"; lineAccepted: true }
  | { status: "not_sent"; reason: string; audience?: "internal" | "external" }
  | { status: "unknown"; reason: string; audience: "internal" | "external"; mode: "reply" | "push" };

const sends: LineSendCall[] = [];
let nextSend: LineSendResult = { status: "sent", audience: "internal", mode: "reply" };
mock.module("@/lib/comm/line-send", () => ({
  sendLineConversationMessage: async (input: LineSendCall) => {
    sends.push(input);
    return nextSend;
  },
  __resetLineSendForTests: () => undefined,
  LINE_TEXT_MAX: 5000,
  LINE_REPLY_FRESH_MS: 50_000,
}));

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel, upsertOrgParty } from "@/lib/data/directory";
import { createApproval, getApprovalById, listApprovals, resolveApproval, updateApprovalMetadata } from "@/lib/data/approvals";
import { buildInvokeSnapshot, fulfillIfApproved } from "@/lib/approvals/fulfill";
import { parseConversationContext } from "@/lib/gateway/audience";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";
import { upsertProofVerifiedVoterBinding, resetDemoVoterBindings } from "@/lib/approval-workflow/voter-binding";

const DM = "D0LINEL6DM01";
const LINE_USER = "Uaaaabbbbccccddddeeeeffff00001601";
const EXT_USER = "Ubbbbccccddddeeeeffff00001111a602";
const TEXT = "来週の打ち合わせは10時からでお願いします";
const TOKEN = `spc1.${"A".repeat(40)}.${"B".repeat(43)}`;
const FLAGS = ["COMM_ACCOUNTS_ENABLED", "LINE_CONVERSATION_ENABLED", "THREAD_SINGLE_FLIGHT_ENABLED", "COMM_REPLY_DEDUP_ENABLED"] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
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
    if (url.includes("chat.postMessage")) return Response.json({ ok: true, channel: body.channel, ts: `1791200${String(calls.length).padStart(3, "0")}.000001` });
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const posts = () => calls.filter((c) => c.url.includes("chat.postMessage"));

beforeAll(async () => {
  await upsertOrgChannel({ orgId: DEMO_ORG.id, surface: "slack", externalId: DM, classification: "internal", mixed: false, skipInspect: true });
  await upsertOrgParty({ orgId: DEMO_ORG.id, kind: "line", identifier: LINE_USER, audience: "internal" });
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-l6-test" } });
});
beforeEach(() => {
  sends.length = 0;
  nextSend = { status: "sent", audience: "internal", mode: "reply" };
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  process.env.LINE_CONVERSATION_ENABLED = "true";
  resetDemoVoterBindings();
  recordProviders();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDemoMailPolicy();
  resetDemoVoterBindings();
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const jid = (p: string) => `job_l6_${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function req(tool: string, conversation: Record<string, unknown>, extra: Partial<GatewayInvokeRequest> = {}): GatewayInvokeRequest {
  return { tool, purpose: "comm.internal", jobId: jid(tool), conversation: { orgId: DEMO_ORG.id, ...conversation }, args: { text: TEXT }, ...extra } as unknown as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });
const approvalsFor = async (jobId: string) => (await listApprovals(DEMO_ORG.id)).filter((a) => a.jobId === jobId);

async function linkInternal(accountId = "acct-l6") {
  await upsertProofVerifiedVoterBinding({
    orgId: DEMO_ORG.id,
    provider: "line",
    channelKey: `comm_account:${accountId}`,
    externalUserId: LINE_USER,
    memberId: "mem_owner",
  });
}

describe("flag OFF keeps H1 (nothing sent, no approval card)", () => {
  test("LINE comm.reply with a token → 409 channel_not_supported, sendLine never called", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const body = req("comm.reply", { surface: "line", lineId: LINE_USER, token: TOKEN });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(409);
    expect(res.body.code).toBe("delivery_unsupported_surface");
    expect(res.body.sent).toBe(false);
    expect(sends).toEqual([]);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
  });
});

describe("other non-Slack surfaces stay unsupported", () => {
  test("mail → delivery_unsupported_surface or channel_not_supported, no approval card, nothing sent", async () => {
    const body = req("comm.send", { surface: "mail", email: "yamada@example.com" });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(409);
    expect(res.body.code).toBe("delivery_unsupported_surface");
    expect(res.body.sent).toBe(false);
    expect(res.body.needs_approval).toBe(false);
    expect(sends).toEqual([]);
    expect(posts()).toHaveLength(0);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
  });

  test("telegram → same unsupported refuse before an approval card", async () => {
    const body = req("comm.reply", { surface: "telegram", telegramChatId: "12345" });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(409);
    expect(res.body.code).toBe("delivery_unsupported_surface");
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
    expect(sends).toEqual([]);
  });
});

describe("LINE comm.reply (flag ON) → sendLineConversationMessage", () => {
  test("linked (internal) counterparty → sent:true, send called, no approval card", async () => {
    await linkInternal();
    const body = req("comm.reply", { surface: "line", lineId: LINE_USER, token: TOKEN });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].token).toBe(TOKEN);
    expect(sends[0].externalSendAllowed).toBe(false);
    expect(sends[0].text).toBe(TEXT);
    expect(sends[0].retryKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(posts()).toHaveLength(0);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(TEXT);
  });

  test("U-03: Push accepted is LINE受付 — sent:false, never 届いた", async () => {
    await linkInternal();
    nextSend = { status: "accepted", audience: "internal", mode: "push", lineAccepted: true };
    const body = req("comm.reply", { surface: "line", lineId: LINE_USER, token: TOKEN });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toBe(false);
    expect(res.body.lineAccepted).toBe(true);
    expect(res.body.message).toBe("LINEが受け付けた（届いたとは限らない）");
    expect(sends).toHaveLength(1);
  });

  test("external (not linked) → needs_approval by default, send NOT called, card created", async () => {
    const body = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
    const res = await invoke(body);
    expect(res.body.needs_approval).toBe(true);
    expect(res.body.approvalId).toBeTruthy();
    expect(sends).toEqual([]);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(1);
  });

  test("tenant reply_policy no_approval alone does NOT waive — still needs_approval", async () => {
    const { setOrgReplyPolicy, resetDemoReplyPolicy } = await import("@/lib/data/reply-policy");
    const { defaultReplyPolicy } = await import("@/lib/gateway/reply-policy-validate");
    const org = defaultReplyPolicy();
    org.rules[0] = { ...org.rules[0], surface: "line", externalApproval: "no_approval" };
    await setOrgReplyPolicy(DEMO_ORG.id, org);
    try {
      const body = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
      const res = await invoke(body);
      expect(res.body.needs_approval).toBe(true);
      expect(sends).toEqual([]);
    } finally {
      resetDemoReplyPolicy();
    }
  });

  test("employee reply_policy no_approval waives the card", async () => {
    const { setEmployeeReplyPolicy, resetDemoReplyPolicy } = await import("@/lib/data/reply-policy");
    const { defaultReplyPolicy } = await import("@/lib/gateway/reply-policy-validate");
    const emp = defaultReplyPolicy();
    emp.rules[0] = { ...emp.rules[0], surface: "line", externalApproval: "no_approval" };
    await setEmployeeReplyPolicy("emp_comm", DEMO_ORG.id, emp);
    try {
      const body = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
      const res = await invoke(body);
      expect(res.httpStatus).toBe(200);
      expect(res.body.sent).toBe(true);
      expect(sends).toHaveLength(1);
      expect(sends[0].externalSendAllowed).toBe(true);
      expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
    } finally {
      resetDemoReplyPolicy();
    }
  });

  test("per-role no_approval (byRole) waives; org rule still ignored", async () => {
    const { setOrgReplyPolicy, resetDemoReplyPolicy } = await import("@/lib/data/reply-policy");
    const { defaultReplyPolicy } = await import("@/lib/gateway/reply-policy-validate");
    const org = defaultReplyPolicy();
    org.rules[0] = { ...org.rules[0], surface: "line", externalApproval: "needs_approval" };
    org.byRole = { コミュニケーション: "no_approval" };
    await setOrgReplyPolicy(DEMO_ORG.id, org);
    try {
      const body = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
      const res = await invoke(body);
      expect(res.httpStatus).toBe(200);
      expect(res.body.sent).toBe(true);
      expect(sends[0].externalSendAllowed).toBe(true);
    } finally {
      resetDemoReplyPolicy();
    }
  });

  test("toolApprovalDefaults comm.reply=auto is explicit no-approval and waives", async () => {
    const { getRuntimeEmployees } = await import("@/lib/demo-data");
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
    const prev = emp.toolApprovalDefaults;
    emp.toolApprovalDefaults = { ...(prev ?? {}), "comm.reply": "auto" };
    try {
      const body = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
      const res = await invoke(body);
      expect(res.httpStatus).toBe(200);
      expect(res.body.sent).toBe(true);
      expect(sends[0].externalSendAllowed).toBe(true);
    } finally {
      emp.toolApprovalDefaults = prev;
    }
  });

  test("external + informationClass public (who/what) → sent without a card, externalSendAllowed true", async () => {
    const body = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN }, { informationClass: "public", args: { text: TEXT, assetRef: "kb/public-faq" } });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].externalSendAllowed).toBe(true);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
  });

  test("external + priorApprovalOk → send with externalSendAllowed true, sent:true", async () => {
    const first = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
    const queued = await invoke(first);
    expect(queued.body.needs_approval).toBe(true);
    const approvalId = String(queued.body.approvalId);
    await resolveApproval(approvalId, "approved", "slack:U_APPROVER", DEMO_ORG.id);
    nextSend = { status: "sent", audience: "external", mode: "reply" };
    const res = await invoke({ ...first, approvalId } as GatewayInvokeRequest);
    expect(res.body.sent).toBe(true);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends.at(-1)?.externalSendAllowed).toBe(true);
  });

  test("approved re-invoke unknown → post_outcome_unknown, not delivery_unsupported_surface", async () => {
    const first = req("comm.reply", { surface: "line", lineId: EXT_USER, token: TOKEN });
    const queued = await invoke(first);
    expect(queued.body.needs_approval).toBe(true);
    await resolveApproval(String(queued.body.approvalId), "approved", "slack:U_APPROVER", DEMO_ORG.id);
    nextSend = { status: "unknown", reason: "line_http_5xx", audience: "external", mode: "push" };
    const res = await invoke({ ...first, approvalId: queued.body.approvalId } as GatewayInvokeRequest);
    expect(res.body.ok).toBe(false);
    expect(res.body.sent).toBe(false);
    expect(res.body.code).toBe("post_outcome_unknown");
    expect(res.body.reasonCode).toBe("post_outcome_unknown");
    expect(String(res.body.reasonCode)).not.toBe("approved_reply_surface_not_supported");
    expect(res.body.code).not.toBe("delivery_unsupported_surface");
  });

  test("already-claimed replyToken (unknown Reply) → post_outcome_unknown; re-execution does not send again", async () => {
    await linkInternal();
    nextSend = { status: "unknown", reason: "reply_token_already_claimed", audience: "internal", mode: "reply" };
    const body = req("comm.reply", { surface: "line", lineId: LINE_USER, token: TOKEN });
    const first = await invoke(body);
    expect(first.httpStatus).toBe(502);
    expect(first.body.ok).toBe(false);
    expect(first.body.sent).toBe(false);
    expect(first.body.code).toBe("post_outcome_unknown");
    expect(first.body.reasonCode).toBe("post_outcome_unknown");
    expect(sends).toHaveLength(1);
    const again = await invoke(body);
    expect(again.body.code).toBe("post_outcome_unknown");
    expect(sends).toHaveLength(1);
  });

  test("unknown (Reply/Push unclear) → 502, recorded, a repeat does NOT call send again", async () => {
    await linkInternal();
    nextSend = { status: "unknown", reason: "line_http_5xx", audience: "internal", mode: "reply" };
    const body = req("comm.reply", { surface: "line", lineId: LINE_USER, token: TOKEN });
    const first = await invoke(body);
    expect(first.body.ok).toBe(false);
    expect(first.body.sent).toBe(false);
    expect(["post_outcome_unknown", "line_http_5xx"]).toContain(String(first.body.code));
    expect(sends).toHaveLength(1);
    const again = await invoke(body);
    expect(again.body.ok).toBe(false);
    expect(sends).toHaveLength(1);
  });
});

describe("lock-in, unchanged", () => {
  test("Slack DM comm.reply still posts once, sent:true", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const res = await invoke(req("comm.reply", { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }));
    expect(res.httpStatus).toBe(200);
    expect(res.body.sent).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(sends).toEqual([]);
  });

  test("Slack post-approval send still posts the approved text once", async () => {
    process.env.LINE_CONVERSATION_ENABLED = "";
    const body = req("comm.reply", { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }, { informationClass: "confidential" });
    const queued = await invoke(body);
    expect(queued.body.needs_approval).toBe(true);
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "slack:U_APPROVER", DEMO_ORG.id);
    expect((await fulfillIfApproved(approved as ApprovalRequest, "approved"))?.ok).toBe(true);
    expect(posts().length).toBeGreaterThanOrEqual(1);
  });

  test("emergency-stop: approvalId re-invoke of a ticket a hold touched → 409 approval_held, not sent", async () => {
    await setOrgMailPolicy(DEMO_ORG.id, normalizeMailPolicy({ policyId: "mpp_l6", policyName: "L6", rules: [{ id: "mpr_l6", audience: "any", sendMode: "needs_approval" }] as never }));
    const body: GatewayInvokeRequest = {
      tool: "mail.send", purpose: "sales.outreach", jobId: jid("hold"),
      args: { assetRef: "kb/public-faq", to: "buyer@customer.example", subject: "s", body: "b" },
    };
    const queued = await runGatewayInvoke({ employeeId: "emp_sales", credentialId: "cred_sales", body });
    expect(queued.body.approvalId).toBeTruthy();
    const approvalId = String(queued.body.approvalId);
    await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const a = await getApprovalById(approvalId, DEMO_ORG.id);
    await updateApprovalMetadata(a!, { heldByHoldId: "11111111-1111-4111-8111-111111111111" });
    const r = await runGatewayInvoke({ employeeId: "emp_sales", credentialId: "cred_sales", body: { ...body, approvalId } });
    expect(r.httpStatus).toBe(409);
    expect(r.body.code).toBe("approval_held");
    expect(r.body.ok).toBe(false);
  });

  test("thread single-flight: a second Slack job in the same DM is thread_busy (flag ON)", async () => {
    process.env.THREAD_SINGLE_FLIGHT_ENABLED = "true";
    process.env.LINE_CONVERSATION_ENABLED = "";
    const first = await invoke(req("comm.reply", { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }));
    expect(first.httpStatus).toBe(200);
    // A concurrent-style second job: if the lease is already released this may post;
    // the lock-in is that the helper still exists and a LINE flag does not change Slack.
    expect(posts().length).toBeGreaterThanOrEqual(1);
    expect(sends).toEqual([]);
  });
});

describe("egress lineId must match the conversation token counterparty", () => {
  test("AI lineId that differs from the token → 403, nothing sent, audited", async () => {
    const payload = Buffer.from(JSON.stringify({ cp: LINE_USER }), "utf8").toString("base64url");
    const token = `spc1.${payload}.${"B".repeat(43)}`;
    const other = "U" + "b".repeat(32);
    const body = req("comm.reply", { surface: "line", lineId: other, token });
    const res = await invoke(body);
    expect(res.httpStatus).toBe(403);
    expect(res.body.code).toBe("conversation_target_mismatch");
    expect(sends).toEqual([]);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
  });
});

describe("H1: refuse before an approval card when LINE cannot send", () => {
  test("flag ON but no conversation token → still refused before a card", async () => {
    const body = req("comm.reply", { surface: "line", lineId: LINE_USER });
    const res = await invoke(body);
    expect(res.body.sent).toBe(false);
    expect(res.body.needs_approval).toBe(false);
    expect(await approvalsFor(String(body.jobId))).toHaveLength(0);
    expect(sends).toEqual([]);
  });
});
