/**
 * Retry cap for the approved-attachment re-run (木村 #255 second round, decision 4).
 * STUB (test commit): implemented in the next commit.
 */
export const ATTACHMENT_RETRY_CAP = 3;
export const SETUP_TOOL_SUCCEEDED_AUDIT = "setup.tool_succeeded" as const;
export type SettingsChangeSource = "admin_fulfillment" | "admin_tool" | "authorize_link_completed";

export function countsAsSettingsChange(_tool: string, _source: SettingsChangeSource): boolean {
  return false;
}

export async function recordSetupToolSucceeded(_input: {
  orgId: string;
  tool: string;
  source: SettingsChangeSource;
  approvalId?: string | null;
  employeeId?: string | null;
}): Promise<void> {}
