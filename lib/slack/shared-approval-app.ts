/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED (default OFF) — Staffpass-wide approval app
 * 「Staffpass承認」 (one distributable Slack app for every tenant).
 *
 * Kept apart from the employee app (App A): different client / signing secret /
 * env names, so approval-path (xoxb of this app) and conversation-path tokens
 * never mix. Per-tenant approval apps keep working unchanged in parallel.
 *
 * Install ("Add to Slack"):
 * - Starts only from an owner/admin session. State = HMAC(shared client secret)
 *   over { orgId, nonce, purpose, exp }, nonce cookie, single use
 *   (slack_oauth_state_uses), 10 min.
 * - Callback requires the same org's owner/admin session again.
 * - Refuses (fail-closed, nothing saved, token revoked):
 *   Enterprise Grid org-wide install / no team, a non-bot token, a different
 *   app_id, auth.test team ≠ oauth team, a workspace already bound to ANOTHER
 *   org (that org's binding is left unchanged), a workspace different from the
 *   one this org already uses.
 * - Saves xoxb (encrypted) into this org's Slack notification channel secrets
 *   under the usual `botToken` key, config.sharedApprovalApp=true. No signing
 *   secret is stored per inbox: requests are verified with the env secret only.
 *
 * Tokens / secrets are never logged, audited or returned.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { appendAuditEvent } from "@/lib/data/audit";
import { findSlackConversationAdaptersByTeam, listConversationAdapters } from "@/lib/data/conversation-adapters";
import {
  findSlackNotificationChannelsByTeam,
  isSharedApprovalAppChannelConfig,
  listNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import type { NotificationChannel } from "@/lib/types";

import { isSharedApprovalAppEnabled } from "@/lib/slack/shared-approval-flags";

export { isSharedApprovalAppEnabled };

export const SHARED_APPROVAL_APP_NAME = "Staffpass承認";
export const SHARED_APPROVAL_APP_BOT_SCOPES = "chat:write,im:write,im:read,users:read";
export const SHARED_APPROVAL_INSTALL_COOKIE = "staffpass_slack_shared_approval_install";
export const SHARED_APPROVAL_INSTALL_START_PATH = "/api/slack/approval-app/install/start";
export const SHARED_APPROVAL_CALLBACK_PATH = "/api/slack/approval-app/callback";
export const SHARED_APPROVAL_EVENTS_PATH = "/api/webhooks/slack/approval-app/events";
export const SHARED_APPROVAL_INTERACTIVITY_PATH = "/api/webhooks/slack/interactivity";
export const SHARED_APPROVAL_STATE_PURPOSE = "shared_approval_install";
export const SHARED_APPROVAL_STATE_TTL_MS = 10 * 60 * 1000;

const APP_ID_RE = /^A[A-Z0-9]{2,30}$/;
const TEAM_ID_RE = /^T[A-Z0-9]{2,30}$/;

export type SharedApprovalAppConfig = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
};

/** All four env values, or null (unconfigured → every entry point refuses). */
export function sharedApprovalAppConfig(): SharedApprovalAppConfig | null {
  const appId = process.env.SLACK_SHARED_APPROVAL_APP_ID?.trim() || "";
  const clientId = process.env.SLACK_SHARED_APPROVAL_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.SLACK_SHARED_APPROVAL_CLIENT_SECRET?.trim() || "";
  const signingSecret = process.env.SLACK_SHARED_APPROVAL_SIGNING_SECRET?.trim() || "";
  if (!APP_ID_RE.test(appId) || !clientId || !clientSecret || !signingSecret) return null;
  return { appId, clientId, clientSecret, signingSecret };
}

export function sharedApprovalRedirectUrl(): string {
  return `${getAppOrigin()}${SHARED_APPROVAL_CALLBACK_PATH}`;
}

export function sharedApprovalInstallStartUrl(): string {
  return `${getAppOrigin()}${SHARED_APPROVAL_INSTALL_START_PATH}`;
}

// ---------------------------------------------------------------------------
// Signed state
// ---------------------------------------------------------------------------

export type SharedApprovalInstallState = {
  orgId: string;
  nonce: string;
  purpose: typeof SHARED_APPROVAL_STATE_PURPOSE;
  exp: number;
};

function hmac(secret: string, encoded: string): string {
  // Domain-separated from every other Slack state (different key AND prefix).
  return createHmac("sha256", secret).update(`staffpass:${SHARED_APPROVAL_STATE_PURPOSE}:${encoded}`).digest("base64url");
}

export function signSharedApprovalInstallState(input: { orgId: string; nonce: string; now?: number }): string {
  const config = sharedApprovalAppConfig();
  if (!config) throw new Error("shared_approval_app_unconfigured");
  const payload: SharedApprovalInstallState = {
    orgId: input.orgId,
    nonce: input.nonce,
    purpose: SHARED_APPROVAL_STATE_PURPOSE,
    exp: (input.now ?? Date.now()) + SHARED_APPROVAL_STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(config.clientSecret, encoded)}`;
}

export function verifySharedApprovalInstallState(
  state: string,
  nonce: string,
  now = Date.now()
): SharedApprovalInstallState | null {
  const config = sharedApprovalAppConfig();
  if (!config || !state || !nonce) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  const a = Buffer.from(state.slice(dot + 1));
  const b = Buffer.from(hmac(config.clientSecret, encoded));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SharedApprovalInstallState;
    if (!parsed?.orgId || !parsed?.nonce || parsed.purpose !== SHARED_APPROVAL_STATE_PURPOSE) return null;
    if (parsed.nonce !== nonce) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp < now) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sharedApprovalAuthorizeUrl(state: string, opts: { teamId?: string | null } = {}): string {
  const config = sharedApprovalAppConfig();
  const params = new URLSearchParams({
    client_id: config?.clientId || "",
    scope: SHARED_APPROVAL_APP_BOT_SCOPES,
    redirect_uri: sharedApprovalRedirectUrl(),
    state,
  });
  const team = (opts.teamId || "").trim();
  if (TEAM_ID_RE.test(team)) params.set("team", team);
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Messages (result page + MCP results use the same text)
// ---------------------------------------------------------------------------

export const SHARED_APPROVAL_INSTALL_MESSAGES: Record<string, string> = {
  installed: "Staffpass承認 を Slack に追加しました。次に承認する人の Slack ID を設定します（管理AI社員の setup.slackApprover.set → 人の承認 1 回）。",
  team_bound_to_other_org: "このSlackワークスペースは別の組織に接続済みです。運営に連絡してください。",
  enterprise_install_not_supported:
    "Enterprise Grid の組織全体へのインストールには対応していません。ワークスペースを 1 つ選んでインストールしてください（分からないときは運営に連絡してください）。",
  team_mismatch_org:
    "この組織がすでに使っている Slack ワークスペースと違うワークスペースです。いつもの Slack ワークスペースでやり直してください（変える場合は運営に連絡してください）。",
  not_bot_token: "Slack から Bot token が返りませんでした。もう一度やり直してください。",
  app_mismatch: "別の Slack アプリの許可が返ってきました。もう一度やり直してください。",
  auth_failed: "Slack でトークンを確認できませんでした。もう一度やり直してください。",
  exchange_failed: "Slack との接続に失敗しました。もう一度やり直してください。",
  denied: "Slack でインストールがキャンセルされました。",
  state_invalid: "時間切れか、別の画面から開かれました。設定画面からもう一度やり直してください。",
  state_reused: "このインストール画面はすでに使われています。設定画面からもう一度やり直してください。",
  session_mismatch: "Staffpass にこの組織の管理者としてログインした状態でやり直してください。",
  flag_off: "共通承認アプリはまだ有効になっていません（運営の設定待ち）。",
  unconfigured: "共通承認アプリの設定が運営側でまだ完了していません。運営に連絡してください。",
  lookup_failed: "確認中にエラーが起きたため、安全のため保存しませんでした。もう一度やり直してください。",
  save_failed: "保存に失敗しました。もう一度やり直してください。",
};

export function sharedApprovalMessage(code: string): string {
  return SHARED_APPROVAL_INSTALL_MESSAGES[code] || SHARED_APPROVAL_INSTALL_MESSAGES.exchange_failed;
}

// ---------------------------------------------------------------------------
// Slack API (injectable for tests)
// ---------------------------------------------------------------------------

export type SlackOAuthV2Access = {
  ok?: boolean;
  error?: string;
  app_id?: string;
  access_token?: string;
  token_type?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string } | null;
  enterprise?: { id?: string; name?: string } | null;
  is_enterprise_install?: boolean;
};

export type SlackAuthTestResult = { ok?: boolean; team_id?: string; team?: string; user_id?: string; bot_id?: string };

export type SharedApprovalSlackDeps = {
  exchange?: (code: string) => Promise<SlackOAuthV2Access>;
  authTest?: (token: string) => Promise<SlackAuthTestResult>;
  revoke?: (token: string) => Promise<void>;
};

async function defaultExchange(code: string): Promise<SlackOAuthV2Access> {
  const config = sharedApprovalAppConfig();
  if (!config) return { ok: false, error: "unconfigured" };
  try {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: sharedApprovalRedirectUrl(),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return ((await response.json().catch(() => ({}))) ?? {}) as SlackOAuthV2Access;
  } catch {
    return { ok: false, error: "network_error" };
  }
}

async function bearerCall(token: string, method: "auth.test" | "auth.revoke"): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    return ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Team binding (anti cross-org)
// ---------------------------------------------------------------------------

function pinnedTeams(config: Record<string, unknown>): string[] {
  return [config.teamId, config.expectedTeamId]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => TEAM_ID_RE.test(value));
}

export type TeamBindingCheck =
  | { ok: true; existingSharedInbox: NotificationChannel | null }
  | { ok: false; code: "team_bound_to_other_org" | "team_mismatch_org" | "lookup_failed" };

/**
 * A workspace may serve only one org. Another org's Slack inbox (any app, enabled
 * or not) or Slack conversation adapter pinned to `teamId` → refuse; that binding
 * is never touched. This org's own Slack inboxes / adapters pinned to a
 * DIFFERENT team → refuse (a re-install cannot move the org to another workspace).
 */
export async function checkSharedApprovalTeamBinding(input: {
  orgId: string;
  teamId: string;
  appId: string;
}): Promise<TeamBindingCheck> {
  try {
    const [channelsForTeam, adaptersForTeam, ownChannels, ownAdapters] = await Promise.all([
      findSlackNotificationChannelsByTeam(input.teamId),
      findSlackConversationAdaptersByTeam(input.teamId),
      listNotificationChannels(input.orgId),
      listConversationAdapters(input.orgId),
    ]);
    if (
      channelsForTeam.some((row) => row.orgId !== input.orgId) ||
      adaptersForTeam.some((row) => row.orgId !== input.orgId)
    ) {
      return { ok: false, code: "team_bound_to_other_org" };
    }
    const ownSlack = ownChannels.filter((row) => row.provider === "slack" && row.orgId === input.orgId);
    const ownTeams = new Set<string>([
      ...ownSlack.flatMap((row) => pinnedTeams(row.config || {})),
      ...ownAdapters
        .filter((row) => row.surface === "slack" && row.orgId === input.orgId)
        .flatMap((row) => pinnedTeams(row.config || {})),
    ]);
    if ([...ownTeams].some((team) => team !== input.teamId)) {
      return { ok: false, code: "team_mismatch_org" };
    }
    const existingSharedInbox =
      ownSlack.find(
        (row) => isSharedApprovalAppChannelConfig(row.config) && String(row.config.apiAppId || "") === input.appId
      ) ?? null;
    return { ok: true, existingSharedInbox };
  } catch {
    return { ok: false, code: "lookup_failed" };
  }
}

/** Team this org is already known to use (for the authorize `team=` hint), or null. */
export async function knownOrgSlackTeam(orgId: string): Promise<string | null> {
  try {
    const [channels, adapters] = await Promise.all([listNotificationChannels(orgId), listConversationAdapters(orgId)]);
    const teams = new Set<string>([
      ...channels.filter((row) => row.provider === "slack").flatMap((row) => pinnedTeams(row.config || {})),
      ...adapters.filter((row) => row.surface === "slack").flatMap((row) => pinnedTeams(row.config || {})),
    ]);
    return teams.size === 1 ? [...teams][0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Callback core
// ---------------------------------------------------------------------------

export type SharedApprovalInstallResult =
  | { ok: true; code: "installed"; messageJa: string; teamId: string; teamName: string; inboxId: string; reinstall: boolean }
  | { ok: false; code: string; messageJa: string };

async function auditInstall(orgId: string, actorEmail: string | null, ok: boolean, metadata: Record<string, unknown>, summary: string) {
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    actorEmail: actorEmail || "slack_shared_approval_install",
    action: "admin.notificationChannel",
    purpose: "admin.notificationChannel",
    summary,
    metadata: {
      auditClass: "admin",
      event: ok ? "shared_approval_app.installed" : "shared_approval_app.install_rejected",
      ...metadata,
    },
  }).catch(() => undefined);
}

/**
 * Exchange → validate → bind. orgId comes ONLY from the verified state (and the
 * route has re-checked the admin session for that org). Never throws.
 */
export async function completeSharedApprovalInstall(input: {
  orgId: string;
  code: string;
  actorEmail?: string | null;
  deps?: SharedApprovalSlackDeps;
}): Promise<SharedApprovalInstallResult> {
  const fail = async (code: string, extra: Record<string, unknown> = {}): Promise<SharedApprovalInstallResult> => {
    await auditInstall(input.orgId, input.actorEmail ?? null, false, { code, ...extra }, `共通承認アプリ「${SHARED_APPROVAL_APP_NAME}」のインストールを拒否（${code}）`);
    return { ok: false, code, messageJa: sharedApprovalMessage(code) };
  };
  if (!isSharedApprovalAppEnabled()) return { ok: false, code: "flag_off", messageJa: sharedApprovalMessage("flag_off") };
  const config = sharedApprovalAppConfig();
  if (!config) return fail("unconfigured");
  const exchange = input.deps?.exchange ?? defaultExchange;
  const authTest = input.deps?.authTest ?? ((token: string) => bearerCall(token, "auth.test") as Promise<SlackAuthTestResult>);
  const revoke = input.deps?.revoke ?? (async (token: string) => void (await bearerCall(token, "auth.revoke")));

  let exchanged: SlackOAuthV2Access;
  try {
    exchanged = await exchange(input.code);
  } catch {
    return fail("exchange_failed");
  }
  if (!exchanged || exchanged.ok !== true) return fail("exchange_failed");
  const token = String(exchanged.access_token || "").trim();
  // Never leave a refused token valid.
  const refuse = async (code: string, extra: Record<string, unknown> = {}) => {
    if (token) await revoke(token).catch(() => undefined);
    return fail(code, extra);
  };
  const teamId = String(exchanged.team?.id || "").trim();
  if (exchanged.is_enterprise_install === true || !teamId) {
    return refuse("enterprise_install_not_supported", {
      enterpriseInstall: exchanged.is_enterprise_install === true,
      hasTeam: Boolean(teamId),
    });
  }
  if (!TEAM_ID_RE.test(teamId)) return refuse("auth_failed");
  if (!token.startsWith("xoxb-") || (exchanged.token_type && exchanged.token_type !== "bot")) {
    return refuse("not_bot_token", { teamId });
  }
  if (String(exchanged.app_id || "") !== config.appId) return refuse("app_mismatch", { teamId });
  let identity: SlackAuthTestResult;
  try {
    identity = await authTest(token);
  } catch {
    identity = { ok: false };
  }
  if (identity?.ok !== true || String(identity.team_id || "") !== teamId) return refuse("auth_failed", { teamId });

  const binding = await checkSharedApprovalTeamBinding({ orgId: input.orgId, teamId, appId: config.appId });
  if (!binding.ok) return refuse(binding.code, { teamId });

  const teamName = String(identity.team || exchanged.team?.name || teamId).slice(0, 120);
  const previous = binding.existingSharedInbox;
  const prevConfig = previous?.config || {};
  const at = new Date().toISOString();
  let saved: NotificationChannel;
  try {
    saved = await upsertNotificationChannel({
      orgId: input.orgId,
      ...(previous ? { id: previous.id } : {}),
      provider: "slack",
      label: `${SHARED_APPROVAL_APP_NAME}（${teamName}）`,
      enabled: true,
      ...(previous ? { isDefault: previous.isDefault } : {}),
      config: {
        // Re-install keeps the approver + DM destination (same team, checked above).
        ...(previous
          ? {
              channelId: String(prevConfig.channelId || ""),
              allowedUserIds: Array.isArray(prevConfig.allowedUserIds) ? prevConfig.allowedUserIds : [],
              ...(prevConfig.autoOpened ? { autoOpened: prevConfig.autoOpened } : {}),
              ...(typeof prevConfig.setupNoticeAt === "string" ? { setupNoticeAt: prevConfig.setupNoticeAt } : {}),
            }
          : { channelId: "", allowedUserIds: [] }),
        sharedApprovalApp: true,
        apiAppId: config.appId,
        teamId,
        expectedTeamId: teamId,
        teamName,
        botUserId: String(exchanged.bot_user_id || identity.user_id || ""),
        installedAt: at,
      },
      secrets: { botToken: token },
    });
  } catch (error) {
    // Unique index (one shared inbox per workspace) → another org won a race.
    const message = String((error as Error)?.message || "");
    if (/duplicate key|unique/i.test(message)) return refuse("team_bound_to_other_org", { teamId });
    return refuse("save_failed", { teamId });
  }
  await auditInstall(
    input.orgId,
    input.actorEmail ?? null,
    true,
    { teamId, teamName, inboxId: saved.id, appId: config.appId, reinstall: Boolean(previous) },
    `共通承認アプリ「${SHARED_APPROVAL_APP_NAME}」を Slack ワークスペース「${teamName}」に追加`
  );
  return { ok: true, code: "installed", messageJa: sharedApprovalMessage("installed"), teamId, teamName, inboxId: saved.id, reinstall: Boolean(previous) };
}

// ---------------------------------------------------------------------------
// Result page
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function sharedApprovalResultHtml(input: { ok: boolean; code: string; teamName?: string }, status = 200): Response {
  const title = input.ok ? "Staffpass承認 を追加しました" : "Staffpass承認 を追加できませんでした";
  const body =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
    `<body><h1>${escapeHtml(title)}</h1>` +
    (input.teamName ? `<p>Slack ワークスペース: ${escapeHtml(input.teamName)}</p>` : "") +
    `<p>${escapeHtml(sharedApprovalMessage(input.code))}</p>` +
    `<p>エラーコード: <code>${escapeHtml(input.code)}</code></p>` +
    `<p><a href="${escapeHtml(`${getAppOrigin()}/app/settings`)}">設定画面へ戻る</a></p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-robots-tag": "noindex",
    },
  });
}
