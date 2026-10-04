import { NextResponse } from "next/server";
import type { SessionContext } from "./session";
import type { OrgMember } from "../types";

/**
 * Production contract shared by requireCapability (lib/team/demo-actor.ts) and
 * resolveMemberChangeActor (lib/team/apply-member-change.ts): a session that
 * cannot be tied to an active org_members row of the session org is 401
 * auth_required / active_member_required. A member who lacks the permission is
 * a separate 403 decided by the caller.
 */
export const ACTIVE_MEMBER_REQUIRED_ERROR = "auth_required" as const;
export const ACTIVE_MEMBER_REQUIRED_CODE = "active_member_required" as const;
export const ACTIVE_MEMBER_REQUIRED_STATUS = 401 as const;
export const ACTIVE_MEMBER_REQUIRED_MESSAGE_JA =
  "ログインと組織メンバーシップが必要です。再ログインしてください。";

/** The session's own member row, only if it is active and belongs to the session org. */
export function activeSessionMember(
  session: Pick<SessionContext, "userId" | "orgId" | "member">
): OrgMember | null {
  const member = session.member;
  if (!session.userId || !session.orgId || !member) return null;
  if (member.orgId !== session.orgId || member.status !== "active") return null;
  return member;
}

export function activeMemberRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: ACTIVE_MEMBER_REQUIRED_ERROR,
      code: ACTIVE_MEMBER_REQUIRED_CODE,
      message: ACTIVE_MEMBER_REQUIRED_MESSAGE_JA,
    },
    { status: ACTIVE_MEMBER_REQUIRED_STATUS }
  );
}
