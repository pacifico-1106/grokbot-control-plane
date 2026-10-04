/**
 * 2026-10-04 (木村, #253 follow-up 6): the W2 cron records the not_sent marker
 * when the approved text was posted, the snapshot carries an approved
 * attachment and nothing says what happened to it (no metadata.attachmentUpload,
 * no #252 attachmentFulfillment, no stored fileUpload marker) — e.g. a re-run
 * that stopped between the text post and the upload claim. Idempotent: one
 * marker, one approval.attachment_not_sent audit, also under concurrent runs.
 * Behind APPROVAL_ATTACHMENT_RECONCILE_ENABLED (needs the new RPC).
 * Demo mode, dummy values, Slack mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-sweep";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { parseFulfillment } = await import("@/lib/approvals/fulfill");
const { runApprovalAttachmentReconcile } = await import("@/lib/approvals/attachment-reconcile");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;

const FILE: FileAttachment = { fileRef: "https://example.com/approved.pdf?sig=SECRET_SIG_sweep", filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };
const NOT_SENT = { status: "not_sent", reason: "rerun_required", filename: "approved.pdf", bytes: 25 };
const LATER = () => new Date(Date.now() + 11 * 60_000);

const originalFetch = globalThis.fetch;
let slackCalls = 0;
beforeEach(() => {
  process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED = "true";
  slackCalls = 0;
  globalThis.fetch = (async () => { slackCalls++; return Response.json({ ok: false, error: "unexpected_fetch" }); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED; });

const jid = () => `job_sw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
/** Approved; the text is recorded as posted, the attachment left without any record. */
async function textPostedOnly(fileAttachment: FileAttachment | null = FILE) {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（sweep・ダミー）", threadId: "1787911797.502889" },
    ...(fileAttachment ? { fileAttachment } : {}),
  };
  const q = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
  expect(q.httpStatus).toBe(402);
  const approvalId = String(q.body.approvalId);
  const approval = (await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id))!;
  await updateApprovalMetadata(approval, { fulfillment: {
    ok: true, delivery: "slack", channel: "C_INTERNAL", ts: "1787911800.000123", at: new Date().toISOString() } });
  return { approvalId, statusToken: String(q.body.statusToken) };
}
const latest = async (id: string) => (await getApprovalById(id, DEMO_ORG.id))!;
const sweep = async (id: string, now = LATER()) => runApprovalAttachmentReconcile([await latest(id)], { now });
const notSentAudits = async (approvalId: string) =>
  (await listAuditEvents(DEMO_ORG.id)).filter((e) => e.action === "approval.attachment_not_sent"
    && (e.metadata as Record<string, unknown>)?.approvalId === approvalId);

describe("scheduled not_sent marking", () => {
  test("text posted + approved attachment + no record → marker + one audit; poll says reinvoke", async () => {
    const { approvalId, statusToken } = await textPostedOnly();
    const run = await sweep(approvalId);
    expect(run.notSentMarked).toEqual([approvalId]);
    expect(parseFulfillment((await latest(approvalId)).metadata)?.fileUpload).toEqual(NOT_SENT);
    expect((await latest(approvalId)).metadata.fulfillment).toMatchObject({ ok: true, delivery: "slack", ts: "1787911800.000123" });
    const ev = await notSentAudits(approvalId);
    expect(ev.length).toBe(1);
    expect(ev[0].metadata).toMatchObject({ filename: "approved.pdf", bytes: 25, reason: "rerun_required", phase: "stuck_watch.reconcile" });
    expect(JSON.stringify(ev)).not.toContain("SECRET_SIG_sweep");
    expect(JSON.stringify(ev)).not.toContain("example.com");
    expect(slackCalls).toBe(0);

    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
    expect(((await res.json()) as { pollHint?: string }).pollHint).toBe("reinvoke_with_approvalId");
  });

  test("idempotent: a second run (and concurrent runs) add nothing", async () => {
    const { approvalId } = await textPostedOnly();
    const approval = await latest(approvalId);
    const [a, b] = await Promise.all([
      runApprovalAttachmentReconcile([approval], { now: LATER() }),
      runApprovalAttachmentReconcile([approval], { now: LATER() }),
    ]);
    expect([...a.notSentMarked, ...b.notSentMarked]).toEqual([approvalId]);
    expect((await sweep(approvalId)).notSentMarked).toEqual([]);
    expect((await notSentAudits(approvalId)).length).toBe(1);
  });

  test("text posted less than 10 min ago → not yet", async () => {
    const { approvalId } = await textPostedOnly();
    expect((await sweep(approvalId, new Date(Date.now() + 2 * 60_000))).notSentMarked).toEqual([]);
    expect((await notSentAudits(approvalId)).length).toBe(0);
  });

  test("an upload record exists → not marked", async () => {
    const { approvalId } = await textPostedOnly();
    await updateApprovalMetadata(await latest(approvalId), { attachmentUpload: { state: "failed", claimId: "c-1", code: "get_upload_url_failed" } });
    expect((await sweep(approvalId)).notSentMarked).toEqual([]);
    expect((await notSentAudits(approvalId)).length).toBe(0);
  });

  test("no approved attachment → not marked", async () => {
    const { approvalId } = await textPostedOnly(null);
    expect((await sweep(approvalId)).notSentMarked).toEqual([]);
  });

  test("text not posted (fulfillment failed) → not marked", async () => {
    const { approvalId } = await textPostedOnly();
    await updateApprovalMetadata(await latest(approvalId), { fulfillment: { ok: false, error: "slack_post_failed", at: new Date().toISOString() } });
    expect((await sweep(approvalId)).notSentMarked).toEqual([]);
  });

  test("flag OFF → not marked, no audit", async () => {
    const { approvalId } = await textPostedOnly();
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    expect((await sweep(approvalId)).notSentMarked).toEqual([]);
    expect(parseFulfillment((await latest(approvalId)).metadata)?.fileUpload).toBeUndefined();
    expect((await notSentAudits(approvalId)).length).toBe(0);
  });
});
