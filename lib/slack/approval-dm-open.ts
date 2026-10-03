/**
 * SLACK_APPROVAL_DM_AUTO_OPEN — approval app delivery DM auto-open (PR-2).
 *
 * When ON and an org admin saves a Slack approval inbox with an empty channel ID:
 * - The delivery user is the single allowedUserIds entry, or `deliveryUserId`
 *   (must be one of allowedUserIds) when several are listed. Ambiguous → reject.
 * - auth.test (approval bot) → workspace team. users.info (needs users:read) →
 *   is_stranger / other team / Grid other workspace / guest / bot / deleted /
 *   undeterminable → reject (fail-closed).
 * - conversations.open (needs im:write) → D… destination; ext-shared flags → reject.
 * - Exactly one 「設定しました」 notice is posted when the destination is new or
 *   changed; a successful post is treated as "destination valid" (no test
 *   approval needed). If the post fails, nothing is saved.
 *
 * Tokens: the bot token is only placed in the Authorization header. Results
 * carry short error codes only (never the token / Slack bodies).
 *
 * When OFF (default): manual channel ID entry exactly as before.
 */
const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5_000;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isSlackApprovalDmAutoOpenEnabled(): boolean {
  return parseFlag(process.env.SLACK_APPROVAL_DM_AUTO_OPEN);
}

export const APPROVAL_SETUP_NOTICE_TEXT =
  "✅ 設定しました。StaffPass の承認依頼はこの DM に届きます。" +
  "テスト承認は不要です。最初に届いた承認依頼のボタンで、そのまま承認・却下してください。";

export const APPROVAL_DM_REQUIRED_BOT_SCOPES = ["chat:write", "im:write", "im:read", "users:read"] as const;

export type ApprovalDmOpenResult =
  | { ok: true; channelId: string; userId: string; teamId: string }
  | { ok: false; code: string; messageJa: string; missingScope?: string };

function errorCode(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9_]{1,64}$/.test(raw) ? raw : "slack_error";
}

async function call(
  token: string,
  method: "auth.test" | "users.info" | "conversations.open" | "chat.postMessage",
  body: Record<string, unknown>
): Promise<{ ok: boolean; error: string; needed: string; data: Record<string, unknown> }> {
  try {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const data = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (data.ok !== true) {
      return {
        ok: false,
        error: errorCode(data.error) || `http_${response.status}`,
        needed: typeof data.needed === "string" && /^[a-z:._,]{1,80}$/.test(data.needed) ? data.needed : "",
        data: {},
      };
    }
    return { ok: true, error: "", needed: "", data };
  } catch {
    return { ok: false, error: "network_error", needed: "", data: {} };
  }
}

function reject(code: string, messageJa: string, missingScope?: string): ApprovalDmOpenResult {
  return { ok: false, code, messageJa, ...(missingScope ? { missingScope } : {}) };
}

function scopeReject(method: string, needed: string, fallbackScope: string): ApprovalDmOpenResult {
  const scope = needed || fallbackScope;
  return reject(
    "approval_app_missing_scope",
    `承認アプリの Bot Token Scopes に ${scope} がありません（${method}）。api.slack.com で追加し、Reinstall to Workspace してから保存し直してください。`,
    scope
  );
}

/** Pick the delivery user. Exactly one allowed user, or an explicit member of the list. */
export function pickApprovalDeliveryUser(
  allowedUserIds: string[],
  deliveryUserId?: string | null
): { ok: true; userId: string } | { ok: false; code: string; messageJa: string } {
  const allowed = [...new Set(allowedUserIds.map((id) => id.trim()).filter(Boolean))];
  const requested = (deliveryUserId || "").trim();
  if (allowed.length === 0) {
    return {
      ok: false,
      code: "allowed_user_required",
      messageJa: "チャンネル ID を空欄にする場合は、許可 user ID（承認する人の Slack U…）を入れてください。",
    };
  }
  if (requested) {
    if (!allowed.includes(requested)) {
      return {
        ok: false,
        code: "delivery_user_not_allowed",
        messageJa: "DM を開く相手は、許可 user ID の中から選んでください。",
      };
    }
    return SLACK_USER_ID_RE.test(requested)
      ? { ok: true, userId: requested }
      : { ok: false, code: "invalid_slack_user_id", messageJa: "Slack の user ID（U…）を入れてください。" };
  }
  if (allowed.length > 1) {
    return {
      ok: false,
      code: "delivery_user_required",
      messageJa: "許可 user ID が複数あります。DM を開く相手（1 人）を指定してください。",
    };
  }
  return SLACK_USER_ID_RE.test(allowed[0])
    ? { ok: true, userId: allowed[0] }
    : { ok: false, code: "invalid_slack_user_id", messageJa: "Slack の user ID（U…）を入れてください。" };
}

