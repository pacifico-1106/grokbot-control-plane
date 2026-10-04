/**
 * 2026-10-04 (木村, second round on #255). APPROVAL_ATTACHMENT_RECONCILE_ENABLED ON
 * unless a test says OFF (OFF = da97a12 behavior, unchanged).
 *
 * 1. Auth errors are guided by the token that actually failed: the upload
 *    adapter knows it (resolveConversationToken → effectivePostingAs) and the
 *    failed record keeps slackTokenType = "user" | "bot".
 *      user → setup.slackAuthorizeLink.issue (employee re-authorizes)
 *      bot  → setup.slackAdapter.setBotToken
 *      not recorded (record written before this change) → setup.slackStatus (diagnose first)
 * 2. Re-checks stop when the approval is no longer "approved" (rejected / expired /
 *    revision_requested / pending) or the A1 stuck-watch item is resolved.
 * 3. The approved re-run response carries reinvokeReason, built by the same
 *    function the status poll / MCP use.
 * 4. The same definite Slack error 3× in a row for one approval → later re-runs do
 *    not call Slack and return the same reinvokeReason, until a setup-type tool
 *    succeeds in the org after the last failure.
 * Demo mode, dummy values, Slack + file download mocked, no network.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/security/public-file-download", () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  downloadPublicFile: async () => Buffer.from("%PDF-1.4 approved content"),
}));
process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-cap-k2";

const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const { runGatewayInvoke } = await import("@/lib/gateway/invoke");
const { getApprovalById, listAuditEvents, resolveApproval } = await import("@/lib/data");
const { updateApprovalMetadata } = await import("@/lib/data/approvals");
const { upsertConversationAdapter } = await import("@/lib/data/conversation-adapters");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { readAttachmentUpload } = await import("@/lib/approvals/attachment-upload-claim");
const { runApprovalAttachmentReconcile } = await import("@/lib/approvals/attachment-reconcile");
const { runStuckWatchList, runStuckWatchResolve } = await import("@/lib/stuck-watch/admin-handlers");
const { GET: statusGET } = await import("@/app/api/approvals/status/route");
const { callStaffpassMcpTool } = await import("@/lib/mcp/tools");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { ADMIN_MCP_TOOL_NAMES } = await import("@/lib/mcp/admin-public");
const { slackReinvokeReason, SLACK_DEFINITE_ERROR_FIXES } = await import("@/lib/slack/definite-errors");
const { reinvokeReasonForFileUpload } = await import("@/lib/approvals/poll-hint");
const {
  ATTACHMENT_RETRY_CAP, SETUP_TOOL_SUCCEEDED_AUDIT, SETTINGS_RESET_SIGNALS, DASHBOARD_SLACK_ADAPTER_SAVE,
  countsAsSettingsChange, recordSetupToolSucceeded, settingsChangedSince,
} = await import("@/lib/approvals/attachment-retry-cap");
const { READ_ONLY_ADMIN_TOOLS } = await import("@/lib/billing/plan-scopes");
const { appendAuditEvent } = await import("@/lib/data/audit");
const { PUT: adapterPUT } = await import("@/app/api/settings/conversation-adapters/route");
type GatewayInvokeRequest = import("@/lib/types").GatewayInvokeRequest;
type FileAttachment = NonNullable<GatewayInvokeRequest["fileAttachment"]>;
type ApprovalRequest = import("@/lib/types").ApprovalRequest;
type ResolvedEmployeeCredential = import("@/lib/auth/employee-credential").ResolvedEmployeeCredential;
type ResolvedAdminCredential = import("@/lib/auth/admin-credential").ResolvedAdminCredential;

const FILE: FileAttachment = { fileRef: "https://example.com/approved.pdf?sig=SECRET_SIG_capk2", filename: "approved.pdf", mimeType: "application/pdf", bytes: 25 };
const THREAD = "1787911797.502889";
const ME = "U_BOT_CAP";
const MIN = 60_000;
const TOKEN = "xoxb-capk2-test";
const USER_TOKEN = "xoxp-capk2-user-SECRET";
const ENDPOINT = "/api/mcp/admin";

type SlackAnswer = { status?: number; json?: Record<string, unknown>; throws?: boolean };
const OK_URL: SlackAnswer = { json: { ok: true, upload_url: "https://files.slack.com/upload/v1/CAP", file_id: "F_CAP_UP" } };
const OK_COMPLETE: SlackAnswer = { json: { ok: true, files: [{ id: "F_CAP_UP" }] } };
const originalFetch = globalThis.fetch;
let lookups = 0, getUrls = 0, completes = 0;
let uploadAuth: string[] = [];
let getUrl: SlackAnswer = OK_URL;
let complete: SlackAnswer = OK_COMPLETE;
let replies: () => Record<string, unknown> = () => ({ ok: true, messages: [], has_more: false });
const answer = (a: SlackAnswer) => {
  if (a.throws) throw new DOMException("The operation timed out.", "TimeoutError");
  return a.json ? Response.json(a.json, { status: a.status ?? 200 }) : new Response("<html>bad gateway</html>", { status: a.status ?? 502 });
};
function installSlack() {
  lookups = 0; getUrls = 0; completes = 0; uploadAuth = []; getUrl = OK_URL; complete = OK_COMPLETE;
  replies = () => ({ ok: true, messages: [], has_more: false });
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = url.match(/slack\.com\/api\/([A-Za-z.]+)/)?.[1] ?? "";
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    if (method === "chat.postMessage") return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000099" });
    if (method === "files.getUploadURLExternal") { getUrls++; uploadAuth.push(auth); return answer(getUrl); }
    if (url.includes("files.slack.com/upload")) return new Response(null, { status: 200 });
    if (method === "files.completeUploadExternal") { completes++; return answer(complete); }
    if (method === "auth.test") { lookups++; return Response.json({ ok: true, user_id: ME, bot_id: "B_CAP", team_id: "T_CAP" }); }
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

const jid = () => `job_capk2_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const invokeComm = (body: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
async function approved() {
  const body: GatewayInvokeRequest = {
    tool: "comm.reply", purpose: "comm.internal", jobId: jid(),
    conversation: { surface: "slack", orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: THREAD },
    informationClass: "confidential",
    args: { slackChannelId: "C_INTERNAL", text: "承認された本文（cap・ダミー）", threadId: THREAD },
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
const streak = async (id: string) => (await latest(id)).metadata.attachmentUploadStreak as Record<string, unknown> | undefined;
async function audits(approvalId: string, action: string) {
  return (await listAuditEvents(DEMO_ORG.id, 100_000)).filter((e) => e.action === action
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
function adminCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_capk2", status: "linked" });
  return {
    orgId: DEMO_ORG.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id,
    generation: agent.credentialGeneration, via: "bearer", agent,
  };
}
async function poll(approvalId: string, statusToken: string) {
  const res = await statusGET(new Request(`http://localhost/api/approvals/status?id=${approvalId}&token=${statusToken}`));
  const web = (await res.json()) as Record<string, unknown>;
  const mcp = (await callStaffpassMcpTool("staffpass_get_approval_status", { approvalId, statusToken }, mcpCred()))
    .structuredContent as Record<string, unknown>;
  return { web, mcp };
}
function noSecrets(text: string) {
  expect(text).not.toContain("SECRET_SIG_capk2");
  expect(text).not.toContain("example.com");
  expect(text).not.toContain("xoxb-");
  expect(text).not.toContain("xoxp-");
  expect(text).not.toContain("fileRefCiphertext");
}
const reason = (code: string, fix: Record<string, unknown>, nextTool: string) =>
  ({ code, fix, nextTool, nextToolEndpoint: ENDPOINT, retryAfterFix: true });

/** emp_comm posts as the employee (user token) for the duration of run(). */
async function asUserToken<T>(run: () => Promise<T>): Promise<T> {
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
  if (!emp) throw new Error("missing emp_comm");
  const prevAccounts = emp.allowedAccounts;
  const prevPosting = emp.postingAs;
  emp.allowedAccounts = [...(emp.allowedAccounts ?? []), { service: "slack", accountId: "U_CAPK2_EMP" }];
  emp.postingAs = "user";
  await bindEmployeeSlackIdentity({
    employeeId: emp.id, orgId: DEMO_ORG.id, slackUserId: "U_CAPK2_EMP", slackTeamId: "T_CAP",
    displayName: "社員（cap）", userToken: USER_TOKEN,
  });
  try { return await run(); } finally {
    emp.allowedAccounts = prevAccounts;
    emp.postingAs = prevPosting;
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id }).catch(() => undefined);
  }
}

