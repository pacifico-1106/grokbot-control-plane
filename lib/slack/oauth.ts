import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppOrigin } from "@/lib/approvals/tokens";

/**
 * User-token scopes for Staffpass Slack app (not Cursor Slack OAuth).
 *
 * - chat:write: postingAs=user の投稿
 * - users:read: 社員の Slack ユーザー情報取得
 * - channels:read, groups:read: チャネル情報取得
 * - im:history: user-token Events (Subscribe to events on behalf of users) の message.im 受信
 *
 * im:history 追加後は、リンク済み社員に re-OAuth を促す（既存トークンには im:history がない）。
 */
export const SLACK_USER_SCOPES = "chat:write,users:read,channels:read,groups:read,im:history";

export const SLACK_OAUTH_COOKIE = "staffpass_slack_oauth";
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
