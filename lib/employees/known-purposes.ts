/**
 * Known purpose keys for hire / post-hire chips.
 * Sourced from ROLE_PROFILES purposes in policy-draft plus comm.internal
 * and calendar.confirm (used in action-limit / confirm flows).
 * Do not include scopes (colon keys such as mail:send).
 */
export const KNOWN_PURPOSES = [
  "sales.outreach",
  "commerce.quote",
  "calendar.propose",
  "ops.admin",
  "invoice.check",
  "support.reply",
  "support.triage",
  "hr.screening",
  "hr.schedule",
  "research.web",
  "research.summary",
  "commerce.order",
  "calendar.confirm",
  "comm.internal",
] as const;

export type KnownPurpose = (typeof KNOWN_PURPOSES)[number];

/** Unique chip order for the policy editor (known purposes only). */
export const PURPOSE_CHIPS: readonly KnownPurpose[] = [
  "ops.admin",
  "invoice.check",
  "sales.outreach",
  "commerce.quote",
  "commerce.order",
  "calendar.propose",
  "calendar.confirm",
  "comm.internal",
  "support.reply",
  "support.triage",
  "hr.screening",
  "hr.schedule",
  "research.web",
  "research.summary",
];

/** One plain Japanese line — the reason this employee may act. */
export const PURPOSE_LABELS_JA: Record<KnownPurpose, string> = {
  "ops.admin": "社内の事務をする",
  "invoice.check": "請求を確認する",
  "sales.outreach": "営業の連絡をする",
  "commerce.quote": "見積を作る",
  "commerce.order": "発注する",
  "calendar.propose": "日程の候補を出す",
  "calendar.confirm": "予定を確定する",
  "comm.internal": "社内のやり取りをする",
  "support.reply": "お客に返信する",
  "support.triage": "問い合わせを仕分ける",
  "hr.screening": "応募を確認する",
  "hr.schedule": "面接の日程を組む",
  "research.web": "調べものをする",
  "research.summary": "調査をまとめる",
};

export function purposeLabelJa(purpose: string): string {
  return PURPOSE_LABELS_JA[purpose as KnownPurpose] ?? purpose;
}
