import { classifyInvokeFailure } from "@/lib/stuck-watch/classify";

/**
 * Attach faultClass + stuckHint to Gateway / MCP invoke failure bodies.
 */
export function enrichInvokeFailureBody(
  body: Record<string, unknown>,
  httpStatus?: number
): Record<string, unknown> {
  if (body.faultClass && body.stuckHint) {
    return body;
  }

  const code = String(body.code || body.error || "");
  const egress =
    body.egress && typeof body.egress === "object" && !Array.isArray(body.egress)
      ? (body.egress as {
          reason?: string;
          audience?: string;
          effectiveAudience?: string;
        })
      : null;

  const classified = classifyInvokeFailure({
    code,
    error: typeof body.error === "string" ? body.error : null,
    needs_approval: body.needs_approval === true || code === "needs_approval",
    httpStatus,
    egress,
    hasInternalLedger: body.hasInternalLedger === true,
    approvedUnfulfilled: body.approvedUnfulfilled === true,
  });

  return {
    ...body,
    faultClass: classified.faultClass,
    stuckHint: classified.stuckHint,
  };
}
