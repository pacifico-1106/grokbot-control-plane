/**
 * JP SME strict approval presets (Ando minimum-map §3 + Kimura P0).
 * These are AI-employee *action* defaults — distinct from human team RBAC
 * (who may press the approve button).
 */

import type { ApprovalPolicy } from "@/lib/types";

export type ToolApprovalDefault =
  | "always_human"
  | "risk_based"
  | "auto"
  | "deny";

export interface ApprovalPresetRow {
  /** Gateway tool id (dot form) or logical action key */
  tool: string;
  labelJa: string;
  defaultMode: ToolApprovalDefault;
  note?: string;
}

/** Mid-size / SME Managed 初期値 — 厳しめ。企業は社員証で緩められる。 */
export const JP_SME_STRICT_APPROVAL_PRESETS: ApprovalPresetRow[] = [
  {
    tool: "mail.send",
    labelJa: "社外へのメール送信（AgentMail）",
    defaultMode: "always_human",
    note: "初回・新規宛先は必須。以降は risk_based 可（宛先ドメイン許可と併用）",
  },
  {
    tool: "mail.draft",
    labelJa: "メール下書き",
    defaultMode: "auto",
    note: "外部送信前に mail.send へ接続",
  },
  {
    tool: "calendar.confirm",
    labelJa: "日程の確定（Calendar invite 送付・承諾）",
    defaultMode: "always_human",
    note: "空いている＝入れてよい、ではない",
  },
  {
    tool: "calendar.propose",
    labelJa: "空き枠の提案のみ",
    defaultMode: "auto",
  },
  {
    tool: "calendar.read",
    labelJa: "社内カレンダー参照",
    defaultMode: "auto",
  },
  {
    tool: "slack.post",
    labelJa: "Slack 投稿（エイリアス。相手台帳が境界）",
    defaultMode: "risk_based",
    note: "ツール名では社内/社外を自己申告できない。宛先の audience で判定",
  },
  {
    tool: "slack.post_external",
    labelJa: "Slack 投稿エイリアス（ツール名は境界ではない）",
    defaultMode: "risk_based",
    note: "slack.post と同じ audience resolver。社外宛は matrix に従う",
  },
  {
    tool: "comm.send",
    labelJa: "会話送信（surface + 宛先必須）",
    defaultMode: "risk_based",
    note: "宛先欠落は unknown=社外で fail-closed",
  },
  {
    tool: "comm.reply",
    labelJa: "会話返信（surface + 宛先必須）",
    defaultMode: "risk_based",
  },
  {
    tool: "commerce.order",
    labelJa: "課金・購入・決済",
    defaultMode: "always_human",
    note: "予算超過は常に必須。Staffpass SaaS 課金（Stripe）とは別物",
  },
  {
    tool: "commerce.quote",
    labelJa: "見積作成",
    defaultMode: "risk_based",
  },
  {
    tool: "files.write",
    labelJa: "顧客マスタ／契約データの更新・削除",
    defaultMode: "always_human",
  },
  {
    tool: "data.export",
    labelJa: "顧客データのエクスポート",
    defaultMode: "always_human",
  },
  {
    tool: "drive.share_external",
    labelJa: "Drive への社外共有リンク発行",
    defaultMode: "always_human",
  },
  {
    tool: "browser.use",
    labelJa: "ブラウザでのログイン状態を使った操作",
    defaultMode: "always_human",
    note: "allowedAccounts 不一致なら停止",
  },
  {
    tool: "account.unallowed",
    labelJa: "許可外アカウントへの操作",
    defaultMode: "deny",
  },
  {
    tool: "credential.self_modify",
    labelJa: "社員証・権限の自己変更",
    defaultMode: "deny",
    note: "人間のダッシュボードのみ",
  },
  {
    tool: "audit.delete",
    labelJa: "監査ログの削除・改ざん",
    defaultMode: "deny",
  },
  {
    tool: "knowledge.search",
    labelJa: "社内ナレッジ検索・下書き作成",
    defaultMode: "auto",
  },
  {
    tool: "resend.notify",
    labelJa: "承認依頼リマインド（制御面 Resend）",
    defaultMode: "auto",
    note: "AI社員の会話チャネルではない",
  },
];

/** Must-approve subset for hire UI / docs. */
export function alwaysHumanMustList(): ApprovalPresetRow[] {
  return JP_SME_STRICT_APPROVAL_PRESETS.filter(
    (r) => r.defaultMode === "always_human"
  );
}

export function denyDefaultList(): ApprovalPresetRow[] {
  return JP_SME_STRICT_APPROVAL_PRESETS.filter((r) => r.defaultMode === "deny");
}

/**
 * Map preset rows → per-tool ApprovalPolicy hints for a draft.
 * deny rows are omitted (gateway reject / scope off).
 */
export function toolApprovalHintsFromPresets(): Record<
  string,
  Exclude<ApprovalPolicy, "auto"> | "auto" | "deny"
> {
  const out: Record<string, ApprovalPolicy | "deny"> = {};
  for (const row of JP_SME_STRICT_APPROVAL_PRESETS) {
    out[row.tool] = row.defaultMode;
  }
  return out;
}

/**
 * Employee-level default. Tool-level force (mail.send, calendar.confirm,
 * commerce.order, browser.use) stays in the Gateway — do not bump the
 * badge to always_human just because those scopes are on.
 */
export function suggestEmployeeApprovalPolicy(input: {
  scopes: string[];
  explicitAlwaysHuman?: boolean;
  /** Kept for callers; tool-level confirm/send/order still force human. */
  preferRiskBased?: boolean;
}): ApprovalPolicy {
  void input.scopes;
  void input.preferRiskBased;
  if (input.explicitAlwaysHuman) return "always_human";
  return "risk_based";
}

export const CHOOSABLE_TOOL_APPROVALS = ["mail.send", "calendar.confirm"] as const;
export type ChoosableToolApproval = (typeof CHOOSABLE_TOOL_APPROVALS)[number];

export const TOOL_APPROVAL_CHOICE_LABELS: Record<ApprovalPolicy, string> = {
  always_human: "毎回人が見る",
  risk_based: "危ないときだけ人が見る",
  auto: "自動",
};

const STRICT_CHOOSABLE_DEFAULTS: Record<ChoosableToolApproval, ApprovalPolicy> = {
  "mail.send": "always_human",
  "calendar.confirm": "always_human",
};

/** New-hire / missing keys stay always_human for send and confirm. */
export function normalizeToolApprovalDefaults(
  value: unknown
): Record<string, ApprovalPolicy | "deny"> {
  const out: Record<string, ApprovalPolicy | "deny"> = {
    ...STRICT_CHOOSABLE_DEFAULTS,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const src = value as Record<string, unknown>;
  for (const tool of CHOOSABLE_TOOL_APPROVALS) {
    const raw = src[tool];
    if (raw === "always_human" || raw === "risk_based" || raw === "auto") {
      out[tool] = raw;
    }
  }
  return out;
}
