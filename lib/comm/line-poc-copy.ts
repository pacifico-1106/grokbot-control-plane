/**
 * LINE PoC screen / LINE / notify copy (U-15 / U-16 / U-21).
 * Kimura reviews these strings. Tests compare against this file, not guesses.
 */
import { LINE_WEBHOOK_SETUP_ERRORS_JA, lineWebhookSetupMessageJa } from "@/lib/comm/line-webhook-setup";
import { LINK_CODE_FAILURE_REPLY_JA } from "@/lib/comm/link-code-guard";

/** UI-01: employee detail. `:employeeId` is replaced by the real id. */
export const LINE_COMM_ACCOUNT_PAGE_PATH = "/app/employees/:employeeId";
export const LINE_COMM_ACCOUNT_PAGE_PATH_OF = (employeeId: string) =>
  `/app/employees/${encodeURIComponent(employeeId)}`;

export const LINE_COMM_ACCOUNT_SECTION_TITLE_JA = "LINE 公式アカウント（会話）";
export const LINE_COMM_ACCOUNT_HELP_JA =
  "この社員専用の LINE 公式アカウントを接続します。チャネルアクセストークンはサーバーだけが復号し、ログには残りません。AI は実行できません。";
export const LINE_COMM_ACCOUNT_BOT_USER_LABEL_JA = "ボット userId";
export const LINE_COMM_ACCOUNT_WEBHOOK_LABEL_JA = "会話 Webhook URL";
export const LINE_COMM_ACCOUNT_TOKEN_LABEL_JA = "チャネルアクセストークン";
export const LINE_COMM_ACCOUNT_SECRET_LABEL_JA = "チャネルシークレット";
export const LINE_COMM_ACCOUNT_CONNECT_BUTTON_JA = "接続して Webhook を登録";
export const LINE_COMM_ACCOUNT_CONNECTING_JA = "接続中…";
export const LINE_COMM_ACCOUNT_RETEST_BUTTON_JA = "Webhook を再登録してテスト";
export const LINE_COMM_ACCOUNT_UPDATE_BUTTON_JA = "トークンを更新して Webhook を再登録";
export const LINE_COMM_ACCOUNT_REGISTERING_JA = "登録中…";
export const LINE_COMM_ACCOUNT_SUCCESS_JA = "Webhook を登録しました";
export const LINE_COMM_ACCOUNT_SUCCESS_WITH_URL_JA = (webhookUrl: string) =>
  `Webhook を登録しました: ${webhookUrl}`;
export const LINE_COMM_ACCOUNT_FAIL_FALLBACK_JA = "接続に失敗しました";
export const LINE_COMM_ACCOUNT_SETUP_ERRORS_JA = LINE_WEBHOOK_SETUP_ERRORS_JA;
export const lineCommAccountSetupMessageJa = lineWebhookSetupMessageJa;

export const LINE_COMM_LINK_SECTION_TITLE_JA = "LINE 会話の連携コード";
export const LINE_COMM_LINK_HELP_JA =
  "発行した本人が、この社員の LINE に自分で送ると、あなたの社内メンバーと LINE が紐付きます。第三者に渡さないでください。本文はログに残りません。";
export const LINE_COMM_LINK_ISSUE_BUTTON_JA = "連携コードを発行";
export const LINE_COMM_LINK_ISSUE_BUSY_JA = "発行中…";
export const LINE_COMM_LINK_ISSUE_FAIL_JA = "発行に失敗しました";
export const LINE_COMM_LINK_ISSUE_FORBIDDEN_JA = "オーナーまたは承認者だけが発行できます";

/** LNK-01: conversation link replies on LINE (1:1). */
export const LINE_CONVERSATION_LINK_OK_JA = "✅ Staffpass の社内メンバーとして確認しました。";
/** Same reply for expired / used / other-employee / malformed / locked (does not reveal whether a code exists). */
export const LINE_CONVERSATION_LINK_FAIL_JA = LINK_CODE_FAILURE_REPLY_JA;
export const LINE_CONVERSATION_LINK_GROUP_JA =
  "連携コードは、公式アカウントとの 1:1 トークで送ってください（グループでは受け付けません）。";

/** Approver-link replies (same OA, U-06). Kept here so Kimura can review both. */
export const LINE_APPROVER_LINK_OK_JA =
  "✅ この LINE アカウントを Staffpass の承認者として確認しました。Staffpass の設定画面に LINE ユーザー ID が表示されます。";
export const LINE_APPROVER_LINK_INVALID_JA =
  "連携コードが無効か、有効期限（15分）が切れています。Staffpass の設定画面で新しいコードを発行してください。";
export const LINE_APPROVER_LINK_GROUP_JA = LINE_CONVERSATION_LINK_GROUP_JA;
export const LINE_APPROVER_LINK_ERROR_JA = "連携コードを確認できませんでした。時間をおいて、もう一度お試しください。";

/**
 * QTA-04 / U-21: 80% monthly-quota notice. L0 records the copy only;
 * the daily quota reader / send is U-05 (later PR).
 */
export const LINE_QUOTA_80_NOTICE_TENANT_ADMIN_SUBJECT_JA =
  "【Staffpass】LINE 送信通数が月間上限の 8 割に達しました";
export const LINE_QUOTA_80_NOTICE_TENANT_ADMIN_BODY_JA =
  "このテナントの LINE 公式アカウントの送信通数が、今月の上限の 8 割に達しました。上限に達すると会話の Push は送れません。Reply は通数に含まれません。本文や秘密は記録していません。";
export const LINE_QUOTA_80_NOTICE_OPS_JA =
  "【運営】LINE 送信通数が月間上限の 8 割に達したテナントがあります。本文・token は含みません。";

/** U-20 (later PR): monthly-limit fallback mail goes to that tenant's approvers. */
export const LINE_QUOTA_EXCEEDED_APPROVER_SUBJECT_JA =
  "【Staffpass】LINE の月間通数上限のため、承認をメールでお送りします";
export const LINE_QUOTA_EXCEEDED_APPROVER_BODY_JA =
  "LINE の月間通数上限に達したため、承認カードを LINE ではなくメールで送ります。他テナントの承認者には届きません。";
