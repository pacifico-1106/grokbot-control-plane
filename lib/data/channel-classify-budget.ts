/**
 * PR-B follow-up H1: per-org budget windows (channel_classify_budget_windows,
 * migration 20261005400000; service_role RPC only). Counts only — no channel
 * id, no content. Store errors → { state: "unavailable" } and the caller
 * falls back to a per-instance budget (never unlimited).
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export const BUDGET_KEY_RE = /^[a-z_]{2,40}$/;

export type BudgetTake =
  | { state: "allowed"; used: number }
  | { state: "over_first"; overflow: number }
  | { state: "over"; overflow: number }
  | { state: "denied" }
  | { state: "unavailable" };

type DemoWindow = { windowStartMs: number; used: number; overflow: number; summarySent: boolean };
const demoWindows = new Map<string, DemoWindow>();

export function resetDemoChannelClassifyBudgetStore(): void {
  demoWindows.clear();
}

export function validBudgetInput(input: { orgId: string; key: string; windowSeconds: number; max: number }): boolean {
  return (
    Boolean(input.orgId) &&
    BUDGET_KEY_RE.test(input.key) &&
    Number.isInteger(input.windowSeconds) &&
    input.windowSeconds >= 60 &&
    input.windowSeconds <= 86_400 &&
    Number.isInteger(input.max) &&
    input.max >= 1 &&
    input.max <= 1_000
  );
}

/** Same state machine as the SQL RPC (demo store and the per-instance fallback). */
export function takeFromWindow(map: Map<string, DemoWindow>, mapKey: string, windowSeconds: number, max: number, now: number): BudgetTake {
  const row = map.get(mapKey);
  if (!row || now - row.windowStartMs >= windowSeconds * 1000) {
    map.set(mapKey, { windowStartMs: now, used: 1, overflow: 0, summarySent: false });
    return { state: "allowed", used: 1 };
  }
  if (row.used < max) {
    row.used += 1;
    return { state: "allowed", used: row.used };
  }
  row.overflow += 1;
  const first = !row.summarySent;
  row.summarySent = true;
  return first ? { state: "over_first", overflow: row.overflow } : { state: "over", overflow: row.overflow };
}

export async function takeChannelClassifyBudget(input: {
  orgId: string;
  key: string;
  windowSeconds: number;
  max: number;
  nowMs?: number;
}): Promise<BudgetTake> {
  if (!validBudgetInput(input)) return { state: "denied" };
  if (isDemoMode()) {
    return takeFromWindow(demoWindows, `${input.orgId}\u0000${input.key}`, input.windowSeconds, input.max, input.nowMs ?? Date.now());
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { state: "unavailable" };
  try {
    const { data, error } = await admin.rpc("take_channel_classify_budget", {
      p_org: input.orgId,
      p_key: input.key,
      p_window_seconds: input.windowSeconds,
      p_max: input.max,
    });
    if (error || !data || typeof data !== "object") return { state: "unavailable" };
    const row = data as Record<string, unknown>;
    const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    switch (row.state) {
      case "allowed":
        return { state: "allowed", used: n(row.used) };
      case "over_first":
        return { state: "over_first", overflow: n(row.overflow) };
      case "over":
        return { state: "over", overflow: n(row.overflow) };
      case "denied":
        return { state: "denied" };
      default:
        return { state: "unavailable" };
    }
  } catch {
    return { state: "unavailable" };
  }
}
