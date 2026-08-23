/**
 * Plan codes + placeholder quotas (Ando BM P0).
 * Client-safe — no Supabase / audit imports.
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

export const QUOTA_PROVISIONAL_NOTE_JA =
  "仮枠・事業確定前（表示用。本番の請求枠は契約後に確定します）";

export function confirmQuotaForPlan(
  plan: PlanCode | string | null | undefined
): number {
  const key = (plan || "business") as PlanCode;
  return PLAN_CONFIRM_QUOTAS[key] ?? PLAN_CONFIRM_QUOTAS.business;
}
