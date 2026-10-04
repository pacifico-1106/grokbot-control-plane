/**
 * 2026-10-04 (木村, #253 follow-up 1+2): the W2 cron settles stale `running` and
 * `uncertain` attachment upload claims by itself (八坂: no manual work, no SQL).
 *
 *   check: read-only Slack Web API with the org's conversation token
 *          (auth.test → poster id, conversations.replies on the approved
 *          channel/thread since the claim time), form-encoded
 *   found exactly once (filename + bytes + poster)  → succeeded + fileId
 *   complete scan, nothing similar                  → failed (next re-run uploads once)
 *   cannot check (no token / API error / missing_scope / ambiguous / truncated /
 *   non-Slack surface)                              → uncertain + ONE admin-agent
 *                                                     stuck-watch item (never a human)
 *   every transition: conditional on the state + claimId that was read
 *   every outcome: one audit (filename / bytes / code only)
 *   flag APPROVAL_ATTACHMENT_RECONCILE_ENABLED OFF (default) → nothing happens
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let downloads = 0;
mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async () => { downloads++; return Buffer.from("%PDF-1.4 approved content"); },
}));
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-reconcile";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { claimAttachmentUpload, finishAttachmentUpload } = await import("@/lib/approvals/attachment-upload-claim");
const { runApprovalAttachmentReconcile } = await import("@/lib/approvals/attachment-reconcile");
const { SLACK_FORM_METHODS } = await import("@/lib/slack/web-api-request");
const { runStuckWatchList } = await import("@/lib/stuck-watch/admin-handlers");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
const { GET: w2Cron } = await import("@/app/api/cron/stuck-watch-w2/route");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;
type ApprovalRequest = import("@/lib/types").ApprovalRequest;

const REF = "https://example.com/approved.pdf?sig=SECRET_SIG_reconcile";
const FILE: FileAttachment = { fileRef: REF, filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };
const THREAD = "1787911797.502889";
const ME = "U_BOT_CONV";
const LATER = () => new Date(Date.now() + 11 * 60_000);
const slackTs = (offsetSeconds: number) => `${Math.floor(Date.now() / 1000) + offsetSeconds}.000100`;

type Call = { method: string; contentType: string; body: string; auth: string };
const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let posts = 0, getUrls = 0, completes = 0;
let completeMode: "ok" | "throw" = "ok";
let authTest: () => Record<string, unknown> = () => ({ ok: true, user_id: ME, bot_id: "B_CONV" });
let replies: (p: URLSearchParams) => Record<string, unknown> | Promise<Record<string, unknown>> =
  () => ({ ok: true, messages: [], has_more: false });

function installSlack() {
  calls = []; posts = 0; getUrls = 0; completes = 0; downloads = 0; completeMode = "ok";
  authTest = () => ({ ok: true, user_id: ME, bot_id: "B_CONV" });
  replies = () => ({ ok: true, messages: [], has_more: false });
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.match(/slack\.com\/api\/([A-Za-z.]+)/)?.[1] ?? "";
    const headers = new Headers(init?.headers);
    const call = { method, contentType: headers.get("content-type") || "", body: String(init?.body ?? ""), auth: headers.get("authorization") || "" };
    if (method === "chat.postMessage") { posts++; return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000077" }); }
    if (method === "files.getUploadURLExternal") { getUrls++; return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/RC", file_id: "F_RC_UP" }); }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (method === "files.completeUploadExternal") {
      completes++;
      if (completeMode === "throw") throw new DOMException("The operation timed out.", "TimeoutError");
      return Response.json({ ok: true, files: [{ id: "F_RC_UP" }] });
    }
    calls.push(call);
    if (method === "auth.test") return Response.json(authTest());
    if (method === "conversations.replies") return Response.json(await replies(new URLSearchParams(call.body)));
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) => upsertConversationAdapter({
  orgId: DEMO_ORG.id, surface: "slack", enabled, secrets: enabled ? { botToken: "xoxb-reconcile-test" } : {} });

beforeEach(() => { process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED = "true"; });
afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
  await setToken(false).catch(() => undefined);
});

const jid = () => `job_rc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invokeComm = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
async function approved(surface: "slack" | "line" = "slack") {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: THREAD },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（reconcile・ダミー）", threadId: THREAD },
    fileAttachment: FILE,
  };
  const q = await invokeComm(body);
  expect(q.httpStatus).toBe(402);
  const approvalId = String(q.body.approvalId);
  const approval = (await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id))!;
  expect(approval.status).toBe("approved");
  if (surface !== "slack") {
    const invoke = approval.metadata.invoke as Record<string, unknown>;
    await updateApprovalMetadata(approval, { invoke: { ...invoke, conversation: { ...(invoke.conversation as object), surface } } });
  }
  return { body, approvalId, statusToken: String(q.body.statusToken) };
}
/** Agent re-run whose completion step times out → uncertain claim record. */
async function uncertainApproval(surface: "slack" | "line" = "slack") {
  const a = await approved(surface);
  completeMode = "throw";
  await invokeComm({ ...a.body, approvalId: a.approvalId });
  completeMode = "ok";
  expect(await record(a.approvalId)).toMatchObject({ state: "uncertain" });
  calls = [];
  return a;
}
const latest = async (id: string) => (await getApprovalById(id, DEMO_ORG.id))!;
const record = async (id: string) => (await latest(id)).metadata.attachmentUpload as Record<string, unknown> | undefined;
async function audits(approvalId: string, action: string) {
  return (await listAuditEvents(DEMO_ORG.id)).filter((e) => e.action === action
    && (e.metadata as Record<string, unknown>)?.approvalId === approvalId);
}
const reconcile = async (ids: string[], now = LATER()) =>
  runApprovalAttachmentReconcile(await Promise.all(ids.map(latest)) as ApprovalRequest[], { now });
