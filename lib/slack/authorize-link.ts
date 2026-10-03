/**
 * SLACK_AUTHORIZE_LINK_ENABLED (default OFF) — employee Slack re-authorize link.
 *
 * Flow (all-tenant, generic):
 * 1. Admin MCP `setup.slackAuthorizeLink.issue` (always_human) → after human
 *    approval, issueSlackAuthorizeLink():
 *    - opens the approval-app DM with an approver (allowedUserIds of the org's
 *      Slack approval inbox; internal member only — #235 checks),
 *    - deliverTo "employee" (default): when the employee's Slack U… is exactly
 *      one (the pinned user), the same approval-app bot also opens a DM with
 *      that U… (same internal-member checks) and the link goes there; the
 *      approver gets 「社員本人（<@U…>）に再認可リンクを送りました」 (no URL).
 *      Zero / several candidates or an unopenable employee DM → approver
 *      delivery with the fallback reason recorded. deliverTo "approver" → as before,
 *    - pins the expected Slack team (and user, when known: existing identity or
 *      the employee's single allowed Slack account),
 *    - stores ONLY sha256(token) with a 24h expiry, supersedes older links,
 *    - posts the link to that DM (unfurl off). The URL is never returned to MCP.
 * 2. /api/slack/oauth/link?t=… (public, no session) → resolveAuthorizeLinkStart()
 *    → signed state {orgId, employeeId, nonce, linkId} + nonce cookie → Slack.
 *    Read-only: an unfurl / prefetch cannot burn the link.
 * 3. /api/slack/oauth/callback with a linkId state → completeAuthorizeLinkCallback():
 *    consume atomically (single use) → code exchange → auth.test → team / user
 *    must equal the pins (else reject, save nothing) → bind identity (existing
 *    allowedAccounts check still applies) → admin change log with the bound U…
 *    → approver is notified in the same approval-app DM. The caller then runs the
 *    existing #234 DM auto-route (SLACK_DM_AUTOROUTE_ENABLED).
 *    Every post-consume failure (AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS) keeps
 *    the link used, DMs the recipient authorizeLinkFailedNoticeJa(code) and —
 *    when the link went to the employee — the approver too
 *    (authorizeLinkApproverFailureNoticeJa); never the other account's U… / URL.
 *
 * Bot token: every approval-app post (link, approver notice, completion /
 * failure notice) gets its token from resolveApprovalAppBotToken() only.
 *
 * Secrets: the link token only appears in the approver DM text; tokens (link,
 * user, bot) never appear in results, audit metadata or logs.
 */
import { createHash, randomBytes } from "node:crypto";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { appendAuditEvent } from "@/lib/data/audit";
import { getEmployee } from "@/lib/data/employees";
import { getNotificationChannelSecretsById, listNotificationChannels } from "@/lib/data/notification-channels";
import {
  consumeSlackAuthorizeLink,
  createSlackAuthorizeLink,
  findLiveSlackAuthorizeLinkByHash,
  finishSlackAuthorizeLink,
  getSlackAuthorizeLink,
  type SlackAuthorizeLink,
} from "@/lib/data/slack-authorize-links";
import { bindEmployeeSlackIdentity, getEmployeeSlackIdentity } from "@/lib/data/slack-identities";
import { approvalInboxAllowedUsers, resolveSlackApprovalInbox } from "@/lib/admin-mcp/slack-dm-setup";
import { openApprovalDeliveryDm } from "@/lib/slack/approval-dm-open";
import {
  allowedSlackAccountIds,
  authorizeLinkApproverFailureNoticeJa,
  authorizeLinkFailedNoticeJa,
  isAuthorizeLinkConsumedFailureReason,
  resolveAllowedAccountsSlackNextStep,
  type AuthorizeLinkConsumedFailureReason,
} from "@/lib/slack/authorize-link-guidance";
import { isSlackAuthorizeLinkEnabled } from "@/lib/slack/authorize-link-flags";
import type { Employee } from "@/lib/types";

