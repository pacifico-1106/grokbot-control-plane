/**
 * F1 Mouth Routing — dual-gate S3 + multi-mouth priority.
 *
 * Routes conversation content based on dualEgress decisions:
 * - Channel/Connect posts: external-safe body only (effectiveDecision)
 * - Internal-only content: route to DM / limited thread, or hold behind approval
 *
 * Constraints:
 * - Conversation adapters ≠ approval notification channels (never mix)
 * - Mentions still required for channel/Connect wake
 * - Approval need ≠ mentioned person is approver
 * - Fail-closed: unknown/external-mixed without resolvable internal parties → no internal leak
 *
 * Extension point: F6 identity disclosure (WHO×WHAT disclosure) is adjacent but separate.
 */

import type {
  ContentVariant,
  ConversationSurface,
  DualAudience,
  DualEgressVerdict,
  MouthPriority,
  MouthRoutingAuditLabel,
  MouthRoutingDecision,
  MouthRoutingRule,
  OrgMouthRoutingPolicy,
  RoutingInstruction,
} from "@/lib/types";
import { dualDecisionsDiffer } from "@/lib/gateway/egress";

/**
 * Default mouth routing policy for orgs without explicit configuration.
 */
export function defaultMouthRoutingPolicy(): OrgMouthRoutingPolicy {
  return {
    version: 1,
    policyId: "default",
    policyName: "既定の口ルーティング",
    rules: [
      {
        id: "default_rule",
        priority: 0,
        preferDmForInternal: true,
        holdOnUnknownInternal: true,
      },
    ],
    defaultMouthPriority: ["slack", "line"],
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
  };
}

/**
 * Resolve the preferred conversation surface from available adapters.
 * Priority: Slack → LINE → Chatwork → Messenger (per product spec).
 *
 * @param available - Surfaces with enabled adapters
 * @param priority - Optional custom priority order
 * @returns The highest-priority available surface, or null if none
 */
export function resolvePreferredMouth(
  available: ConversationSurface[],
  priority?: MouthPriority
): ConversationSurface | null {
  const order = priority ?? ["slack", "line"];
  for (const surface of order) {
    if (available.includes(surface)) {
      return surface;
    }
  }
  return available[0] ?? null;
}

/**
 * Extract internal party user IDs from dual audience signals.
 * Used for routing internal content to specific DMs.
 */
export function extractInternalPartyIds(
  dualAudience: DualAudience | null
): string[] {
  if (!dualAudience) return [];
  return dualAudience.partySignals
    .filter((signal) => signal.audience === "internal" && signal.resolved)
    .map((signal) => signal.identifier)
    .filter((id): id is string => Boolean(id));
}

/**
 * Check if internal routing is safe (no leak to external/unknown parties).
 * Fail-closed: any unresolved or external party blocks internal routing.
 */
export function isInternalRoutingSafe(
  dualAudience: DualAudience | null
): { safe: boolean; reason?: string } {
  if (!dualAudience) {
    return { safe: false, reason: "no_dual_audience" };
  }
  if (!dualAudience.channelMixed) {
    return { safe: true };
  }
  if (dualAudience.hasExternalParty) {
    return { safe: false, reason: "external_party_present" };
  }
  if (!dualAudience.hasInternalParty) {
    return { safe: false, reason: "no_internal_party" };
  }
  const unresolvedInternal = dualAudience.partySignals.some(
    (signal) => signal.audience === "internal" && !signal.resolved
  );
  if (unresolvedInternal) {
    return { safe: false, reason: "unresolved_internal_party" };
  }
  return { safe: true };
}

/**
 * Determine the content variant based on egress decision.
 */
function contentVariantFromDecision(
  decision: "allow" | "summarize" | "needs_approval" | "deny"
): ContentVariant {
  switch (decision) {
    case "allow":
      return "external_safe";
    case "summarize":
      return "summary_only";
    case "needs_approval":
    case "deny":
      return "external_safe";
  }
}

/**
 * Build a channel routing instruction (external-safe).
 */
function buildChannelRoute(
  dualEgress: DualEgressVerdict,
  surfaceHint?: ConversationSurface
): RoutingInstruction | null {
  const decision = dualEgress.effectiveDecision.decision;
  if (decision === "deny") {
    return null;
  }
  return {
    path: { kind: "channel", surfaceHint },
    contentVariant: contentVariantFromDecision(decision),
    audience: "external",
    auditLabel: `channel_${decision}`,
  };
}

/**
 * Build an internal routing instruction (DM / thread / hold).
 */
