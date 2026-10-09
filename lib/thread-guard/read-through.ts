/**
 * The point the AI read the thread through (thread single-flight). Explicit
 * `readThroughTs` (request top level, conversation or tool payload) wins;
 * otherwise the inbound message the AI was woken by (conversation.ts /
 * messageTs / slackTs). Times are compared in microseconds as bigint so a
 * Slack ts ("1791105000.000001") keeps its exact order.
 * A value further than READ_THROUGH_FUTURE_SKEW_SECONDS in the future is
 * ignored: claiming to have read "the future" cannot switch the check off.
 */
import { READ_THROUGH_FUTURE_SKEW_SECONDS } from "./config";

export type ReadThrough = { micros: bigint; ts: string; source: "explicit" | "inbound" };

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Slack ts, epoch seconds (10 digits), epoch ms (13 digits) or ISO 8601 → µs; else null. */
export function parseThreadTimestamp(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    value = String(Math.trunc(value));
  }
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  const slack = /^(\d{9,11})\.(\d{1,6})$/.exec(v);
  if (slack) return BigInt(slack[1]) * BigInt(1_000_000) + BigInt(slack[2].padEnd(6, "0"));
  if (/^\d{9,11}$/.test(v)) return BigInt(v) * BigInt(1_000_000);
  if (/^\d{12,14}$/.test(v)) return BigInt(v) * BigInt(1_000);
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) && ms > 0 ? BigInt(ms) * BigInt(1_000) : null;
  }
  return null;
}

export function microsToTs(micros: bigint): string {
  const sec = micros / BigInt(1_000_000);
  const frac = micros % BigInt(1_000_000);
  return `${sec}.${frac.toString().padStart(6, "0")}`;
}

function pick(candidates: unknown[], source: ReadThrough["source"], nowMs: number): ReadThrough | null {
  const limit = (BigInt(Math.floor(nowMs)) + BigInt(READ_THROUGH_FUTURE_SKEW_SECONDS * 1000)) * BigInt(1_000);
  for (const c of candidates) {
    const micros = parseThreadTimestamp(c);
    if (micros == null || micros > limit) continue;
    return { micros, ts: microsToTs(micros), source };
  }
  return null;
}

export function readThroughFromBody(
  body: { readThroughTs?: unknown; conversation?: unknown; args?: unknown },
  nowMs: number = Date.now()
): ReadThrough | null {
  const conv = rec(body.conversation);
  const args = rec(body.args);
  return (
    pick([body.readThroughTs, conv.readThroughTs, args.readThroughTs], "explicit", nowMs) ??
    pick([conv.ts, conv.messageTs, conv.slackTs, args.ts, args.messageTs], "inbound", nowMs)
  );
}

/** Fulfil: the read point recorded with the approval (never the re-run request's). */
export function readThroughFromSnapshot(
  snapshot: { readThroughTs?: unknown; conversation?: { ts?: unknown } | null },
  nowMs: number = Date.now()
): ReadThrough | null {
  return (
    pick([snapshot.readThroughTs], "explicit", nowMs) ??
    pick([snapshot.conversation?.ts], "inbound", nowMs)
  );
}