export const SLACK_AUTHORIZE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const SLACK_AUTHORIZE_LINK_PATH = "/api/slack/oauth/link";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;
const SLACK_TEAM_ID_RE = /^[TE][A-Z0-9]{2,30}$/;
const SLACK_TIMEOUT_MS = 5_000;

export {
  ALLOWED_ACCOUNTS_ADD_TOOL,
  ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_JA,
  ALLOWED_ACCOUNTS_SLACK_NEXT_STEP_TOOL_JA,
  AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS,
  authorizeLinkApproverFailureNoticeJa,
  authorizeLinkFailedNoticeJa,
  resolveAllowedAccountsSlackNextStep,
} from "@/lib/slack/authorize-link-guidance";

export const AUTHORIZE_LINK_DELIVER_TO = ["employee", "approver"] as const;
export type AuthorizeLinkDeliverTo = (typeof AUTHORIZE_LINK_DELIVER_TO)[number];
export const DEFAULT_AUTHORIZE_LINK_DELIVER_TO: AuthorizeLinkDeliverTo = "employee";

export function parseAuthorizeLinkDeliverTo(value: unknown): AuthorizeLinkDeliverTo | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return (AUTHORIZE_LINK_DELIVER_TO as readonly string[]).includes(raw) ? (raw as AuthorizeLinkDeliverTo) : null;
}

/**
 * THE approval-app bot token resolution (single place). Every approval-app post
 * of this flow — link DM to the employee or approver, the approver notice, the
 * completion / failure notices — gets its xoxb here: the org's Slack approval
 * inbox (notification channel) secret `botToken`. The shared approval app
 * (separate PR) stores its xoxb under the same key of the org's notification
 * channel secrets, so it plugs in here unchanged. Org-scoped (the channel must
 * be an enabled Slack channel of `orgId`), never throws, "" when unusable.
 */
export async function resolveApprovalAppBotToken(orgId: string, inboxId: string | null | undefined): Promise<string> {
  const id = (inboxId || "").trim();
  if (!orgId || !id) return "";
  try {
    const owned = (await listNotificationChannels(orgId)).some(
      (channel) => channel.id === id && channel.orgId === orgId && channel.provider === "slack" && channel.enabled
    );
    if (!owned) return "";
    const secrets = await getNotificationChannelSecretsById(orgId, id);
    const token = String(secrets?.botToken || "").trim();
    return token.startsWith("xoxb-") ? token : "";
  } catch {
    return "";
  }
}

export type AuthorizeLinkDeliveryChoice = {
  target: AuthorizeLinkDeliverTo;
  employeeUserId: string | null;
  requested: AuthorizeLinkDeliverTo;
  explicit: boolean;
  fallbackReason: "employee_slack_user_missing" | "employee_slack_user_ambiguous" | null;
};

/**
 * Where the link goes. "employee" only when the employee's Slack U… is exactly
 * one; zero / several → approver with the reason (defaulted or explicit alike).
 */
export function chooseAuthorizeLinkDelivery(input: {
  requested?: AuthorizeLinkDeliverTo | null;
  employeeSlackUserIds: string[];
}): AuthorizeLinkDeliveryChoice {
  const explicit = Boolean(input.requested);
  const requested = input.requested || DEFAULT_AUTHORIZE_LINK_DELIVER_TO;
  if (requested === "approver") return { target: "approver", employeeUserId: null, requested, explicit, fallbackReason: null };
  const candidates = [...new Set(input.employeeSlackUserIds.filter((id) => SLACK_USER_ID_RE.test(id)))];
  if (candidates.length === 1) return { target: "employee", employeeUserId: candidates[0], requested, explicit, fallbackReason: null };
  return {
    target: "approver",
    employeeUserId: null,
    requested,
    explicit,
    fallbackReason: candidates.length === 0 ? "employee_slack_user_missing" : "employee_slack_user_ambiguous",
  };
}

/** Employee U… candidates for employee delivery: the pinned user, else the allowed Slack accounts. */
export function employeeDeliveryCandidates(pins: AuthorizeLinkPins, employee: Employee): string[] {
  return pins.expectedSlackUserId ? [pins.expectedSlackUserId] : allowedSlackAccountIds(employee);
}

