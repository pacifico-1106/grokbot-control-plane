/**
 * 2026-10-12 (木村): per-tenant custom approval app without users:read.
 * Today: setup.approvalDelivery.autoResolve fails with approval_app_missing_scope,
 * the execution claim ends "uncertain" (the same ticket can never run again) and
 * W2 still spends its 2 automatic retries on it, whatever the error.
 *
 * APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED=ON:
 * - the approver is told right away 「この権限を足して入れ直して」 naming the scope
 *   (ids only: approval id, inbox id, app id, scope — no bodies, no tokens);
 * - the failure is re-runnable: after the reinstall the SAME ticket runs again
 *   (admin agent re-invokes with approvalId);
 * - W2 does not burn retries on this non-transient code; transient failures keep
 *   the existing cap (maxAutoRetries).
 * OFF: exactly today's behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import {
  listNotificationChannels,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { isRetryableApprovalFailure } from "@/lib/approvals/execution";
import { evaluateW2Eligibility, runW2FulfillRetry } from "@/lib/stuck-watch/w2-unfulfilled";
import { defaultStuckWatchPolicy } from "@/lib/stuck-watch/validate";
import {
  APPROVAL_APP_SCOPE_FIX_JA,
  resetApprovalAppScopeNoticeForTests,
  setApprovalAppScopeNoticeDepsForTests,
} from "@/lib/slack/approval-app-scope-notice";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { ApprovalRequest } from "@/lib/types";
import { slackApiArgs } from "@/tests/helpers/slack-api-args";

const ORG_A = DEMO_ORG.id;
const ORG_B = "org_scope_notice_other";
const TEAM = "TSCOPE0001";
const BOT_TOKEN = "xoxb-scope-approval-SECRET-222";
const OTHER_BOT_TOKEN = "xoxb-scope-other-inbox-SECRET-444";
const BOT_TOKEN_B = "xoxb-scope-orgb-SECRET-333";
const APPROVER = "UAPPROVER01";
const APP_ID = "ASCOPEAPP01";
const FLAG = "APPROVAL_APP_MISSING_SCOPE_NOTICE_ENABLED";
const FLAGS = ["SLACK_APPROVAL_DM_AUTO_OPEN", "ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY", FLAG] as const;

type Call = { method: string; body: Record<string, unknown>; auth: string };
let calls: Call[] = [];
let usersInfoMissingScope = true;
let savedFetch: typeof globalThis.fetch;
let saved: Record<string, string | undefined> = {};
type Mail = { to: string[]; subject: string; text: string };
let mails: Mail[] = [];
let sends: Array<{ orgId: string; channelId: string; text: string }> = [];

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_scope", status: "linked" });
  return { orgId, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const body = slackApiArgs(method, init);
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
    calls.push({ method, body, auth });
    const json = (data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (method === "auth.test") return json({ ok: true, user_id: "UBOT", team_id: TEAM, app_id: APP_ID }, { "x-oauth-scopes": "chat:write,im:write,im:read" });
    if (method === "users.info") {
      if (usersInfoMissingScope) return json({ ok: false, error: "missing_scope", needed: "users:read" });
      return json({ ok: true, user: { id: String(body.user), team_id: TEAM } });
    }
    if (method === "conversations.open") return json({ ok: true, channel: { id: "DSCOPEDM01", is_im: true } });
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
    config: {
      channelId: opts.channelId ?? "",
      allowedUserIds: [APPROVER],
      apiAppId: APP_ID,
      ...(opts.shared ? { sharedApprovalApp: true } : {}),
    },
    secrets: { botToken: token, signingSecret: "sig-SECRET" },
  });
}

function data(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

async function queueAndApprove(orgId = ORG_A, inboxId?: string) {
  const args: Record<string, unknown> = { deliveryUserId: APPROVER, ...(inboxId ? { inboxId } : {}) };
  const queued = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", args, cred(orgId)));
  const approvalId = String(queued.approvalId);
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", orgId, { actorId: "mem_1" });
  return { approvalId, approved: approved! };
}

function noSecrets(value: unknown) {
  const blob = JSON.stringify(value);
  for (const s of [BOT_TOKEN, OTHER_BOT_TOKEN, BOT_TOKEN_B, "SECRET"]) expect(blob).not.toContain(s);
}

beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  process.env.SLACK_APPROVAL_DM_AUTO_OPEN = "true";
  delete process.env.ADMIN_MCP_DM_AUTOROUTE_AUDIT_ONLY;
  process.env[FLAG] = "true";
  usersInfoMissingScope = true;
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

describe("flag ON: tell the approver right away (ids only)", () => {
  test("missing users:read → one notice to the approver naming the scope; other inbox gets it, failing inbox does not", async () => {
    const failing = await seedInbox(ORG_A, BOT_TOKEN);
    await seedInbox(ORG_A, OTHER_BOT_TOKEN, { channelId: "CADMINS0001", label: "管理者チャンネル", isDefault: false });
    await seedInbox(ORG_B, BOT_TOKEN_B, { channelId: "DORGBDEST01" });
    const { approvalId, approved } = await queueAndApprove(ORG_A, failing.id);
    const fulfillment = await fulfillApprovedAdmin(approved);
    expect(fulfillment).toMatchObject({ ok: false, error: "approval_app_missing_scope" });

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["owner@example.com"]);
    for (const text of [mails[0].text, ...sends.map((s) => s.text)]) {
      expect(text).toContain(APPROVAL_APP_SCOPE_FIX_JA);
      expect(text).toContain("users:read");
      expect(text).toContain(approvalId);
      expect(text).toContain(APP_ID);
      expect(text).toContain("setup.approvalDelivery.autoResolve");
    }
    expect(APPROVAL_APP_SCOPE_FIX_JA).toContain("この権限を足して入れ直して");
    expect(sends.map((s) => s.channelId)).toEqual(["CADMINS0001"]);
    expect(sends.every((s) => s.orgId === ORG_A)).toBe(true);
    const audit = getRuntimeAudit().filter((e) => e.metadata?.event === "approval_app.missing_scope_notice");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ orgId: ORG_A });
    expect(audit[0].metadata).toMatchObject({ approvalId, inboxId: failing.id, scope: "users:read", apiAppId: APP_ID, tool: "setup.approvalDelivery.autoResolve" });
    noSecrets({ mails, sends, audit, fulfillment });
  });

  test("notice text carries no request body / summary / tokens (ids + scope only)", async () => {
    await seedInbox(ORG_A, BOT_TOKEN);
    const { approved } = await queueAndApprove();
    await fulfillApprovedAdmin(approved);
    const text = mails[0].text;
    // Whatever the ticket's title / summary say, only ids + scope + tool name reach the notice.
    const ids = new Set([approved.id, APP_ID, "users:read", "setup.approvalDelivery.autoResolve"]);
    for (const field of [approved.title, approved.summary, approved.purpose]) {
      if (field && !ids.has(field)) expect({ field, inText: text.includes(field) }).toEqual({ field, inText: false });
    }
    expect(text).not.toContain(APPROVER); // the approver's Slack id stays out too
    noSecrets(text);
  });

  test("after the reinstall the SAME ticket runs again (re-invoke with approvalId) and succeeds", async () => {
    await seedInbox(ORG_A, BOT_TOKEN);
    const { approvalId, approved } = await queueAndApprove();
    expect((await fulfillApprovedAdmin(approved))?.ok).toBe(false);
    usersInfoMissingScope = false; // admin added users:read and reinstalled
    const rerun = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { approvalId }, cred()));
    expect(rerun).toMatchObject({ ok: true });
    const inbox = (await listNotificationChannels(ORG_A))[0];
    expect(String(inbox.config.channelId)).toMatch(/^D/);
  });

  test("another org cannot re-run or read the ticket (BOLA)", async () => {
    await seedInbox(ORG_A, BOT_TOKEN);
    const { approvalId, approved } = await queueAndApprove();
    await fulfillApprovedAdmin(approved);
    usersInfoMissingScope = false;
    const other = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { approvalId }, cred(ORG_B)));
    expect(other).toMatchObject({ ok: false, code: "approval_not_found" });
  });

  test("shared approval app inbox (Staffpass's own app) → no tenant reinstall notice", async () => {
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "true";
    try {
      await seedInbox(ORG_A, BOT_TOKEN, { shared: true });
      const { approved } = await queueAndApprove();
      const fulfillment = await fulfillApprovedAdmin(approved);
      expect(fulfillment?.error).toBe("approval_app_missing_scope");
      expect(mails).toHaveLength(0);
      expect(sends).toHaveLength(0);
    } finally {
      delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
    }
  });
});

describe("retries: non-transient vs transient", () => {
  test("isRetryableApprovalFailure: approval_app_missing_scope re-runnable for the two approval-app tools only, flag ON only", () => {
    expect(isRetryableApprovalFailure("setup.approvalDelivery.autoResolve", "approval_app_missing_scope")).toBe(true);
    expect(isRetryableApprovalFailure("setup.slackAuthorizeLink.issue", "approval_app_missing_scope")).toBe(true);
    expect(isRetryableApprovalFailure("setup.slackApprover.set", "approval_app_missing_scope")).toBe(false);
    process.env[FLAG] = "false";
    expect(isRetryableApprovalFailure("setup.approvalDelivery.autoResolve", "approval_app_missing_scope")).toBe(false);
    expect(isRetryableApprovalFailure("setup.slackAuthorizeLink.issue", "approval_app_missing_scope")).toBe(false);
  });

  function w2Approval(error: string, retryCount: number): ApprovalRequest {
    const resolvedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    return {
      id: `apr_w2_${error}_${retryCount}`,
      orgId: ORG_A,
      employeeId: null,
      credentialId: null,
      jobId: "job_w2",
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

  test("W2 does not spend a retry on approval_app_missing_scope (fix_required, count stays 0)", async () => {
    const policy = defaultStuckWatchPolicy();
    const a = w2Approval("approval_app_missing_scope", 0);
    expect(evaluateW2Eligibility({ approval: a, policy, now: new Date() })).toMatchObject({ eligible: false, reason: "fix_required", retryCount: 0 });
    const run = await runW2FulfillRetry(a, policy);
    expect(run).toMatchObject({ ok: false, skipped: true, reason: "fix_required", retryCount: 0 });
  });

  test("transient failures keep the existing cap: eligible below maxAutoRetries, max_retries at the cap", () => {
    const policy = defaultStuckWatchPolicy();
    expect(evaluateW2Eligibility({ approval: w2Approval("approval_dm_open_failed", 0), policy, now: new Date() }).eligible).toBe(true);
    expect(evaluateW2Eligibility({ approval: w2Approval("approval_dm_open_failed", policy.maxAutoRetries), policy, now: new Date() })).toMatchObject({ eligible: false, reason: "max_retries" });
  });
});

describe("flag OFF: today's behaviour", () => {
  test("no notice, the ticket cannot run again (claim uncertain), W2 still counts it as eligible", async () => {
    process.env[FLAG] = "false";
    await seedInbox(ORG_A, BOT_TOKEN);
    const { approvalId, approved } = await queueAndApprove();
    expect((await fulfillApprovedAdmin(approved))?.error).toBe("approval_app_missing_scope");
    expect(mails).toHaveLength(0);
    expect(sends).toHaveLength(0);
    usersInfoMissingScope = false;
    const rerun = data(await callAdminMcpTool("setup.approvalDelivery.autoResolve", { approvalId }, cred()));
    expect(rerun.ok).not.toBe(true);
    const policy = defaultStuckWatchPolicy();
    const resolvedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const a = { ...approved, resolvedAt, metadata: { ...approved.metadata, adminFulfillment: { ok: false, error: "approval_app_missing_scope" }, stuckWatch: { w2: { firstDetectedAt: resolvedAt, retryCount: 0 } } } } as ApprovalRequest;
    expect(evaluateW2Eligibility({ approval: a, policy, now: new Date() }).eligible).toBe(true);
  });
});
