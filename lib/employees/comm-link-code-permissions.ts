import type { SessionContext } from "@/lib/auth/session";
import { hasCapability } from "@/lib/team/rbac";
import type { OrgMember } from "@/lib/types";

export function memberCanIssueConversationLinkCode(member: OrgMember | null | undefined): boolean {
  if (!member || member.status !== "active") return false;
  if (member.role === "owner") return true;
  return hasCapability(member, "approve_actions");
}

/**
 * Admin employee-detail issue UI. Server route is authoritative.
 * Demo follows the page convention (session.demo → allowed).
 */
export function commLinkCodePermissions(session: SessionContext): { canIssue: boolean } {
  if (session.demo) return { canIssue: true };
  const member = session.userId && session.orgId ? session.member : null;
  if (!member || member.orgId !== session.orgId) return { canIssue: false };
  return { canIssue: memberCanIssueConversationLinkCode(member) };
}