export function hashAuthorizeLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAuthorizeLinkToken(token) };
}

function linkUrl(token: string): string {
  return `${getAppOrigin()}${SLACK_AUTHORIZE_LINK_PATH}?t=${encodeURIComponent(token)}`;
}

function code(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_]{1,64}$/.test(raw) ? raw : fallback;
}

/** chat.postMessage as the approval app. Never throws; never returns the token. */
export async function postApprovalAppText(
  botToken: string,
  channelId: string,
  text: string
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!botToken || !/^D[A-Z0-9]{2,30}$/.test(channelId)) return { ok: false, code: "delivery_invalid" };
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: channelId, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const data = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return data.ok === true ? { ok: true } : { ok: false, code: code(data.error, "slack_error") };
  } catch {
    return { ok: false, code: "network_error" };
  }
}

export type AuthorizeLinkPins = {
  expectedSlackUserId: string | null;
  /** null → use the approval app's workspace team (resolved when the DM is opened). */
  expectedTeamId: string | null;
  linked: boolean;
};

export type PinsResult =
  | ({ ok: true } & AuthorizeLinkPins)
  | { ok: false; code: string; messageJa: string; nextStepJa?: string; allowedAccountsAdminTool?: string | null };

/**
 * Anti-takeover pins. Existing identity → its U… and T…. Otherwise the single
 * Slack account in allowedAccounts (team from the approval app). Several
 * allowed accounts → team only (bind still checks allowedAccounts). None →
 * refuse (binding would be rejected by the allowedAccounts check anyway).
 */
export async function authorizeLinkPins(orgId: string, employee: Employee): Promise<PinsResult> {
  const identity = await getEmployeeSlackIdentity(employee.id);
  const allowed = allowedSlackAccountIds(employee);
  if (identity && identity.orgId === orgId && identity.status !== "revoked" && SLACK_USER_ID_RE.test(identity.slackUserId)) {
    const team = SLACK_TEAM_ID_RE.test(identity.slackTeamId) ? identity.slackTeamId : null;
    return { ok: true, expectedSlackUserId: identity.slackUserId, expectedTeamId: team, linked: identity.status === "linked" };
  }
  if (allowed.length === 0) {
    const step = await resolveAllowedAccountsSlackNextStep();
    return {
      ok: false,
      code: "slack_account_not_allowed",
      messageJa: `この AI 社員には許可された Slack アカウント（allowedAccounts の slack U…）がありません。${step.nextStepJa}`,
      nextStepJa: step.nextStepJa,
      allowedAccountsAdminTool: step.allowedAccountsAdminTool,
    };
  }
  return { ok: true, expectedSlackUserId: allowed.length === 1 ? allowed[0] : null, expectedTeamId: null, linked: false };
}

export type IssueAuthorizeLinkResult =
  | {
      ok: true;
      linkId: string;
      employeeId: string;
      expiresAt: string;
      deliveredTo: {
        inboxId: string;
        channelKind: "dm";
        /** Who actually received the link. */
        target: AuthorizeLinkDeliverTo;
        deliveryUserId: string;
        approverUserId: string;
        requested: AuthorizeLinkDeliverTo;
        explicit: boolean;
        fallbackReason: string | null;
        /** employee delivery: 「社員本人に送りました」 posted to the approver. */
        approverNoticeSent: boolean;
      };
      pinned: { slackUserId: string | null; teamId: string };
    }
  | { ok: false; code: string; messageJa: string; missingScope?: string; nextStepJa?: string };

