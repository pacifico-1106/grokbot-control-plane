/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED (default OFF) flag + request classifier.
 * Dependency-free on purpose: hot paths (Slack interactivity) import this
 * without picking up new data-module edges while the flag is OFF.
 */
function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isSharedApprovalAppEnabled(): boolean {
  return parseFlag(process.env.SLACK_SHARED_APPROVAL_APP_ENABLED);
}

/** api_app_id names the shared approval app (flag ON + SLACK_SHARED_APPROVAL_APP_ID set). */
export function isSharedApprovalAppRequest(apiAppId: string): boolean {
  if (!isSharedApprovalAppEnabled()) return false;
  const appId = process.env.SLACK_SHARED_APPROVAL_APP_ID?.trim() || "";
  return Boolean(appId) && apiAppId === appId;
}

/** api_app_id names the shared approval app while the flag is OFF (review M1: old cards). */
export function isSharedApprovalAppRequestWhileDisabled(apiAppId: string): boolean {
  if (isSharedApprovalAppEnabled()) return false;
  const appId = process.env.SLACK_SHARED_APPROVAL_APP_ID?.trim() || "";
  return Boolean(appId) && apiAppId === appId;
}
