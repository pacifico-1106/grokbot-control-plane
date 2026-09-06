/**
 * Ingress handoff policy resolver.
 * Evaluates org policy rules (first-match-wins) to determine effective rule
 * for a given Slack message context.
 */
import { getOrgChannel } from "@/lib/data/directory";
import { DEFAULT_INGRESS_HANDOFF_RULE } from "./validate";
import type {
  ChannelClassification,
  ConversationSurface,
  IngressHandoffRule,
  OrgIngressHandoffPolicy,
  SealithHandoff,
} from "@/lib/types";

export interface IngressHandoffContext {
  orgId: string;
  channelId: string;
  surface: ConversationSurface;
  classification?: ChannelClassification;
  isIm?: boolean;
}

export interface ResolvedIngressHandoff {
  rule: IngressHandoffRule;
  matchedApplyTo: "all" | "channels" | "classified_external_sensitive";
  classification: ChannelClassification;
  isDefault: boolean;
}

/**
 * Check if a classification qualifies as "external sensitive" for policy matching.
 * shared_external and unknown are treated as sensitive (fail-closed for unknown).
 */
function isExternalSensitiveClassification(
  classification: ChannelClassification
): boolean {
  return classification === "shared_external" || classification === "unknown";
}

/**
 * Check if a rule matches the given context (first-match-wins evaluation).
 */
function ruleMatchesContext(
  rule: IngressHandoffRule,
  context: IngressHandoffContext,
  classification: ChannelClassification
): boolean {
  switch (rule.applyTo) {
    case "all":
      return true;
    case "channels":
      return (
        Array.isArray(rule.channelIds) &&
        rule.channelIds.some(
          (id) => id.toUpperCase() === context.channelId.toUpperCase()
        )
      );
    case "classified_external_sensitive":
      return isExternalSensitiveClassification(classification);
    default:
      return false;
  }
}

/**
 * Resolve the effective ingress handoff rule for a given context.
 * Uses first-match-wins against ordered policy rules.
 *
 * @param policy - Organization's ingress handoff policy
 * @param context - Message context (channelId, classification, etc.)
 * @returns Resolved rule with match metadata
 */
export async function resolveIngressHandoff(
  policy: OrgIngressHandoffPolicy | null,
  context: IngressHandoffContext
): Promise<ResolvedIngressHandoff> {
  let classification = context.classification;

  if (!classification) {
    const channel = await getOrgChannel(
      context.orgId,
      context.surface,
      context.channelId
    );
    classification = channel?.classification ?? "unknown";
  }

  if (!policy || !policy.rules || policy.rules.length === 0) {
    return {
      rule: { ...DEFAULT_INGRESS_HANDOFF_RULE },
      matchedApplyTo: "all",
      classification,
      isDefault: true,
    };
  }

  for (const rule of policy.rules) {
    if (ruleMatchesContext(rule, context, classification)) {
      return {
        rule,
        matchedApplyTo: rule.applyTo,
        classification,
        isDefault: false,
      };
    }
  }

  return {
    rule: { ...DEFAULT_INGRESS_HANDOFF_RULE },
    matchedApplyTo: "all",
    classification,
    isDefault: true,
  };
}

/**
 * Synchronous resolver for when classification is already known.
 * Useful for tests and cases where channel lookup is not needed.
 */
export function resolveIngressHandoffSync(
  policy: OrgIngressHandoffPolicy | null,
  context: Omit<IngressHandoffContext, "orgId" | "surface"> & {
    classification: ChannelClassification;
  }
): ResolvedIngressHandoff {
  const classification = context.classification;

  if (!policy || !policy.rules || policy.rules.length === 0) {
    return {
      rule: { ...DEFAULT_INGRESS_HANDOFF_RULE },
      matchedApplyTo: "all",
      classification,
      isDefault: true,
    };
  }

  for (const rule of policy.rules) {
    const mockContext: IngressHandoffContext = {
      orgId: "",
      channelId: context.channelId,
      surface: "slack",
      classification,
      isIm: context.isIm,
    };
    if (ruleMatchesContext(rule, mockContext, classification)) {
      return {
        rule,
        matchedApplyTo: rule.applyTo,
        classification,
        isDefault: false,
      };
    }
  }

  return {
    rule: { ...DEFAULT_INGRESS_HANDOFF_RULE },
    matchedApplyTo: "all",
    classification,
    isDefault: true,
  };
}

export type SealithHandoffIntent = {
  mode: SealithHandoff;
  required: boolean;
  hints?: string[];
  otherText?: string;
};

/**
 * Extract Sealith handoff intent from resolved rule.
 * Used to populate wake metadata for downstream Sealith processing.
 */
export function extractSealithIntent(
  rule: IngressHandoffRule
): SealithHandoffIntent {
  return {
    mode: rule.sealith,
    required: rule.sealith === "required",
    hints: rule.sealithRequiredHints,
    otherText: rule.sealithRequiredOtherText,
  };
}