/** Issue + deliver. Org comes from the caller (credential / approval row). */
export async function issueSlackAuthorizeLink(input: {
  orgId: string;
  employeeId: string;
  inboxId?: string;
  deliveryUserId?: string;
  approvalId: string | null;
  via: "ticket" | "audit_only";
  actor?: { adminAgentId?: string | null; grokBotAgentId?: string | null };
  /** The pinned user the human approved (ticket). Different now → fail closed. */
  approvedExpectedSlackUserId?: string | null;
  /** Explicit deliverTo; omitted → "employee" (default, falls back to approver). */
  deliverTo?: AuthorizeLinkDeliverTo | null;
  now?: number;
}): Promise<IssueAuthorizeLinkResult> {
  const { orgId } = input;
  const failed = async (result: Extract<IssueAuthorizeLinkResult, { ok: false }>) => {
    await appendAuditEvent({
      orgId,
      employeeId: input.employeeId || null,
      credentialId: null,
      action: "admin.link",
      purpose: "admin.link",
      summary: `Slack 再認可リンクの発行を中止（${result.code}）`,
      metadata: { auditClass: "admin", event: "slack_authorize_link.issue_failed", approvalId: input.approvalId, code: result.code },
    }).catch(() => undefined);
    return result;
  };
  if (!isSlackAuthorizeLinkEnabled()) {
    return failed({ ok: false, code: "authorize_link_flag_off", messageJa: "SLACK_AUTHORIZE_LINK_ENABLED が OFF です。" });
  }
  const employee = await getEmployee(input.employeeId, orgId);
  if (!employee || employee.orgId !== orgId) {
    return failed({ ok: false, code: "employee_not_found", messageJa: "この組織の AI 社員ではありません。" });
  }
  const pins = await authorizeLinkPins(orgId, employee);
  if (!pins.ok) return failed(pins);
  if (input.approvedExpectedSlackUserId !== undefined && input.approvedExpectedSlackUserId !== pins.expectedSlackUserId) {
    return failed({
      ok: false,
      code: "pins_changed",
      messageJa: "承認後に社員の Slack 連携先が変わりました。リンクは発行していません。もう一度発行を依頼してください。",
    });
  }
  const inbox = await resolveSlackApprovalInbox(orgId, (input.inboxId || "").trim());
  if ("kind" in inbox) return failed({ ok: false, code: "inbox_not_found", messageJa: "有効な Slack 承認口が見つかりません。" });
  if (inbox.orgId !== orgId) return failed({ ok: false, code: "inbox_not_found", messageJa: "有効な Slack 承認口が見つかりません。" });
  const botToken = inbox.hasCredentials ? await resolveApprovalAppBotToken(orgId, inbox.id) : "";
  const opened = await openApprovalDeliveryDm({
    botToken,
    allowedUserIds: approvalInboxAllowedUsers(inbox),
    deliveryUserId: input.deliveryUserId || null,
  });
  if (!opened.ok) {
    return failed({ ok: false, code: opened.code, messageJa: opened.messageJa, ...(opened.missingScope ? { missingScope: opened.missingScope } : {}) });
  }
  const teamId = pins.expectedTeamId ?? opened.teamId;
  if (!SLACK_TEAM_ID_RE.test(teamId) || teamId !== opened.teamId) {
    // The approval app and the employee identity live in different workspaces:
    // we cannot vouch for the pin → fail closed.
    return failed({
      ok: false,
      code: "team_mismatch",
      messageJa: "承認アプリのワークスペースと社員の Slack ワークスペースが一致しません。リンクは発行していません。",
    });
  }
  // Delivery target (default employee). The employee DM goes through the same
  // approval-app bot and the same internal-member checks as the approver DM.
  const choice = chooseAuthorizeLinkDelivery({
    requested: input.deliverTo ?? null,
    employeeSlackUserIds: employeeDeliveryCandidates(pins, employee),
  });
  let target: AuthorizeLinkDeliverTo = choice.target;
  let fallbackReason: string | null = choice.fallbackReason;
  let employeeDmError: string | null = null;
  let recipient = { channelId: opened.channelId, userId: opened.userId };
  if (choice.target === "employee" && choice.employeeUserId) {
    const employeeDm = await openApprovalDeliveryDm({
      botToken,
      allowedUserIds: [choice.employeeUserId],
      deliveryUserId: choice.employeeUserId,
    });
    if (employeeDm.ok && employeeDm.teamId === teamId && employeeDm.userId === choice.employeeUserId) {
      recipient = { channelId: employeeDm.channelId, userId: employeeDm.userId };
    } else {
      target = "approver";
      fallbackReason = "employee_dm_unavailable";
      employeeDmError = employeeDm.ok ? "team_mismatch" : employeeDm.code;
    }
  }
  const { token, tokenHash } = newLinkToken();
  const expiresAt = new Date((input.now ?? Date.now()) + SLACK_AUTHORIZE_LINK_TTL_MS).toISOString();
  const link = await createSlackAuthorizeLink({
    orgId,
    employeeId: employee.id,
    tokenHash,
    expectedSlackUserId: pins.expectedSlackUserId,
    expectedTeamId: teamId,
    expiresAt,
    deliveredInboxId: inbox.id,
    deliveredChannelId: recipient.channelId,
    deliveredUserId: recipient.userId,
    deliveredTarget: target,
    approverChannelId: opened.channelId,
    approverUserId: opened.userId,
    approvalId: input.approvalId,
    issuedVia: input.via,
  });
  const who =
    target === "employee"
      ? "この Slack アカウント（社員本人）"
      : pins.expectedSlackUserId
        ? `Slack ユーザー ${pins.expectedSlackUserId}`
        : "社員本人の Slack アカウント";
  const text =
    `🔐 StaffPass: AI社員「${employee.displayName}」の Slack 再認可リンクです（24時間・1回だけ有効）。\n` +
    `${who}でログインしたブラウザで開き、「許可する」を押してください。別のアカウントでは連携されません。\n` +
    `${linkUrl(token)}\n` +
    `心当たりがない場合は開かずに無視してください（期限が切れると使えなくなります）。`;
  const posted = await postApprovalAppText(botToken, recipient.channelId, text);
  if (!posted.ok) {
    await finishSlackAuthorizeLink({ id: link.id, orgId, status: "revoked", reason: "delivery_failed" });
    return failed({ ok: false, code: "delivery_failed", messageJa: `承認アプリの DM にリンクを送れませんでした（${posted.code}）。リンクは無効化しました。` });
  }
  // Employee delivery: tell the approver where it went (never the URL). Best effort.
  let approverNoticeSent = false;
  if (target === "employee" && opened.channelId !== recipient.channelId) {
    const notice = await postApprovalAppText(
      botToken,
      opened.channelId,
      `📨 StaffPass: AI社員「${employee.displayName}」の社員本人（<@${recipient.userId}>）に再認可リンクを送りました` +
        `（24時間・1回限り。URL はここには載せません）。連携が完了するとこの DM でお知らせします。`
    );
    approverNoticeSent = notice.ok;
  }
  await appendAuditEvent({
    orgId,
    employeeId: employee.id,
    credentialId: null,
    action: "admin.link",
    purpose: "admin.link",
    summary:
      `Slack 再認可リンクを発行し、承認アプリの DM で${target === "employee" ? "社員本人" : "承認者"} ${recipient.userId} に送信` +
      `${fallbackReason ? `（社員本人に送れないため承認者へ: ${fallbackReason}）` : ""}（24時間・1回限り・` +
      `${pins.expectedSlackUserId ? `Slack ${pins.expectedSlackUserId} / ` : ""}team ${teamId} に固定${input.via === "audit_only" ? "・承認省略（監査のみ）" : ""}）`,
    metadata: {
      auditClass: "admin",
      event: "slack_authorize_link.issued",
      linkId: link.id,
      approvalId: input.approvalId,
      issuedVia: input.via,
      deliveredInboxId: inbox.id,
      deliveredChannelId: recipient.channelId,
      deliveredUserId: recipient.userId,
      deliveredTarget: target,
      deliverToRequested: choice.requested,
      deliverToExplicit: choice.explicit,
      deliveryFallbackReason: fallbackReason,
      employeeDmError,
      approverUserId: opened.userId,
      approverChannelId: opened.channelId,
      approverNoticeSent,
      expectedSlackUserId: pins.expectedSlackUserId,
      expectedTeamId: teamId,
      expiresAt,
      adminAgentId: input.actor?.adminAgentId ?? null,
      grokBotAgentId: input.actor?.grokBotAgentId ?? null,
    },
  });
  return {
    ok: true,
    linkId: link.id,
    employeeId: employee.id,
    expiresAt,
    deliveredTo: {
      inboxId: inbox.id,
      channelKind: "dm",
      target,
      deliveryUserId: recipient.userId,
      approverUserId: opened.userId,
      requested: choice.requested,
      explicit: choice.explicit,
      fallbackReason,
      approverNoticeSent,
    },
    pinned: { slackUserId: pins.expectedSlackUserId, teamId },
  };
}

