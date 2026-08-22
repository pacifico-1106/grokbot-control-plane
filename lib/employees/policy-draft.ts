import type { ApprovalPolicy, EmployeePolicyDraft, EmployeeScope, SpendLimits } from "@/lib/types";
import { hintAllowedAccountsFromText } from "@/lib/employees/allowed-accounts";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";

const ROLE_PROFILES: Array<{
  match: RegExp;
  displayName: string;
  roleLabel: string;
  purposes: string[];
  scopes: EmployeeScope[];
  approvalPolicy: ApprovalPolicy;
}> = [
  {
    match: /(?:営業|見積|提案|セールス|sales)/i,
    displayName: "営業AI社員",
    roleLabel: "営業アシスタント",
    purposes: ["sales.outreach", "commerce.quote"],
    scopes: ["tools:read", "mail:draft", "commerce:quote", "approvals:request", "audit:append"],
    approvalPolicy: "risk_based",
  },
  {
    match: /(?:事務|バックオフィス|経理|請求|invoice|ops)/i,
    displayName: "事務AI社員",
    roleLabel: "バックオフィス",
    purposes: ["ops.admin", "invoice.check"],
    scopes: ["tools:read", "files:read", "mail:draft", "approvals:request", "audit:append"],
    approvalPolicy: "risk_based",
  },
  {
    match: /(?:カスタマー|顧客対応|サポート|support)/i,
    displayName: "顧客対応AI社員",
    roleLabel: "カスタマーサポート",
    purposes: ["support.reply", "support.triage"],
    scopes: ["tools:read", "mail:draft", "mail:send", "approvals:request", "audit:append"],
    approvalPolicy: "risk_based",
  },
  {
    match: /(?:採用|人事|履歴書|HR|recruit)/i,
    displayName: "採用AI社員",
    roleLabel: "採用アシスタント",
    purposes: ["hr.screening", "hr.schedule"],
    scopes: ["tools:read", "files:read", "mail:draft", "approvals:request", "audit:append"],
    approvalPolicy: "always_human",
  },
  {
    match: /(?:リサーチ|調査|調べ|research)/i,
    displayName: "調査AI社員",
    roleLabel: "リサーチ",
    purposes: ["research.web", "research.summary"],
    scopes: ["tools:read", "browser:use", "files:write", "audit:append"],
    approvalPolicy: "risk_based",
  },
  {
    match: /(?:購買|発注|注文|購入|order|purchase)/i,
    displayName: "購買AI社員",
    roleLabel: "購買アシスタント",
    purposes: ["commerce.quote", "commerce.order"],
    scopes: [
      "tools:read",
      "commerce:quote",
      "commerce:order",
      "approvals:request",
      "audit:append",
    ],
    approvalPolicy: "always_human",
  },
];

const DEFAULT_SCOPES: EmployeeScope[] = [
  "tools:read",
  "approvals:request",
  "audit:append",
];

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function extractExpiryDays(input: string): number | null {
  const days = input.match(/([1-9][0-9]{0,2})\s*(?:日|days?)/i);
  if (days?.[1]) return Math.min(365, Number(days[1]));
  const months = input.match(/([1-9][0-9]?)\s*(?:か月|ヶ月|カ月|months?)/i);
  if (months?.[1]) return Math.min(365, Number(months[1]) * 30);
  return null;
}

/**
 * Deterministic Japanese NL → least-privilege policy draft.
 * Pattern adapted from Sealith ai-settings interpret; scopes rewritten for Grok Bot.
 */
