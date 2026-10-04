/**
 * 2026-10-04 (木村, answers to #255's open decisions).
 *
 * 1. ratelimited stays OUT of the definite list: uncertain, re-checked by the next cron.
 * 2. Re-checks after the admin-agent notification back off (base·2^k: 10m → 20m → 40m …)
 *    and stop 24 h after the notification. The schedule (recheckAttempts / nextCheckAt /
 *    recheckStoppedAt) lives in metadata.attachmentUpload and is written by the existing
 *    reconcile RPC as a compare-and-set on the attempt count.
 * 4. While APPROVAL_ATTACHMENT_RECONCILE_ENABLED is ON the uncertain message says Staffpass
 *    settles it automatically; OFF → unchanged.
 * 5. A failure caused by a definite Slack error → pollHint reinvoke_with_approvalId +
 *    machine-readable reinvokeReason (one table in lib/slack/definite-errors.ts), same
 *    shape from GET /api/approvals/status and MCP staffpass_get_approval_status. No token.
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async () => Buffer.from("%PDF-1.4 approved content"),
}));
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-decisions";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { runApprovalAttachmentReconcile } = await import("@/lib/approvals/attachment-reconcile");
const { runStuckWatchList } = await import("@/lib/stuck-watch/admin-handlers");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
const { ADMIN_MCP_TOOL_NAMES } = await import("@/lib/mcp/admin-public");
const {
  SLACK_DEFINITE_PRE_SHARE_ERRORS, SLACK_DEFINITE_ERROR_FIXES, isDefinitePreShareSlackError,
  slackReinvokeReason, sanitizeSlackScopes,
} = await import("@/lib/slack/definite-errors");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;
type ApprovalRequest = import("@/lib/types").ApprovalRequest;
type ResolvedEmployeeCredential = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;

const FILE: FileAttachment = { fileRef: "https://example.com/approved.pdf?sig=SECRET_SIG_decisions", filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };
const THREAD = "1787911797.502889";
const ME = "U_BOT_DEC";
const MIN = 60_000;
const TOKEN = "xoxb-decisions-test";

type SlackAnswer = { status?: number; json?: Record<string, unknown>; throws?: boolean };
const OK_URL: SlackAnswer = { json: { ok: true, upload_url: "https://files.slack.com/upload/v1/DEC", file_id: "F_DEC_UP" } };
const OK_COMPLETE: SlackAnswer = { json: { ok: true, files: [{ id: "F_DEC_UP" }] } };
const originalFetch = globalThis.fetch;
let lookups = 0, getUrls = 0, completes = 0;
let getUrl: SlackAnswer = OK_URL;
let complete: SlackAnswer = OK_COMPLETE;
let replies: () => Record<string, unknown> = () => ({ ok: true, messages: [], has_more: false });
const answer = (a: SlackAnswer) => {
  if (a.throws) throw new DOMException("The operation timed out.", "TimeoutError");
  return a.json ? Response.json(a.json, { status: a.status ?? 200 }) : new Response("<html>bad gateway</html>", { status: a.status ?? 502 });
};
function installSlack() {
  lookups = 0; getUrls = 0; completes = 0; getUrl = OK_URL; complete = OK_COMPLETE;
  replies = () => ({ ok: true, messages: [], has_more: false });
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const method = url.match(/slack\.com\/api\/([A-Za-z.]+)/)?.[1] ?? "";
    if (method === "chat.postMessage") return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000099" });
    if (method === "files.getUploadURLExternal") { getUrls++; return answer(getUrl); }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (method === "files.completeUploadExternal") { completes++; return answer(complete); }
    if (method === "auth.test") { lookups++; return Response.json({ ok: true, user_id: ME, bot_id: "B_DEC" }); }
    if (method === "conversations.replies") return Response.json(replies());
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const setToken = (enabled: boolean) => upsertConversationAdapter({
  orgId: DEMO_ORG.id, surface: "slack", enabled, secrets: enabled ? { botToken: TOKEN } : {} });

beforeEach(() => { process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED = "true"; });
afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
  await setToken(false).catch(() => undefined);
});

const jid = () => `job_dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invokeComm = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
async function approved() {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: THREAD },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（decisions・ダミー）", threadId: THREAD },
    fileAttachment: FILE,
  };
  const q = await invokeComm(body);
  expect(q.httpStatus).toBe(402);
  const approvalId = String(q.body.approvalId);
  await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
  return { body, approvalId, statusToken: String(q.body.statusToken) };
}
const fileUpload = (r: { body: Record<string, unknown> }) =>
  ((r.body.result || {}) as { fileUpload?: Record<string, unknown> }).fileUpload;
const latest = async (id: string) => (await getApprovalById(id, DEMO_ORG.id))!;
const record = async (id: string) => (await latest(id)).metadata.attachmentUpload as Record<string, unknown> | undefined;
async function audits(approvalId: string, action: string) {
  return (await listAuditEvents(DEMO_ORG.id)).filter((e) => e.action === action
    && (e.metadata as Record<string, unknown>)?.approvalId === approvalId);
}
const reconcileAt = async (id: string, now: Date) => runApprovalAttachmentReconcile([await latest(id)] as ApprovalRequest[], { now });
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
async function poll(approvalId: string, statusToken: string) {
  const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
  const web = (await res.json()) as Record<string, unknown>;
  const mcp = (await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId, statusToken }, mcpCred()))
    .structuredContent as Record<string, unknown>;
  return { web, mcp };
}
function noSecrets(text: string) {
  expect(text).not.toContain("SECRET_SIG_decisions");
  expect(text).not.toContain("example.com");
  expect(text).not.toContain("xoxb-");
  expect(text).not.toContain("fileRefCiphertext");
}
/** Agent re-run whose completion step times out → uncertain claim (finishedAt ≈ real now). */
async function uncertainApproval() {
  const a = await approved();
  complete = { throws: true };
  await invokeComm({ ...a.body, approvalId: a.approvalId });
  complete = OK_COMPLETE;
  expect(await record(a.approvalId)).toMatchObject({ state: "uncertain" });
  return a;
}

