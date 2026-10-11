/**
 * TEST FIXTURE ONLY — frozen copy of lib/mail-policy/apply.ts as of
 * origin/main a72c9f8 (after #223 + #227 merged).
 * Used by mail-policy-followup tests to prove the follow-up hardening is never
 * looser than current main for any input in the test grid.
 * Do not import from production code.
 */
/**
 * B1 Mail Policy — outbound mail send/draft evaluation.
 *
 * Fail-closed: default external → draft_only.
 * draft_only on mail.send demotes to mail.draft (never silent).
 * Pure reject only for denylist / hard violations.
 * D1 attachment: stricter side wins (forbid / Sealith).
 *
 * Hardening (2026-10-03, follow-up to PR #223) — every change is stricter-only:
 * - Every recipient in to / cc / bcc is parsed (comma / semicolon lists of
 *   plain addresses) and judged; the strictest per-recipient outcome wins.
 *   Any external recipient makes the whole mail external, and every recipient
 *   is additionally judged under the mail audience.
 * - A recipient without a parseable domain rejects the mail
 *   (mail_recipient_invalid).
 * - No matching rule never yields auto: approval is the floor, and the legacy
 *   first-rule outcome is kept only when it is stricter (draft / reject).
 * - rule.requireHumanFinalSend forces approval on auto.
 */
import type {
  AttachmentHandoff,
  MailAttachmentPolicyRef,
  MailPolicyDecision,
  MailPolicyRule,
  OrgIngressHandoffPolicy,
  OrgInternalAudienceRule,
  OrgMailPolicy,
  SealithHandoff,
} from "@/lib/types";
import { isEmailDomainInternal } from "@/lib/data/internal-audience-rule";
import { defaultMailPolicy } from "../validate";

export interface EvaluateMailPolicyInput {
  policy?: OrgMailPolicy | null;
  to: string;
  cc?: string[];
  bcc?: string[];
  hasAttachments?: boolean;
  internalAudienceRule?: OrgInternalAudienceRule | null;
  ingressHandoffPolicy?: OrgIngressHandoffPolicy | null;
  sealithTransferId?: string | null;
  /** cc / bcc were present in args but not a string / string[] (fail-closed). */
  malformedRecipients?: boolean;
}

type ParsedRecipient = { address: string; domain: string };

const ADDRESS_RE =
  /^[^\s@<>()[\]\\,;:"]+@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/i;

/**
 * Parse a recipient list string. Splits on "," and ";". Each segment must be a
 * plain addr-spec with a dotted ASCII domain. Display names ("Name <addr>"),
 * quoted local parts, IDN, bare hosts and empty segments (e.g. a trailing
 * comma) are invalid on purpose (fail-closed): legacy judged such strings by
 * the text after the last "@", so accepting them here could be looser.
 */
export function parseMailRecipientList(raw: string): {
  recipients: ParsedRecipient[];
  invalid: string[];
} {
  const recipients: ParsedRecipient[] = [];
  const invalid: string[] = [];
  if (!raw.trim()) return { recipients, invalid };
  for (const segment of raw.split(/[,;]/)) {
    const candidate = segment.trim();
    const match = ADDRESS_RE.exec(candidate);
    if (!match) {
      invalid.push(candidate || "(empty)");
      continue;
    }
    recipients.push({ address: candidate.toLowerCase(), domain: match[1].toLowerCase() });
  }
  return { recipients, invalid };
}

function classifyAudience(
  to: string,
  internalRule?: OrgInternalAudienceRule | null
): "internal" | "external" {
  if (internalRule && isEmailDomainInternal(internalRule, to)) {
    return "internal";
  }
  return "external";
}

function selectRule(
  policy: OrgMailPolicy,
  audience: "internal" | "external",
  domain: string
): { rule: MailPolicyRule | null; matched: boolean } {
  const sorted = [...policy.rules].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );

  for (const rule of sorted) {
    const audienceMatch =
      !rule.audience || rule.audience === "any" || rule.audience === audience;
    if (!audienceMatch) continue;

    if (rule.toDomainDenylist?.length && rule.toDomainDenylist.includes(domain)) {
      return { rule, matched: true };
    }

    if (rule.toDomainAllowlist?.length && !rule.toDomainAllowlist.includes(domain)) {
      continue;
    }

    return { rule, matched: true };
  }

  // No rule matched. The first rule is NOT applied as-is: the caller treats
  // this as approval-required and only keeps the legacy first-rule outcome
  // when it is stricter (draft / reject). See evaluateForRecipient.
  return { rule: sorted[0] ?? null, matched: false };
}

