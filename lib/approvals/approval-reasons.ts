/** Fail-first compile stub (replaced in the implementation commit). */
export const APPROVAL_REASONS_CARD_MAX_CHARS = 0;
export type ApprovalReason = { code: string; messageJa: string; [key: string]: unknown };
export function buildApprovalReasons(_input: Record<string, unknown>): ApprovalReason[] {
  return [];
}
export function readApprovalReasons(_metadata: unknown): ApprovalReason[] | null {
  return null;
}
export function approvalReasonsCardLine(_reasons: ApprovalReason[]): string {
  return "";
}
export function cardApprovalReasonsLine(_metadata: unknown): string | null {
  return null;
}
