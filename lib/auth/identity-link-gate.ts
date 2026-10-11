import { NextResponse } from "next/server";
import { activeSessionMember } from "@/lib/auth/active-member";
import { requireOrgSession } from "@/lib/auth/require-org";
import { getCurrentOrgId, getSessionContext } from "@/lib/auth/session";
import { getEmployee } from "@/lib/data";
import { getRuntimeMemberById } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { requireCapability } from "@/lib/team/demo-actor";
import { hasCapability } from "@/lib/team/rbac";
import type { OrgMember } from "@/lib/types";

/**
 * Who may connect / re-connect / disconnect an AI employee's external
 * identity (Slack user OAuth, Google Calendar OAuth).
 *
 * hire_issue_credentials (雇う／社員証発行) — the capability that already gates
 * the same employee identity elsewhere (PATCH postingAs and DELETE on
 * /api/employees/[id]/slack-identity, employee policy / binding / terminate).
 * Linking hands the employee a third-party user token, i.e. it is credential
 * issuance for that employee. manage_team governs HUMAN org members, not AI
 * employee credentials, so it is not the right gate.
 */
export const IDENTITY_LINK_CAPABILITY = "hire_issue_credentials" as const;

export const IDENTITY_LINK_FORBIDDEN_CODE = "identity_link_capability_required" as const;

export const IDENTITY_LINK_FORBIDDEN_MESSAGE_JA =
  "AI社員の外部アカウント連携（Slack / Google）の開始・解除には「雇う／社員証発行」の権限が必要です。";

export const IDENTITY_LINK_NEXT_STEP =
  "Ask an org owner/admin, or a member with the hire_issue_credentials (雇う／社員証発行) permission, to connect or disconnect this employee's account. Retrying with the same account will not succeed.";

export const IDENTITY_LINK_NEXT_STEP_JA =
  "オーナー・管理者、または「雇う／社員証発行」の権限を持つメンバーに連携・解除を依頼してください。同じアカウントで再試行しても成功しません。";

export function identityLinkForbiddenResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "capability_denied",
      code: IDENTITY_LINK_FORBIDDEN_CODE,
      requiredCapability: IDENTITY_LINK_CAPABILITY,
      message: IDENTITY_LINK_FORBIDDEN_MESSAGE_JA,
      nextStep: IDENTITY_LINK_NEXT_STEP,
      nextStepJa: IDENTITY_LINK_NEXT_STEP_JA,
      retryable: false,
    },
    { status: 403 }
  );
}

/** A top-level browser navigation (an <a href> click), not a fetch() / API call. */
export function isBrowserNavigation(req: Request): boolean {
  const mode = req.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return (req.headers.get("accept") || "").includes("text/html");
}

export type IdentityLinkGate =
  | { ok: true; orgId: string; actor: OrgMember }
  | { ok: false; status: 401 | 403; response: NextResponse };

/**
 * Session + capability gate for identity-link start / disconnect routes.
 * 401 no session / no active member row; 403 member without
 * hire_issue_credentials (JSON with code / nextStep / retryable).
 * Production: the session's own member row only (x-member-id / ?as= / body
 * actorMemberId are ignored by requireCapability). DEMO: demo actor convention.
 */
export async function requireIdentityLinkManager(
  req: Request,
  bodyActorId?: string | null
): Promise<IdentityLinkGate> {
  const org = await requireOrgSession();
  if (!org.ok) return { ok: false, status: 401, response: org.response };
  const gate = await requireCapability(req, IDENTITY_LINK_CAPABILITY, bodyActorId);
  if (!gate.ok) {
    if (gate.response.status === 403) {
      return { ok: false, status: 403, response: identityLinkForbiddenResponse() };
    }
    return { ok: false, status: 401, response: gate.response };
  }
  if (gate.actor.orgId !== org.orgId) {
    // Defensive: actor row of a different org than the session org.
    return { ok: false, status: 403, response: identityLinkForbiddenResponse() };
  }
  return { ok: true, orgId: org.orgId, actor: gate.actor };
}

/**
 * Callback re-check for a session-started identity link (not the admin-issued
 * re-authorize link). The signed state names the initiating member, org and
 * employee; the link completes only when, at callback time:
 * - the state carries an initiating member (older / foreign-shaped state → refused),
 * - the CURRENT session's active member is that same member, in that org,
 * - that member still holds hire_issue_credentials, and
 * - the employee still belongs to that org.
 * DEMO has no Auth: the member named in the state is re-resolved from the
 * in-memory roster and must still hold the capability in the demo org.
 */
export async function verifyIdentityLinkCallbackActor(state: {
  orgId: string;
  employeeId: string;
  actorMemberId?: string;
}): Promise<boolean> {
  const actorMemberId = typeof state.actorMemberId === "string" ? state.actorMemberId.trim() : "";
  if (!actorMemberId || !state.orgId || !state.employeeId) return false;
  let actor: OrgMember | null;
  if (isDemoMode()) {
    if ((await getCurrentOrgId()) !== state.orgId) return false;
    actor = getRuntimeMemberById(actorMemberId);
  } else {
    actor = activeSessionMember(await getSessionContext());
  }
  if (!actor || actor.id !== actorMemberId) return false;
  if (actor.orgId !== state.orgId || actor.status !== "active") return false;
  if (!hasCapability(actor, IDENTITY_LINK_CAPABILITY)) return false;
  const employee = await getEmployee(state.employeeId, state.orgId);
  return Boolean(employee);
}
