/**
 * L-8: fetch the LINE bot userId, store it on the comm account, PUT the
 * conversation webhook URL, and POST LINE's webhook test.
 *
 * Trigger: owner/admin connect API (or a later approved-config-change caller
 * that imports this module). Gateway / MCP / Admin MCP must not import this
 * file — AI never auto-runs it. The channel access token is decrypted
 * server-side only and is never returned or logged.
 *
 * Flag LINE_WEBHOOK_AUTO_SETUP_ENABLED (needs COMM_ACCOUNTS_ENABLED +
 * LINE_CONVERSATION_ENABLED). Default OFF.
 */
import { isPublicHttpsOrigin, resolveAppOrigin } from "@/lib/app-url";
import {
  commWebhookPath,
  createCommAccount,
  getCommAccountInOrg,
  listCommAccounts,
  parseLineSecrets,
  readCommAccountSecretsForServer,
  setCommAccountSecrets,
  type CommAccount,
  type CommAccountView,
  type LineSecrets,
} from "@/lib/comm/accounts";
import { isLineWebhookAutoSetupEnabled } from "@/lib/comm/flags";
import {
  fetchLineBotInfo,
  setLineWebhookEndpoint,
  testLineWebhookEndpoint,
  type LineMessagingFailure,
} from "@/lib/comm/line-messaging";

export const LINE_WEBHOOK_SETUP_ERRORS_JA: Record<string, string> = {
  disabled: "この機能は現在オフです",
  invalid_secrets: "チャネルアクセストークンまたはチャネルシークレットの形式が正しくありません",
  token_unauthorized: "チャネルアクセストークンが正しくありません。LINE Developers の Messaging API の値を確認してください",
  bot_info_invalid: "LINE ボットの userId を取得できませんでした",
  bot_info_http: "LINE のボット情報の取得に失敗しました",
  line_network: "LINE との通信に失敗しました。時間をおいて再試行してください",
  origin_not_https: "Webhook URL を LINE に登録できる公開 https の origin がありません",
  webhook_set_failed: "LINE への Webhook URL の登録に失敗しました",
  webhook_test_failed: "LINE の Webhook テスト呼び出しに失敗しました",
  webhook_test_rejected: "LINE の Webhook テストが失敗しました。URL とチャネルシークレットを確認してください",
  employee_has_account: "この社員にはすでに LINE 公式アカウントがつながっています",
  external_account_taken: "この LINE 公式アカウントは別の社員または別の組織ですでに使われています",
  bot_user_mismatch: "LINE ボットの userId が、保存されている公式アカウントと一致しません",
  not_found: "対象の社員または LINE アカウントが見つかりません",
  no_secrets: "保存済みのチャネルアクセストークンがありません。トークンとシークレットを入力してください",
  storage_error: "保存に失敗しました。時間をおいて再試行してください",
  storage_unavailable: "保存先が設定されていません",
  encryption_unavailable: "秘密情報を暗号化できません",
  secret_invalid: "保存済みの秘密情報を復号できません",
  invalid_external_account_id: "LINE ボットの userId の形式が正しくありません",
  invalid_surface: "この通信面はまだ使えません",
  employee_not_found: "対象の社員が見つかりません",
};

export function lineWebhookSetupMessageJa(reason: string): string {
  return LINE_WEBHOOK_SETUP_ERRORS_JA[reason] || "LINE 公式アカウントの接続に失敗しました";
}

export type LineWebhookSetupOk = {
  ok: true;
  account: CommAccountView;
  botUserId: string;
  webhookUrl: string;
};

export type LineWebhookSetupFail = {
  ok: false;
  reason: string;
  messageJa: string;
  account?: CommAccountView;
  botUserId?: string;
  webhookUrl?: string;
};

export type LineWebhookSetupResult = LineWebhookSetupOk | LineWebhookSetupFail;

function fail(reason: string, extra: Omit<LineWebhookSetupFail, "ok" | "reason" | "messageJa"> = {}): LineWebhookSetupFail {
  return { ok: false, reason, messageJa: lineWebhookSetupMessageJa(reason), ...extra };
}

function failLine(r: LineMessagingFailure, extra: Omit<LineWebhookSetupFail, "ok" | "reason" | "messageJa"> = {}): LineWebhookSetupFail {
  return fail(r.reason, extra);
}

export function conversationWebhookUrl(webhookRef: string, origin = resolveAppOrigin()): string | null {
  if (!isPublicHttpsOrigin(origin)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(webhookRef)) return null;
  return `${origin}${commWebhookPath({ surface: "line", webhookRef })}`;
}

export async function findEmployeeLineAccount(orgId: string, employeeId: string): Promise<CommAccountView | null> {
  const rows = await listCommAccounts(orgId);
  return rows.find((a) => a.employeeId === employeeId && a.surface === "line") ?? null;
}

