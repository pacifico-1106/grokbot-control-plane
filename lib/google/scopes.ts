/**
 * Google OAuth scopes for AI employee calendar free/busy read.
 *
 * Minimal scopes — read-only, never request write capabilities.
 * calendar.freebusy is a sensitive scope; unverified apps are limited to test users.
 *
 * Forbidden scopes (never request):
 * - https://www.googleapis.com/auth/calendar — full calendar access
 * - https://www.googleapis.com/auth/calendar.events — event read/write
 * - https://www.googleapis.com/auth/calendar.settings.readonly — settings
 * - Any scope broader than calendar.freebusy
 *
 * @see docs/google-calendar-freebusy-integration.md
 */

/**
 * Required scopes for Google Calendar free/busy read integration.
 * Space-separated for OAuth authorize URL.
 */
export const GOOGLE_CALENDAR_SCOPES =
  "openid email https://www.googleapis.com/auth/calendar.freebusy";

/**
 * Individual scope constants for validation.
 */
export const GOOGLE_SCOPE_OPENID = "openid";
export const GOOGLE_SCOPE_EMAIL = "email";
export const GOOGLE_SCOPE_CALENDAR_FREEBUSY =
  "https://www.googleapis.com/auth/calendar.freebusy";

/**
 * Set of allowed scopes for callback validation.
 * Reject if granted scopes include anything not in this set.
 */
export const GOOGLE_ALLOWED_SCOPES = new Set([
  GOOGLE_SCOPE_OPENID,
  GOOGLE_SCOPE_EMAIL,
  GOOGLE_SCOPE_CALENDAR_FREEBUSY,
]);

/**
 * Dangerous scopes that must never be granted — fail callback if present.
 * Prevents scope escalation attacks where user/app grants broader access.
 */
export const GOOGLE_FORBIDDEN_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.settings.readonly",
  "https://www.googleapis.com/auth/admin.directory.resource.calendar",
  "https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly",
]);

/**
 * Validate that granted scopes are exactly what we requested (or a subset).
 * Fail-closed: reject if any forbidden or unknown scope is present.
 *
 * @param grantedScopes - Space-separated scope string from Google callback
 * @returns Validation result with reason if invalid
 */
export function validateGrantedScopes(grantedScopes: string): {
  valid: boolean;
  reason?: string;
  forbidden?: string[];
  unknown?: string[];
} {
  if (!grantedScopes?.trim()) {
    return { valid: false, reason: "no_scopes_granted" };
  }

  const granted = new Set(grantedScopes.trim().split(/\s+/).filter(Boolean));
  const forbidden: string[] = [];
  const unknown: string[] = [];

  for (const scope of granted) {
    if (GOOGLE_FORBIDDEN_SCOPES.has(scope)) {
      forbidden.push(scope);
    } else if (!GOOGLE_ALLOWED_SCOPES.has(scope)) {
      unknown.push(scope);
    }
  }

  if (forbidden.length > 0) {
    return {
      valid: false,
      reason: "forbidden_scopes_granted",
      forbidden,
    };
  }

  if (unknown.length > 0) {
    return {
      valid: false,
      reason: "unknown_scopes_granted",
      unknown,
    };
  }

  if (!granted.has(GOOGLE_SCOPE_CALENDAR_FREEBUSY)) {
    return {
      valid: false,
      reason: "calendar_freebusy_scope_missing",
    };
  }

  return { valid: true };
}
