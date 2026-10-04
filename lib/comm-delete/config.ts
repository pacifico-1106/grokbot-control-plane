/**
 * comm.delete — an AI employee deletes ITS OWN posts that Staffpass recorded
 * (e.g. to clean up a duplicate send).
 *
 * COMM_DELETE_ENABLED (default OFF). Kept out of lib/feature-flags.ts on purpose
 * (other open stacks touch it). OFF: the tool answers comm_delete_disabled and
 * nothing else changes.
 *
 * COMM_DELETE_MAX_AGE_HOURS (default 72, 1..720): only posts recorded within
 * this window can be deleted (bounds the record lookup and the blast radius).
 */
export const COMM_DELETE_TOOL_ID = "comm.delete" as const;

const DEFAULT_MAX_AGE_HOURS = 72;
const MIN_MAX_AGE_HOURS = 1;
const MAX_MAX_AGE_HOURS = 720;

function parseFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "enabled";
}

export function isCommDeleteEnabled(): boolean {
  return parseFlag(process.env.COMM_DELETE_ENABLED);
}

export function commDeleteMaxAgeHours(): number {
  const raw = (process.env.COMM_DELETE_MAX_AGE_HOURS ?? "").trim();
  if (!raw) return DEFAULT_MAX_AGE_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGE_HOURS;
  return Math.min(MAX_MAX_AGE_HOURS, Math.max(MIN_MAX_AGE_HOURS, Math.floor(n)));
}