// ---------------------------------------------------------------------------
// Link start (public route)
// ---------------------------------------------------------------------------

export type AuthorizeLinkStart =
  | { ok: true; linkId: string; orgId: string; employeeId: string; expectedTeamId: string }
  | { ok: false; code: "authorize_link_flag_off" | "invalid_link" };

/** Read-only: validates the token; never consumes (unfurl / prefetch safe). */
export async function resolveAuthorizeLinkStart(token: string): Promise<AuthorizeLinkStart> {
  if (!isSlackAuthorizeLinkEnabled()) return { ok: false, code: "authorize_link_flag_off" };
  const raw = (token || "").trim();
  if (!TOKEN_RE.test(raw)) return { ok: false, code: "invalid_link" };
  const link = await findLiveSlackAuthorizeLinkByHash(hashAuthorizeLinkToken(raw));
  if (!link) return { ok: false, code: "invalid_link" };
  const employee = await getEmployee(link.employeeId, link.orgId);
  if (!employee || employee.orgId !== link.orgId) return { ok: false, code: "invalid_link" };
  return { ok: true, linkId: link.id, orgId: link.orgId, employeeId: link.employeeId, expectedTeamId: link.expectedTeamId };
}

// ---------------------------------------------------------------------------
// Callback (link branch)
// ---------------------------------------------------------------------------

