"use client";

import Link from "next/link";
import { useAppSession } from "@/components/AppSessionProvider";
import { formatScheduledDowngradeMessage } from "@/lib/billing/plan-ui";

export function ScheduledPlanChangeBanner() {
  const { planRailsEnabled, scheduledPlanKey, scheduledPlanEffectiveAt } = useAppSession();

  if (!planRailsEnabled) {
    return null;
  }

  const message = formatScheduledDowngradeMessage(scheduledPlanKey, scheduledPlanEffectiveAt);
  if (!message) {
    return null;
  }

  return (
    <div className="surface mb-4 border-l-4 border-l-[var(--warn)] p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--warn)]">プラン変更予定</p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{message}</p>
        </div>
        <Link
          href="/app/billing"
          className="text-sm text-[var(--accent-strong)] hover:underline shrink-0"
        >
          詳細を見る
        </Link>
      </div>
    </div>
  );
}