function resolveD1Attachment(
  ingressPolicy?: OrgIngressHandoffPolicy | null
): { attachment: AttachmentHandoff; sealith: SealithHandoff } {
  const rule = ingressPolicy?.rules?.[0];
  return {
    attachment: rule?.attachment ?? "meta",
    sealith: rule?.sealith ?? "suggest",
  };
}

/**
 * Resolve effective attachment policy. Stricter side wins between B1 and D1.
 */
export function resolveMailAttachmentPolicy(
  mailRef: MailAttachmentPolicyRef | undefined,
  ingressPolicy?: OrgIngressHandoffPolicy | null,
  hasAttachments?: boolean,
  sealithTransferId?: string | null
): {
  allowed: boolean;
  effective: MailAttachmentPolicyRef | "forbid" | "sealith_required";
  reason?: string;
} {
  if (!hasAttachments) {
    return { allowed: true, effective: mailRef ?? "inherit_d1" };
  }

  if (mailRef === "forbid") {
    return {
      allowed: false,
      effective: "forbid",
      reason: "mail_policy_attachment_forbidden",
    };
  }

  const d1 = resolveD1Attachment(ingressPolicy);

  if (d1.attachment === "none") {
    return {
      allowed: false,
      effective: "forbid",
      reason: "d1_attachment_none",
    };
  }

  if (d1.sealith === "required" && !sealithTransferId) {
    return {
      allowed: false,
      effective: "sealith_required",
      reason: "d1_sealith_required",
    };
  }

  return { allowed: true, effective: mailRef ?? "inherit_d1" };
}

