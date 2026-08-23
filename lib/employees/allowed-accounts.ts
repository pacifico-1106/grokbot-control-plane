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

export type ClaimedAccount = {
  service?: string;
  accountId?: string;
};

export type AllowedAccountsDecision =
  | {
      ok: true;
      matched?: AllowedAccount;
      /** Live browser session identity is never fully proven at gateway today. */
      browserIdentityCheck: "partial" | "not_applicable";
      noteJa: string;
    }
  | {
      ok: false;
      code: "allowed_accounts_missing" | "allowed_accounts_mismatch";
      /** Prefer fail-closed; callers may map to needs_approval if product chooses. */
      disposition: "fail_closed";
      browserIdentityCheck: "partial" | "not_applicable";
      message: string;
      allowedAccounts: AllowedAccount[];
      claimed?: ClaimedAccount;
    };

function norm(s: string | undefined | null): string {
  return (s || "").trim().toLowerCase();
}

function extractClaimed(
  claimed: ClaimedAccount | null | undefined
): { service: string; accountId: string } | null {
  const service = (claimed?.service || "").trim();
  const accountId = (claimed?.accountId || "").trim();
  if (!service && !accountId) return null;
  return { service, accountId };
}

/**
 * browser:use gate for allowedAccounts (Kimura C5).
 * - Missing list when browser is required → fail-closed (not soft warn).
 * - Claimed identity that does not match configured list → fail-closed.
 * - Live session ID match remains partial / honesty-only.
 */
export function evaluateAllowedAccountsForBrowser(input: {
  allowedAccounts: AllowedAccount[] | null | undefined;
  claimed?: ClaimedAccount | null;
  /** When true (browser.use), empty list is not allowed. */
  browserRequired?: boolean;
}): AllowedAccountsDecision {
  const accounts = normalizeAllowedAccounts(input.allowedAccounts);
  const claimed = extractClaimed(input.claimed);
  const browserRequired = input.browserRequired !== false;

  if (browserRequired && accounts.length === 0) {
    return {
      ok: false,
      code: "allowed_accounts_missing",
      disposition: "fail_closed",
      browserIdentityCheck: "not_applicable",
      message:
        "browser:use requires allowedAccounts on the credential (fail-closed). Soft warn is not enough when browser is required.",
      allowedAccounts: [],
      claimed: claimed ?? undefined,
    };
  }

  if (claimed) {
    const matched = accounts.find((a) => {
      const serviceOk = claimed.service
        ? norm(a.service) === norm(claimed.service)
        : true;
      const idOk = claimed.accountId
        ? norm(a.accountId) === norm(claimed.accountId)
        : true;
      return serviceOk && idOk && (claimed.service || claimed.accountId);
    });
    if (!matched) {
      return {
        ok: false,
        code: "allowed_accounts_mismatch",
        disposition: "fail_closed",
        browserIdentityCheck: "partial",
        message:
          "claimed account is not in credential.allowedAccounts (fail-closed). Live browser session identity remains only partially verifiable.",
        allowedAccounts: accounts,
        claimed,
      };
    }
    return {
      ok: true,
      matched,
      browserIdentityCheck: "partial",
      noteJa:
        "許可IDは社員証と一致。ただし実行中ブラウザのライブ照合は部分的です（共有セッション前提）。",
    };
  }

  return {
    ok: true,
    browserIdentityCheck: accounts.length ? "partial" : "not_applicable",
    noteJa: accounts.length
      ? "許可IDは社員証に設定済み。クレーム未提示のためライブ照合は監査・Managed目視で補完（部分的）。"
      : "許可ID未使用パス。",
  };
}
