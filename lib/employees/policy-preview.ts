/**
 * Honest hire / policy-editor consequence preview.
 * Derives from scopes, purposes, approvalPolicy, SoD, and browser accounts.
 * Does not reimplement the Gateway matrix.
 */
import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import type {
  AllowedAccount,
  ApprovalPolicy,
  EmployeeScope,
  SodVerdict,
} from "@/lib/types";

export type PolicyPreviewTone = "ok" | "warn" | "danger" | "muted";

export type PolicyPreviewRow = {
  id: string;
  label: string;
  value: string;
  tone: PolicyPreviewTone;
};

export function hasCommScope(scopes: readonly string[]): boolean {
  return (
    scopes.includes("slack:post") ||
    scopes.includes("slack:post_external") ||
    scopes.includes("tools:invoke")
  );
}

export function buildPolicyPreview(input: {
  scopes: readonly EmployeeScope[] | readonly string[];
  allowedPurposes?: readonly string[];
  approvalPolicy: ApprovalPolicy;
  liveSod?: Pick<SodVerdict, "level"> | null;
  allowedAccounts?: AllowedAccount[] | null;
}): PolicyPreviewRow[] {
  void input.allowedPurposes;
  void input.liveSod;
  const scopes = input.scopes;
  const hasSlack = hasCommScope(scopes);
  const hasMailSend = scopes.includes("mail:send") || scopes.includes("agentmail:send");
  const hasConfirm = scopes.includes("calendar:confirm");
  const hasOrder = scopes.includes("commerce:order");
  const hasBrowser = scopes.includes("browser:use");
  const accounts = normalizeAllowedAccounts(input.allowedAccounts);
  const alwaysHuman = input.approvalPolicy === "always_human";

  const slack: PolicyPreviewRow = !hasSlack
    ? { id: "slack", label: "メンション返信 / Slack", value: "できない", tone: "muted" }
    : alwaysHuman
      ? { id: "slack", label: "メンション返信 / Slack", value: "人が見てから", tone: "warn" }
      : { id: "slack", label: "メンション返信 / Slack", value: "自動で出す", tone: "ok" };

  const mail: PolicyPreviewRow = hasMailSend
    ? { id: "mail", label: "メール送信", value: "必ず人が見る", tone: "danger" }
    : { id: "mail", label: "メール送信", value: "できない", tone: "muted" };

  const calendar: PolicyPreviewRow = hasConfirm
    ? { id: "calendar", label: "予定の確定", value: "必ず人が見る", tone: "warn" }
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

  return [slack, mail, calendar, order, browser, external];
}
