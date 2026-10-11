/**
 * Provider rate limits (木村 #278 answers 3, 2026-10-05; reverses the 10/4
 * call): a JSON rate-limit answer — Slack chat.postMessage `ratelimited` /
 * `rate_limited`, X HTTP 429 — is a confirmed "not posted". The provider's
 * wait is surfaced, never acted on here: there is no automatic retry loop.
 * The AI is told how long to wait (retryAfterSeconds + nextStep), and an
 * approved post that was rate-limited does not call the provider again until
 * that wait is over (rateLimitWaitRemainingSeconds, checked at fulfil).
 *
 * Wait source, in order: Retry-After (delta seconds or HTTP date), then
 * x-rate-limit-reset (X: epoch seconds; a small number is read as delta
 * seconds). Missing / unreadable → RETRY_AFTER_DEFAULT_SECONDS. Always clamped
 * to [RETRY_AFTER_MIN_SECONDS, RETRY_AFTER_MAX_SECONDS] so a hostile or broken
 * header cannot park a job (or an approval) for days.
 */

export const PROVIDER_RATE_LIMITED = "provider_rate_limited";
export const RETRY_AFTER_MIN_SECONDS = 1;
export const RETRY_AFTER_MAX_SECONDS = 3600;
export const RETRY_AFTER_DEFAULT_SECONDS = 60;

/** Slack chat.postMessage error strings that mean "rate-limited, nothing posted". */
export const SLACK_RATE_LIMIT_ERRORS: ReadonlySet<string> = new Set(["ratelimited", "rate_limited"]);

const EPOCH_SECONDS_FLOOR = 1_000_000_000;

export function clampRetryAfterSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return RETRY_AFTER_DEFAULT_SECONDS;
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(RETRY_AFTER_MIN_SECONDS, Math.ceil(seconds)));
}

function fromRetryAfter(raw: string, nowMs: number): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^[+-]?\d/.test(value)) return null; // negative / fractional garbage
  const at = Date.parse(value);
  return Number.isFinite(at) ? (at - nowMs) / 1000 : null;
}

function fromRateLimitReset(raw: string, nowMs: number): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= EPOCH_SECONDS_FLOOR ? n - nowMs / 1000 : n;
}

/** The provider's wait in whole seconds, clamped; the default when it gave none. */
export function retryAfterSecondsFromHeaders(headers: Headers, nowMs: number = Date.now()): number {
  const retryAfter = headers.get("retry-after");
  const fromHeader = retryAfter != null ? fromRetryAfter(retryAfter, nowMs) : null;
  if (fromHeader != null) return clampRetryAfterSeconds(fromHeader);
  const reset = headers.get("x-rate-limit-reset");
  const fromReset = reset != null ? fromRateLimitReset(reset, nowMs) : null;
  if (fromReset != null) return clampRetryAfterSeconds(fromReset);
  return RETRY_AFTER_DEFAULT_SECONDS;
}

/**
 * Japanese next step (木村 #290, 2026-10-09: Grok reads the tool-result body):
 * wait N seconds, then re-run with the same jobId without changing the content.
 */
export function rateLimitedNextStep(seconds: number): string {
  return `投稿されていません（投稿先のレート制限）。${seconds}秒待ってから、同じ jobId で、内容を変えずにもう一度実行してください。それより早く再実行しないでください。`;
}

export function rateLimitedNextStepEn(seconds: number): string {
  return `Nothing was posted: the provider rate-limited this request. Wait at least ${seconds} seconds, then retry the same request once (it is safe to retry). Do not retry earlier.`;
}

export function rateLimitedMessageJa(seconds: number): string {
  return `投稿先のレート制限のため投稿していません。${seconds}秒以上待ってから、同じ jobId・同じ内容で再実行してください。`;
}

/** Error body returned to the AI for a rate-limited (not sent) post. */
export function rateLimitedBody(input: { retryAfterSeconds: number; providerError?: string }): Record<string, unknown> {
  const seconds = clampRetryAfterSeconds(input.retryAfterSeconds);
  return {
    ok: false,
    code: PROVIDER_RATE_LIMITED,
    error: PROVIDER_RATE_LIMITED,
    reasonCode: PROVIDER_RATE_LIMITED,
    message: rateLimitedMessageJa(seconds),
    ...(input.providerError ? { providerError: input.providerError } : {}),
    retryable: true,
    nextAction: "retry_later",
    retryAfterSeconds: seconds,
    nextStep: rateLimitedNextStep(seconds),
    nextStepEn: rateLimitedNextStepEn(seconds),
  };
}

/**
 * Seconds left before an approved post that was rate-limited may call the
 * provider again (0 = go). Reads the recorded fulfilment; the stored wait is
 * clamped again so a bad value cannot lock the approval.
 */
export function rateLimitWaitRemainingSeconds(
  fulfillment: { ok?: boolean; error?: string; retryAfterSeconds?: number; at?: string } | null | undefined,
  nowMs: number = Date.now()
): number {
  if (!fulfillment || fulfillment.ok !== false || fulfillment.error !== PROVIDER_RATE_LIMITED) return 0;
  if (typeof fulfillment.retryAfterSeconds !== "number") return 0;
  const at = Date.parse(String(fulfillment.at || ""));
  if (!Number.isFinite(at)) return 0;
  const until = at + clampRetryAfterSeconds(fulfillment.retryAfterSeconds) * 1000;
  const remaining = Math.ceil((until - nowMs) / 1000);
  return remaining > 0 ? Math.min(remaining, RETRY_AFTER_MAX_SECONDS) : 0;
}
