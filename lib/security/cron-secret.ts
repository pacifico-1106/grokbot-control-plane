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
 * LP crons (lp-inquiry-cleanup, lp-handoff-outbox) use the same comparison
 * through explicit options that keep their pre-helper acceptance rules:
 * - `allowRawSecret`: Authorization may also be exactly `<CRON_SECRET>` (no
 *   `Bearer `). Used by lp-inquiry-cleanup, whose caller is unknown.
 * - `rawSecretHeader`: that header (e.g. `x-cron-secret`) may carry exactly
 *   `<CRON_SECRET>`. Used by lp-handoff-outbox for its external POST caller.
 * - `trimSecret: false`: compare the untrimmed CRON_SECRET, as the LP crons
 *   always did. Blank still counts as unset, and a value that starts with
 *   `replace_me` after trimming is still the placeholder.
 * Every accepted form is compared (SHA-256 + timingSafeEqual) before the results
 * are combined, so which form matched, or whether any did, is not decided by an
 * early return on the secret. The defaults are the strict rules above.
 */

export const CRON_SECRET_PLACEHOLDER_PREFIX = "replace_me";

export type CronSecretState =
  | { state: "unset" }
  | { state: "placeholder" }
  | { state: "set"; secret: string };

export type CronAuthDecision = "ok" | "not_configured" | "unauthorized";

export type CronSecretOptions = {
  /** Also accept Authorization: `<CRON_SECRET>` without `Bearer `. Default false. */
  allowRawSecret?: boolean;
  /** Trim CRON_SECRET before use. Default true; the LP crons pass false. */
  trimSecret?: boolean;
};

export type CronRequestOptions = CronSecretOptions & {
  /** Header that may carry exactly `<CRON_SECRET>` (e.g. "x-cron-secret"). Default none. */
  rawSecretHeader?: string;
};

export function readCronSecret(options: { trim?: boolean } = {}): CronSecretState {
  const raw = process.env.CRON_SECRET ?? "";
  const secret = options.trim === false ? raw : raw.trim();
  // blank and the placeholder are judged on the trimmed value even with
  // trim: false, so ` replace_me` is still the placeholder
  if (!raw.trim()) return { state: "unset" };
  if (raw.trim().startsWith(CRON_SECRET_PLACEHOLDER_PREFIX)) return { state: "placeholder" };
  return { state: "set", secret };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant time, length-independent: compare SHA-256 digests (always 32 bytes each). */
export function cronSecretsEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/**
 * Compares every (presented, expected) pair, then combines the results. No
 * pair is skipped because an earlier one matched or failed.
 */
function anyCronSecretMatches(pairs: Array<[string, string]>): boolean {
  const results = pairs.map(([presented, expected]) => cronSecretsEqual(presented, expected));
  return results.reduce((matched, result) => matched || result, false);
}

function decide(
  candidates: (secret: string) => Array<[string, string]>,
  options: CronSecretOptions
): CronAuthDecision {
  const configured = readCronSecret({ trim: options.trimSecret ?? true });
  if (configured.state === "unset") return "not_configured";
  if (configured.state === "placeholder") return "unauthorized";
  return anyCronSecretMatches(candidates(configured.secret)) ? "ok" : "unauthorized";
}

function authorizationPairs(authorization: string | null, secret: string, options: CronSecretOptions): Array<[string, string]> {
  const presented = authorization ?? "";
  const pairs: Array<[string, string]> = [[presented, `Bearer ${secret}`]];
  if (options.allowRawSecret) pairs.push([presented, secret]);
  return pairs;
}

export function checkCronAuthorization(
  authorization: string | null,
  options: CronSecretOptions = {}
): CronAuthDecision {
  return decide((secret) => authorizationPairs(authorization, secret, options), options);
}

/** Authorization (per `options`) plus, if `rawSecretHeader` is set, that header's raw value. */
export function checkCronRequest(req: Request, options: CronRequestOptions = {}): CronAuthDecision {
  const authorization = req.headers.get("authorization");
  const rawHeader = options.rawSecretHeader;
  const rawValue = rawHeader ? req.headers.get(rawHeader) : null;
  return decide((secret) => {
    const pairs = authorizationPairs(authorization, secret, options);
    if (rawHeader) pairs.push([rawValue ?? "", secret]);
    return pairs;
  }, options);
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