const CREDENTIAL = ["invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type"] as const;
const NON_CREDENTIAL = ["channel_not_found", "not_in_channel", "is_archived", "missing_scope", "no_permission"] as const;
/** credential errors fixed by replacing the token (not_allowed_token_type is diagnosed first: third round c). */
const TOKEN_CREDENTIAL = CREDENTIAL.filter((c) => c !== "not_allowed_token_type");

// ---------------------------------------------------------------------------
describe("1. auth-error guidance by the failing token's type", () => {
  test("user → setup.slackAuthorizeLink.issue (link flag ON); bot → setup.slackAdapter.setBotToken; unknown → setup.slackStatus", () => {
    process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
    try {
      for (const code of TOKEN_CREDENTIAL) {
        const bot = SLACK_DEFINITE_ERROR_FIXES[code];
        expect(slackReinvokeReason(code, undefined, "user")).toEqual(reason(code, { kind: "slack_user_token", tokenType: "user" },
          "setup.slackAuthorizeLink.issue"));
        expect(slackReinvokeReason(code, undefined, "bot")).toEqual(reason(code, { kind: bot.kind, tokenType: "bot" }, "setup.slackAdapter.setBotToken"));
        expect(slackReinvokeReason(code)).toEqual(reason(code, { kind: "slack_token", tokenType: "unknown" }, "setup.slackStatus"));
      }
    } finally {
      delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
    }
    for (const tool of ["setup.slackAuthorizeLink.issue", "setup.slackAdapter.setBotToken", "setup.slackStatus"]) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(tool)).toBe(true);
    }
  });

  test("destination / permission errors do not depend on the token type (missing_scope with a user token: see section 5)", () => {
    for (const code of NON_CREDENTIAL) {
      const { kind, nextTool } = SLACK_DEFINITE_ERROR_FIXES[code];
      for (const t of (code === "missing_scope" ? ["bot", undefined] : ["user", "bot", undefined]) as Array<"user" | "bot" | undefined>) {
        const r = slackReinvokeReason(code, code === "missing_scope" ? ["files:write"] : undefined, t);
        expect(r).toEqual(reason(code, {
          kind, ...(code === "missing_scope" ? { needed: ["files:write"], tokenType: t ?? "unknown" } : {}),
        }, nextTool));
      }
    }
  });

  test("flag OFF: unchanged (every credential error → setBotToken, no tokenType field)", () => {
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    for (const code of CREDENTIAL) {
      const { kind } = SLACK_DEFINITE_ERROR_FIXES[code];
      for (const t of ["user", "bot", undefined] as const) {
        expect(slackReinvokeReason(code, undefined, t)).toEqual(reason(code, { kind }, "setup.slackAdapter.setBotToken"));
      }
    }
  });

  test("slackTokenType is kept only next to a definite error and only as user | bot", () => {
    const read = (u: Record<string, unknown>) => readAttachmentUpload({ attachmentUpload: { state: "failed", ...u } });
    expect(read({ slackError: "invalid_auth", slackTokenType: "user" })?.slackTokenType).toBe("user");
    expect(read({ slackError: "invalid_auth", slackTokenType: "bot" })?.slackTokenType).toBe("bot");
    expect(read({ slackError: "invalid_auth", slackTokenType: "xoxb-leak" })?.slackTokenType).toBeUndefined();
    expect(read({ slackError: "ratelimited", slackTokenType: "user" })?.slackTokenType).toBeUndefined();
    expect(read({ slackTokenType: "bot" })?.slackTokenType).toBeUndefined();
  });

  test("user token (postingAs user, linked identity): completion token_revoked → slackTokenType user → setup.slackAuthorizeLink.issue (poll = MCP = re-run)", async () => {
    installSlack();
    await setToken(true);
    process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
    await asUserToken(async () => {
      const { body, approvalId, statusToken } = await approved();
      complete = { json: { ok: false, error: "token_revoked" } };
      const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
      expect(uploadAuth).toEqual([`Bearer ${USER_TOKEN}`]);
      expect(await record(approvalId)).toMatchObject({ state: "failed", slackError: "token_revoked", slackTokenType: "user" });
      const expected = reason("token_revoked", { kind: "slack_user_token", tokenType: "user" }, "setup.slackAuthorizeLink.issue");
      const p = await poll(approvalId, statusToken);
      expect(p.web.pollHint).toBe("reinvoke_with_approvalId");
      expect(p.web.reinvokeReason).toEqual(expected);
      expect(p.mcp.reinvokeReason).toEqual(expected);
      expect(rerun).toMatchObject({ ok: false, status: "failed" });
      expect(rerun?.reinvokeReason).toEqual(expected);
      noSecrets(JSON.stringify({ p, rerun }));
    }).finally(() => { delete process.env.SLACK_AUTHORIZE_LINK_ENABLED; });
  });

  test("bot token: getUploadURLExternal invalid_auth → slackTokenType bot → setup.slackAdapter.setBotToken", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    getUrl = { json: { ok: false, error: "invalid_auth" } };
    const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
    expect(uploadAuth).toEqual([`Bearer ${TOKEN}`]);
    expect(await record(approvalId)).toMatchObject({ state: "failed", slackError: "invalid_auth", slackTokenType: "bot" });
    const expected = reason("invalid_auth", { kind: "slack_bot_token", tokenType: "bot" }, "setup.slackAdapter.setBotToken");
    const p = await poll(approvalId, statusToken);
    expect(p.web.reinvokeReason).toEqual(expected);
    expect(p.mcp.reinvokeReason).toEqual(expected);
    expect(rerun?.reinvokeReason).toEqual(expected);
  });

  test("a failed record written before this change (no slackTokenType) → safe fallback setup.slackStatus", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    complete = { json: { ok: false, error: "token_expired" } };
    await invokeComm({ ...body, approvalId });
    const a = await latest(approvalId);
    const legacy = { ...(a.metadata.attachmentUpload as Record<string, unknown>) };
    delete legacy.slackTokenType;
    await updateApprovalMetadata(a, { attachmentUpload: legacy });
    const p = await poll(approvalId, statusToken);
    expect(p.web.reinvokeReason).toEqual(reason("token_expired", { kind: "slack_token", tokenType: "unknown" }, "setup.slackStatus"));
    expect(p.mcp.reinvokeReason).toEqual(p.web.reinvokeReason);
  });
});

