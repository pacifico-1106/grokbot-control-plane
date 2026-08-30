/**
 * Honest hire / policy-editor consequence preview.
 * Derives from scopes, purposes, approvalPolicy, SoD, and browser accounts.
 * Does not reimplement the Gateway matrix.
 */
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import { evaluateSod, SOD_OPERATOR_RESPONSIBILITY_JA } from "@/lib/employees/sod";
import type {
  AllowedAccount,
  ApprovalPolicy,
  EmployeeScope,
  PostingAs,
  SodVerdict,
} from "@/lib/types";

export type PolicyPreviewTone = "ok" | "warn" | "danger" | "muted";

export type PolicyPreviewRow = {
  id: string;
  label: string;
  value: string;
  tone: PolicyPreviewTone;
};

export const MENTION_REPLY_AUTO =
  "自動（社内は要約で通す。社外・機密は止める）";
export const MENTION_REPLY_WAIT = "承認待ち";

export function hasCommScope(scopes: readonly string[]): boolean {
  return (
    scopes.includes("slack:post") ||
    scopes.includes("slack:post_external") ||
    scopes.includes("tools:invoke")
  );
}

function mentionReplyForcedHuman(approvalPolicy: ApprovalPolicy): boolean {
  return approvalPolicy === "always_human";
}

function choosablePreview(
  tool: "mail.send" | "calendar.confirm",
  hints?: Record<string, ApprovalPolicy | "deny"> | null
): { value: string; tone: PolicyPreviewTone } {
  const hint = hints?.[tool];
  if (hint === "auto") return { value: "自動", tone: "warn" };
  if (hint === "risk_based") return { value: "危ないときだけ人が見る", tone: "warn" };
  return { value: "必ず人が見る", tone: "danger" };
}

export function buildPolicyPreview(input: {
  scopes: readonly EmployeeScope[] | readonly string[];
  allowedPurposes?: readonly string[];
  approvalPolicy: ApprovalPolicy;
  liveSod?: Pick<SodVerdict, "level"> | null;
  allowedAccounts?: AllowedAccount[] | null;
  postingAs?: PostingAs | null;
  slackLinked?: boolean;
  toolApprovalDefaults?: Record<string, ApprovalPolicy | "deny"> | null;
}): PolicyPreviewRow[] {
  void input.allowedPurposes;
  const scopes = input.scopes;
  const hasSlack = hasCommScope(scopes);
  const hasMailSend = scopes.includes("mail:send") || scopes.includes("agentmail:send");
  const hasConfirm = scopes.includes("calendar:confirm");
  const hasOrder = scopes.includes("commerce:order");
  const hasBrowser = scopes.includes("browser:use");
  const accounts = normalizeAllowedAccounts(input.allowedAccounts);
  const mentionForced = mentionReplyForcedHuman(input.approvalPolicy);
  const sodLevel = input.liveSod?.level ?? evaluateSod(scopes as EmployeeScope[]).level;

  const slack: PolicyPreviewRow = !hasSlack
    ? { id: "slack", label: "メンション返信", value: "できない", tone: "muted" }
    : mentionForced
      ? { id: "slack", label: "メンション返信", value: MENTION_REPLY_WAIT, tone: "warn" }
      : { id: "slack", label: "メンション返信", value: MENTION_REPLY_AUTO, tone: "ok" };

  const mailHint = choosablePreview("mail.send", input.toolApprovalDefaults);
  const mail: PolicyPreviewRow = hasMailSend
    ? { id: "mail", label: "メール送信", value: mailHint.value, tone: mailHint.tone }
    : { id: "mail", label: "メール送信", value: "できない", tone: "muted" };

  const calHint = choosablePreview("calendar.confirm", input.toolApprovalDefaults);
  const calendar: PolicyPreviewRow = hasConfirm
    ? { id: "calendar", label: "予定の確定", value: calHint.value, tone: calHint.tone }
    : { id: "calendar", label: "予定の確定", value: "できない", tone: "muted" };

  const order: PolicyPreviewRow = hasOrder
    ? { id: "order", label: "発注", value: "必ず人が見る · お金が動く", tone: "danger" }
    : { id: "order", label: "発注", value: "できない", tone: "muted" };

  let browser: PolicyPreviewRow;
  if (!hasBrowser) {
    browser = { id: "browser", label: "ブラウザ", value: "できない", tone: "muted" };
  } else if (accounts.length === 0) {
    browser = { id: "browser", label: "ブラウザ", value: "動かない（許可アカウント無し）", tone: "danger" };
  } else {
    browser = { id: "browser", label: "ブラウザ", value: "共有セッション注意", tone: "warn" };
  }

  const external: PolicyPreviewRow = {
    id: "external",
    label: "社外チャネル",
    value: "機密は出さない。公開案内のみ / 社内情報は要約",
    tone: "ok",
  };

  const postingAs = input.postingAs === "user" ? "user" : "bot";
  const posting: PolicyPreviewRow =
    postingAs === "bot"
      ? { id: "postingAs", label: "投稿名義", value: "会社のBot", tone: "ok" }
      : input.slackLinked
        ? { id: "postingAs", label: "投稿名義", value: "この社員", tone: "ok" }
        : {
            id: "postingAs",
            label: "投稿名義",
            value: "この社員（未連携なら「本人としては出せない」）",
            tone: "danger",
          };

  const rows: PolicyPreviewRow[] = [slack, posting, mail, calendar, order, browser, external];
  if (hasMailSend && hasConfirm) {
    rows.push({
      id: "combo",
      label: "権限の組み合わせ",
      value: SOD_OPERATOR_RESPONSIBILITY_JA,
      tone: sodLevel === "force_human" ? "danger" : "warn",
    });
  }
  return rows;
}
