/**
 * 2026-10-04 (木村 decision, #252 follow-up): a re-run after approval uploads ONLY
 * the attachment that was approved — the same contract as the approved text.
 *
 *  S. the approval snapshot records the request's fileAttachment as a sealed
 *     reference + metadata (no plain URL, no file body, no token); "no attachment"
 *     is recorded explicitly as `fileAttachment: null`.
 *  R. a re-run never uses the request's fileAttachment: only the snapshot's file
 *     is downloaded/uploaded (once), a differing request attachment is ignored
 *     and audited, the approved text is still posted.
 *  N. snapshot says "no attachment" → an attachment added later is never uploaded.
 *  L. legacy snapshot (no attachment field, pre-#252) + request attachment →
 *     409 approval_snapshot_missing_attachment, nothing posted at all;
 *     legacy without a request attachment → approved text posted as before.
 *  H/K. a size mismatch and an unsealed reference fail the upload closed.
 * Applies to comm.reply / comm.send / slack.post / slack.post_external.
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

let downloads: string[] = [];
const FILE_BYTES: Record<string, string> = {
  "https://example.com/approved.pdf?sig=SECRET_SIG_approved": "%PDF-1.4 approved content",
  "https://example.com/other.pdf?sig=SECRET_SIG_other": "%PDF-1.4 other content",
};
mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async (url: string) => {
    downloads.push(url);
    const body = FILE_BYTES[url];
    if (body === undefined) throw new Error("unexpected_fixture_file");
    return Buffer.from(body);
  },
}));

const TEST_KEY = "test-notification-key-0123456789abcdef-attachment";
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = TEST_KEY;

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { parseFulfillment } = await import("@/lib/approvals/fulfill");
const { publicApproval } = await import("@/lib/approvals/public");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;

const APPROVED_TEXT = "承認された本文です（添付テスト・ダミー）";
const REPLACEMENT_TEXT = "差し替えた本文です（承認されていない）";
const TOOLS = ["comm.reply", "comm.send", "slack.post", "slack.post_external"] as const;
const APPROVED_URL = "https://example.com/approved.pdf?sig=SECRET_SIG_approved";
const OTHER_URL = "https://example.com/other.pdf?sig=SECRET_SIG_other";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const APPROVED_FILE: FileAttachment = {
  fileRef: APPROVED_URL,
  filename: "approved.pdf",
  mimeType: "application/pdf",
  bytes: 25,
  title: "承認済みレポート",
  initialComment: "承認済みの添付です",
};
const OTHER_FILE: FileAttachment = {
  fileRef: OTHER_URL,
  filename: "other.pdf",
  mimeType: "application/pdf",
  title: "差し替え添付",
};

const originalFetch = globalThis.fetch;
let posts: string[] = [];
let uploadFilenames: string[] = [];
let completes = 0;
function recordSlack() {
  posts = [];
  downloads = [];
  uploadFilenames = [];
  completes = 0;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("chat.postMessage")) {
      posts.push(String((JSON.parse(String(init?.body || "{}")) as { text?: string }).text || ""));
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000099" });
    }
    if (url.includes("files.getUploadURLExternal")) {
      uploadFilenames.push(new URLSearchParams(String(init?.body || "")).get("filename") || "");
      return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/ATT", file_id: "F_ATTACH_1" });
    }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (url.includes("files.completeUploadExternal")) {
      completes++;
      return Response.json({ ok: true, files: [{ id: "F_ATTACH_1", timestamp: "1787911801.000001" }] });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) =>
  upsertConversationAdapter({
    orgId: DEMO_ORG.id,
    surface: "slack",
    enabled,
    secrets: enabled ? { botToken: "xoxb-attach-test" } : {},
  });

beforeAll(() => {
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = TEST_KEY;
});
afterEach(async () => {
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = TEST_KEY;
  globalThis.fetch = originalFetch;
  await setToken(false).catch(() => undefined);
});

const jid = (s: string) => `job_attach_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function commBody(tool: string, fileAttachment?: FileAttachment, text = APPROVED_TEXT): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId: jid(tool.replace(".", "_")),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text, threadId: "1787911797.502889" },
    ...(fileAttachment ? { fileAttachment } : {}),
  };
}
const invokeComm = (body: GatewayInvokeRequest) =>
  runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });

/** Queue (402) and approve. The agent re-run is the delivery path under test. */
async function queueAndApprove(tool: string, fileAttachment?: FileAttachment) {
  const body = commBody(tool, fileAttachment);
  const queued = await invokeComm(body);
  expect(queued.httpStatus).toBe(402);
  const approvalId = String(queued.body.approvalId);
  const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
  expect(approved?.status).toBe("approved");
  return { body, approvalId };
}

