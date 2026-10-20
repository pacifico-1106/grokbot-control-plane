/**
 * Required-reason submit (hold release, and any later form that must not fire blank).
 * Trimmed empty / whitespace is not a reason. Stop remains optional.
 */
export const REQUIRED_REASON_HINT_JA = "理由を入力してください";

export function hasRequiredReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.trim().length > 0;
}
