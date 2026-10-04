/** STUB (TDD red phase). Hash-only send ledger for duplicate-reply prevention. */
export type CommReplySendRow = {
  id: string;
  orgId: string;
  employeeId: string;
  conversationKey: string;
  bodyHash: string;
  sketch: number[] | null;
  tool: string;
  approvalId: string | null;
  state: "reserved" | "sent" | "uncertain";
  createdAtMs: number;
};

export type CommReplyClaimInput = {
  orgId: string;
  employeeId: string;
  conversationKey: string;
  bodyHash: string;
  sketch: number[] | null;
  tool: string;
  approvalId?: string | null;
  approvalCreatedAt?: string | null;
  windowSeconds: number;
  similarityThreshold: number | null;
  retentionSeconds: number;
};

export type CommReplyDuplicate = {
  state: "duplicate";
  match: "exact" | "similar";
  similarity: number;
  matchedAt: string;
};

export type CommReplyClaimResult =
  | { state: "claimed"; id: string }
  | CommReplyDuplicate
  | { state: "superseded"; repliedAt: string }
  | { state: "denied" }
  | { state: "unavailable"; reason: string };

export async function claimCommReplySend(_input: CommReplyClaimInput): Promise<CommReplyClaimResult> {
  return { state: "unavailable", reason: "not_implemented" };
}

export async function findRecentCommReplyDuplicate(
  _input: Omit<CommReplyClaimInput, "approvalId" | "approvalCreatedAt" | "tool" | "retentionSeconds">
): Promise<{ state: "none" } | CommReplyDuplicate | { state: "unavailable"; reason: string }> {
  return { state: "none" };
}

export async function finishCommReplySend(_input: {
  id: string;
  orgId: string;
  outcome: "sent" | "failed" | "uncertain";
}): Promise<void> {}

export function resetDemoCommReplySends(): void {}
export function demoCommReplySendsForTests(): CommReplySendRow[] {
  return [];
}