/** Same body, replacement text, and the given request attachment (or none). */
function rerun(body: GatewayInvokeRequest, approvalId: string, fileAttachment?: FileAttachment) {
  const { fileAttachment: _drop, ...rest } = body;
  void _drop;
  return invokeComm({
    ...rest,
    args: { ...(body.args as Record<string, unknown>), text: REPLACEMENT_TEXT },
    ...(fileAttachment ? { fileAttachment } : {}),
    approvalId,
  });
}

/** Simulate a record created before #252: the snapshot has no attachment field. */
async function makeLegacy(approvalId: string) {
  const stored = await getApprovalById(approvalId, DEMO_ORG.id);
  const invoke = { ...(stored!.metadata.invoke as Record<string, unknown>) };
  delete invoke.fileAttachment;
  await updateApprovalMetadata(stored!, { invoke });
  const after = await getApprovalById(approvalId, DEMO_ORG.id);
  expect("fileAttachment" in (after!.metadata.invoke as Record<string, unknown>)).toBe(false);
}

const snapshotAttachment = async (approvalId: string) =>
  ((await getApprovalById(approvalId, DEMO_ORG.id))!.metadata.invoke as Record<string, unknown>).fileAttachment;
const resultOf = (r: { body: Record<string, unknown> }) =>
  (r.body.result || {}) as { fileUpload?: { ok: boolean; code?: string; fileId?: string }; fileAttachmentReceived?: boolean };

describe("S. the approval snapshot records the attachment reference, sealed", () => {
  for (const tool of TOOLS) {
    test(`${tool}: metadata + ref hash + sealed ref; no plain URL, no body, no token; redacted publicly`, async () => {
      recordSlack();
      const { approvalId } = await queueAndApprove(tool, APPROVED_FILE);
      const att = (await snapshotAttachment(approvalId)) as Record<string, unknown>;
      expect(att).toMatchObject({
        filename: "approved.pdf",
        mimeType: "application/pdf",
        bytes: 25,
        title: "承認済みレポート",
        initialComment: "承認済みの添付です",
        refKind: "url",
        refHost: "example.com",
        refSha256: sha256(APPROVED_URL),
        sealed: true,
      });
      expect(String(att.fileRefCiphertext)).toMatch(/^v1\./);
      const stored = await getApprovalById(approvalId, DEMO_ORG.id);
      const raw = JSON.stringify(stored!.metadata);
      expect(raw).not.toContain("SECRET_SIG_approved");
      expect(raw).not.toContain("example.com/approved.pdf");
      expect(raw).not.toContain("%PDF");
      expect(raw).not.toContain("xoxb-");
      const pub = JSON.stringify(publicApproval(stored!).metadata);
      expect(pub).not.toContain(String(att.fileRefCiphertext));
      expect(pub).toContain("approved.pdf");
      expect(downloads).toEqual([]); // approval time never fetches the file
    });

    test(`${tool}: no attachment at approval is recorded explicitly as null`, async () => {
      recordSlack();
      const { approvalId } = await queueAndApprove(tool);
      const invoke = (await getApprovalById(approvalId, DEMO_ORG.id))!.metadata.invoke as Record<string, unknown>;
      expect("fileAttachment" in invoke).toBe(true);
      expect(invoke.fileAttachment).toBeNull();
    });
  }
});

