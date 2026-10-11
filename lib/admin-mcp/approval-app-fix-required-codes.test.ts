/**
 * 2026-10-12 (木村, #329 follow-up): approval_user_external, approval_user_guest
 * and bot_token_required are not transient either. Behind
 * APPROVAL_APP_FIX_REQUIRED_CODES_ENABLED (default OFF, sibling of
 * APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED):
 * - W2 skips them as fix_required (no retry spent); transient errors keep the cap;
 * - each code gets its own notice (what is wrong + how to fix it), ids only;
 * - every one of them stops setup.approvalDelivery.autoResolve before any write
 *   (destination not saved) or post (no chat.postMessage) — pinned here per code.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { listNotificationChannels, resetDemoNotificationChannels, upsertNotificationChannel } from "@/lib/data/notification-channels";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { isRetryableApprovalFailure } from "@/lib/approvals/execution";
import { evaluateW2Eligibility, runW2FulfillRetry } from "@/lib/stuck-watch/w2-unfulfilled";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  APPROVAL_APP_FIX_NOTICE_JA,
  resetApprovalAppScopeNoticeForTests,
  setApprovalAppScopeNoticeDepsForTests,
} from "@/lib/slack/approval-app-scope-notice";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ApprovalRequest } from "@/lib/types";
import { slackApiArgs } from "@/tests/helpers/slack-api-args";

const ORG_A = DEMO_ORG.id;
const ORG_B = "org_fixcodes_other";
const TEAM = "TFIXCODE01";
const BOT_TOKEN = "xoxb-fixcodes-approval-SECRET-222";
const NOT_BOT_TOKEN = "xoxp-fixcodes-user-SECRET-555";
const OTHER_BOT_TOKEN = "xoxb-fixcodes-other-SECRET-444";
const BOT_TOKEN_B = "xoxb-fixcodes-orgb-SECRET-333";
const APPROVER = "UAPPROVER77";
const APP_ID = "AFIXCODE01";
const FLAG = "APPROVAL_APP_FIX_REQUIRED_CODES_ENABLED";
const PARENT = "APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED";
const FLAGS = ["SLACK_APPROVAL_DM_AUTO_OPEN", "ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY", "SLACK_SHARED_APPROVAL_APP_ENABLED", FLAG, PARENT] as const;
const CODES = ["bot_token_required", "approval_user_guest", "approval_user_external"] as const;
type Code = (typeof CODES)[number];

type Call = { method: string; body: Record<string, unknown>; auth: string };
let calls: Call[] = [];
let userFlags: Record<string, unknown> = {};
let dmShared = false;
let savedFetch: typeof globalThis.fetch;
let saved: Record<string, string | undefined> = {};
let mails: Array<{ to: string[]; subject: string; text: string }> = [];
let sends: Array<{ orgId: string; channelId: string; text: string }> = [];

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_fixcodes", status: "linked" });
  return { orgId, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const body = slackApiArgs(method, init);
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    calls.push({ method, body, auth });
    const json = (d: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "auth.test") return json({ ok: true, user_id: "UBOT", team_id: TEAM, app_id: APP_ID }, { "x-oauth-scopes": "chat:write,im:write,im:read,users:read" });
    if (method === "users.info") return json({ ok: true, user: { id: String(body.user), team_id: TEAM, ...userFlags } });
    if (method === "conversations.open") return json({ ok: true, channel: { id: "DFIXCODE01", is_im: true, ...(dmShared ? { is_ext_shared: true } : {}) } });
    if (method === "chat.postMessage") return json({ ok: true, ts: "1700000000.0001" });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

async function seedInbox(orgId: string, token: string, opts: { channelId?: string; shared?: boolean; label?: string; isDefault?: boolean } = {}) {
  return upsertNotificationChannel({
    orgId,
    provider: "slack",
    enabled: true,
    isDefault: opts.isDefault ?? true,
    label: opts.label ?? `承認 ${orgId}`,
    config: { channelId: opts.channelId ?? "", allowedUserIds: [APPROVER], apiAppId: APP_ID, ...(opts.shared ? { sharedApprovalApp: true } : {}) },
    secrets: { botToken: token, signingSecret: "sig-SECRET" },
  });
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

async function queueAndApprove(orgId: string, inboxId: string) {
  const queued = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { deliveryUserId: APPROVER, inboxId }, cred(orgId)));
  const approvalId = String(queued.approvalId);
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_1" });
  return { approvalId, approved: approved! };
}

/** Put Slack / the inbox in the state that makes autoResolve fail with `code`. */
async function arrange(code: Code | "approval_user_external_dm"): Promise<string> {
  const token = code === "bot_token_required" ? NOT_BOT_TOKEN : BOT_TOKEN;
  if (code === "approval_user_guest") userFlags = { is_restricted: true };
  if (code === "approval_user_external") userFlags = { is_stranger: true };
  if (code === "approval_user_external_dm") dmShared = true;
  const failing = await seedInbox(ORG_A, token);
  await seedInbox(ORG_A, OTHER_BOT_TOKEN, { channelId: "CADMINS0001", label: "管理者チャンネル", isDefault: false });
  await seedInbox(ORG_B, BOT_TOKEN_B, { channelId: "DORGBDEST01" });
  return failing.id;
}

