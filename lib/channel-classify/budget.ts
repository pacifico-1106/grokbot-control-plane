/**
 * PR-B follow-up H1: per-org hourly caps for automatic proposals and stuck
 * notices. One window per org × key; over the cap the caller gets
 * "over_first" exactly once per window (→ one summary notice) and "over"
 * afterwards (→ nothing). DB store unavailable / denied → a per-instance
 * window with the same limits (never unlimited, never silent).
 */
import { takeChannelClassifyBudget } from "@/lib/data/channel-classify";
import { takeFromWindow } from "@/lib/data/channel-classify-budget";

export const BUDGET_WINDOW_SECONDS = 60 * 60;
export const DEFAULT_MAX_PROPOSALS_PER_HOUR = 20;
export const DEFAULT_MAX_NOTICES_PER_HOUR = 30;
const MAX_ALLOWED = 200;
const MAX_FALLBACK_KEYS = 2_000;

export type BudgetKey = "proposals" | "notices";
export type BudgetVerdict = "allowed" | "over_first" | "over";

function bounded(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_ALLOWED);
}

export function maxProposalsPerHour(): number {
  return bounded(process.env.CHANNEL_CLASSIFY_MAX_PROPOSALS_PER_HOUR, DEFAULT_MAX_PROPOSALS_PER_HOUR);
}

export function maxNoticesPerHour(): number {
  return bounded(process.env.CHANNEL_STUCK_MAX_NOTICES_PER_HOUR, DEFAULT_MAX_NOTICES_PER_HOUR);
}

const fallback = new Map<string, { windowStartMs: number; used: number; overflow: number; summarySent: boolean }>();

export function resetChannelClassifyBudgetFallbackForTests(): void {
  fallback.clear();
}

/** Take one unit of the org's budget. Never throws. */
export async function takeOrgBudget(orgId: string, key: BudgetKey, max: number): Promise<BudgetVerdict> {
  const taken = await takeChannelClassifyBudget({ orgId, key, windowSeconds: BUDGET_WINDOW_SECONDS, max }).catch(
    () => ({ state: "unavailable" }) as const
  );
  if (taken.state === "allowed" || taken.state === "over_first" || taken.state === "over") return taken.state;
  if (fallback.size >= MAX_FALLBACK_KEYS) fallback.clear();
  const local = takeFromWindow(fallback, `${orgId}\u0000${key}`, BUDGET_WINDOW_SECONDS, Math.max(1, max), Date.now());
  return local.state === "allowed" || local.state === "over_first" ? local.state : "over";
}
