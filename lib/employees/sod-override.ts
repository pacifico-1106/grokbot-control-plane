import type { ApprovalPolicy, SodVerdict } from "@/lib/types";

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
