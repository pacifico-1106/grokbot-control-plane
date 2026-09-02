/**
 * Dashboard humans cannot mutate scopes / purposes / actionLimits.
 * Those writes go through admin MCP (always_human). Identity / manager /
 * voice / inbox / project patches may re-post the existing values.
 */
import type { ActionLimits } from "@/lib/types";

export const DASHBOARD_POLICY_LOCKED = "admin_mcp_required";
export const DASHBOARD_POLICY_LOCKED_JA =
  "権限（できること・使う理由・行為上限）の変更は管理MCPの人承認です";
export const DASHBOARD_DIRECTORY_LOCKED_JA =
  "相手台帳の変更は管理MCPの人承認です";

function sameSorted(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return left.every((value, i) => value === right[i]);
}

function normalizeLimits(limits: ActionLimits | Record<string, unknown> | null | undefined): string {
  const rec = limits && typeof limits === "object" ? limits : {};
  const keys = Object.keys(rec).sort();
  const out: Record<string, { perDay?: number; perMonth?: number }> = {};
  for (const key of keys) {
    const row = rec[key];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as { perDay?: unknown; perMonth?: unknown };
    const next: { perDay?: number; perMonth?: number } = {};
    if (typeof item.perDay === "number" && Number.isFinite(item.perDay)) {
      next.perDay = item.perDay;
    }
    if (typeof item.perMonth === "number" && Number.isFinite(item.perMonth)) {
      next.perMonth = item.perMonth;
    }
    if (next.perDay != null || next.perMonth != null) out[key] = next;
  }
  return JSON.stringify(out);
}

export function dashboardLockedPolicyChanged(input: {
  existing: {
    scopes: readonly string[];
    allowedPurposes: readonly string[];
    actionLimits?: ActionLimits | Record<string, unknown> | null;
  };
  posted: {
    scopes: readonly string[];
    allowedPurposes: readonly string[];
    actionLimits?: ActionLimits | Record<string, unknown> | null;
  };
}): boolean {
  if (!sameSorted(input.existing.scopes, input.posted.scopes)) return true;
  if (!sameSorted(input.existing.allowedPurposes, input.posted.allowedPurposes)) {
    return true;
  }
  return normalizeLimits(input.existing.actionLimits) !== normalizeLimits(input.posted.actionLimits);
}