const fileMsg = (file: Record<string, unknown>, ts = slackTs(30), user = ME) => ({ type: "message", ts, user, files: [file] });
const theFile = (over: Record<string, unknown> = {}) => ({ id: "F_SHARED_1", name: "approved.pdf", size: 25, user: ME, ...over });
function noSecrets(text: string) {
  expect(text).not.toContain("SECRET_SIG_reconcile");
  expect(text).not.toContain("example.com");
  expect(text).not.toContain("xoxb-reconcile-test");
  expect(text).not.toContain("fileRefCiphertext");
}
const fileUpload = (r: { body: Record<string, unknown> }) =>
  ((r.body.result || {}) as { fileUpload?: Record<string, unknown> }).fileUpload;

describe("Slack lookup: read-only, form-encoded, token only in the Authorization header", () => {
  test("auth.test + conversations.replies are form methods", () => {
    expect(SLACK_FORM_METHODS.has("auth.test")).toBe(true);
    expect(SLACK_FORM_METHODS.has("conversations.replies")).toBe(true);
  });

  test("calls auth.test then conversations.replies on the approved channel/thread since the claim", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    const claimedAt = String((await record(approvalId))?.claimedAt);
    await reconcile([approvalId]);
    expect(calls.map((c) => c.method)).toEqual(["auth.test", "conversations.replies"]);
    for (const c of calls) {
      expect(c.contentType).toBe("application/x-www-form-urlencoded");
      expect(c.auth).toBe("Bearer xoxb-reconcile-test");
      expect(c.body).not.toContain("xoxb");
    }
    const p = new URLSearchParams(calls[1].body);
    expect(p.get("channel")).toBe("C_INTERNAL");
    expect(p.get("ts")).toBe(THREAD);
    expect(Number(p.get("oldest"))).toBeLessThanOrEqual(Date.parse(claimedAt) / 1000);
    expect(Number(p.get("oldest"))).toBeGreaterThan(Date.parse(claimedAt) / 1000 - 600);
    expect([posts, getUrls, completes]).toEqual([1, 1, 1]); // nothing posted / uploaded by the check
  });
});