function buildInternalRoute(input: {
  dualEgress: DualEgressVerdict;
  dualAudience: DualAudience | null;
  internalPartyIds: string[];
  rule: MouthRoutingRule;
  surfaceHint?: ConversationSurface;
  threadId?: string;
}): RoutingInstruction | null {
  const { dualEgress, dualAudience, internalPartyIds, rule, surfaceHint, threadId } = input;

  if (!dualEgress.dualEvaluated) {
    return null;
  }

  const internalDecision = dualEgress.internalDecision.decision;
  const externalDecision = dualEgress.externalDecision.decision;

  if (internalDecision === externalDecision) {
    return null;
  }

  if (internalDecision === "deny") {
    return {
      path: { kind: "deny", reason: dualEgress.internalDecision.reason },
      contentVariant: "internal_full",
      audience: "internal",
      auditLabel: "internal_denied",
    };
  }

  const safetyCheck = isInternalRoutingSafe(dualAudience);
  if (!safetyCheck.safe) {
    if (rule.holdOnUnknownInternal !== false) {
      return {
        path: { kind: "hold_approval", reason: safetyCheck.reason ?? "fail_closed" },
        contentVariant: "internal_full",
        audience: "internal",
        auditLabel: `internal_held_${safetyCheck.reason}`,
      };
    }
    return null;
  }

  if (internalDecision === "needs_approval") {
    return {
      path: { kind: "hold_approval", reason: "needs_approval" },
      contentVariant: "internal_full",
      audience: "internal",
      auditLabel: "internal_needs_approval",
    };
  }

  if (rule.preferDmForInternal && internalPartyIds.length > 0) {
    return {
      path: { kind: "dm", targetUserIds: internalPartyIds, surfaceHint },
      contentVariant: contentVariantFromDecision(internalDecision),
      audience: "internal",
      auditLabel: `internal_dm_${internalDecision}`,
    };
  }

  if (threadId) {
    return {
      path: { kind: "limited_thread", parentThreadId: threadId, surfaceHint },
      contentVariant: contentVariantFromDecision(internalDecision),
      audience: "internal",
      auditLabel: `internal_thread_${internalDecision}`,
    };
  }

  if (internalPartyIds.length > 0) {
    return {
      path: { kind: "dm", targetUserIds: internalPartyIds, surfaceHint },
      contentVariant: contentVariantFromDecision(internalDecision),
      audience: "internal",
      auditLabel: `internal_dm_${internalDecision}`,
    };
  }

  return {
    path: { kind: "hold_approval", reason: "no_internal_destination" },
    contentVariant: "internal_full",
    audience: "internal",
    auditLabel: "internal_held_no_destination",
  };
}

export interface EvaluateMouthRoutingInput {
  dualEgress: DualEgressVerdict;
  dualAudience: DualAudience | null;
  policy?: OrgMouthRoutingPolicy | null;
  availableSurfaces?: ConversationSurface[];
  threadId?: string;
}

/**
 * Evaluate mouth routing based on dual egress decisions.
 *
 * When dualEgress shows internalDecision differs from externalDecision:
 * - Channel/surface post uses external-safe / effectiveDecision content only
 * - If internal-facing allows richer content, deliver via DM to internal parties
 *   and/or a limited thread path; audit both paths
 *
 * Fail-closed: unknown/external-mixed without resolvable internal parties → no internal leak
 */
export function evaluateMouthRouting(
  input: EvaluateMouthRoutingInput
): MouthRoutingDecision {
  const {
    dualEgress,
    dualAudience,
    policy,
    availableSurfaces = ["slack"],
    threadId,
  } = input;

  const effectivePolicy = policy ?? defaultMouthRoutingPolicy();
  const rule = effectivePolicy.rules[0] ?? {
    id: "fallback",
    preferDmForInternal: true,
    holdOnUnknownInternal: true,
  };

  const surfaceHint = resolvePreferredMouth(
    availableSurfaces,
    rule.mouthPriority ?? effectivePolicy.defaultMouthPriority
  );

  const internalPartyIds = extractInternalPartyIds(dualAudience);

  const channelRoute = buildChannelRoute(dualEgress, surfaceHint ?? undefined);
  const internalRoute = buildInternalRoute({
    dualEgress,
    dualAudience,
    internalPartyIds,
    rule,
    surfaceHint: surfaceHint ?? undefined,
    threadId,
  });

  const splitDelivery = Boolean(channelRoute && internalRoute);
  const internalHeld =
    internalRoute?.path.kind === "hold_approval" ||
    internalRoute?.path.kind === "deny";
  const holdReason =
    internalRoute?.path.kind === "hold_approval"
      ? internalRoute.path.reason
      : internalRoute?.path.kind === "deny"
        ? internalRoute.path.reason
        : undefined;

  const auditLabels: string[] = [];
  if (channelRoute) auditLabels.push(channelRoute.auditLabel);
  if (internalRoute) auditLabels.push(internalRoute.auditLabel);

  return {
    channelRoute,
    internalRoute,
    splitDelivery,
    internalHeld,
    holdReason,
    auditLabels,
  };
}

/**
 * Build audit label for mouth routing decision.
 */
export function buildMouthRoutingAuditLabel(
  decision: MouthRoutingDecision,
  appliedRules: string[]
): MouthRoutingAuditLabel {
  return {
    routeId: `route_${Date.now()}`,
    channelPath: decision.channelRoute?.path.kind,
    internalPath: decision.internalRoute?.path.kind,
    splitDelivery: decision.splitDelivery,
    appliedRules,
    reason: decision.holdReason,
  };
}

/**
 * Check if mouth routing should be applied (dual evaluation with differing decisions).
 */
export function shouldApplyMouthRouting(dualEgress: DualEgressVerdict): boolean {
  return dualEgress.dualEvaluated && dualDecisionsDiffer(dualEgress);
}

/**
 * Summarize mouth routing decision for logging (no tokens/secrets).
 */
export function summarizeMouthRouting(decision: MouthRoutingDecision): string {
  const parts: string[] = [];

  if (decision.channelRoute) {
    parts.push(`channel:${decision.channelRoute.contentVariant}`);
  }

  if (decision.internalRoute) {
    const pathKind = decision.internalRoute.path.kind;
    if (pathKind === "dm") {
      const dmPath = decision.internalRoute.path as { kind: "dm"; targetUserIds: string[] };
      parts.push(`dm:${dmPath.targetUserIds.length}users`);
    } else if (pathKind === "limited_thread") {
      parts.push("thread:limited");
    } else if (pathKind === "hold_approval") {
      parts.push(`hold:${decision.holdReason}`);
    } else if (pathKind === "deny") {
      parts.push(`deny:${decision.holdReason}`);
    }
  }

  if (decision.splitDelivery) {
    parts.push("split:true");
  }

  return parts.join("|") || "no_routing";
}