// ---------------------------------------------------------------------------
describe("2. re-checks stop when the approval is closed or the A1 item is resolved", () => {
  async function notified() {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { throws: true };
    await invokeComm({ ...a.body, approvalId: a.approvalId });
    complete = OK_COMPLETE;
    expect(await record(a.approvalId)).toMatchObject({ state: "uncertain" });
    replies = () => ({ ok: false, error: "missing_scope", needed: "channels:history" });
    const t0 = new Date(Date.now() + 11 * MIN);
    const run = await reconcileAt(a.approvalId, t0);
    expect(run.results[0]).toMatchObject({ outcome: "uncertain", notified: true, applied: true });
    lookups = 0;
    return { ...a, t0 };
  }
  const at = (t0: Date, minutes: number) => new Date(t0.getTime() + minutes * MIN);

  for (const status of ["rejected", "expired", "revision_requested", "pending"] as const) {
    test(`approval ${status}: a due re-check makes no Slack call and writes nothing`, async () => {
      const { approvalId, t0 } = await notified();
      const before = JSON.stringify(await record(approvalId));
      const closed = { ...(await latest(approvalId)), status } as ApprovalRequest;
      for (const m of [10, 30, 70]) {
        expect((await runApprovalAttachmentReconcile([closed], { now: at(t0, m) })).results).toEqual([]);
      }
      expect(lookups).toBe(0);
      expect(JSON.stringify(await record(approvalId))).toBe(before);
    });
  }

  test("a closed approval's stale (not yet notified) claim is not checked either", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { throws: true };
    await invokeComm({ ...a.body, approvalId: a.approvalId });
    const closed = { ...(await latest(a.approvalId)), status: "expired" } as ApprovalRequest;
    lookups = 0;
    expect((await runApprovalAttachmentReconcile([closed], { now: new Date(Date.now() + 11 * MIN) })).results).toEqual([]);
    expect(lookups).toBe(0);
    expect(await audits(a.approvalId, "stuck_watch.attachment_uncertain_notify")).toEqual([]);
  });

  test("stuckWatch.resolve on the A1 item stops the schedule (recheckStopReason stuck_watch_resolved); no more Slack checks", async () => {
    const { approvalId, t0 } = await notified();
    await reconcileAt(approvalId, at(t0, 10));
    expect(lookups).toBe(1);
    const stale = await latest(approvalId); // read before the resolve
    const res = await runStuckWatchResolve(DEMO_ORG.id, { itemId: `a1:${approvalId}`, note: "対応済み" }, "admin_capk2");
    expect(res.ok).toBe(true);
    const r = await record(approvalId);
    expect(r).toMatchObject({ state: "uncertain", recheckAttempts: 1, recheckStopReason: "stuck_watch_resolved" });
    expect(String(r?.recheckStoppedAt || "")).not.toBe("");
    expect(r?.nextCheckAt).toBeUndefined();
    for (const m of [30, 70, 150, 1270]) expect((await reconcileAt(approvalId, at(t0, m))).results).toEqual([]);
    expect(lookups).toBe(1);
    // a reconcile that read the record before the resolve cannot write a schedule after it
    const late = await runApprovalAttachmentReconcile([stale], { now: at(t0, 30) });
    expect(late.results.filter((x) => x.applied)).toEqual([]);
    expect(await record(approvalId)).toMatchObject({ recheckAttempts: 1, recheckStopReason: "stuck_watch_resolved" });
    expect((await record(approvalId))?.nextCheckAt).toBeUndefined();
    const item = ((await runStuckWatchList(DEMO_ORG.id, { kind: "a1", includeResolved: true })).items || [])
      .find((i) => i.id === `a1:${approvalId}`);
    expect(item?.metadata).toMatchObject({ recheckStopped: true, nextCheckAt: null, recheckStopReason: "stuck_watch_resolved" });
    expect((await audits(approvalId, "stuck_watch.attachment_uncertain_notify")).length).toBe(1);
  });

  test("flag OFF: stuckWatch.resolve still resolves and leaves the record untouched", async () => {
    const { approvalId, t0 } = await notified();
    await reconcileAt(approvalId, at(t0, 10));
    const before = JSON.stringify(await record(approvalId));
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    expect((await runStuckWatchResolve(DEMO_ORG.id, { itemId: `a1:${approvalId}` }, "admin_capk2")).ok).toBe(true);
    expect(JSON.stringify(await record(approvalId))).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("3. the re-run response carries the same reinvokeReason (one builder)", () => {
  test("missing_scope: re-run fileUpload.reinvokeReason = poll = MCP = reinvokeReasonForFileUpload(record view)", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    getUrl = { json: { ok: false, error: "missing_scope", needed: "files:write", provided: "chat:write,xoxb-leak-1" } };
    const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
    // third round: missing_scope carries the failing token type (bot here)
    const expected = reason("missing_scope", { kind: "slack_scope", needed: ["files:write"], tokenType: "bot" }, "setup.slackStatus");
    expect(rerun?.reinvokeReason).toEqual(expected);
    const p = await poll(approvalId, statusToken);
    expect(p.web.reinvokeReason).toEqual(expected);
    expect(p.mcp.reinvokeReason).toEqual(expected);
    const view = (p.web.fulfillment as { fileUpload?: unknown } | undefined)?.fileUpload
      ?? ((p.web.result as { fileUpload?: unknown } | undefined)?.fileUpload);
    expect(reinvokeReasonForFileUpload(view)).toEqual(expected);
    noSecrets(JSON.stringify({ rerun, p }));
  });

  test("not_in_channel: same reason in the re-run and the poll", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId, statusToken } = await approved();
    complete = { json: { ok: false, error: "not_in_channel" } };
    const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
    const p = await poll(approvalId, statusToken);
    expect(rerun?.reinvokeReason).toEqual(reason("not_in_channel", { kind: "slack_channel_membership" }, "setup.slackStatus"));
    expect(rerun?.reinvokeReason).toEqual(p.web.reinvokeReason);
  });

  test("a failure that is not a definite Slack error → no reinvokeReason in the re-run", async () => {
    installSlack();
    await setToken(true);
    const { body, approvalId } = await approved();
    getUrl = { status: 429, json: { ok: false, error: "ratelimited" } };
    const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
    expect(rerun).toMatchObject({ ok: false, status: "failed" });
    expect(rerun && "reinvokeReason" in rerun).toBe(false);
  });

  test("flag OFF: the re-run response is unchanged (no reinvokeReason field)", async () => {
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    installSlack();
    await setToken(true);
    const { body, approvalId } = await approved();
    complete = { json: { ok: false, error: "not_in_channel" } };
    const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
    expect(rerun).toMatchObject({ ok: false, status: "failed" });
    expect(rerun && "reinvokeReason" in rerun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("4. retry cap: the same definite error 3× in a row", () => {
  const BOT_REVOKED = reason("token_revoked", { kind: "slack_bot_token", tokenType: "bot" }, "setup.slackAdapter.setBotToken");
  async function failTimes(n: number, a: { body: GatewayInvokeRequest; approvalId: string }) {
    const out: Array<Record<string, unknown> | undefined> = [];
    for (let i = 0; i < n; i++) out.push(fileUpload(await invokeComm({ ...a.body, approvalId: a.approvalId })));
    return out;
  }

  test("cap is 3; reset trigger is generic (settings-changing setup tool succeeded; the link issue counts only on completion)", () => {
    expect(ATTACHMENT_RETRY_CAP).toBe(3);
    expect(SETUP_TOOL_SUCCEEDED_AUDIT).toBe("setup.tool_succeeded");
    expect(countsAsSettingsChange("setup.slackAdapter.setBotToken", "admin_fulfillment")).toBe(true);
    expect(countsAsSettingsChange("setup.slackApprover.set", "admin_fulfillment")).toBe(true);
    expect(countsAsSettingsChange("setup.lineApproval.upsert", "admin_fulfillment")).toBe(false); // fourth round 3: Slack-related only
    expect(countsAsSettingsChange("setup.slackStatus", "admin_fulfillment")).toBe(false); // read-only (third round e)
    expect(countsAsSettingsChange("employees.postingIdentity.set", "admin_fulfillment")).toBe(true);
    expect(countsAsSettingsChange("setup.slackAuthorizeLink.issue", "admin_fulfillment")).toBe(false);
    expect(countsAsSettingsChange("setup.slackAuthorizeLink.issue", "authorize_link_completed")).toBe(true);
    expect(countsAsSettingsChange("policy.patch", "admin_fulfillment")).toBe(false);
    expect(countsAsSettingsChange("comm.reply", "admin_fulfillment")).toBe(false);
  });

  test("3 failures call Slack; the 4th and 5th re-run do not, and return the same reinvokeReason (+ poll unchanged)", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    const first3 = await failTimes(3, a);
    expect([getUrls, completes]).toEqual([3, 3]);
    for (const r of first3) expect(r?.reinvokeReason).toEqual(BOT_REVOKED);
    expect(await streak(a.approvalId)).toMatchObject({ code: "token_revoked", count: 3 });
    complete = OK_COMPLETE; // even if Slack would now accept it: nothing is sent until settings change
    const capped = await failTimes(2, a);
    expect([getUrls, completes]).toEqual([3, 3]);
    for (const r of capped) {
      expect(r).toMatchObject({ ok: false, status: "failed", code: "approval_attachment_retry_capped", reason: "token_revoked" });
      expect(r?.reinvokeReason).toEqual(BOT_REVOKED);
      expect(r?.retryCap).toEqual({ consecutive: 3, limit: 3 });
      expect(String(r?.messageJa)).toContain("3回");
      expect(String(r?.messageJa)).not.toContain("Grok");
    }
    expect(await record(a.approvalId)).toMatchObject({ state: "failed", slackError: "token_revoked" });
    const p = await poll(a.approvalId, a.statusToken);
    expect(p.web.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.web.reinvokeReason).toEqual(BOT_REVOKED);
    expect(p.mcp.reinvokeReason).toEqual(BOT_REVOKED);
    const capAudits = await audits(a.approvalId, "approval.attachment_upload_capped");
    expect(capAudits.length).toBe(2);
    expect(capAudits[0].metadata).toMatchObject({ code: "token_revoked", consecutive: 3, limit: 3, filename: "approved.pdf" });
    noSecrets(JSON.stringify({ capped, p, capAudits }));
  });

  test("a different definite error starts a new streak (per approval + error code)", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(2, a);
    complete = { json: { ok: false, error: "not_in_channel" } };
    await failTimes(1, a);
    expect(await streak(a.approvalId)).toMatchObject({ code: "not_in_channel", count: 1 });
    await failTimes(2, a);
    expect(completes).toBe(5);
    expect(await streak(a.approvalId)).toMatchObject({ code: "not_in_channel", count: 3 });
    const capped = (await failTimes(1, a))[0];
    expect(completes).toBe(5);
    expect(capped).toMatchObject({ code: "approval_attachment_retry_capped", reason: "not_in_channel" });
    expect(capped?.reinvokeReason).toEqual(reason("not_in_channel", { kind: "slack_channel_membership" }, "setup.slackStatus"));
  });

  test("a non-definite failure in between breaks the streak", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(2, a);
    getUrl = { status: 429, json: { ok: false, error: "ratelimited" } };
    await failTimes(1, a);
    expect(await streak(a.approvalId)).toBeUndefined();
    getUrl = OK_URL;
    await failTimes(2, a);
    expect(await streak(a.approvalId)).toMatchObject({ code: "token_revoked", count: 2 });
    expect(getUrls).toBe(5);
  });

  test("per approval: another approval with the same error still calls Slack", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    const b = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(4, a);
    expect(completes).toBe(3);
    await failTimes(1, b);
    expect(completes).toBe(4);
    expect(await streak(b.approvalId)).toMatchObject({ code: "token_revoked", count: 1 });
  });

  test("reset: setup.slackAdapter.setBotToken succeeds (admin MCP → human approval) → the next re-run calls Slack once", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(4, a);
    expect(completes).toBe(3);
    const queued = await callAdminMcpTool("setup.slackAdapter.setBotToken", { botToken: "xoxb-capk2-new-token" }, adminCred());
    const ticketId = String((queued.structuredContent as Record<string, unknown>).approvalId);
    const ticket = await resolveApproval(ticketId, "approved", "owner@example.com", DEMO_ORG.id, { actorId: "mem_human_1" });
    expect((await fulfillApprovedAdmin(ticket!))?.ok).toBe(true);
    const reset = (await listAuditEvents(DEMO_ORG.id, 100_000)).filter((e) => e.action === SETUP_TOOL_SUCCEEDED_AUDIT
      && (e.metadata as Record<string, unknown>)?.approvalId === ticketId);
    expect(reset.length).toBe(1);
    expect(reset[0].metadata).toMatchObject({ tool: "setup.slackAdapter.setBotToken", source: "admin_fulfillment" });
    noSecrets(JSON.stringify(reset));
    complete = OK_COMPLETE;
    const after = (await failTimes(1, a))[0];
    expect(after).toMatchObject({ ok: true, fileId: "F_CAP_UP" });
    expect(completes).toBe(4);
    expect(await streak(a.approvalId)).toBeUndefined();
    expect((await failTimes(1, a))[0]).toMatchObject({ ok: true, fileId: "F_CAP_UP" });
    expect(completes).toBe(4);
  });

  test("after a reset the same error counts from 1 again (3 more tries, then capped again)", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(3, a);
    await new Promise((r) => setTimeout(r, 5)); // demo audit clock is ms; the reset must be AFTER the last failure
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "setup.slackApprover.set", source: "admin_fulfillment" });
    await failTimes(1, a);
    expect(completes).toBe(4);
    expect(await streak(a.approvalId)).toMatchObject({ code: "token_revoked", count: 1 });
    await failTimes(3, a);
    expect(completes).toBe(6);
  });

  test("no reset: a setup success before the last failure, a non-setup tool, or the link issue (not completed)", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(2, a);
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "setup.slackAdapter.setBotToken", source: "admin_fulfillment" });
    await new Promise((r) => setTimeout(r, 5));
    await failTimes(1, a); // 3rd failure is after that success
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "policy.patch", source: "admin_fulfillment" });
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "setup.slackAuthorizeLink.issue", source: "admin_fulfillment" });
    await failTimes(2, a);
    expect(completes).toBe(3);
  });

  test("another org's setup success does not reset this org's cap", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(3, a);
    await recordSetupToolSucceeded({ orgId: "org_capk2_other", tool: "setup.slackAdapter.setBotToken", source: "admin_fulfillment" });
    await failTimes(1, a);
    expect(completes).toBe(3);
  });

  test("flag OFF: no cap (every re-run may call Slack, response unchanged)", async () => {
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    const out = await failTimes(5, a);
    expect(completes).toBe(5);
    for (const r of out) expect(r?.code).not.toBe("approval_attachment_retry_capped");
  });
});