function viewOf(account: { id: string; orgId: string; employeeId: string; surface: "line"; externalAccountId: string; webhookRef: string; status: CommAccountView["status"]; displayName: string | null }, extras: Pick<CommAccountView, "secretNames" | "secretsVerifiedAt">): CommAccountView {
  return {
    id: account.id,
    orgId: account.orgId,
    employeeId: account.employeeId,
    surface: account.surface,
    externalAccountId: account.externalAccountId,
    status: extras.secretNames.length ? (account.status === "pending" ? "active" : account.status) : account.status,
    displayName: account.displayName,
    webhookPath: commWebhookPath(account),
    secretNames: extras.secretNames,
    secretsVerifiedAt: extras.secretsVerifiedAt,
  };
}

async function registerWebhook(
  accessToken: string,
  account: Pick<CommAccount, "webhookRef" | "externalAccountId">,
  listed?: CommAccountView
): Promise<LineWebhookSetupResult> {
  const webhookUrl = conversationWebhookUrl(account.webhookRef);
  if (!webhookUrl) return fail("origin_not_https", { account: listed, botUserId: account.externalAccountId });
  const extra = { account: listed, botUserId: account.externalAccountId, webhookUrl };
  const set = await setLineWebhookEndpoint(accessToken, webhookUrl);
  if (!set.ok) return failLine(set, extra);
  const test = await testLineWebhookEndpoint(accessToken, webhookUrl);
  if (!test.ok) return failLine(test, extra);
  if (!listed) return fail("storage_error", extra);
  return { ok: true, account: listed, botUserId: account.externalAccountId, webhookUrl };
}

/**
 * Connect a new LINE official account, or re-register the webhook on an
 * existing one. `secrets` present → validate + (create or rotate). Absent →
 * decrypt the stored token. The token is never logged or returned.
 */
export async function setupLineConversationWebhook(input: {
  orgId: string;
  employeeId: string;
  secrets?: unknown;
  createdByMemberId: string | null;
}): Promise<LineWebhookSetupResult> {
  if (!isLineWebhookAutoSetupEnabled()) return fail("disabled");
  const existing = await findEmployeeLineAccount(input.orgId, input.employeeId);
  let secrets: LineSecrets | null = null;
  if (input.secrets !== undefined) {
    secrets = parseLineSecrets(input.secrets);
    if (!secrets) return fail("invalid_secrets", { account: existing ?? undefined });
  } else if (!existing) {
    return fail("not_found");
  }

  let accessToken = secrets?.channelAccessToken ?? "";
  if (!secrets) {
    const stored = await readCommAccountSecretsForServer(input.orgId, existing!.id).catch(() => ({ ok: false as const, reason: "storage_error" }));
    if (!stored.ok) return fail(stored.reason === "no_secrets" ? "no_secrets" : stored.reason, { account: existing ?? undefined });
    accessToken = stored.secrets.channelAccessToken;
    secrets = stored.secrets;
  }

  const info = await fetchLineBotInfo(accessToken);
  if (!info.ok) return failLine(info, { account: existing ?? undefined });

  if (existing) {
    if (existing.externalAccountId !== info.bot.userId) {
      return fail("bot_user_mismatch", { account: existing, botUserId: existing.externalAccountId });
    }
    if (input.secrets !== undefined) {
      const set = await setCommAccountSecrets({
        orgId: input.orgId,
        accountId: existing.id,
        secrets,
        memberId: input.createdByMemberId,
        verifiedAt: new Date().toISOString(),
      });
      if (!set.ok) return fail(set.reason, { account: existing, botUserId: info.bot.userId });
    }
    const listed = (await findEmployeeLineAccount(input.orgId, input.employeeId)) ?? existing;
    const stored = await getCommAccountInOrg(input.orgId, existing.id);
    if (!stored) return fail("storage_error", { account: listed, botUserId: info.bot.userId });
    return registerWebhook(accessToken, stored, listed);
  }

  const created = await createCommAccount({
    orgId: input.orgId,
    employeeId: input.employeeId,
    surface: "line",
    externalAccountId: info.bot.userId,
    displayName: info.bot.displayName,
    createdByMemberId: input.createdByMemberId,
  });
  if (!created.ok) return fail(created.reason, { botUserId: info.bot.userId });
  const set = await setCommAccountSecrets({
    orgId: input.orgId,
    accountId: created.account.id,
    secrets,
    memberId: input.createdByMemberId,
    verifiedAt: new Date().toISOString(),
  });
  if (!set.ok) {
    return fail(set.reason, {
      account: viewOf(created.account, { secretNames: [], secretsVerifiedAt: null }),
      botUserId: info.bot.userId,
    });
  }
  const listed = (await findEmployeeLineAccount(input.orgId, input.employeeId)) ?? viewOf(created.account, { secretNames: set.secretNames, secretsVerifiedAt: new Date().toISOString() });
  return registerWebhook(accessToken, created.account, listed);
}
