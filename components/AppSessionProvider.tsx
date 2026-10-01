"use client";

import { createContext, useContext } from "react";
import type { SubscriptionStatus } from "@/lib/types";
import type { PlanKey } from "@/lib/billing/plan-scopes";

export type AppSessionValue = {
  email: string | null;
  displayName: string | null;
  demo: boolean;
  superAdmin: boolean;
  pendingApprovalCount: number;
  subscriptionStatus: SubscriptionStatus | null;
  expiredTrial: boolean;
  /** P1 Plan Rails: org's current plan key. null = legacy (no plan). */
  planKey: PlanKey | null;
  /** P1 Plan Rails: true when plan rails feature is enabled. */
  planRailsEnabled: boolean;
  /** P1 Plan Rails: scheduled downgrade plan if any. */
  scheduledPlanKey: PlanKey | null;
  /** P1 Plan Rails: ISO timestamp when scheduled change takes effect. */
  scheduledPlanEffectiveAt: string | null;
};

const AppSessionContext = createContext<AppSessionValue>({
  email: null,
  displayName: null,
  demo: false,
  superAdmin: false,
  pendingApprovalCount: 0,
  subscriptionStatus: null,
  expiredTrial: false,
  planKey: null,
  planRailsEnabled: false,
  scheduledPlanKey: null,
  scheduledPlanEffectiveAt: null,
});

export function AppSessionProvider({
  value,
  children,
}: {
  value: AppSessionValue;
  children: React.ReactNode;
}) {
  return (
    <AppSessionContext.Provider value={value}>
      {children}
    </AppSessionContext.Provider>
  );
}

export function useAppSession(): AppSessionValue {
  return useContext(AppSessionContext);
}
