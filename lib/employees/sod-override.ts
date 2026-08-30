import { sodNeedsOperatorAck } from "@/lib/employees/sod";
import type { ApprovalPolicy, EmployeeScope, SodVerdict } from "@/lib/types";

type VerdictForAck = Pick<SodVerdict, "level"> & Partial<Pick<SodVerdict, "domains">>;

/**
 * force_human without ack stays fail-closed (always_human).
 * send+confirm warn never rewrites — PATCH/hire must collect ack instead.
 */
export function resolveApprovalPolicy(input: {
  verdict: Pick<SodVerdict, "level">;
  requested: ApprovalPolicy;
  acknowledged?: boolean;
}): ApprovalPolicy {
  if (input.verdict.level === "force_human" && !input.acknowledged) {
    return "always_human";
  }
  return input.requested;
}

/** PATCH / hire must tell the UI instead of silently re-locking. */
export function sodAckRequired(input: {
  verdict: VerdictForAck;
  requested: ApprovalPolicy;
  acknowledged?: boolean;
}): boolean {
  if (input.requested === "always_human" || input.acknowledged) return false;
  return sodNeedsOperatorAck({
    level: input.verdict.level,
    domains: input.verdict.domains ?? [],
  });
}

/** True when posted scopes + approvalPolicy match the stored employee. */
export function samePolicyFields(
  existing: { scopes: readonly string[]; approvalPolicy: string },
  posted: { scopes: readonly string[]; approvalPolicy: string }
): boolean {
  if (existing.approvalPolicy !== posted.approvalPolicy) return false;
  if (existing.scopes.length !== posted.scopes.length) return false;
  const a = [...existing.scopes].sort();
  const b = [...posted.scopes].sort();
  return a.every((scope, i) => scope === b[i]);
}

/**
 * Manager / voice / identity / project PATCHes re-post existing scopes
 * and approvalPolicy. Those must not demand a fresh SoD ack.
 */
export function sodAckRequiredOnPatch(input: {
  existing: { scopes: readonly EmployeeScope[]; approvalPolicy: ApprovalPolicy };
  posted: { scopes: readonly EmployeeScope[]; approvalPolicy: ApprovalPolicy };
  verdict: VerdictForAck;
  acknowledged?: boolean;
}): boolean {
  if (samePolicyFields(input.existing, input.posted)) return false;
  return sodAckRequired({
    verdict: input.verdict,
    requested: input.posted.approvalPolicy,
    acknowledged: input.acknowledged,
  });
}