export type SlackOAuthExchange = {
  ok?: boolean;
  authed_user?: { id?: string; access_token?: string; token?: string };
  team?: { id?: string; name?: string };
};
export type SlackAuthTestIdentity = { ok?: boolean; user_id?: string; user?: string; team_id?: string };

export type AuthorizeLinkCallbackResult =
  | { ok: true; orgId: string; employeeId: string; slackUserId: string }
  | { ok: false; code: string; consumed: boolean };

function linkIsLive(link: SlackAuthorizeLink | null, now = Date.now()): boolean {
  return Boolean(link && link.status === "issued" && Date.parse(link.expiresAt) > now);
}

export async function completeAuthorizeLinkCallback(input: {
  state: { orgId: string; employeeId: string; linkId: string };
  code: string;
  oauthError: string;
  exchange: (code: string) => Promise<SlackOAuthExchange>;
  authTest: (userToken: string) => Promise<SlackAuthTestIdentity>;
}): Promise<AuthorizeLinkCallbackResult> {
  const { orgId, employeeId, linkId } = input.state;
  if (!isSlackAuthorizeLinkEnabled()) return { ok: false, code: "authorize_link_flag_off", consumed: false };
  // Cancel / missing code: keep the link usable (same browser can retry).
  if (input.oauthError || !input.code) {
    const link = await getSlackAuthorizeLink(linkId, orgId);
    if (!linkIsLive(link) || link!.employeeId !== employeeId) return { ok: false, code: "invalid_link", consumed: false };
    return { ok: false, code: input.oauthError === "access_denied" ? "denied" : "oauth_error", consumed: false };
  }
  const link = await consumeSlackAuthorizeLink({ id: linkId, orgId, employeeId });
  if (!link) return { ok: false, code: "invalid_link", consumed: false };

  // Every exit below is post-consume: the link stays used, so every one notifies.
  const reject = async (
    reason: AuthorizeLinkConsumedFailureReason,
    extra: Record<string, unknown> = {}
  ): Promise<AuthorizeLinkCallbackResult> => {
    await finishSlackAuthorizeLink({ id: link.id, orgId, status: "rejected", reason });
    // Tell the recipient (and the approver for employee delivery) that it is
    // void — never the other U… / URL. Best effort: never changes the response.
    const notices = await sendAuthorizeLinkFailureNotices(link, reason).catch(() => ({
      recipientSent: false,
      approverSent: false,
      approverSkipped: null as string | null,
    }));
    const failureNotice: Record<string, unknown> = {
      failureNoticeSent: notices.recipientSent,
      failureNoticeTarget: link.deliveredTarget,
      approverFailureNoticeSent: notices.approverSent,
      ...(notices.approverSkipped ? { approverFailureNoticeSkipped: notices.approverSkipped } : {}),
    };
    await appendAuditEvent({
      orgId,
      employeeId,
      credentialId: null,
      action: "admin.link",
      purpose: "admin.link",
      summary: `Slack 再認可リンクでの連携を拒否（${reason}）。何も保存していません`,
      metadata: { auditClass: "admin", event: "slack_authorize_link.rejected", linkId: link.id, reason, ...extra, ...failureNotice },
    }).catch(() => undefined);
    return { ok: false, code: reason, consumed: true };
  };

  let exchanged: SlackOAuthExchange;
  try {
    exchanged = await input.exchange(input.code);
  } catch {
    return reject("oauth_exchange_failed");
  }
  if (!exchanged?.ok) return reject("oauth_exchange_failed");
  const userToken = String(exchanged.authed_user?.access_token || exchanged.authed_user?.token || "").trim();
  if (!userToken || userToken.startsWith("xoxb-")) return reject("user_token_missing");
  let identity: SlackAuthTestIdentity;
  try {
    identity = await input.authTest(userToken);
  } catch {
    return reject("auth_test_failed");
  }
  const slackUserId = String(identity?.user_id || "").trim();
  const teamId = String(identity?.team_id || "").trim();
  if (!identity?.ok || !SLACK_USER_ID_RE.test(slackUserId) || !SLACK_TEAM_ID_RE.test(teamId)) return reject("auth_test_failed");
  if (teamId !== link.expectedTeamId) {
    return reject("team_mismatch", { expectedTeamId: link.expectedTeamId, attemptedTeamId: teamId });
  }
  if (link.expectedSlackUserId && slackUserId !== link.expectedSlackUserId) {
    return reject("user_mismatch", { expectedSlackUserId: link.expectedSlackUserId, attemptedSlackUserId: slackUserId });
  }
  // Audit-only context; a lookup failure must not strand the consumed link.
  const previous = await getEmployeeSlackIdentity(employeeId).catch(() => null);
  try {
    await bindEmployeeSlackIdentity({
      employeeId,
      orgId,
      slackUserId,
      slackTeamId: teamId,
      displayName: String(identity.user || "").trim(),
      userToken,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return reject(message === "slack_identity_mismatch" ? "allowed_accounts_mismatch" : "bind_failed", {
      attemptedSlackUserId: slackUserId,
    });
  }
  await finishSlackAuthorizeLink({ id: link.id, orgId, status: "completed", reason: "ok", boundSlackUserId: slackUserId });
  const employee = await getEmployee(employeeId, orgId);
  const name = employee?.displayName || employeeId;
  const wasPinned = Boolean(link.expectedSlackUserId);
  await appendAuditEvent({
    orgId,
    employeeId,
    credentialId: null,
    action: "admin.link",
    purpose: "admin.link",
    summary: `AI社員「${name}」の Slack 連携が再認可リンクで完了（Slack ${slackUserId} / team ${teamId}${wasPinned ? "" : "・発行時はユーザー未固定"}）`,
    metadata: {
      auditClass: "admin",
      event: "slack_authorize_link.completed",
      linkId: link.id,
      approvalId: link.approvalId,
      boundSlackUserId: slackUserId,
      teamId,
      userPinnedAtIssue: wasPinned,
      previousSlackUserId: previous && previous.orgId === orgId ? previous.slackUserId || null : null,
    },
  });
  // Notify the approver in the approval-app DM (best effort, never throws).
  const approverChannel = link.approverChannelId || link.deliveredChannelId;
  if (link.deliveredInboxId && approverChannel) {
    const botToken = await resolveApprovalAppBotToken(orgId, link.deliveredInboxId);
    if (botToken) {
      await postApprovalAppText(
        botToken,
        approverChannel,
        `✅ StaffPass: AI社員「${name}」の Slack 連携が完了しました（Slack ユーザー ${slackUserId}）。` +
          `心当たりがない場合は、ダッシュボードの社員ページで Slack 連携を解除してください。`
      );
    }
  }
  return { ok: true, orgId, employeeId, slackUserId };
}

/**
 * Failure DMs for a burned link. Never throws.
 * - recipient (employee or approver, `delivered_channel_id`): authorizeLinkFailedNoticeJa(code)
 * - approver (only when the link went to the employee): authorizeLinkApproverFailureNoticeJa(name, code)
 *   → an approver-delivered link gets exactly one notice (no duplicate).
 */
async function sendAuthorizeLinkFailureNotices(
  link: SlackAuthorizeLink,
  reason: AuthorizeLinkConsumedFailureReason
): Promise<{ recipientSent: boolean; approverSent: boolean; approverSkipped: string | null }> {
  const result = { recipientSent: false, approverSent: false, approverSkipped: null as string | null };
  try {
    const approverChannel =
      link.deliveredTarget === "employee" && link.approverChannelId && link.approverChannelId !== link.deliveredChannelId
        ? link.approverChannelId
        : null;
    if (!approverChannel) {
      result.approverSkipped = link.deliveredTarget === "employee" ? "approver_channel_unknown" : "delivered_to_approver";
    }
    if (!link.deliveredInboxId) return result;
    const botToken = await resolveApprovalAppBotToken(link.orgId, link.deliveredInboxId);
    if (!botToken) return result;
    const employee = await getEmployee(link.employeeId, link.orgId).catch(() => null);
    const name = employee && employee.orgId === link.orgId ? employee.displayName : "";
    if (link.deliveredChannelId) {
      const posted = await postApprovalAppText(
        botToken,
        link.deliveredChannelId,
        `⚠️ StaffPass${name ? `（AI社員「${name}」）` : ""}: ${authorizeLinkFailedNoticeJa(reason)}`
      );
      result.recipientSent = posted.ok;
    }
    if (approverChannel) {
      const posted = await postApprovalAppText(
        botToken,
        approverChannel,
        `⚠️ StaffPass: ${authorizeLinkApproverFailureNoticeJa(name || link.employeeId, reason)}`
      );
      result.approverSent = posted.ok;
    }
    return result;
  } catch {
    return result;
  }
}

export type AuthorizeLinkPageKind = "ok" | "denied" | "burned" | "invalid" | "error";

/** Callback result code → result page kind (every consumed failure → "burned"). */
export function authorizeLinkPageKind(code: string): Exclude<AuthorizeLinkPageKind, "ok"> {
  if (code === "denied") return "denied";
  if (isAuthorizeLinkConsumedFailureReason(code)) return "burned";
  if (code === "invalid_link" || code === "authorize_link_flag_off") return "invalid";
  return "error";
}

/**
 * Minimal result page for the link flow (the clicker may have no Staffpass
 * session). "burned" uses the same template as the DM; only the code varies.
 */
export function authorizeLinkResultHtml(kind: AuthorizeLinkPageKind, code?: string): string {
  const messages: Record<typeof kind, string> = {
    ok: "Slack 連携が完了しました。このタブを閉じてください。",
    denied: "許可がキャンセルされました。もう一度リンクを開くとやり直せます。",
    burned: authorizeLinkFailedNoticeJa(code),
    invalid: "このリンクは無効か、期限切れ・使用済みです。承認者に再発行を依頼してください。",
    error: "Slack 連携を完了できませんでした。承認者に再発行を依頼してください。",
  };
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>StaffPass</title></head><body><p>${messages[kind]}</p></body></html>`;
}

export function authorizeLinkHtmlResponse(kind: AuthorizeLinkPageKind, status = 200, code?: string): Response {
  return new Response(authorizeLinkResultHtml(kind, code), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'",
      "x-robots-tag": "noindex",
    },
  });
}
