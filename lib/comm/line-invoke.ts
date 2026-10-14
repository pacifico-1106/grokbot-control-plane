/**
 * L-6 glue: invoke / fulfill → sendLineConversationMessage.
 * Destination and counterparty come only from the conversation token.
 * External sends need approval by default (who/what public, or a human yes).
 */
import { createHash } from "node:crypto";
import { conversationTokenFromRequest } from "@/lib/comm/conversation-token";
import { isLineConversationEnabled } from "@/lib/comm/flags";
import { recordLineReplyUnknown, wasLineReplyUnknown } from "@/lib/comm/reply-token-ledger";
import { sendLineConversationMessage, type LineSendResult } from "@/lib/comm/line-send";
import type { ConversationContext } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLineConversationRequest(ctx: ConversationContext | null | undefined, body: { conversation?: unknown; args?: unknown }): boolean {
  if (!isLineConversationEnabled()) return false;
  if ((ctx?.surface || "").toLowerCase() !== "line") return false;
  return Boolean(conversationTokenFromRequest(body));
}

/** Stable UUID per logical send (job / approval id) for X-Line-Retry-Key. */
export function lineRetryKey(id: string): string {
  if (UUID_RE.test(id)) return id;
  const h = createHash("sha256").update(`line-retry:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Tenant (org/default) reply_policy cannot waive external approval.
 * Only an explicit per-employee or per-role "no approval", or tool hint `auto`.
 */
export function lineExternalNoApproval(input: {
  policySource: "employee" | "org" | "default" | string;
  ruleExternalApproval?: string | null;
  roleExternalApproval?: string | null;
  toolHint?: string | null;
}): boolean {
  if (input.toolHint === "auto") return true;
  if (input.roleExternalApproval === "no_approval") return true;
  if (input.policySource === "employee" && input.ruleExternalApproval === "no_approval") return true;
  return false;
}

export function lineExternalSendAllowed(input: {
  priorApprovalOk: boolean;
  audience: "internal" | "external" | "unknown" | string;
  informationClass?: string | null;
  egressDecision?: string | null;
  employeeNoApproval?: boolean;
}): boolean {
  if (input.priorApprovalOk) return true;
  if (input.audience === "internal") return false;
  if (input.employeeNoApproval) return true;
  return input.informationClass === "public" && (input.egressDecision === "allow" || input.egressDecision === "summarize");
}

/** Unclassified external LINE: default confidential-deny becomes needs_approval. */
export function lineForceExternalApproval(input: {
  surface?: string | null;
  audience: string;
  egressDecision: string;
  informationClass?: string | null;
  explicitClass?: string | null;
  unclassified?: boolean;
  employeeNoApproval?: boolean;
}): boolean {
  if (!isLineConversationEnabled()) return false;
  if ((input.surface || "").toLowerCase() !== "line") return false;
  if (input.audience !== "external" && input.audience !== "unknown") return false;
  if (input.employeeNoApproval) return false;
  if (input.egressDecision !== "deny") return false;
  if (input.explicitClass === "confidential" || input.explicitClass === "verbatim") return false;
  return input.unclassified !== false;
}

/** When the employee/role setting is "no approval", unclassified external deny becomes allow. */
export function lineWaiveExternalDeny(input: {
  surface?: string | null;
  audience: string;
  egressDecision: string;
  explicitClass?: string | null;
  unclassified?: boolean;
  employeeNoApproval?: boolean;
}): boolean {
  if (!isLineConversationEnabled()) return false;
  if ((input.surface || "").toLowerCase() !== "line") return false;
  if (!input.employeeNoApproval) return false;
  if (input.audience !== "external" && input.audience !== "unknown") return false;
  if (input.egressDecision !== "deny" && input.egressDecision !== "needs_approval") return false;
  if (input.explicitClass === "confidential" || input.explicitClass === "verbatim") return false;
  return input.unclassified !== false;
}

export async function alreadyLineUnknown(orgId: string, retryId: string): Promise<boolean> {
  return wasLineReplyUnknown({ orgId, retryKey: retryId });
}

export async function deliverLineConversation(input: {
  token: string | null | undefined;
  args: Record<string, unknown>;
  text: unknown;
  orgId: string;
  employeeId: string;
  externalSendAllowed: boolean;
  retryId: string;
}, deps?: { send?: typeof sendLineConversationMessage }): Promise<LineSendResult> {
  if (await alreadyLineUnknown(input.orgId, input.retryId)) {
    return { status: "unknown", reason: "line_unknown_already_recorded", audience: "external", mode: "push" };
  }
  const send = deps?.send ?? sendLineConversationMessage;
  const result = await send({
    token: input.token,
    args: input.args,
    text: input.text,
    orgId: input.orgId,
    employeeId: input.employeeId,
    externalSendAllowed: input.externalSendAllowed,
    retryKey: lineRetryKey(input.retryId),
  });
  if (result.status === "unknown") {
    const recorded = await recordLineReplyUnknown({ orgId: input.orgId, retryKey: input.retryId });
    if (!recorded.ok) {
      return { status: "unknown", reason: "unknown_record_failed", audience: result.audience, mode: result.mode };
    }
  }
  return result;
}

export function lineSendAsPosted(result: LineSendResult): {
  ok: boolean;
  sendState: "sent" | "not_sent" | "unknown";
  error?: string;
  delivery?: "line";
} {
  if (result.status === "sent") return { ok: true, sendState: "sent", delivery: "line" };
  if (result.status === "unknown") return { ok: false, sendState: "unknown", error: result.reason };
  return { ok: false, sendState: "not_sent", error: result.reason };
}
