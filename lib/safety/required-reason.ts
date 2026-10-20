/**
 * Required-reason submit (hold release, and any later form that must not fire blank).
 * Empty / whitespace / zero-width / invisible-control-only is not a reason.
 * Stop remains optional.
 *
 * Emptiness is decided by hasVisibleReasonText (shared with cleanReason).
 * Stored reasons stay trim-only so mid-string ZWJ in emoji is kept.
 */

/** C0/C1 + zero-width / format / invisible controls. Emptiness check only — not stripped from stored text. */
const INVISIBLE_REASON_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD\u180E]/g;

export const REQUIRED_REASON_HINT_JA = "理由を入力してください";

/** True when trim + stripping zero-width / invisible controls leaves a visible reason. */
export function hasVisibleReasonText(text: string): boolean {
  return text.replace(INVISIBLE_REASON_CHARS, "").trim().length > 0;
}

export function hasRequiredReason(reason: unknown): boolean {
  return typeof reason === "string" && hasVisibleReasonText(reason);
}
