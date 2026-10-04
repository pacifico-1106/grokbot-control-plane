/**
 * 2026-10-04 (木村, #252 follow-up 3): the approval callback paths and W2 post the
 * approved TEXT only (unchanged). When the approval snapshot carries an approved
 * attachment, that is recorded instead of staying silent:
 *   - fulfillment result / metadata.fulfillment:
 *       fileUpload: { status: "not_sent", reason: "rerun_required", filename, bytes }
 *   - audit approval.attachment_not_sent (filename / bytes only — no reference,
 *     no host, no hash, no sealed value)
 * No attachment → no marker. The agent re-run (which uploads the approved file)
 * records no marker, and once the file is uploaded the status reports "sent".
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

let downloads = 0;
mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async () => { downloads++; return Buffer.from("%PDF-1.4 approved content"); },
}));
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-notsent";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { fulfillIfApproved, parseFulfillment } = await import("@/lib/approvals/fulfill");
const { runW2FulfillRetry } = await import("@/lib/stuck-watch/w2-unfulfilled");
const { defaultStuckWatchPolicy } = await import("@/lib/stuck-watch/validate");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;

const REF = "https://example.com/approved.pdf?sig=SECRET_SIG_notsent";
const REF_SHA = createHash("sha256").update(REF).digest("hex");
const FILE: FileAttachment = { fileRef: REF, filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };
const NOT_SENT = { status: "not_sent", reason: "rerun_required", filename: "approved.pdf", bytes: 25 };

const originalFetch = globalThis.fetch;
let posts = 0, uploads = 0;
function recordSlack() {
  posts = 0; uploads = 0; downloads = 0;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) { posts++; return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000077" }); }
    if (url.includes("files.getUploadURLExternal")) { uploads++; return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/NS", file_id: "F_NS_1" }); }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (url.includes("files.completeUploadExternal")) return Response.json({ ok: true, files: [{ id: "F_NS_1" }] });
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) => upsertConversationAdapter({
  orgId: DEMO_ORG.id, surface: "slack", enabled, secrets: enabled ? { botToken: "xoxb-notsent-test" } : {} });
afterEach(async () => { globalThis.fetch = originalFetch; await setToken(false).catch(() => undefined); });

const jid = () => `job_ns_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
async function approved(fileAttachment?: FileAttachment) {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（not_sent・ダミー）", threadId: "1787911797.502889" },
    ...(fileAttachment ? { fileAttachment } : {}),
  };
  const q = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
  expect(q.httpStatus).toBe(402);
  const approvalId = String(q.body.approvalId);
  const approval = (await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id))!;
  expect(approval.status).toBe("approved");
  return { body, approvalId, approval, statusToken: String(q.body.statusToken) };
}
const notSentAudits = async (approvalId: string) =>
  (await listAuditEvents(DEMO_ORG.id)).filter((e) => e.action === "approval.attachment_not_sent"
    && (e.metadata as Record<string, unknown>)?.approvalId === approvalId);
function noSecrets(text: string) {
  expect(text).not.toContain("SECRET_SIG_notsent");
  expect(text).not.toContain("example.com");
  expect(text).not.toContain(REF_SHA);
  expect(text).not.toContain("fileRefCiphertext");
  expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]{8,}\./);
}

describe("approval callback (fulfillIfApproved: Slack button / Telegram / LINE / web approve / proxy)", () => {
  test("text posted, attachment not uploaded, not_sent recorded in result + metadata + audit", async () => {
    recordSlack();
    await setToken(true);
    const { approvalId, approval, statusToken } = await approved(FILE);
    const result = await fulfillIfApproved(approval, "approved");
    expect(result).toMatchObject({ ok: true, delivery: "slack", fileUpload: NOT_SENT });
    expect([posts, uploads, downloads]).toEqual([1, 0, 0]);
    const stored = (await getApprovalById(approvalId, DEMO_ORG.id))!;
    expect(parseFulfillment(stored.metadata)?.fileUpload).toEqual(NOT_SENT);
    const ev = await notSentAudits(approvalId);
    expect(ev.length).toBe(1);
    expect(ev[0].metadata).toMatchObject({ filename: "approved.pdf", bytes: 25, reason: "rerun_required" });
    noSecrets(JSON.stringify(ev));
    noSecrets(JSON.stringify(result));

    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
    const status = (await res.json()) as { fulfillmentResult?: { fileUpload?: unknown } };
    expect(status.fulfillmentResult?.fileUpload).toEqual(NOT_SENT);

    // A second callback for the same approval: nothing re-posted, no second audit.
    await fulfillIfApproved((await getApprovalById(approvalId, DEMO_ORG.id))!, "approved");
    expect(posts).toBe(1);
    expect((await notSentAudits(approvalId)).length).toBe(1);
  });

  test("then the agent re-run uploads the approved file once; status reports sent", async () => {
    recordSlack();
    await setToken(true);
    const { body, approvalId, approval, statusToken } = await approved(FILE);
    await fulfillIfApproved(approval, "approved");
    const r = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: { ...body, approvalId } });
    expect(((r.body.result || {}) as { fileUpload?: unknown }).fileUpload).toMatchObject({ ok: true, fileId: "F_NS_1" });
    expect([posts, uploads]).toEqual([1, 1]);
    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
    const status = (await res.json()) as { fulfillmentResult?: { fileUpload?: unknown } };
    expect(status.fulfillmentResult?.fileUpload).toEqual({ status: "sent", fileId: "F_NS_1", filename: "approved.pdf", bytes: 25 });
  });

  test("no attachment approved → no marker, no audit", async () => {
    recordSlack();
    await setToken(true);
    const { approvalId, approval } = await approved();
    const result = await fulfillIfApproved(approval, "approved");
    expect(result?.ok).toBe(true);
    expect(result?.fileUpload).toBeUndefined();
    expect((await notSentAudits(approvalId)).length).toBe(0);
  });
});

describe("agent re-run (uploads the attachment itself)", () => {
  test("no not_sent marker and no not_sent audit", async () => {
    recordSlack();
    await setToken(true);
    const { body, approvalId } = await approved(FILE);
    const r = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: { ...body, approvalId } });
    expect(((r.body.result || {}) as { fileUpload?: unknown }).fileUpload).toMatchObject({ ok: true });
    const stored = (await getApprovalById(approvalId, DEMO_ORG.id))!;
    expect(parseFulfillment(stored.metadata)?.fileUpload).toEqual({ status: "sent", fileId: "F_NS_1", filename: "approved.pdf", bytes: 25 });
    expect((stored.metadata.fulfillment as Record<string, unknown>).fileUpload).toBeUndefined();
    expect((await notSentAudits(approvalId)).length).toBe(0);
  });
});

describe("W2 auto re-execution", () => {
  test("text posted, attachment not uploaded, not_sent recorded (result + metadata + audit)", async () => {
    recordSlack();
    await setToken(true);
    const { approvalId, approval } = await approved(FILE);
    const policy = { ...defaultStuckWatchPolicy(), enabled: true, approvedUnfulfilledMinutes: 0, retryBackoffSeconds: 0 };
    const w2 = await runW2FulfillRetry(approval, policy);
    expect(w2).toMatchObject({ ok: true, fulfillmentOk: true, fileUpload: NOT_SENT });
    expect([posts, uploads, downloads]).toEqual([1, 0, 0]);
    const stored = (await getApprovalById(approvalId, DEMO_ORG.id))!;
    expect(parseFulfillment(stored.metadata)?.fileUpload).toEqual(NOT_SENT);
    const ev = await notSentAudits(approvalId);
    expect(ev.length).toBe(1);
    noSecrets(JSON.stringify(ev));
  });
});
