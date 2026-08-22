import type { ApprovalPolicy, SpendLimits } from "@/lib/types";

export type SpendDecision = "allow" | "needs_approval" | "deny";

export type SpendDenyReason =
  | "missing_limits"
  | "always_human"
  | "first_order"
  | "max_per_order_zero"
  | "over_per_order"
  | "over_per_day"
  | "over_per_month"
  | "invalid_amount";

export interface EvaluateSpendInput {
  amountJpy: number;
  limits: SpendLimits | null | undefined;
  approvalPolicy: ApprovalPolicy;
  /** Default true (fail-closed) when unknown. */
  isFirstOrder?: boolean;
  /** Optional running totals for day/month caps (JPY). */
  spentTodayJpy?: number;
  spentThisMonthJpy?: number;
}

export interface EvaluateSpendResult {
  decision: SpendDecision;
  reason: SpendDenyReason | "within_limits" | "auto_policy";
  message: string;
}

const DEFAULT_FIRST_ORDER = true;

/**
 * Fail-closed spend gate for commerce.order.
 * Missing limits + order scope ⇒ needs_approval (never silent allow).
 */
export function evaluateSpend(input: EvaluateSpendInput): EvaluateSpendResult {
  const amount = Number(input.amountJpy);
  if (!Number.isFinite(amount) || amount < 0) {
    return {
      decision: "deny",
      reason: "invalid_amount",
      message: "金額が不正です（発注を拒否）",
    };
  }

  if (input.approvalPolicy === "always_human") {
    return {
      decision: "needs_approval",
      reason: "always_human",
      message: "承認ポリシーが「常に人間承認」のため、社長の許可が必要です",
    };
  }

  const limits = input.limits;
  if (!limits) {
    return {
      decision: "needs_approval",
      reason: "missing_limits",
      message:
        "予算上限が未設定のため自動発注できません（fail-closed → 人間承認）",
    };
  }

  const firstOrderRequires =
    limits.firstOrderRequiresHuman ?? DEFAULT_FIRST_ORDER;
  const isFirst = input.isFirstOrder ?? true;
  if (isFirst && firstOrderRequires) {
    return {
      decision: "needs_approval",
      reason: "first_order",
      message: "初回発注は必ず人間承認が必要です",
    };
  }

  const maxPerOrder = Number(limits.maxPerOrderJpy);
  if (!Number.isFinite(maxPerOrder) || maxPerOrder < 0) {
    return {
      decision: "needs_approval",
      reason: "missing_limits",
      message: "1件あたり上限が未設定のため人間承認が必要です",
    };
  }

  if (maxPerOrder === 0) {
    return {
      decision: "deny",
      reason: "max_per_order_zero",
      message: "1件あたり上限が 0円のため発注禁止です（または人間承認へ切替）",
    };
  }

  if (amount > maxPerOrder) {
    return {
      decision: "needs_approval",
      reason: "over_per_order",
      message: `1件あたり上限（¥${maxPerOrder.toLocaleString("ja-JP")}）を超えるため承認が必要です`,
    };
  }

  const spentToday = Number(input.spentTodayJpy ?? 0);
  const maxDay = limits.maxPerDayJpy;
  if (
    maxDay != null &&
    Number.isFinite(maxDay) &&
    maxDay > 0 &&
    spentToday + amount > maxDay
  ) {
    return {
      decision: "needs_approval",
      reason: "over_per_day",
      message: `日次上限（¥${maxDay.toLocaleString("ja-JP")}）を超えるため承認が必要です`,
    };
  }

  const spentMonth = Number(input.spentThisMonthJpy ?? 0);
  const maxMonth = limits.maxPerMonthJpy;
  if (
    maxMonth != null &&
    Number.isFinite(maxMonth) &&
    maxMonth > 0 &&
    spentMonth + amount > maxMonth
  ) {
    return {
      decision: "needs_approval",
      reason: "over_per_month",
      message: `月次上限（¥${maxMonth.toLocaleString("ja-JP")}）を超えるため承認が必要です`,
    };
  }

  if (input.approvalPolicy === "auto") {
    return {
      decision: "allow",
      reason: "auto_policy",
      message: "自動許可ポリシーかつ上限内のため許可",
    };
  }

  // risk_based: within limits → allow
  return {
    decision: "allow",
    reason: "within_limits",
    message: "リスクベースかつ少額上限内のため自動許可",
  };
}

export const DEFAULT_SPEND_LIMITS: SpendLimits = {
  maxPerOrderJpy: 3000,
  maxPerDayJpy: null,
  maxPerMonthJpy: null,
  merchantAllowTip: null,
  firstOrderRequiresHuman: true,
};

export function normalizeSpendLimits(
  raw: Partial<SpendLimits> | null | undefined
): SpendLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const maxPerOrderJpy = Number(
    raw.maxPerOrderJpy ?? DEFAULT_SPEND_LIMITS.maxPerOrderJpy
  );
  return {
    maxPerOrderJpy: Number.isFinite(maxPerOrderJpy) ? maxPerOrderJpy : 3000,
    maxPerDayJpy:
      raw.maxPerDayJpy == null || raw.maxPerDayJpy === ("" as unknown)
        ? null
        : Number(raw.maxPerDayJpy),
    maxPerMonthJpy:
      raw.maxPerMonthJpy == null || raw.maxPerMonthJpy === ("" as unknown)
        ? null
        : Number(raw.maxPerMonthJpy),
    merchantAllowTip: raw.merchantAllowTip?.trim()
      ? String(raw.merchantAllowTip).trim()
      : null,
    firstOrderRequiresHuman: raw.firstOrderRequiresHuman ?? true,
  };
}