describe("R. re-run uploads only the approved attachment", () => {
  for (const tool of TOOLS) {
    test(`${tool}: a different request attachment is ignored; the approved file is uploaded once`, async () => {
      recordSlack();
      const { body, approvalId } = await queueAndApprove(tool, APPROVED_FILE);
      await setToken(true);
      const r = await rerun(body, approvalId, OTHER_FILE);
      expect(r.httpStatus).toBe(200);
      expect(downloads).not.toContain(OTHER_URL);
      expect(uploadFilenames).not.toContain("other.pdf");
      expect(downloads).toEqual([APPROVED_URL]);
      expect(uploadFilenames).toEqual(["approved.pdf"]);
      expect(completes).toBe(1);
      expect(resultOf(r).fileUpload).toMatchObject({ ok: true, fileId: "F_ATTACH_1" });
      expect(posts.length).toBe(1);
      expect(posts[0]).toContain(APPROVED_TEXT);
      expect(posts[0]).not.toContain(REPLACEMENT_TEXT);
      const events = await listAuditEvents(DEMO_ORG.id, 500);
      const ignored = events.find((e) => e.action === "approval.attachment_request_ignored" && e.metadata?.approvalId === approvalId);
      expect(ignored?.metadata).toMatchObject({ reason: "differs_from_snapshot", requestFilename: "other.pdf" });
      expect(JSON.stringify(ignored?.metadata)).not.toContain("SECRET_SIG_other");
      const uploaded = events.find((e) => e.action === "slack.file_uploaded" && e.metadata?.approvalId === approvalId);
      expect(uploaded).toBeTruthy();
      expect(JSON.stringify(uploaded?.metadata)).not.toContain("SECRET_SIG_approved");
    });

    test(`${tool}: re-run without a request attachment still uploads the approved one; repeat re-run does not re-upload`, async () => {
      recordSlack();
      const { body, approvalId } = await queueAndApprove(tool, APPROVED_FILE);
      await setToken(true);
      const first = await rerun(body, approvalId);
      expect(first.httpStatus).toBe(200);
      expect(downloads).toEqual([APPROVED_URL]);
      expect(completes).toBe(1);
      expect(resultOf(first).fileUpload).toMatchObject({ ok: true, fileId: "F_ATTACH_1" });
      const again = await rerun(body, approvalId, APPROVED_FILE);
      expect(again.httpStatus).toBe(200);
      expect(downloads).toEqual([APPROVED_URL]);
      expect(completes).toBe(1);
      expect(resultOf(again).fileUpload).toMatchObject({ ok: true, fileId: "F_ATTACH_1" });
      expect(posts.length).toBe(1);
      const stored = await getApprovalById(approvalId, DEMO_ORG.id);
      // #252 follow-up: the upload is recorded by the upload claim (metadata.attachmentUpload).
      expect(stored!.metadata.attachmentUpload).toMatchObject({ state: "succeeded", fileId: "F_ATTACH_1" });
    });
  }
});

describe("N. snapshot recorded no attachment: a later request attachment is never uploaded", () => {
  for (const tool of TOOLS) {
    test(`${tool}: fileUpload approval_attachment_not_approved, approved text still posted`, async () => {
      recordSlack();
      const { body, approvalId } = await queueAndApprove(tool);
      await setToken(true);
      const r = await rerun(body, approvalId, OTHER_FILE);
      expect(r.httpStatus).toBe(200);
      expect(downloads).toEqual([]);
      expect(uploadFilenames).toEqual([]);
      expect(completes).toBe(0);
      expect(resultOf(r).fileUpload).toMatchObject({ ok: false, code: "approval_attachment_not_approved" });
      expect(posts.length).toBe(1);
      expect(posts[0]).toContain(APPROVED_TEXT);
      const events = await listAuditEvents(DEMO_ORG.id, 500);
      expect(events.some((e) => e.action === "approval.attachment_request_ignored" &&
        e.metadata?.approvalId === approvalId && e.metadata?.reason === "not_approved")).toBe(true);
    });
  }
});

