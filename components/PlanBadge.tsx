"use client";

import type { PlanKey } from "@/lib/billing/plan-scopes";
import { PLAN_DISPLAY_INFO } from "@/lib/billing/plan-scopes";

type PlanBadgeProps = {
  planKey: PlanKey | null;
  showDescription?: boolean;
  className?: string;
};

const PLAN_BADGE_COLORS: Record<PlanKey | "legacy", string> = {
  intern: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  proper: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  executive: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  legacy: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export function PlanBadge({ planKey, showDescription, className = "" }: PlanBadgeProps) {
  const colorKey = planKey ?? "legacy";
  const colors = PLAN_BADGE_COLORS[colorKey];
  const displayInfo = planKey ? PLAN_DISPLAY_INFO[planKey] : null;
  const label = displayInfo?.nameJa ?? "Legacy";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${colors} ${className}`}
      title={showDescription && displayInfo ? displayInfo.descriptionJa : undefined}
    >
      {label}
      {showDescription && displayInfo?.businessCapacity ? (
        <span className="text-[10px] opacity-75">({displayInfo.businessCapacity})</span>
      ) : null}
    </span>
  );
}

type PlanBadgeInlineProps = {
  planKey: PlanKey;
};

export function PlanBadgeInline({ planKey }: PlanBadgeInlineProps) {
  const displayInfo = PLAN_DISPLAY_INFO[planKey];
  return (
    <span className="text-xs text-[var(--text-muted)]">
      {displayInfo.nameJa}
    </span>
  );
}