function evaluateRule(
  policy: OrgMailPolicy,
  rule: MailPolicyRule,
  audience: "internal" | "external",
  domain: string,
  input: EvaluateMailPolicyInput
): MailPolicyDecision {
  const auditLabels: string[] = [`audience:${audience}`];
  const appliedRules: string[] = [rule.id];

  auditLabels.push(`sendMode:${rule.sendMode}`);

  if (rule.toDomainDenylist?.length && rule.toDomainDenylist.includes(domain)) {
    return {
      allowed: false,
      rejected: true,
      rejectReason: `Domain ${domain} is on denylist`,
      rejectCode: "mail_domain_denied",
      demotedToDraft: false,
      needsApproval: false,
      autoSend: false,
      sendMode: rule.sendMode,
      audience,
      attachmentAllowed: false,
      effectiveAttachmentPolicy: "forbid",
      auditLabels: [...auditLabels, "denylist:matched"],
      appliedRules,
    };
  }

  if (rule.toDomainAllowlist?.length && !rule.toDomainAllowlist.includes(domain)) {
    return {
      allowed: false,
      rejected: true,
      rejectReason: `Domain ${domain} is not on allowlist`,
      rejectCode: "mail_domain_not_allowed",
      demotedToDraft: false,
      needsApproval: false,
      autoSend: false,
      sendMode: rule.sendMode,
      audience,
      attachmentAllowed: false,
      effectiveAttachmentPolicy: "forbid",
      auditLabels: [...auditLabels, "allowlist:miss"],
      appliedRules,
    };
  }

  if (input.cc?.length && rule.allowCc === false) {
    return {
      allowed: false,
      rejected: true,
      rejectReason: "CC not allowed by mail policy",
      rejectCode: "mail_cc_forbidden",
      demotedToDraft: false,
      needsApproval: false,
      autoSend: false,
      sendMode: rule.sendMode,
      audience,
      attachmentAllowed: false,
      effectiveAttachmentPolicy: "forbid",
      auditLabels: [...auditLabels, "cc:forbidden"],
      appliedRules,
    };
  }

  if (input.bcc?.length && rule.allowBcc === false) {
    return {
      allowed: false,
      rejected: true,
      rejectReason: "BCC not allowed by mail policy",
      rejectCode: "mail_bcc_forbidden",
      demotedToDraft: false,
      needsApproval: false,
      autoSend: false,
      sendMode: rule.sendMode,
      audience,
      attachmentAllowed: false,
      effectiveAttachmentPolicy: "forbid",
      auditLabels: [...auditLabels, "bcc:forbidden"],
      appliedRules,
    };
  }

  const attachment = resolveMailAttachmentPolicy(
    rule.attachmentPolicyRef,
    input.ingressHandoffPolicy,
    input.hasAttachments,
    input.sealithTransferId
  );

  auditLabels.push(`attachment:${attachment.effective}`);

  if (!attachment.allowed) {
    return {
      allowed: false,
      rejected: true,
      rejectReason: attachment.reason,
      rejectCode: attachment.reason,
      demotedToDraft: false,
      needsApproval: false,
      autoSend: false,
      sendMode: rule.sendMode,
      audience,
      attachmentAllowed: false,
      effectiveAttachmentPolicy: attachment.effective,
      auditLabels,
      appliedRules,
    };
  }

  if (rule.sendMode === "draft_only") {
    return {
      allowed: true,
      rejected: false,
      demotedToDraft: true,
      needsApproval: false,
      autoSend: false,
      sendMode: "draft_only",
      audience,
      attachmentAllowed: attachment.allowed,
      effectiveAttachmentPolicy: attachment.effective,
      auditLabels,
      appliedRules,
      code: "mail_send_demoted_to_draft",
    };
  }

  if (rule.sendMode === "needs_approval") {
    return {
      allowed: true,
      rejected: false,
      demotedToDraft: false,
      needsApproval: true,
      autoSend: false,
      sendMode: "needs_approval",
      audience,
      attachmentAllowed: attachment.allowed,
      effectiveAttachmentPolicy: attachment.effective,
      auditLabels,
      appliedRules,
    };
  }

  const hasConsent = Boolean(policy.highRiskConsentAt && policy.highRiskConsentBy);
  const requireHuman = rule.requireHumanFinalSend === true;
  const autoSend = hasConsent && !requireHuman;

  return {
    allowed: true,
    rejected: false,
    demotedToDraft: false,
    needsApproval: !autoSend,
    autoSend,
    sendMode: "auto",
    audience,
    attachmentAllowed: attachment.allowed,
    effectiveAttachmentPolicy: attachment.effective,
    auditLabels: [
      ...auditLabels,
      hasConsent ? "auto:consented" : "auto:no_consent",
      ...(requireHuman ? ["requireHumanFinalSend:true"] : []),
    ],
    appliedRules,
  };
}

/** Strictness rank: reject > draft > approval > defer-to-gate > auto. */
function decisionRank(d: MailPolicyDecision): number {
  if (d.rejected) return 4;
  if (d.demotedToDraft) return 3;
  if (d.needsApproval) return 2;
  if (!d.autoSend) return 1;
  return 0;
}

/** Turn any non-reject / non-draft outcome into approval-required. */
function floorToApproval(d: MailPolicyDecision, label: string): MailPolicyDecision {
  if (d.rejected || d.demotedToDraft || d.needsApproval) {
    return { ...d, auditLabels: [...d.auditLabels, label] };
  }
  return {
    ...d,
    allowed: true,
    needsApproval: true,
    autoSend: false,
    auditLabels: [...d.auditLabels, label],
  };
}

function evaluateForRecipient(
  policy: OrgMailPolicy,
  audience: "internal" | "external",
  domain: string,
  input: EvaluateMailPolicyInput
): MailPolicyDecision {
  const { rule, matched } = selectRule(policy, audience, domain);

  if (!rule) {
    // Empty rule list: external stays draft (legacy), internal needs approval.
    return {
      allowed: true,
      rejected: false,
      demotedToDraft: audience === "external",
      needsApproval: audience !== "external",
      autoSend: false,
      sendMode: audience === "external" ? "draft_only" : "needs_approval",
      audience,
      attachmentAllowed: true,
      effectiveAttachmentPolicy: "inherit_d1",
      auditLabels: [`audience:${audience}`, "rule:no_match", `sendMode:${audience === "external" ? "draft_only" : "needs_approval"}`],
      appliedRules: [],
      code: audience === "external" ? "mail_send_demoted_to_draft" : undefined,
    };
  }

  const decision = evaluateRule(policy, rule, audience, domain, input);
  return matched ? decision : floorToApproval(decision, "rule:no_match");
}