describe("uncertain → found exactly once → succeeded + fileId", () => {
  test("filename + bytes + poster match after the claim → succeeded; re-run does not upload; status sent", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await uncertainApproval();
    replies = () => ({ ok: true, has_more: false, messages: [
      { type: "message", ts: THREAD, user: "U_HUMAN", text: "親メッセージ" },
      fileMsg(theFile()),
    ] });
    const run = await reconcile([approvalId]);
    expect(run.enabled).toBe(true);
    expect(run.results.length).toBe(1);
    expect(run.results[0]).toMatchObject({ approvalId, from: "uncertain", outcome: "succeeded", applied: true });
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_SHARED_1", filename: "approved.pdf", bytes: 25 });
    const ev = await audits(approvalId, "approval.attachment_reconciled");
    expect(ev.length).toBe(1);
    expect(ev[0].metadata).toMatchObject({ outcome: "succeeded", filename: "approved.pdf", bytes: 25, code: "reconcile_found" });
    noSecrets(JSON.stringify(ev));

    const again = await invokeComm({ ...body, approvalId });
    expect(fileUpload(again)).toMatchObject({ ok: true, fileId: "F_SHARED_1" });
    expect([getUrls, completes]).toEqual([1, 1]);
    const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
    const status = (await res.json()) as { fulfillment?: { fileUpload?: unknown } };
    expect(status.fulfillment?.fileUpload).toMatchObject({ status: "sent", fileId: "F_SHARED_1" });

    // settled: a later run makes no Slack call and writes nothing
    calls = [];
    await reconcile([approvalId]);
    expect(calls).toEqual([]);
    expect((await audits(approvalId, "approval.attachment_reconciled")).length).toBe(1);
  });

  test("the match is found on the second page (cursor followed)", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    replies = (p) => p.get("cursor")
      ? { ok: true, has_more: false, messages: [fileMsg(theFile({ id: "F_PAGE_2" }))] }
      : { ok: true, has_more: true, response_metadata: { next_cursor: "page2" }, messages: [{ type: "message", ts: slackTs(5), user: "U_HUMAN", text: "x" }] };
    await reconcile([approvalId]);
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_PAGE_2" });
  });
});

describe("uncertain → complete scan, nothing similar → failed; the next re-run uploads once", () => {
  test("failed + audit; re-run uploads once; the one after does not", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId } = await uncertainApproval();
    replies = () => ({ ok: true, has_more: false, messages: [
      { type: "message", ts: slackTs(10), user: "U_HUMAN", text: "返信" },
      fileMsg({ id: "F_OTHER", name: "other.png", size: 999, user: "U_HUMAN" }, slackTs(20), "U_HUMAN"),
    ] });
    const run = await reconcile([approvalId]);
    expect(run.results[0]).toMatchObject({ outcome: "failed", applied: true, code: "reconcile_not_found" });
    expect(await record(approvalId)).toMatchObject({ state: "failed", code: "reconcile_not_found" });
    const ev = await audits(approvalId, "approval.attachment_reconciled");
    expect(ev.length).toBe(1);
    expect(ev[0].metadata).toMatchObject({ outcome: "failed", filename: "approved.pdf", bytes: 25, code: "reconcile_not_found" });
    noSecrets(JSON.stringify(ev));

    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true, fileId: "F_RC_UP" });
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true, fileId: "F_RC_UP" });
    expect([getUrls, completes]).toEqual([2, 2]); // 1 timed-out attempt + exactly 1 re-upload
  });
});

