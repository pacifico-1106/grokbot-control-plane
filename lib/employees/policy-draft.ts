import type { ActionLimits, ApprovalPolicy, EmployeePolicyDraft, EmployeeScope, SpendLimits } from "@/lib/types";
import { hintAllowedAccountsFromText } from "@/lib/employees/allowed-accounts";
import {
  suggestEmployeeApprovalPolicy,
  toolApprovalHintsFromPresets,
} from "@/lib/employees/approval-presets";
import { sanitizePurposes } from "@/lib/employees/purposes";
import { DEFAULT_SPEND_LIMITS } from "@/lib/spend-gate";
import { evaluateSod } from "@/lib/employees/sod";
import { defaultVoice } from "@/lib/employees/voice";
import { defaultProjectAccess } from "@/lib/employees/project-access";

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
    match: /(?:秘書|secretary|セクレタリ|社長室)/i,
    displayName: "秘書AI社員",
    roleLabel: "秘書",
    purposes: ["ops.admin", "calendar.propose", "comm.internal"],
    scopes: [
      "tools:read",
      "mail:draft",
      "calendar:propose",
      "slack:post",
      "approvals:request",
      "audit:append",
    ],
    approvalPolicy: "risk_based",
    actionLimits: { "mail.send": { perDay: 10, perMonth: 100 } },
  },
  {
    match: /(?:営業|見積|セールス|sales|outreach)/i,
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
    match: /(?:事業開発|biz\s*dev|ビズデブ|アライアンス)/i,
    displayName: "事業開発AI社員",
    roleLabel: "事業開発",
    purposes: ["sales.outreach", "calendar.propose", "comm.internal"],
    scopes: [
      "tools:read",
      "mail:draft",
      "calendar:propose",
      "slack:post",
      "approvals:request",
      "audit:append",
    ],
    approvalPolicy: "risk_based",
    actionLimits: { "mail.send": { perDay: 15, perMonth: 200 } },
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
    approvalPolicy: "risk_based",
    actionLimits: { "calendar.confirm": { perDay: 10 }, "mail.send": { perDay: 15 } },
  },
  {
    match: /(?:リサーチ|調査|research)/i,
    displayName: "調査AI社員",
    roleLabel: "リサーチ",
    purposes: ["research.web", "research.summary"],
    scopes: ["tools:read", "browser:use", "files:write", "audit:append"],
    approvalPolicy: "risk_based",
    actionLimits: { "files.write": { perDay: 10 } },
  },
  {
    match: /(?:購買|発注|購入|調達|purchasing|procurement)/i,
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
    approvalPolicy: "risk_based",
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
  return /(?:発注|購入|購買|調達|決済|commerce\.order|commerce:order|purchasing|procurement)/i.test(
    rawInput.trim()
  );
}

