/**
 * Plan codes + provisional JPY display (Ando BM P0.5).
 * Client-safe — no Supabase / audit imports.
 *
 * displayYen / overageYen / onboardingYen are 税別・仮決め／事業確定前.
 * Stripe Dashboard Prices remain the source of truth for Checkout charges.
 */

export type PlanCode = "starter" | "business" | "managed";

/**
 * Placeholder monthly quotas for gated_confirm_action (確定アクション / 月).
 * Labeled 仮枠 in UI — business numbers not finalized.
 */
export const PLAN_CONFIRM_QUOTAS: Record<PlanCode, number> = {
  starter: 50,
  business: 500,
  managed: 2000,
};

/** Monthly plan fee (税別・仮決め), yen. */
export const PLAN_DISPLAY_YEN: Record<PlanCode, number> = {
  starter: 12_000,
  business: 39_800,
  managed: 128_000,
};

/** Overage per gated_confirm_action beyond quota (税別・仮決め), yen. Metered Stripe Price = P0.5 stub. */
export const PLAN_OVERAGE_YEN: Record<PlanCode, number> = {
  starter: 80,
  business: 40,
  managed: 25,
};

/**
 * One-time onboarding (税別・仮決め), yen.
 * business only — managed includes onboarding in monthly.
 */
export const PLAN_ONBOARDING_YEN: Partial<Record<PlanCode, number>> = {
  business: 150_000,
};

export const PRICING_PROVISIONAL_NOTE_JA =
  "税別・仮決め／事業確定前";

export const QUOTA_PROVISIONAL_NOTE_JA =
  "仮枠・事業確定前（表示用。本番の請求枠は契約後に確定します）";

export function confirmQuotaForPlan(
  plan: PlanCode | string | null | undefined
): number {
  const key = (plan || "business") as PlanCode;
  return PLAN_CONFIRM_QUOTAS[key] ?? PLAN_CONFIRM_QUOTAS.business;
}

export function formatYenJa(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

export function planDisplayLabel(plan: PlanCode): string {
  return `${formatYenJa(PLAN_DISPLAY_YEN[plan])} / 月`;
}