function invalidRecipientDecision(
  audience: "internal" | "external",
  invalid: string[]
): MailPolicyDecision {
  return {
    allowed: false,
    rejected: true,
    rejectReason:
      invalid.length > 0
        ? `Recipient without a valid domain: ${invalid.slice(0, 3).join(", ")}`
        : "No valid recipient",
    rejectCode: "mail_recipient_invalid",
    demotedToDraft: false,
    needsApproval: false,
    autoSend: false,
    sendMode: "draft_only",
    audience,
    attachmentAllowed: false,
    effectiveAttachmentPolicy: "forbid",
    auditLabels: [`audience:${audience}`, "recipient:invalid"],
    appliedRules: [],
  };
}

export function evaluateMailPolicy(
  input: EvaluateMailPolicyInput
): MailPolicyDecision {
  const policy = input.policy ?? defaultMailPolicy();

  const parsedTo = parseMailRecipientList(typeof input.to === "string" ? input.to : "");
  const parsedCc = (input.cc ?? []).map((v) => parseMailRecipientList(v));
  const parsedBcc = (input.bcc ?? []).map((v) => parseMailRecipientList(v));
  const all = [parsedTo, ...parsedCc, ...parsedBcc];
  const recipients = all.flatMap((p) => p.recipients);
  const invalid = all.flatMap((p) => p.invalid);

  // Fail-closed: unparseable recipient, malformed cc/bcc container, or no "to".
  if (input.malformedRecipients || invalid.length > 0 || parsedTo.recipients.length === 0) {
    return invalidRecipientDecision("external", invalid);
  }

  const withAudience = recipients.map((r) => ({
    ...r,
    audience: classifyAudience(r.address, input.internalAudienceRule),
  }));
  const mailAudience: "internal" | "external" = withAudience.some((r) => r.audience === "external")
    ? "external"
    : "internal";

  let chosen: MailPolicyDecision | null = null;
  const appliedRules: string[] = [];
  for (const r of withAudience) {
    const audiences = r.audience === mailAudience ? [r.audience] : [r.audience, mailAudience];
    for (const aud of audiences) {
      const d = evaluateForRecipient(policy, aud, r.domain, input);
      for (const id of d.appliedRules) if (!appliedRules.includes(id)) appliedRules.push(id);
      if (!chosen || decisionRank(d) > decisionRank(chosen)) chosen = d;
    }
  }

  const decision = chosen as MailPolicyDecision;
  return {
    ...decision,
    audience: mailAudience,
    auditLabels: [
      `audience:${mailAudience}`,
      ...decision.auditLabels.filter((l) => !l.startsWith("audience:")),
      `recipients:${withAudience.length}`,
    ],
    appliedRules: [...decision.appliedRules, ...appliedRules.filter((id) => !decision.appliedRules.includes(id))],
  };
}

export function extractMailRecipients(body: {
  args?: Record<string, unknown>;
}): { cc: string[]; bcc: string[]; hasAttachments: boolean; malformed: boolean } {
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const cc = normalizeEmailList(args.cc);
  const bcc = normalizeEmailList(args.bcc);
  const hasAttachments =
    Array.isArray(args.attachments) && args.attachments.length > 0 ||
    args.hasAttachments === true;
  // Fail-closed: a cc / bcc we cannot read must not be silently dropped.
  const malformed = isMalformedEmailList(args.cc) || isMalformedEmailList(args.bcc);
  return { cc, bcc, hasAttachments, malformed };
}

function isMalformedEmailList(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some((v) => typeof v !== "string");
  return true;
}

function normalizeEmailList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
  }
  return [];
}
