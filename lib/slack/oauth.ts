import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppOrigin } from "@/lib/approvals/tokens";

/**
 * User-token scopes for Staffpass Slack app (not Cursor Slack OAuth).
 *
 * Core scopes:
 * - chat:write: postingAs=user の投稿
 * - users:read: 社員の Slack ユーザー情報取得
 * - channels:read, groups:read: チャネル情報取得（legacy — 別クリーンアップ検討）
 * - files:write: postingAs=user でのファイルアップロード（Path B 人↔人 DM へ PDF 添付等）
 *
 * History scopes for user-token Events (Subscribe to events on behalf of users):
 * - im:history: message.im 受信（既存 Path B DM ingress）
 * - channels:history: message.channels 受信（P0 user-token channel mention ingress）
 * - groups:history: message.groups 受信（P0 user-token channel mention ingress）
 *
 * @see docs/p0-user-mention-ingress-design-20260919.md §3 最小スコープ + クレデンシャル・リース (DL-1)
 *
 * Forbidden scopes (never request):
 * - admin.* — 管理権限は不要、ブラスト半径が組織全体に拡大
 * - search:read — 検索能力は不要
 * - files:read — ファイル読み取りは別途 D1 ingress handoff で制御
 *
 * スコープ追加後は、リンク済み社員に re-OAuth を促す（既存トークンには新スコープがない）。
 */
export const SLACK_USER_SCOPES =
  "chat:write,users:read,channels:read,groups:read,im:history,files:write,channels:history,groups:history";

/**
 * Bot-token scopes for Staffpass Slack app workspace installation.
 *
 * - im:write: App DM の作成
 * - app_mentions:read: @mention イベント受信
 * - channels:history, groups:history, im:history: メッセージ履歴読み取り
 * - chat:write: メッセージ投稿
 * - files:write: ファイルアップロード（Path A チャネル / App DM 添付）
 *
 * docs/tenant-slack-kickoff-rail.md の Bot Token Scopes と一致させること。
 * スコープ追加後は、テナントが bot-install フローを再実行して xoxb をリフレッシュする必要があります。
 */
export const SLACK_BOT_SCOPES = "im:write,app_mentions:read,channels:history,groups:history,im:history,chat:write,files:write";

export const SLACK_OAUTH_COOKIE = "staffpass_slack_oauth";
export const SLACK_BOT_INSTALL_COOKIE = "staffpass_slack_bot_install";
const STATE_TTL_MS = 10 * 60 * 1000;

export function slackOAuthConfigured(): boolean {
  return Boolean(
    process.env.SLACK_CLIENT_ID?.trim() && process.env.SLACK_CLIENT_SECRET?.trim()
  );
}

export function slackOAuthRedirectUrl(): string {
  const explicit = process.env.SLACK_OAUTH_REDIRECT_URL?.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${getAppOrigin()}/api/slack/oauth/callback`;
}

function signingSecret(): string {
  return (
    process.env.SLACK_CLIENT_SECRET?.trim() ||
    process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY?.trim() ||
    ""
  );
}

export type SlackOAuthState = {
  orgId: string;
  employeeId: string;
  nonce: string;
  exp: number;
};

export type SlackBotInstallState = {
  orgId: string;
  nonce: string;
  purpose: "bot_install";
  exp: number;
};

export function signSlackOAuthState(input: {
  orgId: string;
  employeeId: string;
  nonce: string;
}): string {
  const payload: SlackOAuthState = {
    orgId: input.orgId,
    employeeId: input.employeeId,
    nonce: input.nonce,
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = signingSecret();
  if (!secret) throw new Error("slack_oauth_unconfigured");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifySlackOAuthState(
  state: string,
  nonce: string
): SlackOAuthState | null {
  const secret = signingSecret();
  if (!secret || !state || !nonce) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SlackOAuthState;
    if (!parsed?.orgId || !parsed?.employeeId || !parsed?.nonce) return null;
    if (parsed.nonce !== nonce) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function slackAuthorizeUrl(state: string): string {
  const clientId = process.env.SLACK_CLIENT_ID?.trim() || "";
  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: SLACK_USER_SCOPES,
    redirect_uri: slackOAuthRedirectUrl(),
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export function slackBotInstallRedirectUrl(): string {
  const explicit = process.env.SLACK_BOT_INSTALL_REDIRECT_URL?.trim().replace(/\/$/, "");
  if (explicit) return explicit;
  return `${getAppOrigin()}/api/slack/bot-install/callback`;
}

export function signSlackBotInstallState(input: { orgId: string; nonce: string }): string {
  const payload: SlackBotInstallState = {
    orgId: input.orgId,
    nonce: input.nonce,
    purpose: "bot_install",
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = signingSecret();
  if (!secret) throw new Error("slack_oauth_unconfigured");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifySlackBotInstallState(
  state: string,
  nonce: string
): SlackBotInstallState | null {
  const secret = signingSecret();
  if (!secret || !state || !nonce) return null;
  const dot = state.indexOf(".");
  if (dot <= 0) return null;
  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SlackBotInstallState;
    if (!parsed?.orgId || !parsed?.nonce || parsed?.purpose !== "bot_install") return null;
    if (parsed.nonce !== nonce) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function slackBotInstallAuthorizeUrl(state: string): string {
  const clientId = process.env.SLACK_CLIENT_ID?.trim() || "";
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_BOT_SCOPES,
    redirect_uri: slackBotInstallRedirectUrl(),
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}