describe("cannot check → stays uncertain, ONE admin-agent stuck-watch item, never a human", () => {
  const cases: Array<[string, () => void, string]> = [
    ["missing_scope on conversations.replies", () => { replies = () => ({ ok: false, error: "missing_scope", needed: "channels:history" }); }, "reconcile_slack_missing_scope"],
    ["network error (fetch throws)", () => { replies = () => { throw new Error("boom"); }; }, "reconcile_slack_network_error"],
    ["auth.test invalid_auth", () => { authTest = () => ({ ok: false, error: "invalid_auth" }); }, "reconcile_slack_invalid_auth"],
    ["ambiguous: two exact matches", () => { replies = () => ({ ok: true, has_more: false, messages: [fileMsg(theFile()), fileMsg(theFile({ id: "F_SHARED_2" }), slackTs(40))] }); }, "reconcile_ambiguous_match"],
    ["ambiguous: same name, different size", () => { replies = () => ({ ok: true, has_more: false, messages: [fileMsg(theFile({ size: 26 }))] }); }, "reconcile_ambiguous_match"],
    ["ambiguous: same name + size, other poster", () => { replies = () => ({ ok: true, has_more: false, messages: [fileMsg(theFile({ user: "U_HUMAN" }), slackTs(30), "U_HUMAN")] }); }, "reconcile_ambiguous_match"],
    ["ambiguous: exact match just before the claim time", () => { replies = () => ({ ok: true, has_more: false, messages: [fileMsg(theFile(), slackTs(-30))] }); }, "reconcile_ambiguous_match"],
    ["file details hidden", () => { replies = () => ({ ok: true, has_more: false, messages: [fileMsg({ id: "F_HIDDEN", file_access: "check_file_info" })] }); }, "reconcile_file_details_hidden"],
    ["scan truncated (page cap)", () => { replies = () => ({ ok: true, has_more: true, response_metadata: { next_cursor: "more" }, messages: [{ type: "message", ts: slackTs(5), user: "U_HUMAN", text: "x" }] }); }, "reconcile_scan_truncated"],
  ];
  for (const [name, arrange, code] of cases) {
    test(name, async () => {
      installSlack();
      await setToken(true);
      const { approvalId } = await uncertainApproval();
      const postsBefore = posts;
      arrange();
      const run = await reconcile([approvalId]);
      expect(run.results[0]).toMatchObject({ outcome: "uncertain", code, notified: true });
      expect(await record(approvalId)).toMatchObject({ state: "uncertain", code });
      expect(String((await record(approvalId))?.adminNotifiedAt || "")).not.toBe("");
      expect(posts).toBe(postsBefore); // no Slack message to anyone
      const notes = await audits(approvalId, "stuck_watch.attachment_uncertain_notify");
      expect(notes.length).toBe(1);
      expect(notes[0].metadata).toMatchObject({ itemId: `a1:${approvalId}`, code, filename: "approved.pdf", bytes: 25 });
      expect((notes[0].metadata as Record<string, unknown>).notifyMouth).toBeUndefined();
      noSecrets(JSON.stringify(notes));
      expect((await audits(approvalId, "approval.attachment_reconciled")).map((e) => e.metadata?.outcome)).toEqual(["uncertain"]);

      const list = await runStuckWatchList(DEMO_ORG.id, { kind: "a1" });
      const item = (list.items || []).find((i) => i.id === `a1:${approvalId}`);
      expect(item).toMatchObject({ kind: "a1_attachment_uncertain", status: "notified", approvalId, code });
      expect(String(item?.nextStepJa)).not.toBe("");
      noSecrets(JSON.stringify(item));

      // the next runs check again but never notify again
      await reconcile([approvalId]);
      await reconcile([approvalId]);
      expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
      expect((await audits(approvalId, "approval.attachment_reconciled")).length).toBe(1);
      expect(posts).toBe(postsBefore);
    });
  }

  test("no conversation token → uncertain + one notification, no Slack call", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    await setToken(false);
    const run = await reconcile([approvalId]);
    expect(run.results[0]).toMatchObject({ outcome: "uncertain", notified: true });
    expect(String(run.results[0].code)).toMatch(/^reconcile_token_/);
    expect(calls).toEqual([]);
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
  });

  test("a later successful check settles a notified item (no second notification)", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    replies = () => ({ ok: false, error: "missing_scope" });
    await reconcile([approvalId]);
    replies = () => ({ ok: true, has_more: false, messages: [fileMsg(theFile())] });
    await reconcile([approvalId]);
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_SHARED_1" });
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
    const list = await runStuckWatchList(DEMO_ORG.id, { kind: "a1" });
    expect((list.items || []).some((i) => i.id === `a1:${approvalId}`)).toBe(false);
  });
});

describe("non-Slack conversation surface → uncertain + admin agent (no shared verifier yet)", () => {
  test("surface line: no Slack call, uncertain, one notification", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval("line");
    const run = await reconcile([approvalId]);
    expect(run.results[0]).toMatchObject({ outcome: "uncertain", code: "reconcile_surface_unsupported", notified: true });
    expect(calls).toEqual([]);
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
  });
});