export function buildEmployeePolicyDraft(rawInput: string): EmployeePolicyDraft {
  const input = rawInput.trim();
  const profile = ROLE_PROFILES.find((p) => p.match.test(input));

  const wantsSend = /(?:送信|送る|メールを出す|外部送信|send mail)/i.test(input);
  const wantsOrder = /(?:発注|注文|購入|決済|order|purchase|buy)/i.test(input);
  const wantsBrowser = /(?:ブラウザ|ウェブ|検索|調べ|browse|research)/i.test(input);
  const wantsWrite = /(?:書込|編集|作成|ファイルを作|write|edit)/i.test(input);
  const explicitAlwaysHuman =
    /(?:必ず承認|毎回承認|人間が許可|always.?human|要承認のみ)/i.test(input);
  // Order detected → *suggest* always_human initially (UI may switch to risk_based + limits).
  const suggestAlwaysHumanForOrder = wantsOrder && !/(?:少額は自動|リスクベース|risk.?based)/i.test(input);

  const scopes = unique<EmployeeScope>([
    ...(profile?.scopes ?? DEFAULT_SCOPES),
    ...(wantsSend ? (["mail:draft", "mail:send"] as EmployeeScope[]) : []),
    ...(wantsOrder ? (["commerce:quote", "commerce:order"] as EmployeeScope[]) : []),
    ...(wantsBrowser ? (["browser:use"] as EmployeeScope[]) : []),
    ...(wantsWrite ? (["files:write"] as EmployeeScope[]) : []),
    "approvals:request",
    "audit:append",
  ]);

  const approvalPolicy: ApprovalPolicy = explicitAlwaysHuman || suggestAlwaysHumanForOrder
    ? "always_human"
    : profile?.approvalPolicy ?? "risk_based";

  const spend: SpendLimits | null = scopes.includes("commerce:order")
    ? { ...DEFAULT_SPEND_LIMITS }
    : null;

  const spendRecommendation = scopes.includes("commerce:order")
    ? "発注権限があるため、最初は「常に人間承認」を推奨します。慣れたらリスクベース＋少額上限（例: 1件3,000円）に切り替えできます。初回発注は人間承認のままが安全です。"
    : null;

  const allowedAccounts = hintAllowedAccountsFromText(input);
  // If browser is in play and text mentions Gmail/Workspace-ish words, keep Google hint even without explicit match above.
  if (
    scopes.includes("browser:use") &&
    /(?:gmail|workspace|グーグル|google)/i.test(input) &&
    !allowedAccounts.some((a) => a.service === "google")
  ) {
    allowedAccounts.push({
      service: "google",
      accountId: "",
      label: "会社Google（要確認）",
      browserRequired: true,
    });
  }

  const purposes =
    profile?.purposes ??
    (input
      ? [input.slice(0, 40).replace(/\s+/g, "_") || "general.assist"]
      : []);

  const assumptions: string[] = [];
  if (!profile) {
    assumptions.push("職務が特定できないため、汎用の業務支援ロールにしています。");
  }
  if (!extractExpiryDays(input)) {
    assumptions.push("社員証の有効期限は30日後にしています。");
  }
  if (wantsSend) {
    assumptions.push("外部送信は承認ポリシーに従ってゲートします。");
  }
  if (scopes.includes("commerce:order")) {
    assumptions.push(
      "発注は予算・承認ステップで上限を設定できます。Draft の「常に人間承認」は初期推奨であり、固定ではありません。"
    );
  }
  if (allowedAccounts.length) {
    assumptions.push(
      "外部アカウントの候補を職務文から推測しました。実際に使ってよいIDは「予算・承認」ステップで刻んでください。"
    );
  } else if (scopes.includes("browser:use")) {
    assumptions.push(
      "ブラウザ利用がある場合は、共有PCで混ざるログインを避けるため、許可する外部アカウントIDの登録を推奨します。"
    );
  }

  const warnings: EmployeePolicyDraft["warnings"] = [];
  if (!purposes.length || purposes[0]?.startsWith(input.slice(0, 8))) {
    if (!profile) warnings.push("broad_purpose_access");
  }
  if (scopes.includes("mail:send")) warnings.push("mail_send_requested");
  if (scopes.includes("commerce:order")) warnings.push("commerce_order_requested");
  if (scopes.includes("browser:use")) warnings.push("browser_use_requested");
  if (approvalPolicy === "always_human") warnings.push("always_human_recommended");

  const missingFields: EmployeePolicyDraft["missingFields"] = [];
  if (!profile) missingFields.push("role");
  if (!profile) missingFields.push("purpose");
  // Order + risk_based is OK once spend limits are set in hire step 3 (not a missing field).

  return {
    policy: {
      displayName: profile?.displayName ?? "業務支援AI社員",
      roleLabel: profile?.roleLabel ?? "業務アシスタント",
      scopes,
      allowedPurposes: purposes,
      approvalPolicy,
      expiresInDays: extractExpiryDays(input) ?? 30,
      spend,
      spendRecommendation,
      allowedAccounts,
    },
    assumptions,
    missingFields,
    warnings,
    confidence: profile ? 0.86 : 0.55,
    source: "rules",
  };
}

export const ALL_SCOPES: EmployeeScope[] = [
  "tools:read",
  "tools:invoke",
  "mail:draft",
  "mail:send",
  "files:read",
  "files:write",
  "browser:use",
  "commerce:quote",
  "commerce:order",
  "audit:append",
  "approvals:request",
];

export const SCOPE_LABELS: Record<EmployeeScope, string> = {
  "tools:read": "ツール読取",
  "tools:invoke": "ツール実行",
  "mail:draft": "メール下書き",
  "mail:send": "メール送信",
  "files:read": "ファイル読取",
  "files:write": "ファイル書込",
  "browser:use": "ブラウザ利用",
  "commerce:quote": "見積作成",
  "commerce:order": "発注・購入",
  "audit:append": "監査追記",
  "approvals:request": "承認申請",
};

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  auto: "自動許可（低リスクのみ）",
  always_human: "常に人間承認",
  risk_based: "リスクベース",
};
