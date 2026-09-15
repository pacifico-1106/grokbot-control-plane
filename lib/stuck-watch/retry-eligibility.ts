import type { FaultClass, GatewayInvokeRequest, OrgStuckWatchPolicy } from "@/lib/types";
import { isConfirmClassTool, resolveGatewayTool } from "@/lib/gateway/tools";

export type OpsFaultRetryInput = {
  faultClass: FaultClass;
  policy: OrgStuckWatchPolicy;
  retryCount: number;
};

/**
 * Whether an ops_fault invoke failure may be auto-retried under policy limits.
 * expected_gate never auto-retries.
 */
export function canAutoRetryOpsFault(input: OpsFaultRetryInput): boolean {
  if (!input.policy.enabled) return false;
  if (input.faultClass === "expected_gate") return false;
  if (!input.policy.autoRetryFaultClasses.includes(input.faultClass)) {
    return false;
  }
  return input.retryCount < input.policy.maxAutoRetries;
}

const GATE_REEVAL_TOOLS = new Set([
  "mail.send",
  "calendar.confirm",
  "commerce.order",
  "comm.send",
  "comm.reply",
  "sns.publish",
]);

export function sendConfirmToolRequiresGateReevaluation(tool: string): boolean {
  return GATE_REEVAL_TOOLS.has(tool);
}

/**
 * Outbound send/confirm retries must not bypass approval gates.
 * Strip approvalId so runGatewayInvoke re-evaluates policy / approval state.
 */
export function prepareOpsFaultRetryInvokeBody(
  body: GatewayInvokeRequest
): GatewayInvokeRequest {
  const toolRaw = (body.tool || "").trim();
  const resolved = resolveGatewayTool(toolRaw);
  const tool = resolved.ok ? resolved.def.id : toolRaw;
  const confirmClass =
    resolved.ok && isConfirmClassTool(resolved.def);
  const needsGate =
    sendConfirmToolRequiresGateReevaluation(tool) || confirmClass;
  if (!needsGate) {
    return body;
  }
  const next: GatewayInvokeRequest = { ...body };
  delete next.approvalId;
  return next;
}
