import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Shared CRON_SECRET check for app/api/cron/* (木村 2026-10-04).
 *
 * - The caller must send exactly `Authorization: Bearer <CRON_SECRET>`. That is
 *   what Vercel Cron sends for the paths in vercel.json.
 * - Both sides are SHA-256 hashed and the two 32-byte digests are compared with
 *   timingSafeEqual, so neither the secret's content nor its length is leaked
 *   through timing. No length check comes first.
 * - CRON_SECRET unset or blank -> "not_configured" (routes answer 503).
 * - CRON_SECRET left at the `replace_me…` placeholder -> nothing authenticates
 *   ("unauthorized", 401), including a request that presents the placeholder.
 *
 * The LP crons (lp-inquiry-cleanup, lp-handoff-outbox) still have their own
 * checks. They move to this helper after PR #261 merges.
 */

export const CRON_SECRET_PLACEHOLDER_PREFIX = "replace_me";

export type CronSecretState =
  | { state: "unset" }
  | { state: "placeholder" }
  | { state: "set"; secret: string };

export type CronAuthDecision = "ok" | "not_configured" | "unauthorized";

export function readCronSecret(): CronSecretState {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!secret) return { state: "unset" };
  if (secret.startsWith(CRON_SECRET_PLACEHOLDER_PREFIX)) return { state: "placeholder" };
  return { state: "set", secret };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant time, length-independent: compare SHA-256 digests (always 32 bytes each). */
export function cronSecretsEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

export function checkCronAuthorization(authorization: string | null): CronAuthDecision {
  const configured = readCronSecret();
  if (configured.state === "unset") return "not_configured";
  if (configured.state === "placeholder") return "unauthorized";
  return cronSecretsEqual(authorization ?? "", `Bearer ${configured.secret}`) ? "ok" : "unauthorized";
}

/**
 * Returns the error response the cron routes have always returned, or null when
 * the request is authorized and the route should continue.
 */
export function rejectUnauthorizedCron(req: Request): NextResponse | null {
  const decision = checkCronAuthorization(req.headers.get("authorization"));
  if (decision === "ok") return null;
  if (decision === "not_configured") {
    return NextResponse.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
