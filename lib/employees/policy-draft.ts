import type { ActionLimits, ApprovalPolicy, EmployeePolicyDraft, EmployeeScope, SpendLimits } from "@/lib/types";
import { hintAllowedAccountsFromText } from "@/lib/employees/allowed-accounts";
import {
  suggestEmployeeApprovalPolicy,
  toolApprovalHintsFromPresets,
} from "@/lib/employees/approval-presets";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";
import { evaluateSod } from "@/lib/employees/sod";
import { defaultVoice } from "@/lib/employees/voice";

const ROLE_PROFILES: Array<{
  match: RegExp;
  displayName: string;
  roleLabel: string;
  purposes: string[];
  scopes: EmployeeScope[];
  approvalPolicy: ApprovalPolicy;
  actionLimits: ActionLimits;
}> = [
  {
    match: /(?:営業|見積|提案|セールス|sales)/i,
    displayName: "営業AI社員",
    roleLabel: "営業アシスタント",
    purposes: ["sales.outreach", "commerce.quote", "calendar.propose"],
    scopes: [
      "tools:read",
      "mail:draft",
      "calendar:propose",
      "commerce:quote",
      "approvals:request",
      "audit:append",
    ],
    approvalPolicy: "risk_based",
    actionLimits: { "mail.send": { perDay: 20, perMonth: 300 }, "calendar.confirm": { perDay: 8 } },
  },
  {
    match: /(?:事務|バックオフィス|経理|請求|invoice|ops)/i,
    displayName: "事務AI社員",
    roleLabel: "バックオフィス",
    purposes: ["ops.admin", "invoice.check"],
    scopes: ["tools:read", "files:read", "mail:draft", "approvals:request", "audit:append"],
    approvalPolicy: "risk_based",
    actionLimits: { "files.write": { perDay: 10 } },
  },
  {
    match: /(?:カスタマー|顧客対応|サポート|support)/i,
    displayName: "顧客対応AI社員",
    roleLabel: "カスタマーサポート",
    purposes: ["support.reply", "support.triage"],
    scopes: ["tools:read", "mail:draft", "mail:send", "approvals:request", "audit:append"],
    approvalPolicy: "risk_based",
    actionLimits: { "mail.send": { perDay: 30, perMonth: 500 } },
  },
  {
    match: /(?:採用|人事|履歴書|HR|recruit)/i,
    displayName: "採用AI社員",
    roleLabel: "採用アシスタント",
    purposes: ["hr.screening", "hr.schedule"],
    scopes: [
      "tools:read",
      "files:read",
      "mail:draft",
      "calendar:propose",
      "approvals:request",
      "audit:append",
    ],
    approvalPolicy: "always_human",
    actionLimits: { "calendar.confirm": { perDay: 10 }, "mail.send": { perDay: 15 } },
  },
  {
    match: /(?:リサーチ|調査|調べ|research)/i,
    displayName: "調査AI社員",
    roleLabel: "リサーチ",
    purposes: ["research.web", "research.summary"],
    scopes: ["tools:read", "browser:use", "files:write", "audit:append"],
    approvalPolicy: "risk_based",
    actionLimits: { "files.write": { perDay: 10 } },
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
    actionLimits: { "commerce.order": { perMonth: 5 } },
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


/** Job text implies ordering / purchase — auto-enable commerce:order in draft. */
export function jobTextImpliesCommerceOrder(rawInput: string): boolean {
  return /(?:発注|注文|購入|購買|調達|決済|買い物|commerce|order|purchase|buy)/i.test(
    rawInput.trim()
  );
}

/**
 * Deterministic Japanese NL → least-privilege policy draft.
 * Pattern adapted from Sealith ai-settings interpret; scopes rewritten for Grok Bot.
 */
function buildEmployeePolicyDraftForProfile(
  rawInput: string,
  forcedProfile?: (typeof ROLE_PROFILES)[number]
): EmployeePolicyDraft {
  const input = rawInput.trim();
  const profile = forcedProfile ?? ROLE_PROFILES.find((p) => p.match.test(input));
  const splitMode = Boolean(forcedProfile);

  const wantsSend = !splitMode && /(?:送信|送る|メールを出す|外部送信|send mail)/i.test(input);
  const wantsDraftOnly =
    !splitMode && /(?:下書き|draft)/i.test(input) && !wantsSend;
  const wantsOrder = !splitMode && jobTextImpliesCommerceOrder(input);
  const wantsBrowser = !splitMode && /(?:ブラウザ|ウェブ|検索|調べ|browse|research)/i.test(input);
  const wantsWrite = !splitMode && /(?:書込|編集|作成|ファイルを作|write|edit)/i.test(input);
  const wantsCalendarConfirm =
    !splitMode && /(?:日程.?確定|予定を入れる|invite|カレンダー.?確定|予定確定|commit.?calendar)/i.test(input);
  const wantsCalendarPropose =
    (!splitMode && /(?:空き|候補|日程.?提案|カレンダー|schedule|面接枠)/i.test(input)) ||
    wantsCalendarConfirm;
  const explicitAlwaysHuman =
    /(?:必ず承認|毎回承認|人間が許可|always.?human|要承認のみ)/i.test(input);
  const preferRiskBased = /(?:少額は自動|リスクベース|risk.?based)/i.test(input);

  const scopes = unique<EmployeeScope>([
    ...(profile?.scopes ?? DEFAULT_SCOPES),
    ...(wantsSend || wantsDraftOnly
      ? (["mail:draft"] as EmployeeScope[])
      : []),
    ...(wantsSend ? (["mail:send"] as EmployeeScope[]) : []),
    ...(wantsCalendarPropose ? (["calendar:propose"] as EmployeeScope[]) : []),
    ...(wantsCalendarConfirm ? (["calendar:confirm"] as EmployeeScope[]) : []),
    ...(wantsOrder ? (["commerce:quote", "commerce:order"] as EmployeeScope[]) : []),
    ...(wantsBrowser ? (["browser:use"] as EmployeeScope[]) : []),
    ...(wantsWrite ? (["files:write"] as EmployeeScope[]) : []),
    "approvals:request",
    "audit:append",
  ]);

  // confirm / send / order / browser → always_human default (Ando A + §3).
  const approvalPolicy: ApprovalPolicy = suggestEmployeeApprovalPolicy({
    scopes,
    explicitAlwaysHuman,
    preferRiskBased,
  });

  const spend: SpendLimits | null = scopes.includes("commerce:order")
    ? { ...DEFAULT_SPEND_LIMITS }
    : null;
  const sodVerdict = evaluateSod(scopes);
  const effectiveApprovalPolicy: ApprovalPolicy =
    sodVerdict.level === "force_human" ? "always_human" : approvalPolicy;

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
    assumptions.push(
      "mail.send は常に人間承認（always_human）。下書き（mail.draft）のみ自動可。"
    );
  }
  if (wantsCalendarConfirm) {
    assumptions.push(
      "calendar.confirm（日程確定）は always_human。提案（calendar.propose）のみ自動可。"
    );
  } else if (wantsCalendarPropose) {
    assumptions.push("カレンダーは提案（propose）まで。確定は別ツールで人間承認が必要です。");
  }
  if (scopes.includes("commerce:order")) {
    assumptions.push(
      wantsOrder
        ? "職務文から発注・購入が必要と読み取り、発注権限（commerce:order）を案に含めました。外すこともできます。"
        : "発注は予算・承認ステップで上限を設定できます。Draft の「常に人間承認」は初期推奨であり、固定ではありません。"
    );
  }
  assumptions.push(
    "needs_approval 時は署名付き status poll URL を承認/却下まで待つ（Partner webhook 実装までは poll 必須）。発行後の Instructions / Routine に貼ってください。"
  );
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
  if (scopes.includes("calendar:confirm")) warnings.push("calendar_confirm_requested");
  if (scopes.includes("commerce:order")) warnings.push("commerce_order_requested");
  if (scopes.includes("browser:use")) warnings.push("browser_use_requested");
  if (effectiveApprovalPolicy === "always_human") warnings.push("always_human_recommended");

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
      approvalPolicy: effectiveApprovalPolicy,
      actionLimits: profile?.actionLimits ?? {},
      expiresInDays: extractExpiryDays(input) ?? 30,
      spend,
      spendRecommendation,
      allowedAccounts,
      voice: defaultVoice(),
      toolApprovalDefaults: toolApprovalHintsFromPresets(),
    },
    sodVerdict,
    assumptions,
    missingFields,
    warnings,
    confidence: profile ? 0.86 : 0.55,
    source: "rules",
  };
}