function noSecrets(value: unknown) {
  const blob = JSON.stringify(value);
  for (const s of [BOT_TOKEN, NOT_BOT_TOKEN, OTHER_BOT_TOKEN, BOT_TOKEN_B, "SECRET"]) expect(blob).not.toContain(s);
}

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  process.env.SLACK_APPROVAL_DM_AUTO_OPEN = "true";
  delete process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY;
  delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
  delete process.env[PARENT];
  process.env[FLAG] = "true";
  userFlags = {};
  dmShared = false;
  savedFetch = globalThis.fetch;
  installFetch();
  resetDemoNotificationChannels();
  mails = [];
  sends = [];
  resetApprovalAppScopeNoticeForTests();
  setApprovalAppScopeNoticeDepsForTests({
    mail: async (msg) => {
      mails.push({ to: [...msg.to], subject: msg.subject, text: msg.text });
      return { ok: true };
    },
    send: async (channel, text) => {
      sends.push({ orgId: channel.orgId, channelId: String(channel.config?.channelId || ""), text });
      return { ok: true };
    },
  });
});

afterEach(() => {
  for (const f of FLAGS) {
    if (saved[f] === undefined) delete process.env[f];
    else process.env[f] = saved[f];
  }
  globalThis.fetch = savedFetch;
  setApprovalAppScopeNoticeDepsForTests({ mail: null, send: null });
});

const CASES: Array<{ name: string; arrange: Code | "approval_user_external_dm"; code: Code; opensDm: boolean }> = [
  { name: "bot_token_required (not an xoxb- token)", arrange: "bot_token_required", code: "bot_token_required", opensDm: false },
  { name: "approval_user_guest (is_restricted)", arrange: "approval_user_guest", code: "approval_user_guest", opensDm: false },
  { name: "approval_user_external (is_stranger)", arrange: "approval_user_external", code: "approval_user_external", opensDm: false },
  { name: "approval_user_external (Slack Connect DM)", arrange: "approval_user_external_dm", code: "approval_user_external", opensDm: true },
];

describe("each code stops autoResolve before any write or post (characterization)", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const inboxId = await arrange(c.arrange);
      const { approved } = await queueAndApprove(ORG_A, inboxId);
      const fulfillment = await fulfillApprovedAdmin(approved);
      expect(fulfillment).toMatchObject({ ok: false, error: c.code });
      expect(calls.filter((x) => x.method === "chat.postMessage")).toHaveLength(0);
      expect(calls.some((x) => x.method === "conversations.open")).toBe(c.opensDm);
      const inbox = (await listNotificationChannels(ORG_A)).find((x) => x.id === inboxId)!;
      expect(inbox.config.channelId).toBe("");
      expect(inbox.config.setupNoticeAt).toBeUndefined();
      expect(getRuntimeAudit().some((e) => e.metadata?.event === "approval_dm.auto_resolved" && e.metadata?.approvalId === approved.id)).toBe(false);
    });
  }
});

