import type { ApprovalPolicy, EmployeeScope, SodVerdict } from "@/lib/types";

/**
 * SoD concentration stays fail-closed: mixed high-risk domains force
 * always_human unless the operator explicitly acknowledged the warning.
 * sod_level itself is not rewritten here (stays force_human for the UI).
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

/** PATCH must tell the UI instead of silently re-locking. */
export function sodAckRequired(input: {
  verdict: Pick<SodVerdict, "level">;
  requested: ApprovalPolicy;
  acknowledged?: boolean;
}): boolean {
  return (
    input.verdict.level === "force_human" &&
    input.requested !== "always_human" &&
    !input.acknowledged
  );
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
  verdict: Pick<SodVerdict, "level">;
  acknowledged?: boolean;
}): boolean {
  if (samePolicyFields(input.existing, input.posted)) return false;
  return sodAckRequired({
    verdict: input.verdict,
    requested: input.posted.approvalPolicy,
    acknowledged: input.acknowledged,
  });
}
