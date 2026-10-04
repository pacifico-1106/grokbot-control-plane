/**
 * 2026-10-04 (木村, #253 follow-up 3 + 4).
 *
 * 3. files.completeUploadExternal answered with a Slack error that is known to
 *    happen BEFORE anything is shared (lib/slack/definite-errors.ts, one list)
 *    → "failed" (a later re-run uploads once). Timeouts, 5xx / no JSON body and
 *    unknown errors stay "uncertain".
 * 4. While the attachment is not_sent, the status poll and MCP
 *    staffpass_get_approval_status say pollHint=reinvoke_with_approvalId.
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async () => Buffer.from("%PDF-1.4 approved content"),
}));
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-definite";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { fulfillIfApproved } = await import("@/lib/approvals/fulfill");
const { SLACK_DEFINITE_PRE_SHARE_ERRORS, isDefinitePreShareSlackError } = await import("@/lib/slack/definite-errors");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;
type ResolvedEmployeeCredential = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;

const FILE: FileAttachment = { fileRef: "https://example.com/approved.pdf?sig=SECRET_SIG_definite", filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };

type Complete = { status?: number; json?: Record<string, unknown>; throws?: boolean };
const originalFetch = globalThis.fetch;
let getUrls = 0, completes = 0;
let complete: Complete = { json: { ok: true, files: [{ id: "F_DEF_1" }] } };
function installSlack() {
  getUrls = 0; completes = 0; complete = { json: { ok: true, files: [{ id: "F_DEF_1" }] } };
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000088" });
    if (url.includes("files.getUploadURLExternal")) { getUrls++; return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/DEF", file_id: "F_DEF_1" }); }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (url.includes("files.completeUploadExternal")) {
      completes++;
      const c = complete;
      if (c.throws) throw new DOMException("The operation timed out.", "TimeoutError");
      if (c.json) return Response.json(c.json, { status: c.status ?? 200 });
      return new Response("<html>bad gateway</html>", { status: c.status ?? 502 });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) => upsertConversationAdapter({
  orgId: DEMO_ORG.id, surface: "slack", enabled, secrets: enabled ? { botToken: "xoxb-definite-test" } : {} });
afterEach(async () => { globalThis.fetch = originalFetch; await setToken(false).catch(() => undefined); });

const jid = () => `job_def_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invokeComm = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
async function approved(fileAttachment: FileAttachment | undefined = FILE) {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（definite・ダミー）", threadId: "1787911797.502889" },
    ...(fileAttachment ? { fileAttachment } : {}),
  };
  const q = await invokeComm(body);
  expect(q.httpStatus).toBe(402);
  const approvalId = String(q.body.approvalId);
  const approval = (await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id))!;
  return { body, approvalId, approval, statusToken: String(q.body.statusToken) };
}
const fileUpload = (r: { body: Record<string, unknown> }) =>
  ((r.body.result || {}) as { fileUpload?: Record<string, unknown> }).fileUpload;
const record = async (id: string) =>
  (await getApprovalById(id, DEMO_ORG.id))!.metadata.attachmentUpload as Record<string, unknown> | undefined;
function mcpCred(): ResolvedEmployeeCredential {
  const now = new Date().toISOString();
  return {
    employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialId: "cred_emp_comm", generation: 1,
    fingerprint: "fixture-hash", secretPrefix: "gb_emp_fixture",
    binding: { status: "linked", employeeId: "emp_comm", orgId: DEMO_ORG.id, credentialGeneration: 1,
      grokBotAgentId: "agent_test", grokBotWorkspaceId: null, credentialFingerprint: null, lastSuccessAt: null,
      lastError: null, wakeWebhookUrl: null, hasWakeWebhook: false, createdAt: now, updatedAt: now },
  } as ResolvedEmployeeCredential;
}

describe("3. the definite pre-share Slack error list (one place)", () => {
  test("contains the decided errors", () => {
    for (const e of ["channel_not_found", "not_in_channel", "invalid_auth", "not_authed", "account_inactive",
      "token_revoked", "missing_scope", "is_archived"]) {
      expect(SLACK_DEFINITE_PRE_SHARE_ERRORS.has(e)).toBe(true);
      expect(isDefinitePreShareSlackError(e)).toBe(true);
    }
  });
  test("timeouts / 5xx / unknown are not definite", () => {
    for (const e of ["internal_error", "fatal_error", "service_unavailable", "request_timeout", "complete_upload_failed",
      "The operation timed out.", "unknown_thing", "", undefined, null, " not_in_channel", "NOT_IN_CHANNEL"]) {
      expect(isDefinitePreShareSlackError(e as string | undefined)).toBe(false);
    }
  });
});

describe("3. completion step: definite error → failed, others → uncertain", () => {
  for (const error of ["not_in_channel", "channel_not_found", "invalid_auth", "token_revoked", "missing_scope", "is_archived"]) {
    test(`${error} → failed; the next re-run uploads once`, async () => {
      installSlack();
      await setToken(true);
      const { body, approvalId } = await approved();
      complete = { json: { ok: false, error } };
      const r = await invokeComm({ ...body, approvalId });
      expect(fileUpload(r)).toMatchObject({ ok: false, status: "failed" });
      expect(await record(approvalId)).toMatchObject({ state: "failed", code: "complete_upload_failed" });
      const failed = (await listAuditEvents(DEMO_ORG.id)).filter((e) => e.action === "slack.file_upload_failed"
        && (e.metadata as Record<string, unknown>)?.approvalId === approvalId);
      expect(failed.length).toBe(1);
      expect(failed[0].metadata).toMatchObject({ code: "complete_upload_failed", error });

      complete = { json: { ok: true, files: [{ id: "F_DEF_1" }] } };
      expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true, fileId: "F_DEF_1" });
      expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true, fileId: "F_DEF_1" });
      expect([getUrls, completes]).toEqual([2, 2]);
    });
  }

  const unknown: Array<[string, Complete]> = [
    ["timeout", { throws: true }],
    ["502 without JSON", { status: 502 }],
    ["503 with a Slack error body", { status: 503, json: { ok: false, error: "service_unavailable" } }],
    ["unknown Slack error", { json: { ok: false, error: "something_new" } }],
    ["ok:false without error", { json: { ok: false } }],
  ];
  for (const [name, c] of unknown) {
    test(`${name} → uncertain (not retried automatically)`, async () => {
      installSlack();
      await setToken(true);
      const { body, approvalId } = await approved();
      complete = c;
      const r = await invokeComm({ ...body, approvalId });
      expect(fileUpload(r)).toMatchObject({ ok: false, status: "uncertain", code: "approval_attachment_upload_uncertain" });
      expect(await record(approvalId)).toMatchObject({ state: "uncertain" });
      complete = { json: { ok: true, files: [{ id: "F_DEF_1" }] } };
      expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ status: "uncertain" });
      expect(completes).toBe(1);
    });
  }
});

describe("4. pollHint while the attachment is not_sent", () => {
  async function poll(approvalId: string, statusToken: string) {
    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
    const web = (await res.json()) as { pollHint?: string; fulfillment?: { fileUpload?: { status?: string } } };
    const mcp = (await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId, statusToken }, mcpCred()))
      .structuredContent as { pollHint?: string };
    return { web, mcp };
  }

  test("callback posted the text only → reinvoke_with_approvalId (status + MCP); after the re-run → fulfilled", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, approval, statusToken } = await approved();
    await fulfillIfApproved(approval, "approved");
    const before = await poll(approvalId, statusToken);
    expect(before.web.fulfillment?.fileUpload?.status).toBe("not_sent");
    expect(before.web.pollHint).toBe("reinvoke_with_approvalId");
    expect(before.mcp.pollHint).toBe("reinvoke_with_approvalId");

    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true });
    const after = await poll(approvalId, statusToken);
    expect(after.web.fulfillment?.fileUpload?.status).toBe("sent");
    expect(after.web.pollHint).toBe("fulfilled");
    expect(after.mcp.pollHint).toBe("fulfilled");
  });

  test("no attachment approved → fulfilled (unchanged)", async () => {
    installSlack();
    await setToken(true);
    const { approvalId, approval, statusToken } = await approved(undefined);
    await fulfillIfApproved(approval, "approved");
    const p = await poll(approvalId, statusToken);
    expect(p.web.pollHint).toBe("fulfilled");
    expect(p.mcp.pollHint).toBe("fulfilled");
  });
});
