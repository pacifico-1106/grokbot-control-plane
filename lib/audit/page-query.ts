import { classifyAuditResult, mapAdminStoredResult } from "./result";
import type { AuditResultKind } from "./types";
import type { AuditEvent } from "@/lib/types";

export const AUDIT_PAGE_LEGACY_LIMIT = 100;
export const AUDIT_PAGE_FILTER_SIZE = 50;

export type AuditPageSearchInput = {
  action?: string | string[] | undefined;
  from?: string | string[] | undefined;
  to?: string | string[] | undefined;
  result?: string | string[] | undefined;
  cursor?: string | string[] | undefined;
};

export type AuditPageSearch = {
  action: string | null;
  fromIso: string | null;
  toIsoExclusive: string | null;
  result: AuditResultKind | null;
  cursor: { createdAt: string; id: string } | null;
  rejected: boolean;
};

const ACTION_RE = /^[a-z][a-z0-9._]{0,63}$/i;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RESULT_KINDS = new Set<AuditResultKind>([
  "success",
  "failure",
  "denied",
  "pending",
  "unknown",
]);

const EMPTY: AuditPageSearch = {
  action: null,
  fromIso: null,
  toIsoExclusive: null,
  result: null,
  cursor: null,
  rejected: true,
};

function firstParam(value: string | string[] | undefined): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined) return { ok: true, value: null };
  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: true, value: null };
    if (value.length !== 1) return { ok: false };
    value = value[0];
  }
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed ? trimmed : null };
}

function jstMidnightIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000).toISOString();
}

function parseDayOrIso(raw: string, edge: "start" | "endExclusive"): string | null {
  const day = DAY_RE.exec(raw);
  if (day) {
    const year = Number(day[1]);
    const month = Number(day[2]);
    const date = Number(day[3]);
    const probe = new Date(Date.UTC(year, month - 1, date));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() + 1 !== month ||
      probe.getUTCDate() !== date
    ) {
      return null;
    }
    if (edge === "start") return jstMidnightIso(year, month, date);
    const next = new Date(Date.UTC(year, month - 1, date + 1));
    return jstMidnightIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseCursor(raw: string): { createdAt: string; id: string } | null {
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!ID_RE.test(id)) return null;
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  return { createdAt: new Date(ms).toISOString(), id };
}

export function encodeAuditPageCursor(event: Pick<AuditEvent, "id" | "createdAt">): string {
  return `${event.createdAt}|${event.id}`;
}

export function parseAuditPageSearch(input: AuditPageSearchInput): AuditPageSearch {
  const actionP = firstParam(input.action);
  const fromP = firstParam(input.from);
  const toP = firstParam(input.to);
  const resultP = firstParam(input.result);
  const cursorP = firstParam(input.cursor);
  if (!actionP.ok || !fromP.ok || !toP.ok || !resultP.ok || !cursorP.ok) return EMPTY;

  let action: string | null = null;
  if (actionP.value) {
    if (!ACTION_RE.test(actionP.value)) return EMPTY;
    action = actionP.value;
  }

  let fromIso: string | null = null;
  if (fromP.value) {
    fromIso = parseDayOrIso(fromP.value, "start");
    if (!fromIso) return EMPTY;
  }

  let toIsoExclusive: string | null = null;
  if (toP.value) {
    toIsoExclusive = parseDayOrIso(toP.value, "endExclusive");
    if (!toIsoExclusive) return EMPTY;
  }

  if (fromIso && toIsoExclusive && fromIso >= toIsoExclusive) return EMPTY;

  let result: AuditResultKind | null = null;
  if (resultP.value) {
    if (!RESULT_KINDS.has(resultP.value as AuditResultKind)) return EMPTY;
    result = resultP.value as AuditResultKind;
  }

  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorP.value) {
    cursor = parseCursor(cursorP.value);
    if (!cursor) return EMPTY;
  }

  return { action, fromIso, toIsoExclusive, result, cursor, rejected: false };
}

export function auditEventResultKind(event: AuditEvent): AuditResultKind {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const stored = mapAdminStoredResult((meta as Record<string, unknown>).result);
  if (stored) return stored;
  return classifyAuditResult(event).kind;
}

function isBeforeCursor(
  event: AuditEvent,
  cursor: { createdAt: string; id: string }
): boolean {
  if (event.createdAt < cursor.createdAt) return true;
  if (event.createdAt > cursor.createdAt) return false;
  return event.id < cursor.id;
}

export function applyAuditPageQuery(
  events: AuditEvent[],
  orgId: string | null | undefined,
  search: AuditPageSearch
): { events: AuditEvent[]; nextCursor: string | null } {
  if (!orgId || search.rejected) return { events: [], nextCursor: null };
  if (
    search.cursor &&
    !events.some((event) => event.orgId === orgId && event.id === search.cursor!.id)
  ) {
    return { events: [], nextCursor: null };
  }

  const filtered = events.filter((event) => {
    if (event.orgId !== orgId) return false;
    if (search.action && event.action !== search.action) return false;
    if (search.fromIso && event.createdAt < search.fromIso) return false;
    if (search.toIsoExclusive && event.createdAt >= search.toIsoExclusive) return false;
    if (search.result && auditEventResultKind(event) !== search.result) return false;
    if (search.cursor && !isBeforeCursor(event, search.cursor)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  const page = filtered.slice(0, AUDIT_PAGE_FILTER_SIZE);
  const nextCursor =
    filtered.length > AUDIT_PAGE_FILTER_SIZE && page.length > 0
      ? encodeAuditPageCursor(page[page.length - 1])
      : null;
  return { events: page, nextCursor };
}