/** Open the approval app ↔ approver DM. Never throws; never returns the token. */
export async function openApprovalDeliveryDm(input: {
  botToken: string;
  allowedUserIds: string[];
  deliveryUserId?: string | null;
}): Promise<ApprovalDmOpenResult> {
  const token = (input.botToken || "").trim();
  if (!token) return reject("bot_token_required", "Slackボットトークンが必要です");
  if (!token.startsWith("xoxb-")) {
    return reject("bot_token_required", "承認アプリの Bot User OAuth Token（xoxb-…）を入れてください。");
  }
  const picked = pickApprovalDeliveryUser(input.allowedUserIds, input.deliveryUserId);
  if (!picked.ok) return reject(picked.code, picked.messageJa);
  const userId = picked.userId;

  const auth = await call(token, "auth.test", {});
  if (!auth.ok) return reject("approval_app_auth_failed", `承認アプリの token を確認できませんでした（${auth.error}）。`);
  const teamId = typeof auth.data.team_id === "string" ? auth.data.team_id.trim() : "";
  if (!teamId) return reject("approval_app_team_unknown", "承認アプリのワークスペースを確認できませんでした。");

  const info = await call(token, "users.info", { user: userId });
  if (!info.ok) {
    if (info.error === "missing_scope") return scopeReject("users.info", info.needed, "users:read");
    return reject("approval_user_undeterminable", `承認者 ${userId} を確認できませんでした（${info.error}）。`);
  }
  const user = (info.data.user ?? null) as Record<string, unknown> | null;
  if (!user || String(user.id || "") !== userId) {
    return reject("approval_user_undeterminable", `承認者 ${userId} を確認できませんでした。`);
  }
  if (user.is_stranger === true) {
    return reject("approval_user_external", "Slack Connect（社外）のユーザーには承認 DM を開けません。");
  }
  const userTeam = typeof user.team_id === "string" ? user.team_id.trim() : "";
  if (!userTeam) return reject("approval_user_undeterminable", "承認者のワークスペースを確認できませんでした。");
  if (userTeam !== teamId) {
    return reject("approval_user_external", "承認アプリと別のワークスペースのユーザーには承認 DM を開けません。");
  }
  const enterprise = user.enterprise_user as Record<string, unknown> | undefined;
  if (enterprise && typeof enterprise === "object" && Array.isArray(enterprise.teams)) {
    const teams = enterprise.teams.map(String);
    if (teams.length > 0 && !teams.includes(teamId)) {
      return reject("approval_user_external", "承認アプリと別のワークスペースのユーザーには承認 DM を開けません。");
    }
  }
  if (user.deleted === true) return reject("approval_user_inactive", "承認者の Slack アカウントが無効です。");
  if (user.is_bot === true || user.is_app_user === true) {
    return reject("approval_user_inactive", "bot には承認 DM を開けません。");
  }
  if (user.is_restricted === true || user.is_ultra_restricted === true) {
    return reject("approval_user_guest", "ゲストユーザーには承認 DM を開けません（社内メンバーを指定してください）。");
  }

  const opened = await call(token, "conversations.open", { users: userId, return_im: true });
  if (!opened.ok) {
    if (opened.error === "missing_scope") return scopeReject("conversations.open", opened.needed, "im:write");
    return reject("approval_dm_open_failed", `承認 DM を開けませんでした（${opened.error}）。`);
  }
  const channel = (opened.data.channel ?? {}) as Record<string, unknown>;
  const channelId = typeof channel.id === "string" ? channel.id.trim() : "";
  if (!/^D[A-Z0-9]{2,30}$/.test(channelId)) {
    return reject("approval_dm_open_failed", "承認 DM の ID を取得できませんでした。");
  }
  if (
    channel.is_ext_shared === true ||
    channel.is_shared === true ||
    channel.is_org_shared === true ||
    channel.is_pending_ext_shared === true
  ) {
    return reject("approval_user_external", "外部共有の DM は承認インボックスに使えません。");
  }
  return { ok: true, channelId, userId, teamId };
}

/** Post the single 「設定しました」 notice. ok=true ⇒ destination treated as valid. */
export async function sendApprovalSetupNotice(
  botToken: string,
  channelId: string
): Promise<{ ok: true; ts: string } | { ok: false; code: string; messageJa: string; missingScope?: string }> {
  const token = (botToken || "").trim();
  if (!token || !channelId) {
    return { ok: false, code: "setup_notice_failed", messageJa: "「設定しました」を送れませんでした。" };
  }
  const sent = await call(token, "chat.postMessage", { channel: channelId, text: APPROVAL_SETUP_NOTICE_TEXT });
  if (!sent.ok) {
    if (sent.error === "missing_scope") {
      const scope = sent.needed || "chat:write";
      return {
        ok: false,
        code: "approval_app_missing_scope",
        messageJa: `承認アプリの Bot Token Scopes に ${scope} がありません。追加して再インストールしてください。`,
        missingScope: scope,
      };
    }
    return {
      ok: false,
      code: "setup_notice_failed",
      messageJa: `「設定しました」を送れませんでした（${sent.error}）。宛先を保存していません。`,
    };
  }
  return { ok: true, ts: typeof sent.data.ts === "string" ? sent.data.ts : "" };
}
