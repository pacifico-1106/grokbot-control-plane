import { NextResponse } from "next/server";
import { getCurrentOrgId, getSessionContext, type SessionContext } from "./session";

export function authRequiredResponse(
  message = "認証と組織が必要です"
): NextResponse {
  return NextResponse.json(
    { ok: false, error: "auth_required", message },
    { status: 401 }
  );
}

/**
 * Browser-session org required.
 * DEMO: getCurrentOrgId() is always org_demo (dashboard polling stays up).
 * Production unauthenticated / no org_members → 401 (not 200 empty / 500).
 */
export async function requireOrgSession(): Promise<
  { ok: true; orgId: string } | { ok: false; response: NextResponse }
> {
  const orgId = await getCurrentOrgId();
  if (!orgId) {
    return { ok: false, response: authRequiredResponse() };
  }
  return { ok: true, orgId };
}

/**
 * Real Auth user + org. Refuses DEMO synthetic session so open Relays
 * (email / trial stubs) cannot send without a logged-in org.
 */
export async function requireAuthenticatedOrg(): Promise<
  | { ok: true; orgId: string; session: SessionContext }
  | { ok: false; response: NextResponse }
> {
  const session = await getSessionContext();
  if (!session.userId || !session.orgId) {
    return { ok: false, response: authRequiredResponse() };
  }
  return { ok: true, orgId: session.orgId, session };
}