// ---------------------------------------------------------------------------
describe("migration 20261004400000 (static, 木村 second round)", () => {
  test("token type kept with the definite error; streak in finish; capped claim checks setup success after the last failure; stop RPC", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/20261004400000_approval_attachment_reconcile.sql", import.meta.url), "utf8");
    // 1: token type
    expect(sql).toContain("'slackTokenType'");
    expect(sql).toMatch(/in \('user','bot'\)/);
    // 4: streak per approval + code, written by finish under the row lock
    expect(sql).toContain("'attachmentUploadStreak'");
    expect(sql).toContain("create or replace function public.claim_approval_attachment_upload_capped(p_id uuid, p_org uuid, p_claim uuid, p_ref text, p_cap int)");
    expect(sql).toContain("from public.org_settings_changes c");
    expect(sql).toMatch(/c\.changed_at > \(s->>'lastAt'\)::timestamptz/);
    expect(sql).toContain("return public.claim_approval_attachment_upload(p_id, p_org, p_claim, p_ref);");
    expect(sql).toContain("'capped'");
    // 2: stop
    expect(sql).toContain("create or replace function public.stop_approval_attachment_recheck(p_id uuid, p_org uuid, p_reason text)");
    expect(sql).toContain("'recheckStopReason'");
    expect(sql).toMatch(/u \? 'recheckStoppedAt' then return false/);
    for (const sig of [
      "claim_approval_attachment_upload_capped(uuid,uuid,uuid,text,int)",
      "stop_approval_attachment_recheck(uuid,uuid,text)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${sig} from public,anon,authenticated;`);
      expect(sql).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(sql.match(/security invoker set search_path = pg_catalog, public/g)?.length).toBe(6);
    expect(sql.match(/for update;/g)?.length).toBe(5);
    expect(sql).not.toMatch(/security definer|create policy|drop function/i);
    // still applied after #253's 300000, and no later migration was needed
    const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter((f: string) => f.endsWith(".sql")).sort();
    expect(names.indexOf("20261004400000_approval_attachment_reconcile.sql")).toBeGreaterThan(names.indexOf("20261004300000_approval_attachment_upload_claim.sql"));
    // "No later migration was needed": later migrations (500000 / 600000 RLS,
    // 700000 comm-reply dedup, …) must not redefine the attachment claim functions.
    // (Was "is the last migration", which broke as soon as any later migration landed.)
    for (const later of names.slice(names.indexOf("20261004400000_approval_attachment_reconcile.sql") + 1)) {
      const laterSql = readFileSync(new URL(`../../supabase/migrations/${later}`, import.meta.url), "utf8");
      expect(laterSql).not.toMatch(/approval_attachment_upload|approval_attachment_recheck/);
    }
  });
});

// ---------------------------------------------------------------------------
// 木村 third round on #255 (answers to open decisions a–h)
describe("5. third round: guidance (a–c), resets (d, e, h), poll = re-run (f), fixed cap (g)", () => {
  const BOT_REVOKED = reason("token_revoked", { kind: "slack_bot_token", tokenType: "bot" }, "setup.slackAdapter.setBotToken");
  async function failTimes(n: number, a: { body: GatewayInvokeRequest; approvalId: string }) {
    const out: Array<Record<string, unknown> | undefined> = [];
    for (let i = 0; i < n; i++) out.push(fileUpload(await invokeComm({ ...a.body, approvalId: a.approvalId })));
    return out;
  }
  const tick = () => new Promise((r) => setTimeout(r, 5)); // demo clocks are ms: the reset must be AFTER the last failure
  afterEach(() => { delete process.env.SLACK_AUTHORIZE_LINK_ENABLED; });

  test("(a) user-token credential errors: authorize-link flag OFF → setup.slackStatus (never an unusable tool); ON → setup.slackAuthorizeLink.issue", () => {
    for (const code of TOKEN_CREDENTIAL) {
      delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
      expect(slackReinvokeReason(code, undefined, "user")).toEqual(reason(code, { kind: "slack_user_token", tokenType: "user" }, "setup.slackStatus"));
      process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
      expect(slackReinvokeReason(code, undefined, "user")).toEqual(reason(code, { kind: "slack_user_token", tokenType: "user" }, "setup.slackAuthorizeLink.issue"));
      // bot / unknown do not depend on the link flag
      expect(slackReinvokeReason(code, undefined, "bot")?.nextTool).toBe("setup.slackAdapter.setBotToken");
      expect(slackReinvokeReason(code)?.nextTool).toBe("setup.slackStatus");
    }
  });

  test("(b) missing_scope: user token → setup.slackAuthorizeLink.issue (re-auth adds scopes; flag OFF → setup.slackStatus); bot / unknown → setup.slackStatus", () => {
    const needed = ["files:write"];
    process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
    expect(slackReinvokeReason("missing_scope", needed, "user")).toEqual(reason("missing_scope",
      { kind: "slack_scope", needed, tokenType: "user" }, "setup.slackAuthorizeLink.issue"));
    expect(slackReinvokeReason("missing_scope", needed, "bot")).toEqual(reason("missing_scope",
      { kind: "slack_scope", needed, tokenType: "bot" }, "setup.slackStatus"));
    expect(slackReinvokeReason("missing_scope", needed)).toEqual(reason("missing_scope",
      { kind: "slack_scope", needed, tokenType: "unknown" }, "setup.slackStatus"));
    delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
    expect(slackReinvokeReason("missing_scope", needed, "user")).toEqual(reason("missing_scope",
      { kind: "slack_scope", needed, tokenType: "user" }, "setup.slackStatus"));
  });

  test("(c) not_allowed_token_type → setup.slackStatus for user, bot and unknown (link flag ON or OFF)", () => {
    for (const link of [true, false]) {
      if (link) process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true"; else delete process.env.SLACK_AUTHORIZE_LINK_ENABLED;
      for (const t of ["user", "bot", undefined] as const) {
        expect(slackReinvokeReason("not_allowed_token_type", undefined, t)).toEqual(reason("not_allowed_token_type",
          { kind: "slack_token_type", tokenType: t ?? "unknown" }, "setup.slackStatus"));
      }
    }
  });

  test("(a–c) reconcile flag OFF: the da97a12 table for every token (no tokenType)", () => {
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
    for (const t of ["user", "bot", undefined] as const) {
      expect(slackReinvokeReason("not_allowed_token_type", undefined, t)).toEqual(reason("not_allowed_token_type",
        { kind: "slack_token_type" }, "setup.slackAdapter.setBotToken"));
      expect(slackReinvokeReason("missing_scope", ["files:write"], t)).toEqual(reason("missing_scope",
        { kind: "slack_scope", needed: ["files:write"] }, "setup.slackStatus"));
    }
  });

  test("(b) end to end: user token getUploadURLExternal missing_scope → poll = MCP = re-run → setup.slackAuthorizeLink.issue with needed", async () => {
    installSlack();
    await setToken(true);
    process.env.SLACK_AUTHORIZE_LINK_ENABLED = "true";
    await asUserToken(async () => {
      const { body, approvalId, statusToken } = await approved();
      getUrl = { json: { ok: false, error: "missing_scope", needed: "files:write", provided: "chat:write" } };
      const rerun = fileUpload(await invokeComm({ ...body, approvalId }));
      expect(uploadAuth).toEqual([`Bearer ${USER_TOKEN}`]);
      const expected = reason("missing_scope", { kind: "slack_scope", needed: ["files:write"], tokenType: "user" }, "setup.slackAuthorizeLink.issue");
      expect(rerun?.reinvokeReason).toEqual(expected);
      const p = await poll(approvalId, statusToken);
      expect(p.web.reinvokeReason).toEqual(expected);
      expect(p.mcp.reinvokeReason).toEqual(expected);
      noSecrets(JSON.stringify({ rerun, p }));
    });
  });

  test("(d) saving the Slack bot token from the dashboard (PUT /api/settings/conversation-adapters) resets the cap", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(4, a);
    expect(completes).toBe(3);
    await tick();
    const res = await adapterPUT(new Request("http://localhost/api/settings/conversation-adapters", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "slack", label: "会話投稿（ダミー）", enabled: true, botToken: TOKEN }),
    }));
    expect(res.status).toBe(200);
    complete = OK_COMPLETE;
    expect((await failTimes(1, a))[0]).toMatchObject({ ok: true, fileId: "F_CAP_UP" });
    expect(completes).toBe(4);
  });

  test("(d) flag OFF: a dashboard save records no reset signal", async () => {
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    await tick(); // the previous test's (flag ON) save must be older than `since`
    const since = new Date().toISOString();
    await tick();
    const res = await adapterPUT(new Request("http://localhost/api/settings/conversation-adapters", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "slack", label: "x", enabled: true, botToken: TOKEN }),
    }));
    expect(res.status).toBe(200);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
  });

  test("(e) read-only setup tools never reset (any source)", () => {
    const readOnlySetup = (READ_ONLY_ADMIN_TOOLS as readonly string[]).filter((t) => t.startsWith("setup."));
    expect(readOnlySetup).toContain("setup.slackStatus");
    for (const tool of readOnlySetup) {
      for (const source of ["admin_fulfillment", "authorize_link_completed", "dashboard_settings"] as const) {
        expect(countsAsSettingsChange(tool, source)).toBe(false);
      }
    }
    expect(countsAsSettingsChange(DASHBOARD_SLACK_ADAPTER_SAVE, "dashboard_settings")).toBe(true);
    expect(countsAsSettingsChange(DASHBOARD_SLACK_ADAPTER_SAVE, "admin_fulfillment")).toBe(false);
    expect(countsAsSettingsChange("setup.slackAdapter.setBotToken", "dashboard_settings")).toBe(false);
  });

  test("(e) read-only setup.slackStatus succeeding does not reset the cap", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(3, a);
    await tick();
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "setup.slackStatus", source: "admin_fulfillment" });
    complete = OK_COMPLETE;
    expect((await failTimes(1, a))[0]).toMatchObject({ code: "approval_attachment_retry_capped" });
    expect(completes).toBe(3);
  });

  test("(f) a not_sent marker next to a definite failure: the poll returns the same reason as the re-run (one builder)", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    const first = (await failTimes(1, a))[0];
    expect(first?.reinvokeReason).toEqual(BOT_REVOKED);
    const cur = await latest(a.approvalId);
    const fulfillment = (cur.metadata.fulfillment ?? {}) as Record<string, unknown>;
    expect(fulfillment.ok).toBe(true);
    await updateApprovalMetadata(cur, {
      fulfillment: { ...fulfillment, fileUpload: { status: "not_sent", reason: "rerun_required", filename: "approved.pdf", bytes: 25 } },
    });
    const p = await poll(a.approvalId, a.statusToken);
    expect(p.web.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.web.reinvokeReason).toEqual(BOT_REVOKED);
    expect(p.mcp.reinvokeReason).toEqual(BOT_REVOKED);
    const again = (await failTimes(1, a))[0];
    expect(again?.reinvokeReason).toEqual(p.web.reinvokeReason);
  });

  test("(f) flag OFF: the stored not_sent marker still wins in the poll (unchanged)", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(1, a);
    delete process.env.APPROVAL_ATTACHMENT_RECONCILE_ENABLED;
    const cur = await latest(a.approvalId);
    const fulfillment = (cur.metadata.fulfillment ?? {}) as Record<string, unknown>;
    await updateApprovalMetadata(cur, {
      fulfillment: { ...fulfillment, fileUpload: { status: "not_sent", reason: "rerun_required", filename: "approved.pdf", bytes: 25 } },
    });
    const p = await poll(a.approvalId, a.statusToken);
    expect(p.web.pollHint).toBe("reinvoke_with_approvalId");
    expect(p.web.reinvokeReason).toBeUndefined();
  });

  test("(g) the cap stays 3: env values are ignored", async () => {
    process.env.APPROVAL_ATTACHMENT_RETRY_CAP = "10";
    process.env.ATTACHMENT_RETRY_CAP = "10";
    try {
      installSlack();
      await setToken(true);
      const a = await approved();
      complete = { json: { ok: false, error: "token_revoked" } };
      const out = await failTimes(4, a);
      expect(completes).toBe(3);
      expect(out[3]).toMatchObject({ code: "approval_attachment_retry_capped", retryCap: { consecutive: 3, limit: 3 } });
    } finally {
      delete process.env.APPROVAL_ATTACHMENT_RETRY_CAP;
      delete process.env.ATTACHMENT_RETRY_CAP;
    }
  });

  test("(h) an audit row 'setup.tool_succeeded' written directly (as an org member could) is NOT a reset; only the service-side signal is", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(3, a);
    await tick();
    const since = new Date().toISOString();
    await appendAuditEvent({
      orgId: DEMO_ORG.id, employeeId: null, credentialId: null, action: SETUP_TOOL_SUCCEEDED_AUDIT, purpose: "setup",
      summary: "forged", metadata: { tool: "setup.slackAdapter.setBotToken", source: "admin_fulfillment" },
    });
    complete = OK_COMPLETE;
    expect((await failTimes(1, a))[0]).toMatchObject({ code: "approval_attachment_retry_capped" });
    expect(completes).toBe(3);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
    await tick();
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "setup.slackAdapter.setBotToken", source: "admin_fulfillment" });
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(true);
    expect((await failTimes(1, a))[0]).toMatchObject({ ok: true, fileId: "F_CAP_UP" });
    expect(completes).toBe(4);
  });

  test("(h) migration: the reset signal is a service_role-only table read by the capped claim (not audit_events)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/20261004400000_approval_attachment_reconcile.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table if not exists public.org_settings_changes");
    expect(sql).toContain("org_id uuid primary key references public.orgs(id) on delete cascade");
    expect(sql).toContain("alter table public.org_settings_changes enable row level security;");
    expect(sql).toContain("revoke all on public.org_settings_changes from public, anon, authenticated;");
    expect(sql).toContain("grant select, insert, update on public.org_settings_changes to service_role;");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toContain("audit_events");
    expect(sql).toContain("create or replace function public.record_org_settings_change(p_org uuid, p_tool text, p_source text)");
    expect(sql).toContain("revoke all on function public.record_org_settings_change(uuid,text,text) from public,anon,authenticated;");
    expect(sql).toContain("grant execute on function public.record_org_settings_change(uuid,text,text) to service_role;");
  });
});