// ---------------------------------------------------------------------------
describe("1. ratelimited is not a definite error (pinned)", () => {
  test("not in the list; completion ratelimited → uncertain; the next cron re-checks and settles it", async () => {
    expect(SLACK_DEFINITE_PRE_SHARE_ERRORS.has("ratelimited")).toBe(false);
    expect(isDefinitePreShareSlackError("ratelimited")).toBe(false);
    installSlack();
    await setToken(true);
    const { body, approvalId } = await approved();
    complete = { status: 429, json: { ok: false, error: "ratelimited" } };
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: false, status: "uncertain" });
    expect(await record(approvalId)).toMatchObject({ state: "uncertain" });
    complete = OK_COMPLETE;
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ status: "uncertain" }); // never auto re-sent
    expect(completes).toBe(1);
    replies = () => ({ ok: true, has_more: false, messages: [
      { type: "message", ts: `${Math.floor(Date.now() / 1000) + 30}.000100`, user: ME, files: [{ id: "F_RL_1", name: "approved.pdf", size: 25, user: ME }] },
    ] });
    const run = await reconcileAt(approvalId, new Date(Date.now() + 11 * MIN));
    expect(run.results[0]).toMatchObject({ outcome: "succeeded", applied: true });
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_RL_1" });
  });
});

