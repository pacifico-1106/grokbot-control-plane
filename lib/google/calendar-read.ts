/**
 * Google Calendar free/busy read implementation.
 *
 * Queries Google freebusy.query API for allowlisted calendar IDs only.
 * Returns busy intervals, never event contents (freebusy has none anyway).
 *
 * Security:
 * - Only queries calendars in the employee's allowlist (calendar_read_grants).
 * - Requested but unlisted calendar IDs are refused, not queried.
 * - Max window capped at 31 days to prevent unbounded queries.
 * - Per-calendar errors (notFound, notShared) surface as status, not crash.
 * - Tokens never appear in responses, logs, audit metadata, or chat.
 */
import type { BusyInterval } from "@/lib/scheduling-policy/freebusy";
import {
  getAllowedCalendarIds,
  getLinkedGoogleRefreshToken,
  markGoogleIdentityNeedsReauth,
} from "@/lib/data/google-identities";
import { refreshGoogleToken } from "@/lib/google/oauth";
import { isGoogleCalendarReadEnabled } from "@/lib/feature-flags";
import { appendAuditEvent } from "@/lib/data/audit";

const MAX_WINDOW_DAYS = 31;
const MAX_CALENDARS_PER_REQUEST = 50;

export interface CalendarReadInput {
  orgId: string;
  employeeId: string;
  jobId?: string;
  calendarIds: string[];
  timeMin: string;
  timeMax: string;
}

export interface CalendarReadResult {
  ok: boolean;
  busyByCalendar: Record<string, BusyInterval[]>;
  errors: Record<string, CalendarReadError>;
  refused: string[];
  queried: string[];
  auditMetadata: Record<string, unknown>;
}

export interface CalendarReadError {
  code: string;
  message: string;
}

interface GoogleFreebusyResponse {
  kind?: string;
  timeMin?: string;
  timeMax?: string;
  calendars?: Record<
    string,
    {
      busy?: Array<{ start?: string; end?: string }>;
      errors?: Array<{ domain?: string; reason?: string }>;
    }
  >;
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

/**
 * Read free/busy data from Google Calendar for allowlisted calendars.
 *
 * When flag OFF, returns empty result (no-op).
 * Unlisted calendar IDs are refused without querying Google.
 */
export async function readCalendarFreebusy(
  input: CalendarReadInput
): Promise<CalendarReadResult> {
  const {
    orgId,
    employeeId,
    jobId,
    calendarIds: rawCalendarIds,
    timeMin,
    timeMax,
  } = input;

  const auditBase = {
    orgId,
    employeeId,
    jobId,
    calendarIdsRequested: rawCalendarIds,
    timeMin,
    timeMax,
  };

  if (!isGoogleCalendarReadEnabled()) {
    return {
      ok: true,
      busyByCalendar: {},
      errors: {},
      refused: rawCalendarIds,
      queried: [],
      auditMetadata: { ...auditBase, flagOff: true },
    };
  }

  const calendarIds = rawCalendarIds
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_CALENDARS_PER_REQUEST);

  if (!calendarIds.length) {
    return {
      ok: true,
      busyByCalendar: {},
      errors: {},
      refused: [],
      queried: [],
      auditMetadata: { ...auditBase, noCalendarsRequested: true },
    };
  }

  const windowMs = new Date(timeMax).getTime() - new Date(timeMin).getTime();
  const maxWindowMs = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  if (windowMs > maxWindowMs) {
    return {
      ok: false,
      busyByCalendar: {},
      errors: { _request: { code: "window_too_large", message: `Max ${MAX_WINDOW_DAYS} days` } },
      refused: calendarIds,
      queried: [],
      auditMetadata: { ...auditBase, windowTooLarge: true, windowDays: windowMs / (24 * 60 * 60 * 1000) },
    };
  }

  const allowed = await getAllowedCalendarIds({ orgId, employeeId });
  const toQuery: string[] = [];
  const refused: string[] = [];

  for (const id of calendarIds) {
    if (allowed.has(id)) {
      toQuery.push(id);
    } else {
      refused.push(id);
    }
  }

