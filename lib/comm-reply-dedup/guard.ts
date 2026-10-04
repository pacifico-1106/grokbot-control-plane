/** STUB (TDD red phase). Orchestration used by gateway invoke and approval fulfill. */
import type { ApprovalRequest, GatewayInvokeRequest } from "@/lib/types";
import type { InvokeSnapshot } from "@/lib/approvals/fulfill";
import type { ReplyFingerprint } from "./fingerprint";
import type { CommReplyDedupSettings } from "./config";

export const DUPLICATE_REPLY_SUPPRESSED = "duplicate_reply_suppressed";
export const DUPLICATE_CHECK_UNAVAILABLE = "duplicate_check_unavailable";
export const APPROVAL_SUPERSEDED = "approval_superseded";
export const APPROVAL_EXPIRED = "approval_expired";
export const FULFILL_BLOCKED_DEDUP_UNAVAILABLE = "fulfill_blocked_dedup_unavailable";

export type PreparedCommReplyDedup =
  | { kind: "off" }
  | { kind: "skip" }
  | { kind: "unavailable"; reason: string }
  | {
      kind: "ready";
      orgId: string;
      employeeId: string;
      conversationKey: string;
      fingerprint: ReplyFingerprint;
      settings: CommReplyDedupSettings;
    };

export function prepareCommReplyDedupFromBody(_input: {
  orgId: string;
  employeeId: string;
  body: GatewayInvokeRequest;
  text: string;
}): PreparedCommReplyDedup {
  return { kind: "off" };
}

export type FulfillDedupGate =
  | { ok: true; claimId: string | null; prepared: PreparedCommReplyDedup }
  | { ok: false; code: string };

export async function fulfillDedupGate(
  _approval: ApprovalRequest,
  _snapshot: InvokeSnapshot,
  _text: string
): Promise<FulfillDedupGate> {
  return { ok: true, claimId: null, prepared: { kind: "off" } };
}
