"use client";

import { createContext, useContext } from "react";

export type AppSessionValue = {
  email: string | null;
  displayName: string | null;
  demo: boolean;
  superAdmin: boolean;
  pendingApprovalCount: number;
};

const AppSessionContext = createContext<AppSessionValue>({
  email: null,
  displayName: null,
  demo: false,
  superAdmin: false,
  pendingApprovalCount: 0,
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