function inferPurposes(
  input: string,
  profile: (typeof ROLE_PROFILES)[number] | undefined,
  extras: { wantsOrder: boolean; wantsCalendarPropose: boolean; wantsCalendarConfirm: boolean }
): string[] {
  const found = [...(profile?.purposes ?? [])];
  if (/(?:社内|メンション|slack|スラック|返信)/i.test(input)) found.push("comm.internal");
  if (extras.wantsCalendarPropose || /(?:日程|カレンダー|候補|schedule)/i.test(input)) {
    found.push("calendar.propose");
  }
  if (extras.wantsCalendarConfirm) found.push("calendar.confirm");
  if (extras.wantsOrder) found.push("commerce.order");
  const cleaned = sanitizePurposes(found);
  return cleaned.length ? cleaned : ["ops.admin"];
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
  const wantsBrowser =
    !splitMode && /(?:ブラウザ|browser\.use|browser:use|web\s*brows)/i.test(input);
  const wantsWrite =
    !splitMode && /(?:ファイルを(書|作)|書込|files\.write|files:write)/i.test(input);
  const wantsCalendarConfirm =
    !splitMode && /(?:日程.?確定|予定を入れる|invite|カレンダー.?確定|予定確定|commit.?calendar)/i.test(input);
  const wantsCalendarPropose =
    (!splitMode && /(?:空き|候補|日程.?提案|カレンダー|schedule|面接枠)/i.test(input)) ||
    wantsCalendarConfirm;
  const explicitAlwaysHuman =
    /(?:必ず承認|毎回承認|人間が許可|always.?human|要承認のみ|毎回人が見る|毎回人間)/i.test(input);
  const preferRiskBased = /(?:少額は自動|リスクベース|risk.?based|危ないときだけ)/i.test(input);

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

  // Tool-level force stays in Gateway. Employee badge stays risk_based
  // unless the job text asked for always_human.
  const approvalPolicy: ApprovalPolicy = suggestEmployeeApprovalPolicy({
    scopes,
    explicitAlwaysHuman,
    preferRiskBased,
  });

  const spend: SpendLimits | null = scopes.includes("commerce:order")
    ? { ...DEFAULT_SPEND_LIMITS }
    : null;
  const sodVerdict = evaluateSod(scopes);
  // SoD warning is separate (hire UI ack). Do not rewrite employee-level policy here.
  const effectiveApprovalPolicy: ApprovalPolicy = approvalPolicy;

  const spendRecommendation = scopes.includes("commerce:order")
    ? "発注はツール強制で必ず人が見ます。社員全体はリスクベースのままにできます。慣れたら少額上限（例: 1件3,000円）を足せます。"
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

  const purposes = inferPurposes(input, profile, {
    wantsOrder,
    wantsCalendarPropose,
    wantsCalendarConfirm,
  });

  const assumptions: string[] = [];
  if (!profile) {
    assumptions.push("職務が特定できないため、汎用の業務支援ロールにしています。");
  }
  if (!extractExpiryDays(input)) {
    assumptions.push("社員証の有効期限は30日後にしています。");
  }
  if (wantsSend || scopes.includes("mail:send")) {
    assumptions.push(
      "メール送信はツール強制で必ず人が見ます。社員全体の承認はリスクベースのままです。"
    );
  }
  if (wantsCalendarConfirm) {
    assumptions.push(
      "予定の確定はツール強制で必ず人が見ます。候補を出すだけなら自動で進められます。"
    );
  } else if (wantsCalendarPropose || scopes.includes("calendar:propose")) {
    assumptions.push("カレンダーは候補を出すまで。確定は人が止めます。");
  }
  if (scopes.includes("commerce:order")) {
    assumptions.push(
      wantsOrder
        ? "職務文から発注・購入が必要と読み取り、発注を案に含めました。外すこともできます。発注は必ず人が見ます。"
        : "発注は予算・承認ステップで上限を設定できます。確定操作は人が止めます。"
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
  if (!profile) warnings.push("broad_purpose_access");
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
      projectAccess: defaultProjectAccess(),
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

/** One plain Japanese line of the actual capability (hire / policy chips). */
export const SCOPE_LABELS: Record<EmployeeScope, string> = {
  "tools:read": "社内ツールの内容を読む",
  "tools:invoke": "社内ツールを動かす",
  "calendar:read": "カレンダーを見る",
  "mail:draft": "メールの下書きを作る",
  "mail:send": "メールを送る",
  "agentmail:draft": "AI専用メールの下書きを作る",
  "agentmail:send": "AI専用メールを送る",
  "calendar:propose": "日程の候補を出す",
  "calendar:confirm": "予定を確定する",
  "files:read": "ファイルを読む",
  "files:write": "ファイルを書く",
  "browser:use": "ブラウザで操作する",
  "commerce:quote": "見積を作る",
  "commerce:order": "発注・購入する",
  "slack:post": "社内Slackに投稿する",
  "slack:post_external": "社外混在のSlackに投稿する",
  "drive:share_external": "Driveを社外に共有する",
  "knowledge:search": "社内ナレッジを探す",
  "audit:append": "監査ログに残す",
  "approvals:request": "人の承認を依頼する",
};

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  auto: "低リスクのみ自動",
  always_human: "毎回人が見る",
  risk_based: "危ないときだけ人が見る",
};

export const HIRE_APPROVAL_CHOICES: Array<{
  value: Exclude<ApprovalPolicy, "auto">;
  label: string;
  hint: string;
}> = [
  {
    value: "risk_based",
    label: "危ないときだけ人が見る",
    hint: "下書きや社内返信は進めてよい。送信・発注・日程確定は人が止めます。",
  },
  {
    value: "always_human",
    label: "毎回人が見る",
    hint: "すべての行為を人が確認してから進みます。",
  },
];
