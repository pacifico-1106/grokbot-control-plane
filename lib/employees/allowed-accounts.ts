import type { AllowedAccount } from "@/lib/types";

/** JP SME preset chips (service key → label). "other" opens custom service name. */
export const ACCOUNT_SERVICE_PRESETS: Array<{ key: string; label: string }> = [
  { key: "google", label: "Google" },
  { key: "microsoft365", label: "Microsoft 365" },
  { key: "line", label: "LINE" },
  { key: "x", label: "X" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "slack", label: "Slack" },
  { key: "other", label: "その他" },
];

export const ACCOUNT_SERVICE_LABELS: Record<string, string> = Object.fromEntries(
  ACCOUNT_SERVICE_PRESETS.map((p) => [p.key, p.label])
);

export function serviceLabel(service: string): string {
  if (!service) return "（未設定）";
  return ACCOUNT_SERVICE_LABELS[service] ?? service;
}

export function emptyAllowedAccount(service = "google"): AllowedAccount {
  return {
    service,
    accountId: "",
    label: "",
    browserRequired: service === "google" || service === "microsoft365",
  };
}

/**
 * Soft hints from Japanese NL (Gmail / Workspace / SNS).
 * Does not invent accountIds — only seeds empty rows for the hire UI.
 */
export function hintAllowedAccountsFromText(input: string): AllowedAccount[] {
  const hints: AllowedAccount[] = [];
  const push = (service: string, label?: string) => {
    if (hints.some((h) => h.service === service)) return;
    hints.push({
      service,
      accountId: "",
      label,
      browserRequired: service === "google" || service === "microsoft365",
    });
  };

  if (/(?:gmail|workspace|グーグル|google\s*帳|google\s*メール|google\s*アカウント)/i.test(input)) {
    push("google", "会社Google（要確認）");
  }
  if (/(?:microsoft\s*365|m365|outlook|オフィス365|マイクロソフト)/i.test(input)) {
    push("microsoft365", "会社Microsoft 365（要確認）");
  }
  if (/(?:\bline\b|ライン公式|LINE公式)/i.test(input)) {
    push("line", "公式LINE（要確認）");
  }
  if (/(?:\bx\b|twitter|ツイッター)/i.test(input)) {
    push("x", "X公式（要確認）");
  }
  if (/(?:instagram|インスタ)/i.test(input)) {
    push("instagram", "Instagram（要確認）");
  }
  if (/(?:facebook|フェイスブック|Meta\s*ビジネス)/i.test(input)) {
    push("facebook", "Facebook（要確認）");
  }
  if (/(?:slack|スラック)/i.test(input)) {
    push("slack", "Slack（要確認）");
  }

  return hints;
}

export function normalizeAllowedAccounts(
  rows: AllowedAccount[] | null | undefined
): AllowedAccount[] {
  if (!rows?.length) return [];
  return rows
    .map((r) => ({
      service: (r.service || "").trim(),
      accountId: (r.accountId || "").trim(),
      label: (r.label || "").trim() || undefined,
      browserRequired: r.browserRequired === true,
    }))
    .filter((r) => r.service && r.accountId);
}
