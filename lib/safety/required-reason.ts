/**
 * Required-reason submit (hold release, and any later form that must not fire blank).
 * Empty / whitespace / zero-width / invisible-control-only is not a reason.
 * Stop remains optional.
 *
 * Emptiness is decided by hasVisibleReasonText (shared with cleanReason).
 * Stored reasons stay trim-only so mid-string ZWJ / VS16 in emoji is kept.
 */

/**
 * C0/C1 + zero-width / format / invisible controls, hangul fillers,
 * variation selectors, and tag characters. Emptiness check only — not stripped
 * from stored text. `u` so supplementary-plane ranges match as code points.
 */
const INVISIBLE_REASON_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u00AD\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0001}\u{E0020}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export const REQUIRED_REASON_HINT_JA = "理由を入力してください";

/** True when trim + stripping zero-width / invisible controls leaves a visible reason. */
export function hasVisibleReasonText(text: string): boolean {
  return text.replace(INVISIBLE_REASON_CHARS, "").trim().length > 0;
}

export function hasRequiredReason(reason: unknown): boolean {
  return typeof reason === "string" && hasVisibleReasonText(reason);
}
