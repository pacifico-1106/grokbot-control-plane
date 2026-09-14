"use client";

import { createContext, useContext } from "react";
import type { SubscriptionStatus } from "@/lib/types";

export type AppSessionValue = {
  email: string | null;
  displayName: string | null;
  demo: boolean;
  superAdmin: boolean;
  pendingApprovalCount: number;
  subscriptionStatus: SubscriptionStatus | null;
  expiredTrial: boolean;
};

const AppSessionContext = createContext<AppSessionValue>({
  email: null,
  displayName: null,
  demo: false,
  superAdmin: false,
  pendingApprovalCount: 0,
  subscriptionStatus: null,
  expiredTrial: false,
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