// ---------------------------------------------------------------------------
describe("2. re-check backoff after the admin-agent notification", () => {
  /** Notify at T0 (cannot check: missing_scope on the history read). */
  async function notified() {
    installSlack();
    await setToken(true);
    const a = await uncertainApproval();
    replies = () => ({ ok: false, error: "missing_scope", needed: "channels:history" });
    const t0 = new Date(Date.now() + 11 * MIN);
    const run = await reconcileAt(a.approvalId, t0);
    expect(run.results[0]).toMatchObject({ outcome: "uncertain", notified: true, applied: true });
    lookups = 0;
    return { ...a, t0 };
  }
  const at = (t0: Date, minutes: number) => new Date(t0.getTime() + minutes * MIN);

  test("notify records attempts 0 + next check T0+10m", async () => {
    const { approvalId, t0 } = await notified();
    const r = await record(approvalId);
    expect(r).toMatchObject({ state: "uncertain", recheckAttempts: 0, nextCheckAt: at(t0, 10).toISOString() });
    expect(r?.recheckStoppedAt).toBeUndefined();
  });

  test("schedule: re-checks at T0+10, 30, 70, 150, 310, 630, 1270 min (interval doubles), then stops before 24h", async () => {
    const { approvalId, t0 } = await notified();
    const due = [10, 30, 70, 150, 310, 630, 1270];
    let prev = 0;
    for (const [i, m] of due.entries()) {
      // just before the due time → no Slack call, nothing written
      const early = await reconcileAt(approvalId, at(t0, m - 1));
      expect(early.results.filter((x) => x.approvalId === approvalId)).toEqual([]);
      expect(lookups).toBe(prev);
      // due → one check, attempt i+1 recorded with the next (doubled) time or stop
      const run = await reconcileAt(approvalId, at(t0, m));
      expect(run.results[0]).toMatchObject({ approvalId, outcome: "uncertain", applied: true, notified: false });
      expect(lookups).toBe(prev + 1);
      prev = lookups;
      const r = await record(approvalId);
      expect(r?.recheckAttempts).toBe(i + 1);
      if (i + 1 < due.length) {
        expect(r?.nextCheckAt).toBe(at(t0, due[i + 1]).toISOString());
        expect(due[i + 1] - m).toBe(10 * 2 ** (i + 1));
        expect(r?.recheckStoppedAt).toBeUndefined();
      } else {
        expect(r?.nextCheckAt).toBeUndefined();
        expect(String(r?.recheckStoppedAt || "")).not.toBe("");
      }
    }
    // stopped: no more checks, ever
    for (const m of [1271, 1439, 1441, 3000]) {
      expect((await reconcileAt(approvalId, at(t0, m))).results).toEqual([]);
    }
    expect(lookups).toBe(prev);
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
    expect((await audits(approvalId, "approval.attachment_reconciled")).length).toBe(1);
    expect(await record(approvalId)).toMatchObject({ state: "uncertain", recheckAttempts: 7 });
  });

  test("a re-check that finds the file settles it (succeeded, no second notification)", async () => {
    const { approvalId, t0 } = await notified();
    await reconcileAt(approvalId, at(t0, 10));
    replies = () => ({ ok: true, has_more: false, messages: [
      { type: "message", ts: `${Math.floor(Date.now() / 1000) + 30}.000100`, user: ME, files: [{ id: "F_BACK_1", name: "approved.pdf", size: 25, user: ME }] },
    ] });
    expect((await reconcileAt(approvalId, at(t0, 29))).results).toEqual([]);
    const run = await reconcileAt(approvalId, at(t0, 30));
    expect(run.results[0]).toMatchObject({ outcome: "succeeded", applied: true });
    expect(await record(approvalId)).toMatchObject({ state: "succeeded", fileId: "F_BACK_1" });
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
  });

  test("two runs on the same due re-check → one applied (compare-and-set on the attempt count)", async () => {
    const { approvalId, t0 } = await notified();
    const approval = await latest(approvalId);
    const [a, b] = await Promise.all([
      runApprovalAttachmentReconcile([approval], { now: at(t0, 10) }),
      runApprovalAttachmentReconcile([approval], { now: at(t0, 10) }),
    ]);
    expect([a.results[0]?.applied, b.results[0]?.applied].filter(Boolean).length).toBe(1);
    expect(await record(approvalId)).toMatchObject({ recheckAttempts: 1, nextCheckAt: at(t0, 30).toISOString() });
    // a stale read (attempt 0) is refused after the write
    const stale = await runApprovalAttachmentReconcile([approval], { now: at(t0, 40) });
    expect(stale.results.filter((r) => r.applied)).toEqual([]);
    expect((await record(approvalId))?.recheckAttempts).toBe(1);
  });

  test("a notified record without a schedule (written before this change) is due at adminNotifiedAt + 10m", async () => {
    const { approvalId, t0 } = await notified();
    const approval = await latest(approvalId);
    const upload = { ...(approval.metadata.attachmentUpload as Record<string, unknown>) };
    delete upload.recheckAttempts;
    delete upload.nextCheckAt;
    const legacy = { ...approval, metadata: { ...approval.metadata, attachmentUpload: upload } } as ApprovalRequest;
    expect((await runApprovalAttachmentReconcile([legacy], { now: at(t0, 9) })).results).toEqual([]);
    expect(lookups).toBe(0);
    await runApprovalAttachmentReconcile([legacy], { now: at(t0, 10) });
    expect(lookups).toBe(1);
  });

  test("stuck-watch A1 item shows the schedule; after the stop nextStepJa says stuckWatch.resolve", async () => {
    const { approvalId, t0 } = await notified();
    await reconcileAt(approvalId, at(t0, 10));
    const find = async () => ((await runStuckWatchList(DEMO_ORG.id, { kind: "a1" })).items || []).find((i) => i.id === `a1:${approvalId}`);
    const open = await find();
    expect(open?.metadata).toMatchObject({ recheckAttempts: 1, nextCheckAt: at(t0, 30).toISOString(), recheckStopped: false });
    for (const m of [30, 70, 150, 310, 630, 1270]) await reconcileAt(approvalId, at(t0, m));
    const stopped = await find();
    expect(stopped?.metadata).toMatchObject({ recheckAttempts: 7, nextCheckAt: null, recheckStopped: true });
    expect(String(stopped?.nextStepJa)).toContain("24時間");
    expect(String(stopped?.nextStepJa)).toContain("stuckWatch.resolve");
    noSecrets(JSON.stringify(stopped));
  });
});

