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
 *
 * MCP Rail Hints:
 * - When flag OFF or no identity: nextStepJa guides setup
 * - When readErrors: hintJa explains how to resolve sharing issues
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
  /** MCP rail hint: next step in Japanese when action is needed */
  nextStepJa?: string;
  /** MCP rail hint: per-calendar hints for resolving read errors */
  readErrorHints?: Record<string, string>;
  /** MCP rail hint: whether busy data is complete (false if any read errors) */
  busyDataComplete?: boolean;
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
      nextStepJa:
        "Google Calendar 連携は現在無効です（フラグ OFF）。" +
        "接続するアカウントは、AI 社員専用の Google アカウントで、" +
        "オペレータが管理する Workspace または Staffpass を許可済みの Workspace に所属している必要があります。" +
        "相手方は Staffpass に接続せず、カレンダーを AI 社員アカウントに共有（空き時間のみで OK）してください。",
      busyDataComplete: false,
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
      nextStepJa:
        "この AI 社員に Google アカウントが連携されていません。" +
        "社員証画面から「Google カレンダー接続」を実行してください。" +
        "接続するアカウントは、AI 社員専用の Google アカウントで、" +
        "オペレータが管理する Workspace または Staffpass を許可済みの Workspace に所属している必要があります。" +
        "相手方は Staffpass に接続せず、カレンダーを AI 社員アカウントに共有（空き時間のみで OK）してください。",
      busyDataComplete: false,
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
      nextStepJa:
        "Google トークンの更新に失敗しました。" +
        "社員証画面から Google を再連携してください。" +
        "接続する Google アカウントの Workspace でサードパーティアプリがブロックされている場合は、" +
        "アカウントを別の Workspace に移すか、管理者に Staffpass の許可を依頼してください。",
      busyDataComplete: false,
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
    const hintJa = freebusyResult.error.code === 401
      ? "認証エラーです。社員証画面から Google を再連携してください。" +
        "接続する Google アカウントの Workspace でサードパーティアプリがブロックされている場合は、" +
        "アカウントを別の Workspace に移すか、管理者に Staffpass の許可を依頼してください。"
      : "Google API エラーです。しばらく待ってから再試行してください。";
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
      nextStepJa: hintJa,
      busyDataComplete: false,
    };
  }

  const busyByCalendar: Record<string, BusyInterval[]> = {};
  const errors: Record<string, CalendarReadError> = {};
  const readErrorHints: Record<string, string> = {};

  for (const calendarId of toQuery) {
    const calData = freebusyResult.calendars?.[calendarId];
    if (!calData) {
      errors[calendarId] = { code: "not_found", message: "Calendar not in response" };
      readErrorHints[calendarId] =
        "カレンダーが見つかりません。オーナーに AI 社員アカウントへの共有を依頼してください（空き時間のみで OK）。" +
        "オーナーの Workspace で外部カレンダー共有が無効な場合は、管理者に許可を依頼してください。";
      continue;
    }

    if (calData.errors?.length) {
      const firstError = calData.errors[0];
      const reason = firstError.reason || "calendar_error";
      errors[calendarId] = {
        code: reason,
        message: firstError.reason || "Calendar query error",
      };
      if (reason === "notFound" || reason === "notShared") {
        readErrorHints[calendarId] =
          "カレンダーへのアクセス権がありません。オーナーに AI 社員アカウントへの共有を依頼してください（空き時間のみで OK）。" +
          "オーナーの Workspace で外部カレンダー共有が無効な場合は、管理者に許可を依頼してください。";
      } else {
        readErrorHints[calendarId] =
          `カレンダー読み取りエラー (${reason})。しばらく待ってから再試行してください。`;
      }
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

  const hasReadErrors = Object.keys(errors).length > 0;
  const busyDataComplete = !hasReadErrors;

  return {
    ok: true,
    busyByCalendar,
    errors,
    refused,
    queried: toQuery,
    auditMetadata,
    ...(hasReadErrors ? { readErrorHints } : {}),
    busyDataComplete,
    ...(hasReadErrors
      ? {
          nextStepJa:
            "一部のカレンダーで読み取りエラーが発生しました（readErrors を確認）。" +
            "オーナーに AI 社員アカウントへの共有を依頼してください（空き時間のみで OK）。",
        }
      : {}),
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