describe("flag ON: own notice per code (what is wrong + how to fix), ids only", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const inboxId = await arrange(c.arrange);
      const { approvalId, approved } = await queueAndApprove(ORG_A, inboxId);
      await fulfillApprovedAdmin(approved);
      expect(mails).toHaveLength(1);
      expect(mails[0].to).toEqual(["owner@example.com"]);
      expect(sends.map((s) => s.channelId)).toEqual(["CADMINS0001"]);
      for (const text of [mails[0].text, sends[0].text]) {
        expect(text).toContain(APPROVAL_APP_FIX_NOTICE_JA[c.code].problem);
        expect(text).toContain(APPROVAL_APP_FIX_NOTICE_JA[c.code].fix);
        expect(text).toContain(approvalId);
        expect(text).not.toContain(APPROVER);
        for (const field of [approved.title, approved.summary, approved.purpose]) {
          if (field && field !== "setup.approvalDelivery.autoResolve") expect(text.includes(field)).toBe(false);
        }
      }
      const audit = getRuntimeAudit().filter((e) => e.metadata?.event === "approval_app.fix_required_notice" && e.metadata?.approvalId === approvalId);
      expect(audit).toHaveLength(1);
      expect(audit[0].orgId).toBe(ORG_A);
      expect(audit[0].metadata).toMatchObject({ code: c.code, inboxId, tool: "setup.approvalDelivery.autoResolve" });
      noSecrets({ mails, sends, audit });
    });
  }

  test("the three wordings differ from each other and from the missing-scope one", () => {
    const texts = CODES.map((c) => `${APPROVAL_APP_FIX_NOTICE_JA[c].problem}|${APPROVAL_APP_FIX_NOTICE_JA[c].fix}`);
    expect(new Set(texts).size).toBe(3);
    expect(APPROVAL_APP_FIX_NOTICE_JA.bot_token_required.fix).toContain("/app/settings");
    expect(APPROVAL_APP_FIX_NOTICE_JA.approval_user_guest.problem).toContain("ゲスト");
    expect(APPROVAL_APP_FIX_NOTICE_JA.approval_user_external.problem).toContain("社外");
  });

  test("bot_token_required: after a human enters the xoxb token the SAME ticket runs again and succeeds", async () => {
    const inboxId = await arrange("bot_token_required");
    const { approvalId, approved } = await queueAndApprove(ORG_A, inboxId);
    expect((await fulfillApprovedAdmin(approved))?.error).toBe("bot_token_required");
    const inbox = (await listNotificationChannels(ORG_A)).find((x) => x.id === inboxId)!;
    await upsertNotificationChannel({ id: inbox.id, orgId: ORG_A, provider: "slack", label: inbox.label, enabled: true, isDefault: true, config: inbox.config, secrets: { botToken: BOT_TOKEN } });
    const rerun = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { approvalId }, cred()));
    expect(rerun).toMatchObject({ ok: true });
  });

  test("approval_user_guest: after the person becomes a full member the SAME ticket runs again", async () => {
    const inboxId = await arrange("approval_user_guest");
    const { approvalId, approved } = await queueAndApprove(ORG_A, inboxId);
    expect((await fulfillApprovedAdmin(approved))?.error).toBe("approval_user_guest");
    userFlags = {};
    expect(data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { approvalId }, cred()))).toMatchObject({ ok: true });
  });

  test("another org cannot re-run the ticket (BOLA) and gets no notice", async () => {
    const inboxId = await arrange("approval_user_guest");
    const { approvalId, approved } = await queueAndApprove(ORG_A, inboxId);
    await fulfillApprovedAdmin(approved);
    expect(data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { approvalId }, cred(ORG_B)))).toMatchObject({ ok: false, code: "approval_not_found" });
    expect(sends.every((s) => s.orgId === ORG_A)).toBe(true);
  });

  test("shared approval app: bot_token_required is Staffpass's to fix → no tenant notice; guest → tenant notice", async () => {
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    const tokenInbox = await seedInbox(ORG_A, NOT_BOT_TOKEN, { shared: true });
    const a = await queueAndApprove(ORG_A, tokenInbox.id);
    expect((await fulfillApprovedAdmin(a.approved))?.error).toBe("bot_token_required");
    expect(mails).toHaveLength(0);
    resetDemoNotificationChannels();
    userFlags = { is_restricted: true };
    const guestInbox = await seedInbox(ORG_A, BOT_TOKEN, { shared: true });
    const b = await queueAndApprove(ORG_A, guestInbox.id);
    expect((await fulfillApprovedAdmin(b.approved))?.error).toBe("approval_user_guest");
    expect(mails).toHaveLength(1);
  });
});