// ---------------------------------------------------------------------------
describe("4. uncertain wording", () => {
  const ON = "添付ファイルの送信結果を確認できませんでした（Slack 側で共有された可能性があります）。二重送信を防ぐため自動では再送しません。Staffpass が自動で確認し、送信済みか未送信かを確定します。";
  const OFF = "添付ファイルの送信結果を確認できませんでした（Slack 側で共有された可能性があります）。二重送信を防ぐため自動では再送しません。チャンネルを確認し、必要なら管理者が対応してください。";
  for (const [flag, text] of [["ON", ON], ["OFF", OFF]] as const) {
    test(`flag ${flag}: the timed-out upload and the next re-run both say it`, async () => {
      if (flag === "OFF") delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
      installSlack();
      await setToken(true);
      const { body, approvalId } = await approved();
      complete = { throws: true };
      expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ status: "uncertain", messageJa: text });
      complete = OK_COMPLETE;
      expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ status: "uncertain", messageJa: text });
    });
  }
});

// ---------------------------------------------------------------------------
describe("5. reinvokeReason: one mapping table", () => {
  const EXPECTED: Record<string, [string, string]> = {
    channel_not_found: ["slack_channel", "setup.slackStatus"],
    not_in_channel: ["slack_channel_membership", "setup.slackStatus"],
    is_archived: ["slack_channel_archived", "setup.slackStatus"],
    invalid_auth: ["slack_bot_token", "setup.slackAdapter.setBotToken"],
    not_authed: ["slack_bot_token", "setup.slackAdapter.setBotToken"],
    account_inactive: ["slack_bot_token", "setup.slackAdapter.setBotToken"],
    token_revoked: ["slack_bot_token", "setup.slackAdapter.setBotToken"],
    token_expired: ["slack_bot_token", "setup.slackAdapter.setBotToken"],
    not_allowed_token_type: ["slack_token_type", "setup.slackAdapter.setBotToken"], // flag ON: setup.slackStatus (third round c)
    missing_scope: ["slack_scope", "setup.slackStatus"],
    no_permission: ["slack_permission", "setup.slackStatus"],
  };

  test("every definite error has exactly one entry; the list is derived from the table", () => {
    expect(Object.keys(SLACK_DEFINITE_ERROR_FIXES).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect([...SLACK_DEFINITE_PRE_SHARE_ERRORS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [code, [kind, nextTool]] of Object.entries(EXPECTED)) {
      expect(SLACK_DEFINITE_ERROR_FIXES[code as keyof typeof SLACK_DEFINITE_ERROR_FIXES]).toEqual({ kind, nextTool });
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(nextTool)).toBe(true);
      // 木村 #255 second round: credential errors carry the failing token type (bot here)
      const credential = nextTool === "setup.slackAdapter.setBotToken";
      const tokenTyped = credential || code === "missing_scope";
      expect(slackReinvokeReason(code, undefined, "bot")).toEqual({
        code, fix: { kind, ...(tokenTyped ? { tokenType: "bot" } : {}) },
        nextTool: code === "not_allowed_token_type" ? "setup.slackStatus" : nextTool, // 木村 third round c
        nextToolEndpoint: "/api/mcp/admin", retryAfterFix: true,
      });
    }
  });

  test("missing_scope carries Slack's `needed` (sanitized); other codes never do", () => {
    expect(slackReinvokeReason("missing_scope", ["files:write"])?.fix).toEqual({ kind: "slack_scope", needed: ["files:write"], tokenType: "unknown" });
    expect(slackReinvokeReason("not_in_channel", ["files:write"])?.fix).toEqual({ kind: "slack_channel_membership" });
    expect(sanitizeSlackScopes("files:write,chat:write.public")).toEqual(["files:write", "chat:write.public"]);
    expect(sanitizeSlackScopes("files:write, files:write ,xoxb-123-456-abc,Bearer x,<script>,")).toEqual(["files:write"]);
    expect(sanitizeSlackScopes(["files:read", 3, "xoxp-1-2"])).toEqual(["files:read"]);
    expect(sanitizeSlackScopes("a".repeat(200))).toBeUndefined();
    expect(sanitizeSlackScopes(undefined)).toBeUndefined();
    expect(sanitizeSlackScopes(Array.from({ length: 30 }, (_, i) => `scope${i}:read`))?.length).toBe(10);
  });

  test("not definite → null", () => {
    for (const e of ["ratelimited", "internal_error", "", undefined, null, "MISSING_SCOPE"]) {
      expect(slackReinvokeReason(e as string | undefined)).toBeNull();
    }
  });
});

describe("5. definite failure → reinvoke_with_approvalId + reinvokeReason (status API = MCP)", () => {
  test("getUploadURLExternal missing_scope (needed files:write) → failed record, hint + reason; after the fix the re-run uploads once", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    getUrl = { json: { ok: false, error: "missing_scope", needed: "files:write", provided: "chat:write,xoxb-leak-1" } };
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: false, status: "failed" });
    expect(await record(approvalId)).toMatchObject({
      state: "failed", code: "get_upload_url_failed", slackError: "missing_scope", slackNeeded: ["files:write"] });
    const p = await poll(approvalId, statusToken);
    const reason = { code: "missing_scope", fix: { kind: "slack_scope", needed: ["files:write"], tokenType: "bot" }, // third round: + tokenType
      nextTool: "setup.slackStatus", nextToolEndpoint: "/api/mcp/admin", retryAfterFix: true };
    expect(p.web.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.mcp.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.web.reinvokeReason).toEqual(reason);
    expect(p.mcp.reinvokeReason).toEqual(reason);
    noSecrets(JSON.stringify(p));

    getUrl = OK_URL;
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true, fileId: "F_DEC_UP" });
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: true, fileId: "F_DEC_UP" });
    expect([getUrls, completes]).toEqual([2, 1]);
    const after = await poll(approvalId, statusToken);
    expect(after.web.pollHint).toBe("fulfilled");
    expect(after.mcp.pollHint).toBe("fulfilled");
    expect("reinvokeReason" in after.web).toBe(false);
    expect("reinvokeReason" in after.mcp).toBe(false);
  });

  test("completion not_in_channel → slack_channel_membership / setup.slackStatus (same shape both)", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    complete = { json: { ok: false, error: "not_in_channel" } };
    await invokeComm({ ...body, approvalId });
    expect(await record(approvalId)).toMatchObject({ state: "failed", code: "complete_upload_failed", slackError: "not_in_channel" });
    expect((await record(approvalId))?.slackNeeded).toBeUndefined();
    const p = await poll(approvalId, statusToken);
    expect(p.web.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.web.reinvokeReason).toEqual({ code: "not_in_channel", fix: { kind: "slack_channel_membership" },
      nextTool: "setup.slackStatus", nextToolEndpoint: "/api/mcp/admin", retryAfterFix: true });
    expect(p.mcp.reinvokeReason).toEqual(p.web.reinvokeReason);
  });

  test("completion token_revoked → slack_bot_token / setup.slackAdapter.setBotToken", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await invokeComm({ ...body, approvalId });
    const p = await poll(approvalId, statusToken);
    expect(p.mcp.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.mcp.reinvokeReason).toMatchObject({ code: "token_revoked", fix: { kind: "slack_bot_token" }, nextTool: "setup.slackAdapter.setBotToken" });
    expect(p.web.reinvokeReason).toEqual(p.mcp.reinvokeReason);
    noSecrets(JSON.stringify(p));
  });

  test("a failure that is not a definite Slack error → no reinvokeReason, pollHint unchanged (fulfilled)", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    getUrl = { status: 429, json: { ok: false, error: "ratelimited" } };
    expect(fileUpload(await invokeComm({ ...body, approvalId }))).toMatchObject({ ok: false, status: "failed" });
    expect((await record(approvalId))?.slackError).toBeUndefined();
    const p = await poll(approvalId, statusToken);
    expect(p.web.pollHint).toBe("fulfilled");
    expect(p.mcp.pollHint).toBe("fulfilled");
    expect("reinvokeReason" in p.web).toBe(false);
    expect("reinvokeReason" in p.mcp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("migration 20261004400000 (static, decisions 2 + 5)", () => {
  test("re-check compare-and-set bounded by 24h; finish keeps slackError / slackNeeded (sanitized)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/20261004400000_approval_attachment_reconcile.sql", import.meta.url), "utf8");
    expect(sql).toContain("'recheckAttempts'");
    expect(sql).toContain("'nextCheckAt'");
    expect(sql).toContain("'recheckStoppedAt'");
    expect(sql).toContain("interval '24 hours'");
    expect(sql).toMatch(/is distinct from n then return false/);
    expect(sql).toContain("create or replace function public.finish_approval_attachment_upload(p_id uuid, p_org uuid, p_claim uuid, p_state text, p_result jsonb)");
    expect(sql).toContain("'slackError'");
    expect(sql).toContain("'slackNeeded'");
    expect(sql).toContain("revoke all on function public.finish_approval_attachment_upload(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;");
    expect(sql).toContain("grant execute on function public.finish_approval_attachment_upload(uuid,uuid,uuid,text,jsonb) to service_role;");
    // + claim_approval_attachment_upload_capped / stop_approval_attachment_recheck (木村 #255 second round)
    // + record_org_settings_change (木村 #255 third round h: service_role-only reset signal table)
    expect(sql.match(/security invoker set search_path = pg_catalog, public/g)?.length).toBe(6);
    expect(sql.match(/for update;/g)?.length).toBe(5);
    expect(sql).not.toMatch(/security definer|create policy/i);
    expect(sql.match(/create table/gi)?.length).toBe(1);
  });
});
