/**
 * B1 Mail Policy — outbound mail send/draft evaluation.
 *
 * Fail-closed: default external → draft_only.
 * draft_only on mail.send demotes to mail.draft (never silent).
 * Pure reject only for denylist / hard violations.
 * D1 attachment: stricter side wins (forbid / Sealith).
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
import { defaultMailPolicy } from "./validate";

export interface EvaluateMailPolicyInput {
  policy?: OrgMailPolicy | null;
  to: string;
  cc?: string[];
  bcc?: string[];
  hasAttachments?: boolean;
  internalAudienceRule?: OrgInternalAudienceRule | null;
  ingressHandoffPolicy?: OrgIngressHandoffPolicy | null;
  sealithTransferId?: string | null;
}

function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  return email.slice(at + 1).trim().toLowerCase() || undefined;
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
  domain: string | undefined
): MailPolicyRule | null {
  const sorted = [...policy.rules].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
  );

  for (const rule of sorted) {
    const audienceMatch =
      !rule.audience || rule.audience === "any" || rule.audience === audience;
    if (!audienceMatch) continue;

    if (rule.toDomainDenylist?.length && domain) {
      if (rule.toDomainDenylist.includes(domain)) {
        return rule;
      }
    }

    if (rule.toDomainAllowlist?.length && domain) {
      if (!rule.toDomainAllowlist.includes(domain)) {
        continue;
      }
    }

    return rule;
  }

  return sorted[0] ?? null;
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

export function evaluateMailPolicy(
  input: EvaluateMailPolicyInput
): MailPolicyDecision {
  const policy = input.policy ?? defaultMailPolicy();
  const audience = classifyAudience(input.to, input.internalAudienceRule);
  const domain = emailDomain(input.to);
  const rule = selectRule(policy, audience, domain);

  const auditLabels: string[] = [`audience:${audience}`];
  const appliedRules: string[] = rule ? [rule.id] : [];

  if (!rule) {
    return {
      allowed: true,
      rejected: false,
      demotedToDraft: audience === "external",
      needsApproval: false,
      autoSend: false,
      sendMode: "draft_only",
      audience,
      attachmentAllowed: true,
      effectiveAttachmentPolicy: "inherit_d1",
      auditLabels: [...auditLabels, "sendMode:draft_only"],
      appliedRules,
      code: audience === "external" ? "mail_send_demoted_to_draft" : undefined,
    };
  }

  auditLabels.push(`sendMode:${rule.sendMode}`);

  if (rule.toDomainDenylist?.length && domain && rule.toDomainDenylist.includes(domain)) {
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

  if (rule.toDomainAllowlist?.length && domain && !rule.toDomainAllowlist.includes(domain)) {
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
  const autoSend = hasConsent;

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
    auditLabels: [...auditLabels, autoSend ? "auto:consented" : "auto:no_consent"],
    appliedRules,
  };
}

export function extractMailRecipients(body: {
  args?: Record<string, unknown>;
}): { cc: string[]; bcc: string[]; hasAttachments: boolean } {
  const args = body.args && typeof body.args === "object" ? body.args : {};
  const cc = normalizeEmailList(args.cc);
  const bcc = normalizeEmailList(args.bcc);
  const hasAttachments =
    Array.isArray(args.attachments) && args.attachments.length > 0 ||
    args.hasAttachments === true;
  return { cc, bcc, hasAttachments };
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