describe("L. legacy snapshot without an attachment field (pre-#252 record)", () => {
  for (const tool of TOOLS) {
    test(`${tool}: request attachment → 409 approval_snapshot_missing_attachment, nothing posted`, async () => {
      recordSlack();
      const { body, approvalId } = await queueAndApprove(tool);
      await makeLegacy(approvalId);
      await setToken(true);
      const r = await rerun(body, approvalId, OTHER_FILE);
      expect(r.httpStatus).toBe(409);
      expect(r.body.code).toBe("approval_snapshot_missing_attachment");
      expect(String(r.body.message)).toContain("再承認");
      expect(posts).toEqual([]);
      expect(downloads).toEqual([]);
      expect(uploadFilenames).toEqual([]);
      const stored = await getApprovalById(approvalId, DEMO_ORG.id);
      expect(parseFulfillment(stored?.metadata)).toBeNull();
      const events = await listAuditEvents(DEMO_ORG.id, 500);
      expect(events.some((e) => e.action === "approval.snapshot_missing_attachment" && e.metadata?.approvalId === approvalId)).toBe(true);
    });

    test(`${tool}: no request attachment → approved text posted as before, no upload`, async () => {
      recordSlack();
      const { body, approvalId } = await queueAndApprove(tool);
      await makeLegacy(approvalId);
      await setToken(true);
      const r = await rerun(body, approvalId);
      expect(r.httpStatus).toBe(200);
      expect(posts.length).toBe(1);
      expect(posts[0]).toContain(APPROVED_TEXT);
      expect(posts[0]).not.toContain(REPLACEMENT_TEXT);
      expect(downloads).toEqual([]);
      expect(completes).toBe(0);
      expect(resultOf(r).fileUpload).toBeUndefined();
    });
  }
});

describe("H/K. integrity and sealing fail closed", () => {
  test("comm.reply: downloaded bytes that differ from the approved size block the upload", async () => {
    recordSlack();
    const { body, approvalId } = await queueAndApprove("comm.reply", { ...APPROVED_FILE, bytes: 999 });
    expect(await snapshotAttachment(approvalId)).toMatchObject({ bytes: 999 });
    await setToken(true);
    const r = await rerun(body, approvalId);
    expect(r.httpStatus).toBe(200);
    expect(downloads).toEqual([APPROVED_URL]);
    expect(resultOf(r).fileUpload).toMatchObject({ ok: false, code: "file_content_mismatch" });
    expect(uploadFilenames).toEqual([]);
    expect(completes).toBe(0);
    expect(posts.length).toBe(1);
  });

  test("comm.reply: no encryption key at approval → reference not stored; re-run fails the upload closed", async () => {
    recordSlack();
    delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
    const { body, approvalId } = await queueAndApprove("comm.reply", APPROVED_FILE);
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = TEST_KEY;
    const att = (await snapshotAttachment(approvalId)) as Record<string, unknown>;
    expect(att).toMatchObject({ filename: "approved.pdf", sealed: false, refSha256: sha256(APPROVED_URL) });
    expect(att.fileRefCiphertext).toBeUndefined();
    expect(JSON.stringify(att)).not.toContain("SECRET_SIG_approved");
    await setToken(true);
    const r = await rerun(body, approvalId, APPROVED_FILE); // even the identical request ref is not used
    expect(r.httpStatus).toBe(200);
    expect(resultOf(r).fileUpload).toMatchObject({ ok: false, code: "approval_attachment_unavailable" });
    expect(downloads).toEqual([]);
    expect(completes).toBe(0);
    expect(posts.length).toBe(1);
  });
});
