/**
 * Google OAuth scopes for AI employee calendar free/busy read and (optional)
 * incremental mail.send via gmail.send.
 *
 * Calendar start still requests only freebusy (read-only). gmail.send is
 * requested only from the separate Gmail-send consent (MAIL_SEND_GMAIL_LIVE).
 * calendar.freebusy and gmail.send are sensitive/restricted; unverified apps
 * are limited to test users.
 *
 * Forbidden scopes (never request):
 * - https://www.googleapis.com/auth/calendar — full calendar access
 * - https://www.googleapis.com/auth/calendar.events — event read/write
 * - https://www.googleapis.com/auth/calendar.settings.readonly — settings
 * - https://mail.google.com/ and gmail.modify / compose / readonly / metadata / insert
 * - Any scope broader than the allowlist
 *
 * @see docs/google-calendar-freebusy-integration.md
 * @see docs/mail-policy.md
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
 * Incremental mail.send live path (MAIL_SEND_GMAIL_LIVE). Requested only from
 * the separate Gmail-send consent — never from the calendar start URL.
 */
export const GOOGLE_SCOPE_GMAIL_SEND =
  "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_GMAIL_SEND_SCOPES = `openid email ${GOOGLE_SCOPE_GMAIL_SEND}`;

export type GoogleOAuthIntent = "calendar" | "gmail.send";

/**
 * Set of allowed scopes for callback validation.
 * Reject if granted scopes include anything not in this set.
 * gmail.send is allowed so incremental consent can union with calendar.freebusy.
 */
export const GOOGLE_ALLOWED_SCOPES = new Set([
  GOOGLE_SCOPE_OPENID,
  GOOGLE_SCOPE_EMAIL,
  GOOGLE_SCOPE_CALENDAR_FREEBUSY,
  GOOGLE_SCOPE_GMAIL_SEND,
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
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.insert",
]);

export function parseGoogleOAuthIntent(value: unknown): GoogleOAuthIntent {
  return value === "gmail.send" ? "gmail.send" : "calendar";
}

export function splitGoogleScopes(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function mergeGoogleScopes(...lists: string[]): string {
  const set = new Set<string>();
  for (const list of lists) {
    for (const scope of splitGoogleScopes(list)) set.add(scope);
  }
  return [...set].join(" ");
}

export function grantedScopesInclude(granted: string, needed: string): boolean {
  return splitGoogleScopes(granted).includes(needed);
}

/**
 * Validate that granted scopes are exactly what we requested (or a subset).
 * Fail-closed: reject if any forbidden or unknown scope is present.
 *
 * @param grantedScopes - Space-separated scope string from Google callback
 * @param intent - calendar start requires freebusy; gmail.send start requires gmail.send
 */
export function validateGrantedScopes(
  grantedScopes: string,
  intent: GoogleOAuthIntent = "calendar"
): {
  valid: boolean;
  reason?: string;
  forbidden?: string[];
  unknown?: string[];
} {
  if (!grantedScopes?.trim()) {
    return { valid: false, reason: "no_scopes_granted" };
  }

  const granted = new Set(splitGoogleScopes(grantedScopes));
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

  if (intent === "gmail.send") {
    if (!granted.has(GOOGLE_SCOPE_GMAIL_SEND)) {
      return {
        valid: false,
        reason: "gmail_send_scope_missing",
      };
    }
    return { valid: true };
  }

  if (!granted.has(GOOGLE_SCOPE_CALENDAR_FREEBUSY)) {
    return {
      valid: false,
      reason: "calendar_freebusy_scope_missing",
    };
  }

  return { valid: true };
}
