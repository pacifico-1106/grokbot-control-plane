/**
 * WHO × WHAT → egress decision.
 * Four decisions only: allow | summarize | needs_approval | deny.
 *
 * S2: Dual evaluation for mixed/Connect channels — evaluates the matrix
 * twice (internal-facing vs external-facing) and records both decisions
 * for audit. Channel posting remains external-safe (effectiveDecision).
 */

import type {
  Audience,
  DisclosureFidelity,
  DualAudience,
  DualEgressVerdict,
  EgressDecision,
  EgressVerdict,
  InformationClass,
} from "@/lib/types";
import { effectiveAudienceOf } from "@/lib/gateway/audience";

export function evaluateEgressMatrix(input: {
  audience: Audience;
  informationClass: InformationClass;
  fidelity: DisclosureFidelity;
  namedRecipients: boolean;
}): EgressVerdict {
  const effectiveAudience = effectiveAudienceOf(input.audience);
  const { informationClass, fidelity, namedRecipients } = input;

  let decision: EgressDecision;
  let reason: string;
  let messageJa: string;

  if (effectiveAudience === "external") {
    if (informationClass === "public") {
      decision = "allow";
      reason = "external_public_allow";
      messageJa = "公開情報のため社外へ開示できます。";
    } else if (informationClass === "internal" && fidelity === "summary") {
      decision = "summarize";
      reason = "external_internal_summary";
      messageJa = "社外向けのため社内情報は要約のみ開示します。詳細は拒否します。";
    } else if (informationClass === "internal") {
      decision = "deny";
      reason = "external_internal_source_denied";
      messageJa = "社外への社内情報の詳細開示は拒否しました。";
    } else if (informationClass === "confidential") {
      decision = "deny";
      reason = "external_confidential_denied";
      messageJa = "機密情報の社外開示は拒否しました。";
    } else {
      decision = "deny";
      reason = "external_verbatim_denied";
      messageJa = "原文（verbatim）の社外開示は拒否しました。";
    }
  } else if (informationClass === "public") {
    decision = "allow";
    reason = "internal_public_allow";
    messageJa = "公開情報のため社内へ開示できます。";
  } else if (informationClass === "internal") {
    decision = "allow";
    reason = fidelity === "summary" ? "internal_internal_summary_allow" : "internal_internal_source_allow";
    messageJa = "社内向けの社内情報です。開示できます。";
  } else if (informationClass === "confidential") {
    decision = "needs_approval";
    reason = fidelity === "summary" ? "internal_confidential_summary" : "internal_confidential_source";
    messageJa = "機密情報の社内開示には上長の承認が必要です。";
  } else if (namedRecipients) {
    decision = "needs_approval";
    reason = "internal_verbatim_named";
    messageJa = "原文の開示は指名された宛先のみ、上長承認のうえで可能です。";
  } else {
    decision = "deny";
    reason = "internal_verbatim_unnamed";
    messageJa = "原文の開示は宛先が指名されていないチャネルでは拒否します。";
  }

  return {
    decision,
    audience: input.audience,
    effectiveAudience,
    informationClass,
    fidelity,
    namedRecipients,
    reason,
    messageJa,
  };
}

/**
 * S2: Dual egress evaluation for mixed/Connect channels.
 *
 * When dualAudience.channelMixed is true, evaluates the WHO×WHAT matrix
 * twice:
 * - internalDecision: using internalFacing audience (internal parties only)
 * - externalDecision: using externalFacing audience (external-safe)
 *
 * Both decisions are recorded for audit. The effectiveDecision is always
 * the external-facing path (strictest) for channel posting behavior.
 *
 * For non-mixed channels or when dualAudience is null, returns a
 * single-path verdict wrapped in dual format with dualEvaluated=false.
 */
export function evaluateDualEgress(input: {
  audience: Audience;
  dualAudience: DualAudience | null;
  informationClass: InformationClass;
  fidelity: DisclosureFidelity;
  namedRecipients: boolean;
}): DualEgressVerdict {
  const { audience, dualAudience, informationClass, fidelity, namedRecipients } = input;

  const shouldDualEvaluate =
    dualAudience !== null &&
    dualAudience.channelMixed &&
    (dualAudience.hasInternalParty || dualAudience.hasExternalParty);

  if (!shouldDualEvaluate) {
    const singleVerdict = evaluateEgressMatrix({
      audience,
      informationClass,
      fidelity,
      namedRecipients,
    });
    return {
      internalDecision: singleVerdict,
      externalDecision: singleVerdict,
      dualEvaluated: false,
      effectiveDecision: singleVerdict,
    };
  }

  const internalDecision = evaluateEgressMatrix({
    audience: dualAudience.internalFacing,
    informationClass,
    fidelity,
    namedRecipients,
  });

  const externalDecision = evaluateEgressMatrix({
    audience: dualAudience.externalFacing,
    informationClass,
    fidelity,
    namedRecipients,
  });

  return {
    internalDecision,
    externalDecision,
    dualEvaluated: true,
    effectiveDecision: externalDecision,
  };
}

/**
 * Compare two egress decisions for audit logging.
 * Returns true if internal and external paths produce different decisions.
 */
export function dualDecisionsDiffer(dual: DualEgressVerdict): boolean {
  if (!dual.dualEvaluated) return false;
  return dual.internalDecision.decision !== dual.externalDecision.decision;
}