export function buildEmployeePolicyDraft(rawInput: string): EmployeePolicyDraft {
  return buildEmployeePolicyDraftForProfile(rawInput);
}

export function buildEmployeePolicyDrafts(rawInput: string): EmployeePolicyDraft[] {
  const input = rawInput.trim();
  const matches = ROLE_PROFILES.filter((profile) => profile.match.test(input));
  if (matches.length <= 1) return [buildEmployeePolicyDraftForProfile(input)];
  return matches.map((profile) => buildEmployeePolicyDraftForProfile(input, profile));
}

export const ALL_SCOPES: EmployeeScope[] = [
  "tools:read",
  "tools:invoke",
  "calendar:read",
  "mail:draft",
  "mail:send",
  "agentmail:draft",
  "agentmail:send",
  "calendar:propose",
  "calendar:confirm",
  "files:read",
  "files:write",
  "browser:use",
  "commerce:quote",
  "commerce:order",
  "slack:post",
  "slack:post_external",
  "drive:share_external",
  "knowledge:search",
  "audit:append",
  "approvals:request",
];

export const SCOPE_LABELS: Record<EmployeeScope, string> = {
  "tools:read": "ツール読取",
  "tools:invoke": "ツール実行",
  "calendar:read": "カレンダー参照",
  "mail:draft": "メール下書き",
  "mail:send": "メール送信（要承認）",
  "agentmail:draft": "AI専用メール下書き",
  "agentmail:send": "AI専用メール送信",
  "calendar:propose": "日程提案",
  "calendar:confirm": "日程確定（要承認）",
  "files:read": "ファイル読取",
  "files:write": "ファイル書込",
  "browser:use": "ブラウザ利用",
  "commerce:quote": "見積作成",
  "commerce:order": "発注・購入",
  "slack:post": "Slack社内投稿",
  "slack:post_external": "Slack社外投稿",
  "drive:share_external": "Drive社外共有",
  "knowledge:search": "ナレッジ検索",
  "audit:append": "監査追記",
  "approvals:request": "承認申請",
};

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  auto: "自動許可（低リスクのみ）",
  always_human: "常に人間承認",
  risk_based: "リスクベース",
};
