/**
 * #292 木村 22:13: one sentence for every classification card / notice that
 * mentions rejecting. Rejecting means "keep this AI employee out of the
 * channel" (and silences the wake-skip notice for 30 days); a wrong class is
 * fixed by classifying again with the right one, not by rejecting.
 */
export const CLASSIFY_REJECT_GUIDANCE_JA =
  "却下するのは、この AI 社員に対応させたくないときだけ。分類が違うときは、正しい区分で分類し直してください";

/** How to file the external classification (notices only; the card has its own buttons). */
export const CLASSIFY_AS_EXTERNAL_HOW_JA =
  "社外なら、管理エージェントで channels.classify に classification=shared_external を指定";

/** Notice tail: guidance + how-to, ending with 「。」. */
export function classifyRejectGuidanceNoticeJa(): string {
  return `${CLASSIFY_REJECT_GUIDANCE_JA}（${CLASSIFY_AS_EXTERNAL_HOW_JA}）。`;
}
