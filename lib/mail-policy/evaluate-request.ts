/**
 * Load the effective mail policy for an org / employee and evaluate one
 * mail.send request. Shared by the gateway invoke (before the approval gate)
 * and the approved-item fulfill re-check, so both judge the same inputs:
 * every primary recipient field + cc / bcc + attachments.
 */
import {
  getEffectiveIngressHandoffPolicy,
  getEffectiveMailPolicy,
} from "@/lib/data";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import type { MailPolicyDecision } from "@/lib/types";
import {
  collectMailToRecipients,
  evaluateMailPolicy,
  extractMailRecipients,
} from "./apply";

export type MailRequestLike = {
  args?: Record<string, unknown>;
  email?: unknown;
  conversation?: { email?: unknown } | null;
};

export async function evaluateMailPolicyForRequest(input: {
  orgId: string;
  employeeId: string;
  body: MailRequestLike;
}): Promise<{ decision: MailPolicyDecision; to: string; sources: string[] }> {
  const effectiveMail = await getEffectiveMailPolicy(input.orgId, input.employeeId);
  const internalRule = await getOrgInternalAudienceRule(input.orgId);
  const d1Effective = await getEffectiveIngressHandoffPolicy(input.orgId, input.employeeId);
  const primary = collectMailToRecipients(input.body);
  const recipients = extractMailRecipients({ args: input.body.args });
  const args = input.body.args && typeof input.body.args === "object" ? input.body.args : {};
  const sealithTransferId =
    typeof args.sealithTransferId === "string" ? args.sealithTransferId : null;
  const decision = evaluateMailPolicy({
    policy: effectiveMail.policy,
    to: primary.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    hasAttachments: recipients.hasAttachments,
    malformedRecipients: recipients.malformed || primary.malformed,
    internalAudienceRule: internalRule,
    ingressHandoffPolicy: d1Effective.policy,
    sealithTransferId,
  });
  return { decision, to: primary.to, sources: primary.sources };
}