function w2Approval(error: string, retryCount: number): ApprovalRequest {
  const resolvedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  return {
    id: `apr_w2fix_${error}_${retryCount}`,
    orgId: ORG_A,
    employeeId: null,
    credentialId: null,
    jobId: "job_w2fix",
    tool: "setup.approvalDelivery.autoResolve",
    status: "approved",
    resolvedAt,
    createdAt: resolvedAt,
    metadata: {
      auditClass: "admin",
      adminTool: "setup.approvalDelivery.autoResolve",
      adminFulfillment: { ok: false, tool: "setup.approvalDelivery.autoResolve", at: resolvedAt, error },
      stuckWatch: { w2: { firstDetectedAt: resolvedAt, retryCount } },
    },
  } as unknown as ApprovalRequest;
}

describe("W2 and the execution claim", () => {
  test("flag ON: each code → fix_required, no retry spent; claim re-runnable for the two approval-app tools only", async () => {
    const policy = defaultStuckWatchPolicy();
    for (const code of CODES) {
      expect(evaluateW2Eligibility({ approval: w2Approval(code, 0), policy, now: new Date() })).toMatchObject({ eligible: false, reason: "fix_required", retryCount: 0 });
      expect(await runW2FulfillRetry(w2Approval(code, 0), policy)).toMatchObject({ skipped: true, reason: "fix_required", retryCount: 0 });
      expect(isRetryableApprovalFailure("setup.approvalDelivery.autoResolve", code)).toBe(true);
      expect(isRetryableApprovalFailure("setup.slackAuthorizeLink.issue", code)).toBe(true);
      expect(isRetryableApprovalFailure("setup.slackApprover.set", code)).toBe(false);
    }
  });

  test("transient errors keep the existing cap", () => {
    const policy = defaultStuckWatchPolicy();
    expect(evaluateW2Eligibility({ approval: w2Approval("approval_dm_open_failed", 0), policy, now: new Date() }).eligible).toBe(true);
    expect(evaluateW2Eligibility({ approval: w2Approval("approval_user_undeterminable", 1), policy, now: new Date() }).eligible).toBe(true);
    expect(evaluateW2Eligibility({ approval: w2Approval("approval_dm_open_failed", policy.maxAutoRetries), policy, now: new Date() })).toMatchObject({ eligible: false, reason: "max_retries" });
  });

  test("flag OFF (even with the missing-scope flag ON): these codes behave as today; missing_scope keeps its own flag", async () => {
    process.env[FLAG] = "false";
    process.env[PARENT] = "true";
    const policy = defaultStuckWatchPolicy();
    for (const code of CODES) {
      expect(evaluateW2Eligibility({ approval: w2Approval(code, 0), policy, now: new Date() }).eligible).toBe(true);
      expect(isRetryableApprovalFailure("setup.approvalDelivery.autoResolve", code)).toBe(false);
    }
    expect(evaluateW2Eligibility({ approval: w2Approval("approval_app_missing_scope", 0), policy, now: new Date() }).reason).toBe("fix_required");
    const inboxId = await arrange("approval_user_guest");
    const { approved } = await queueAndApprove(ORG_A, inboxId);
    expect((await fulfillApprovedAdmin(approved))?.error).toBe("approval_user_guest");
    expect(mails).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
