/** STUB (TDD red phase). Supersede / expire pending conversation approvals. */
import type { ApprovalRequest } from "@/lib/types";

export async function supersedePendingConversationApprovals(_input: {
  orgId: string;
  employeeId: string;
  conversationKey: string;
  reason: "newer_reply_sent" | "newer_approval_requested";
  excludeApprovalId?: string | null;
  supersededBy?: string | null;
}): Promise<string[]> {
  return [];
}

export async function expireStaleConversationApprovals(_input: {
  orgId?: string | null;
  employeeId?: string | null;
  phase: "invoke" | "sweep";
}): Promise<string[]> {
  return [];
}

export function conversationApprovalExpiresAtMs(_approval: Pick<ApprovalRequest, "createdAt">): number {
  return Number.POSITIVE_INFINITY;
}
