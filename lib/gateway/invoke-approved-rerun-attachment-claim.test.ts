/**
 * 2026-10-04 (木村, #252 follow-up 2): the approved attachment is uploaded at most
 * once per approval, even when the same approval is re-run concurrently.
 *
 *  C. a claim is taken (atomic, per approval) BEFORE the upload; a concurrent
 *     re-run that cannot take it never downloads/uploads → in_progress.
 *  U. unknown outcome (completion threw / timed out / Slack answered an error at
 *     the completion step) → "uncertain": never retried automatically, recorded
 *     in the audit log and the response; later re-runs do not upload.
 *  F. a failure known to precede sharing (before files.completeUploadExternal)
 *     → "failed": a later re-run may upload (once).
 *  D. after success a later re-run never uploads again (also for the #252
 *     `attachmentFulfillment` record already in production).
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let downloads: string[] = [];
let gate: Promise<void> | null = null;
let onDownload: (() => void) | null = null;
mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async (url: string) => {
    downloads.push(url);
    onDownload?.();
    if (gate) { const g = gate; gate = null; await g; } // only the first download waits
    return Buffer.from("%PDF-1.4 approved content");
  },
}));

const TEST_KEY = "test-notification-key-0123456789abcdef-claim";
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = TEST_KEY;

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;

const APPROVED_URL = "https://example.com/approved.pdf?sig=SECRET_SIG_claim";
const FILE: FileAttachment = { fileRef: APPROVED_URL, filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };

type CompleteMode = "ok" | "throw" | "slack_error";
const originalFetch = globalThis.fetch;
let posts = 0, getUrls = 0, completes = 0;
let completeMode: CompleteMode = "ok";
let getUrlFails = false;
function recordSlack() {
  posts = 0; getUrls = 0; completes = 0; downloads = [];
  completeMode = "ok"; getUrlFails = false; gate = null; onDownload = null;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) { posts++; return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000099" }); }
    if (url.includes("files.getUploadURLExternal")) {
      getUrls++;
      if (getUrlFails) return Response.json({ ok: false, error: "ratelimited" });
      return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/ATT", file_id: "F_CLAIM_1" });
    }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (url.includes("files.completeUploadExternal")) {
      completes++;
      if (completeMode === "throw") throw new DOMException("The operation timed out.", "TimeoutError");
      if (completeMode === "slack_error") return Response.json({ ok: false, error: "internal_error" });
      return Response.json({ ok: true, files: [{ id: "F_CLAIM_1", timestamp: "1787911801.000001" }] });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) => upsertConversationAdapter({
  orgId: DEMO_ORG.id, surface: "slack", enabled, secrets: enabled ? { botToken: "xoxb-claim-test" } : {} });
afterEach(async () => {
  globalThis.fetch = originalFetch;
  gate = null; onDownload = null;
  await setToken(false).catch(() => undefined);
});

const jid = () => `job_claim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invokeComm = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
async function approved(): Promise<{ body: GatewayInvokeRequest; approvalId: string }> {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（claim・ダミー）", threadId: "1787911797.502889" },
    fileAttachment: FILE,
  };
  const q = await invokeComm(body);
  expect(q.httpStatus).toBe(402);
  const approvalId = String(q.body.approvalId);
  expect((await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id))?.status).toBe("approved");
  return { body, approvalId };
}
const rerun = (body: GatewayInvokeRequest, approvalId: string) => invokeComm({ ...body, approvalId });
type FU = { ok: boolean; code?: string; status?: string; fileId?: string; messageJa?: string };
const fileUpload = (r: { body: Record<string, unknown> }) => ((r.body.result || {}) as { fileUpload?: FU }).fileUpload;
const uploadRecord = async (id: string) =>
  (await getApprovalById(id, DEMO_ORG.id))!.metadata.attachmentUpload as Record<string, unknown> | undefined;
async function audits(approvalId: string, action: string) {
  const all = await listAuditEvents(DEMO_ORG.id);
  return all.filter((e) => e.action === action && (e.metadata as Record<string, unknown>)?.approvalId === approvalId);
}

describe("C. concurrent re-runs of the same approval upload once", () => {
  test("the second re-run cannot take the claim → in_progress, no download / no upload", async () => {
    recordSlack();
    await setToken(true);
    const { body, approvalId } = await approved();
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const firstDownload = new Promise<void>((r) => { onDownload = r; });
    const first = rerun(body, approvalId);
    await firstDownload; // first re-run holds the attachment claim and is mid-upload
    onDownload = null;
    const second = await rerun(body, approvalId);
    expect(second.httpStatus).toBe(200);
    expect(fileUpload(second)).toMatchObject({ ok: false, code: "approval_attachment_upload_in_progress", status: "in_progress" });
    expect(downloads.length).toBe(1);
    release();
    const done = await first;
    expect(fileUpload(done)).toMatchObject({ ok: true, fileId: "F_CLAIM_1" });
    expect(getUrls).toBe(1);
    expect(completes).toBe(1);
    expect(await uploadRecord(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_CLAIM_1", filename: "approved.pdf", bytes: 25 });
    expect((await audits(approvalId, "approval.attachment_upload_in_progress")).length).toBe(1);

    // D. a later re-run after success: no download, no upload, same file id.
    const later = await rerun(body, approvalId);
    expect(fileUpload(later)).toMatchObject({ ok: true, fileId: "F_CLAIM_1" });
    expect([downloads.length, getUrls, completes]).toEqual([1, 1, 1]);
    expect(posts).toBe(1); // approved text posted once in total
  });
});

describe("U. unknown outcome → uncertain, never retried automatically", () => {
  for (const mode of ["throw", "slack_error"] as const) {
    test(`completion ${mode} → uncertain in response + audit; later re-runs do not upload`, async () => {
      recordSlack();
      await setToken(true);
      const { body, approvalId } = await approved();
      completeMode = mode;
      const r = await rerun(body, approvalId);
      expect(r.httpStatus).toBe(200);
      expect(fileUpload(r)).toMatchObject({ ok: false, code: "approval_attachment_upload_uncertain", status: "uncertain" });
      expect(String(fileUpload(r)?.messageJa)).toContain("自動では再送しません");
      expect(await uploadRecord(approvalId)).toMatchObject({ state: "uncertain", code: "complete_upload_failed" });
      const ev = await audits(approvalId, "approval.attachment_upload_uncertain");
      expect(ev.length).toBe(1);
      expect(ev[0].metadata).toMatchObject({ filename: "approved.pdf", bytes: 25 });
      expect(JSON.stringify(ev)).not.toContain("SECRET_SIG_claim");
      expect(JSON.stringify(ev)).not.toContain("fileRefCiphertext");

      completeMode = "ok";
      const again = await rerun(body, approvalId);
      expect(fileUpload(again)).toMatchObject({ ok: false, code: "approval_attachment_upload_uncertain", status: "uncertain" });
      expect([downloads.length, getUrls, completes]).toEqual([1, 1, 1]);
    });
  }
});

describe("F. failure known to precede sharing → failed, a later re-run uploads once", () => {
  test("getUploadURLExternal error → failed; next re-run uploads; the one after does not", async () => {
    recordSlack();
    await setToken(true);
    const { body, approvalId } = await approved();
    getUrlFails = true;
    const r = await rerun(body, approvalId);
    expect(fileUpload(r)).toMatchObject({ ok: false, code: "get_upload_url_failed" });
    expect(fileUpload(r)?.status).not.toBe("uncertain");
    expect(await uploadRecord(approvalId)).toMatchObject({ state: "failed", code: "get_upload_url_failed" });
    expect(completes).toBe(0);

    getUrlFails = false;
    expect(fileUpload(await rerun(body, approvalId))).toMatchObject({ ok: true, fileId: "F_CLAIM_1" });
    expect(fileUpload(await rerun(body, approvalId))).toMatchObject({ ok: true, fileId: "F_CLAIM_1" });
    expect(completes).toBe(1);
  });
});

describe("D. #252 record already in production", () => {
  test("metadata.attachmentFulfillment ok → no upload, stored file id returned", async () => {
    recordSlack();
    await setToken(true);
    const { body, approvalId } = await approved();
    const stored = (await getApprovalById(approvalId, DEMO_ORG.id))!;
    const refSha256 = (stored.metadata.invoke as { fileAttachment: { refSha256: string } }).fileAttachment.refSha256;
    await updateApprovalMetadata(stored, { attachmentFulfillment: {
      ok: true, fileId: "F_PRIOR_252", filename: "approved.pdf", bytes: 25, refSha256, at: new Date().toISOString() } });
    const r = await rerun(body, approvalId);
    expect(fileUpload(r)).toMatchObject({ ok: true, fileId: "F_PRIOR_252" });
    expect([downloads.length, getUrls, completes]).toEqual([0, 0, 0]);
  });
});