describe("stale running claim", () => {
  async function runningClaim() {
    const a = await approved();
    const approval = await latest(a.approvalId);
    const refSha256 = (approval.metadata.invoke as { fileAttachment: { refSha256: string } }).fileAttachment.refSha256;
    const claim = await claimAttachmentUpload(approval, refSha256);
    expect(claim.kind).toBe("claimed");
    calls = [];
    return { ...a, claimId: (claim as { claimId: string }).claimId };
  }

  test("running < 10 min → untouched, no Slack call", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await runningClaim();
    const run = await reconcile([approvalId], new Date(Date.now() + 5 * 60_000));
    expect(run.results.filter((r) => r.approvalId === approvalId && r.applied)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await record(approvalId)).toMatchObject({ state: "running" });
  });

  test("running ≥ 10 min, shared → succeeded", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await runningClaim();
    replies = () => ({ ok: true, has_more: false, messages: [fileMsg(theFile({ id: "F_RUN_1" }))] });
    const run = await reconcile([approvalId]);
    expect(run.results[0]).toMatchObject({ from: "running", outcome: "succeeded", applied: true });
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_RUN_1" });
  });

  test("running ≥ 10 min, not shared → failed", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await runningClaim();
    await reconcile([approvalId]);
    expect(await record(approvalId)).toMatchObject({ state: "failed", code: "reconcile_not_found" });
  });

  test("running ≥ 10 min, cannot check → uncertain + one notification", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await runningClaim();
    replies = () => ({ ok: false, error: "ratelimited" });
    await reconcile([approvalId]);
    expect(await record(approvalId)).toMatchObject({ state: "uncertain", code: "reconcile_slack_ratelimited" });
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
  });

  test("the holder finishes while the check runs → the reconcile write is refused (state changed)", async () => {
    installSlack();
    await setToken(true);
    const { approvalId, claimId } = await runningClaim();
    replies = async () => {
      expect(await finishAttachmentUpload(await latest(approvalId), claimId, "succeeded", { fileId: "F_HOLDER", filename: "approved.pdf", bytes: 25 })).toBe(true);
      return { ok: true, has_more: false, messages: [] };
    };
    const run = await reconcile([approvalId]);
    expect(run.results[0]).toMatchObject({ outcome: "failed", applied: false });
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_HOLDER" });
    expect((await audits(approvalId, "approval.attachment_reconciled")).length).toBe(0);
  });
});

describe("concurrent reconcile runs", () => {
  test("two runs on the same uncertain claim → one transition, one audit", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    const approval = await latest(approvalId);
    const [a, b] = await Promise.all([
      runApprovalAttachmentReconcile([approval], { now: LATER() }),
      runApprovalAttachmentReconcile([approval], { now: LATER() }),
    ]);
    expect([a.results[0]?.applied, b.results[0]?.applied].filter(Boolean).length).toBe(1);
    expect(await record(approvalId)).toMatchObject({ state: "failed" });
    expect((await audits(approvalId, "approval.attachment_reconciled")).length).toBe(1);
  });

  test("two runs that cannot check → one notification", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    replies = () => ({ ok: false, error: "missing_scope" });
    const approval = await latest(approvalId);
    await Promise.all([
      runApprovalAttachmentReconcile([approval], { now: LATER() }),
      runApprovalAttachmentReconcile([approval], { now: LATER() }),
    ]);
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
  });

  test("a stale read (claim already re-taken by a re-run) is refused", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId } = await uncertainApproval();
    const stale = await latest(approvalId);
    await reconcile([approvalId]); // → failed
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true }); // new claim → succeeded
    const run = await runApprovalAttachmentReconcile([stale], { now: LATER() });
    expect(run.results.filter((r) => r.applied)).toEqual([]);
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_RC_UP" });
  });
});

describe("flag OFF (default) → nothing changes", () => {
  test("no Slack call, no record change, no audit, cron response unchanged", async () => {
    installSlack();
    await setToken(true);
    const { approvalId } = await uncertainApproval();
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    const before = await record(approvalId);
    const run = await reconcile([approvalId]);
    expect(run).toEqual({ enabled: false, results: [], notSentMarked: [] });
    expect(calls).toEqual([]);
    expect(await record(approvalId)).toEqual(before);
    expect((await audits(approvalId, "approval.attachment_reconciled")).length).toBe(0);
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(0);
    expect(((await runStuckWatchList(DEMO_ORG.id, { kind: "a1" })).items || []).some((i) => i.approvalId === approvalId)).toBe(false);

    process.env.CRON_SECRET = "cron-test-secret";
    const off = (await (await w2Cron(new Request("http://localhost/api/cron/stuck-watch-w2", { headers: { authorization: "Bearer cron-test-secret" } }))).json()) as Record<string, unknown>;
    expect("attachmentReconcile" in off).toBe(false);
    process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED = "true";
    const on = (await (await w2Cron(new Request("http://localhost/api/cron/stuck-watch-w2", { headers: { authorization: "Bearer cron-test-secret" } }))).json()) as Record<string, unknown>;
    expect(on.attachmentReconcile).toMatchObject({ enabled: true });
    delete process.env.CRON_SECRET;
  });
});