// ---------------------------------------------------------------------------
describe("6. fourth round: narrower resets (1 dashboard, 3 Slack-only allow-list), admin_tool source removed (4)", () => {
  async function failTimes(n: number, a: { body: GatewayInvokeRequest; approvalId: string }) {
    const out: Array<Record<string, unknown> | undefined> = [];
    for (let i = 0; i < n; i++) out.push(fileUpload(await invokeComm({ ...a.body, approvalId: a.approvalId })));
    return out;
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const put = (body: Record<string, unknown>) => adapterPUT(new Request("http://localhost/api/settings/conversation-adapters", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "slack", label: "会話投稿（ダミー）", ...body }),
  }));
  const ALLOW = [
    { tool: "dashboard.conversationAdapter.slack", source: "dashboard_settings" },
    { tool: "employees.postingIdentity.set", source: "admin_fulfillment" },
    { tool: "setup.slackAdapter.setBotToken", source: "admin_fulfillment" },
    { tool: "setup.slackApprover.set", source: "admin_fulfillment" },
    { tool: "setup.slackAuthorizeLink.issue", source: "authorize_link_completed" },
  ];
  const key = (x: { tool: string; source: string }) => `${x.tool}|${x.source}`;

  test("(1) a dashboard save that only sets enabled:false (no token) is NOT a reset: no signal, the cap stays", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(3, a);
    await tick();
    const since = new Date().toISOString();
    await tick();
    const res = await put({ enabled: false });
    expect(res.status).toBe(200);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
    expect((await listAuditEvents(DEMO_ORG.id, 100_000)).filter((e) => e.action === SETUP_TOOL_SUCCEEDED_AUDIT
      && Date.parse(e.createdAt) > Date.parse(since))).toHaveLength(0);
    await setToken(true); // re-enable through the data layer (no route, no signal)
    complete = OK_COMPLETE;
    expect((await failTimes(1, a))[0]).toMatchObject({ code: "approval_attachment_retry_capped" });
    expect(completes).toBe(3);
  });

  test("(1) a save that enables the adapter (no new token) is a reset", async () => {
    installSlack();
    await setToken(true);
    await tick();
    const since = new Date().toISOString();
    await tick();
    expect((await put({ enabled: true })).status).toBe(200);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(true);
  });

  test("(1) a save that includes a token is a reset even with enabled:false", async () => {
    installSlack();
    await setToken(true);
    await tick();
    const since = new Date().toISOString();
    await tick();
    expect((await put({ enabled: false, botToken: TOKEN })).status).toBe(200);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(true);
  });

  test("(1) a whitespace-only token with enabled:false is not a token: no reset", async () => {
    installSlack();
    await setToken(true);
    await tick();
    const since = new Date().toISOString();
    await tick();
    expect((await put({ enabled: false, botToken: "   " })).status).toBe(200);
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
  });

  test("(3) explicit allow-list: Slack-related signals only (exact tool + source pairs)", () => {
    expect([...SETTINGS_RESET_SIGNALS].map(key).sort()).toEqual(ALLOW.map(key).sort());
    for (const s of ALLOW) expect(countsAsSettingsChange(s.tool, s.source as "admin_fulfillment")).toBe(true);
    for (const tool of ["setup.lineApproval.upsert", "setup.lineApproval.setEmployeeInbox", "setup.lineApproval.demoteTelegram",
      "setup.approvalDelivery.autoResolve", "setup.slackStatus", "setup.slackDmApprovalStatus", "policy.patch"]) {
      for (const source of ["admin_fulfillment", "authorize_link_completed", "dashboard_settings"] as const) {
        expect(countsAsSettingsChange(tool, source)).toBe(false);
      }
    }
    // a listed tool with another source is not a signal
    expect(countsAsSettingsChange("setup.slackAuthorizeLink.issue", "admin_fulfillment")).toBe(false);
    expect(countsAsSettingsChange("setup.slackApprover.set", "dashboard_settings")).toBe(false);
    // registered names (no typo in the allow-list)
    for (const s of ALLOW.filter((x) => x.source !== "dashboard_settings")) {
      expect((ADMIN_MCP_TOOL_NAMES as readonly string[]).includes(s.tool)).toBe(true);
    }
  });

  test("(3) LINE setup tools and setup.approvalDelivery.autoResolve no longer reset the cap", async () => {
    installSlack();
    await setToken(true);
    const a = await approved();
    complete = { json: { ok: false, error: "token_revoked" } };
    await failTimes(3, a);
    await tick();
    const since = new Date().toISOString();
    for (const tool of ["setup.lineApproval.upsert", "setup.lineApproval.setEmployeeInbox", "setup.lineApproval.demoteTelegram", "setup.approvalDelivery.autoResolve"]) {
      await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool, source: "admin_fulfillment" });
    }
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
    complete = OK_COMPLETE;
    expect((await failTimes(1, a))[0]).toMatchObject({ code: "approval_attachment_retry_capped" });
    expect(completes).toBe(3);
  });

  test("(3) migration: record_org_settings_change and the table check accept exactly the same tool + source pairs", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/20261004400000_approval_attachment_reconcile.sql", import.meta.url), "utf8");
    const pairs = (text: string) => [...text.matchAll(/\('([a-z][A-Za-z0-9._]*)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]}|${m[2]}`).sort();
    const table = sql.slice(sql.indexOf("create table if not exists public.org_settings_changes"), sql.indexOf("alter table public.org_settings_changes"));
    const fnStart = sql.indexOf("create or replace function public.record_org_settings_change");
    const fn = sql.slice(fnStart, sql.indexOf("end $$;", fnStart));
    expect(pairs(table)).toEqual(ALLOW.map(key).sort());
    expect(pairs(fn)).toEqual(ALLOW.map(key).sort());
    expect(fn).toContain("raise exception 'invalid_settings_change_tool'");
    expect(fn).toContain("raise exception 'invalid_settings_change_source'");
  });

  test("(4) the admin_tool source is gone (code, migration validation)", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(read("../../supabase/migrations/20261004400000_approval_attachment_reconcile.sql")).not.toContain("admin_tool");
    expect(read("./attachment-retry-cap.ts")).not.toContain("admin_tool");
    const adminTools = read("../mcp/admin-tools.ts");
    expect(adminTools).not.toContain("admin_tool\"");
    expect(adminTools).not.toContain("recordSetupToolSucceeded");
    expect(adminTools).not.toContain("callAdminMcpToolCore");
  });

  test("(4) a caller passing the old admin_tool source records nothing", async () => {
    await tick();
    const since = new Date().toISOString();
    await tick();
    expect(countsAsSettingsChange("setup.slackAdapter.setBotToken", "admin_tool" as never)).toBe(false);
    await recordSetupToolSucceeded({ orgId: DEMO_ORG.id, tool: "setup.slackAdapter.setBotToken", source: "admin_tool" as never });
    expect(await settingsChangedSince(DEMO_ORG.id, since)).toBe(false);
  });
});
