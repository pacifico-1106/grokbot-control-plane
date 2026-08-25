import type { ActionLimits } from "@/lib/types";

export type ActionDecision = "allow" | "needs_approval" | "deny";

export type ActionLimitResult = {
  decision: ActionDecision;
  reason: string;
  message: string;
  limit?: { period: "day" | "month"; value: number; count: number };
};

function validLimit(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeActionLimits(value: unknown): ActionLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, { perDay?: number; perMonth?: number }]> = [];
  for (const [tool, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const perDay = validLimit(obj.perDay);
    const perMonth = validLimit(obj.perMonth);
    if (!perDay && !perMonth) continue;
    entries.push([tool.trim(), {
      ...(perDay ? { perDay } : {}),
      ...(perMonth ? { perMonth } : {}),
    }]);
  }
  return Object.fromEntries(entries.filter(([tool]) => tool));
}

export function evaluateActionLimit(input: {
  tool: string;
  limits: ActionLimits | null | undefined;
  countToday: number;
  countThisMonth: number;
}): ActionLimitResult {
  const limit = input.limits?.[input.tool];
  if (!limit) return { decision: "allow", reason: "limit_not_set", message: "行為上限は未設定です。" };

  const checks = [
    { period: "day" as const, value: validLimit(limit.perDay), count: Math.max(0, input.countToday) },
    { period: "month" as const, value: validLimit(limit.perMonth), count: Math.max(0, input.countThisMonth) },
  ].filter((item): item is { period: "day" | "month"; value: number; count: number } => item.value !== null);

  const denied = checks.find((item) => item.count >= item.value * 2);
  if (denied) {
    return {
      decision: "deny",
      reason: `action_limit_${denied.period}_hard_stop`,
      message: `${denied.period === "day" ? "本日" : "今月"}の実行数が上限の2倍（${denied.value * 2}件）に達したため停止しました。`,
      limit: denied,
    };
  }
  const reached = checks.find((item) => item.count >= item.value);
  if (reached) {
    return {
      decision: "needs_approval",
      reason: `action_limit_${reached.period}_reached`,
      message: `${reached.period === "day" ? "本日" : "今月"}の実行上限（${reached.value}件）に達したため、人の確認が必要です。`,
      limit: reached,
    };
  }
  return { decision: "allow", reason: "within_action_limit", message: "行為上限内です。" };
}
