import { normalizeAllowedAccounts } from "@/lib/employees/allowed-accounts";
import type { AllowedAccount, PostingAs } from "@/lib/types";

export function normalizePostingAs(value: unknown): PostingAs {
  return value === "user" ? "user" : "bot";
}

export function employeeAllowsSlackUser(
  allowedAccounts: AllowedAccount[] | null | undefined,
  slackUserId: string
): boolean {
  const id = slackUserId.trim();
  if (!id) return false;
  return normalizeAllowedAccounts(allowedAccounts).some(
    (row) => row.service.toLowerCase() === "slack" && row.accountId === id
  );
}