  if (!toQuery.length) {
    return {
      ok: true,
      busyByCalendar: {},
      errors: {},
      refused,
      queried: [],
      auditMetadata: { ...auditBase, allRefused: true, refused },
    };
  }

  const refreshToken = await getLinkedGoogleRefreshToken(employeeId);
  if (!refreshToken) {
    return {
      ok: false,
      busyByCalendar: {},
      errors: { _auth: { code: "no_google_identity", message: "Google Calendar not connected" } },
      refused,
      queried: [],
      auditMetadata: { ...auditBase, noGoogleIdentity: true },
    };
  }

  const tokenResponse = await refreshGoogleToken(refreshToken);
  if (!tokenResponse.access_token) {
    await markGoogleIdentityNeedsReauth(employeeId);
    return {
      ok: false,
      busyByCalendar: {},
      errors: { _auth: { code: "token_refresh_failed", message: "Google token refresh failed" } },
      refused,
      queried: [],
      auditMetadata: { ...auditBase, tokenRefreshFailed: true },
    };
  }

  const accessToken = tokenResponse.access_token;
  const freebusyResult = await queryGoogleFreebusy({
    accessToken,
    calendarIds: toQuery,
    timeMin,
    timeMax,
  });

  if (freebusyResult.error) {
    const errorCode = freebusyResult.error.code === 401 ? "unauthorized" : "api_error";
    if (freebusyResult.error.code === 401) {
      await markGoogleIdentityNeedsReauth(employeeId);
    }
    return {
      ok: false,
      busyByCalendar: {},
      errors: {
        _api: {
          code: errorCode,
          message: freebusyResult.error.message || "Google API error",
        },
      },
      refused,
      queried: toQuery,
      auditMetadata: {
        ...auditBase,
        apiError: true,
        apiErrorCode: freebusyResult.error.code,
      },
    };
  }

  const busyByCalendar: Record<string, BusyInterval[]> = {};
  const errors: Record<string, CalendarReadError> = {};

  for (const calendarId of toQuery) {
    const calData = freebusyResult.calendars?.[calendarId];
    if (!calData) {
      errors[calendarId] = { code: "not_found", message: "Calendar not in response" };
      continue;
    }

    if (calData.errors?.length) {
      const firstError = calData.errors[0];
      errors[calendarId] = {
        code: firstError.reason || "calendar_error",
        message: firstError.reason || "Calendar query error",
      };
      continue;
    }

    busyByCalendar[calendarId] = (calData.busy || [])
      .filter((b) => b.start && b.end)
      .map((b) => ({ start: b.start!, end: b.end! }));
  }

  const auditMetadata = {
    ...auditBase,
    queried: toQuery,
    refused,
    busyIntervalCounts: Object.fromEntries(
      Object.entries(busyByCalendar).map(([k, v]) => [k, v.length])
    ),
    errorCalendars: Object.keys(errors),
  };

  await appendAuditEvent({
    orgId,
    employeeId,
    credentialId: null,
    action: "calendar.freebusy_read",
    purpose: jobId || "calendar.read",
    summary: `Read freebusy for ${toQuery.length} calendar(s)`,
    metadata: auditMetadata,
  });

  return {
    ok: true,
    busyByCalendar,
    errors,
    refused,
    queried: toQuery,
    auditMetadata,
  };
}

async function queryGoogleFreebusy(input: {
  accessToken: string;
  calendarIds: string[];
  timeMin: string;
  timeMax: string;
}): Promise<GoogleFreebusyResponse> {
  const { accessToken, calendarIds, timeMin, timeMax } = input;

  const requestBody = {
    timeMin,
    timeMax,
    timeZone: "UTC",
    items: calendarIds.map((id) => ({ id })),
  };

  try {
    const response = await fetch(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(15_000),
      }
    );

    const data = (await response.json().catch(() => ({}))) as GoogleFreebusyResponse;

    if (!response.ok) {
      return {
        error: {
          code: response.status,
          message: data.error?.message || `HTTP ${response.status}`,
        },
      };
    }

    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      error: {
        code: 0,
        message: `Network error: ${message}`,
      },
    };
  }
}
