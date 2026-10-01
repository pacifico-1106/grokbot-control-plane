"use client";

import Link from "next/link";
import type { PlanKey } from "@/lib/billing/plan-scopes";
import { PLAN_DISPLAY_INFO } from "@/lib/billing/plan-scopes";

type PlanUpgradeHintProps = {
  /** The plan required to access this feature */
  requiredPlan: PlanKey;
  /** Optional custom message */
  message?: string;
  /** Show as inline text instead of a banner */
  inline?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Show link to billing page */
  showBillingLink?: boolean;
};

export function PlanUpgradeHint({
  requiredPlan,
  message,
  inline = false,
  className = "",
  showBillingLink = true,
}: PlanUpgradeHintProps) {
  const planInfo = PLAN_DISPLAY_INFO[requiredPlan];
  const defaultMessage = `この機能は ${planInfo.nameJa} プラン以上でご利用いただけます`;
  const displayMessage = message ?? defaultMessage;

  if (inline) {
    return (
      <span className={`text-xs text-[var(--text-muted)] ${className}`}>
        {displayMessage}
        {showBillingLink ? (
          <>
            {" "}
            <Link href="/app/billing" className="underline hover:text-[var(--accent-strong)]">
              アップグレード
            </Link>
          </>
        ) : null}
      </span>
    );
  }

  return (
    <div
      className={`rounded-lg border border-[var(--border-soft)] bg-[var(--bg-soft)] p-4 ${className}`}
    >
      <div className="flex items-start gap-3">
        <span className="text-lg" aria-hidden>
          ✨
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--text)]">
            {displayMessage}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {planInfo.descriptionJa}
          </p>
          {showBillingLink ? (
            <Link
              href="/app/billing"
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent-strong)] hover:underline"
            >
              プランを見る
              <span aria-hidden>→</span>
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type PlanGatedSectionProps = {
  /** The feature being gated */
  featureName: string;
  /** The plan required to access this feature */
  requiredPlan: PlanKey;
  /** Current plan (null = legacy, always allowed) */
  currentPlan: PlanKey | null;
  /** Whether plan rails are enabled */
  planRailsEnabled: boolean;
  /** Children to render when allowed */
  children: React.ReactNode;
  /** Fallback content when not allowed (defaults to upgrade hint) */
  fallback?: React.ReactNode;
};

export function PlanGatedSection({
  featureName,
  requiredPlan,
  currentPlan,
  planRailsEnabled,
  children,
  fallback,
}: PlanGatedSectionProps) {
  if (!planRailsEnabled) {
    return <>{children}</>;
  }

  if (currentPlan === null) {
    return <>{children}</>;
  }

  const TIER_ORDER: Record<PlanKey, number> = {
    intern: 0,
    proper: 1,
    executive: 2,
  };

  const currentTier = TIER_ORDER[currentPlan];
  const requiredTier = TIER_ORDER[requiredPlan];

  if (currentTier >= requiredTier) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return (
    <PlanUpgradeHint
      requiredPlan={requiredPlan}
      message={`${featureName}は ${PLAN_DISPLAY_INFO[requiredPlan].nameJa} プラン以上でご利用いただけます`}
    />
  );
}
