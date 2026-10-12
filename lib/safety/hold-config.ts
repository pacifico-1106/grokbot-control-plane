/**
 * AI安全5ルール #3 緊急停止 — S3 surface config (design §2.4 / §2.6).
 *
 * EMPLOYEE_HOLD_ENABLED (default OFF) gates the *surfaces* that start / release a hold
 * (web buttons, inbox 「緊急停止」 buttons, the /admin stop). The is-stopped check
 * (`checkOperable`, S2) does NOT read this flag: a hold already in the DB always stops.
 *
 * ORG_HOLD_ENABLED (default OFF, needs EMPLOYEE_HOLD_ENABLED too) adds the org-wide stop.
 */

const ON = new Set(["1", "true", "on", "yes"]);

export function isEmployeeHoldEnabled(): boolean {
  return ON.has(String(process.env.EMPLOYEE_HOLD_ENABLED ?? "").trim().toLowerCase());
}

export function isOrgHoldEnabled(): boolean {
  return isEmployeeHoldEnabled() && ON.has(String(process.env.ORG_HOLD_ENABLED ?? "").trim().toLowerCase());
}

/**
 * Where a hold may be STOPPED from. Stopping is the safe direction, so every human surface may.
 */
export const HOLD_STOP_SURFACES = ["web", "slack", "line", "telegram", "ops_console"] as const;
export type HoldStopSurface = (typeof HOLD_STOP_SURFACES)[number];

/**
 * Where a hold-release may be REQUESTED and APPROVED from (working assumption 10/12 07:03,
 * until 木村 decides otherwise): web only, behind a fresh login. Inbox buttons only stop.
 *
 * To change this decision, edit this list (and give the new surface its own freshness proof
 * in `hold-actions.ts › assertReleaseSurface`). Everything that refuses inbox approval of a
 * release ticket reads this one constant.
 */
export const HOLD_RELEASE_SURFACES: readonly HoldStopSurface[] = ["web"];

export function isHoldReleaseSurface(surface: string | null | undefined): boolean {
  return (HOLD_RELEASE_SURFACES as readonly string[]).includes(String(surface ?? ""));
}

/** Fresh-login window for requesting / approving a release (design §2.6: 5 minutes). */
export const HOLD_RELEASE_FRESH_LOGIN_MAX_AGE_MS = 5 * 60_000;

/** The approval-ticket tool for a release (S1 function checks the same string). */
export const HOLD_RELEASE_TOOL = "employee.hold.release";

/** S3 start-retry policy (木村 10/12 05:35): 40P01 deadlock / 40001 serialization failure. */
// 木村 10/12 09:01: 40P01 deadlock, 40001 serialization failure, 55P03 lock not available.
// The S1 functions run at READ COMMITTED (the PostgREST default; they set no isolation), where
// row-lock waits re-check instead of raising 40001 — see the PR body. 5 attempts with
// exponential backoff + jitter (each wait uniform in [base/2, base], bases 50/100/200/400 ms,
// ≤ 750 ms in total) so concurrent stops that collide do not retry in lockstep.
export const HOLD_START_RETRYABLE_CODES: ReadonlySet<string> = new Set(["40P01", "40001", "55P03"]);
export const HOLD_START_MAX_ATTEMPTS = 5;
export const HOLD_START_BACKOFF_MS = [50, 100, 200, 400] as const;
export function holdStartBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = HOLD_START_BACKOFF_MS[Math.min(Math.max(attempt, 1) - 1, HOLD_START_BACKOFF_MS.length - 1)];
  return Math.round(base / 2 + random() * (base / 2));
}

/** True for the S3 release ticket (same test as the S1 SQL: metadata.adminTool, else tool). */
export function isHoldReleaseTicket(approval: { tool?: string | null; metadata?: Record<string, unknown> | null } | null | undefined): boolean {
  if (!approval) return false;
  const md = approval.metadata ?? {};
  return String(md.adminTool ?? approval.tool ?? "") === HOLD_RELEASE_TOOL;
}

/** Inbox cards show 「緊急停止」 only with the flag ON, for an employee's ticket (never a release ticket). */
export function showHoldStopButton(approval: { employeeId?: string | null; tool?: string | null; metadata?: Record<string, unknown> | null }): boolean {
  return isEmployeeHoldEnabled() && Boolean(approval.employeeId) && !isHoldReleaseTicket(approval);
}
