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

/** Owner/admin-only browser session for tenant-level secrets and integrations. */
export async function requireOrgAdminSession(): Promise<
  | { ok: true; orgId: string; email: string }
  | { ok: false; response: NextResponse }
> {
  const session = await getSessionContext();
  if (session.demo && session.orgId) {
    return { ok: true, orgId: session.orgId, email: session.email || "owner@example.com" };
  }
  if (!session.userId || !session.orgId || !session.member) {
    return { ok: false, response: authRequiredResponse() };
  }
  if (session.member.role !== "owner" && session.member.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "admin_required", message: "組織のオーナーまたは管理者権限が必要です" },
        { status: 403 }
      ),
    };
  }
  return { ok: true, orgId: session.orgId, email: session.email || session.member.email };
}
