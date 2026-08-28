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
