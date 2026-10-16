import { NextResponse } from "next/server";
import { getCurrentOrgId, getSessionContext, type SessionContext } from "./session";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export function authRequiredResponse(
  message = "認証と組織が必要です"
): NextResponse {
  return jsonUtf8(
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

type OrgAdminDecision = "ok" | "auth_required" | "admin_required";

function orgAdminDecision(session: SessionContext): OrgAdminDecision {
  if (session.demo && session.orgId) return "ok";
  if (!session.userId || !session.orgId || !session.member) return "auth_required";
  if (session.member.role !== "owner" && session.member.role !== "admin") return "admin_required";
  return "ok";
}

/**
 * Same rule as requireOrgAdminSession, for server-rendered UI decisions
 * (e.g. render tenant-level integration controls only for owners/admins).
 */
export function isOrgAdminSession(session: SessionContext): boolean {
  return orgAdminDecision(session) === "ok";
}

/** Owner-only browser session (stricter than requireOrgAdminSession). */
export async function requireOrgOwnerSession(): Promise<
  | { ok: true; orgId: string; email: string; memberId: string }
  | { ok: false; reason: "auth_required" | "owner_required"; response: NextResponse }
> {
  const session = await getSessionContext();
  if (session.demo && session.orgId) {
    return {
      ok: true,
      orgId: session.orgId,
      email: session.email || "owner@example.com",
      memberId: session.member?.id || "mem_1",
    };
  }
  if (!session.userId || !session.orgId || !session.member) {
    return { ok: false, reason: "auth_required", response: authRequiredResponse() };
  }
  if (session.member.role !== "owner") {
    return {
      ok: false,
      reason: "owner_required",
      response: jsonUtf8(
        { ok: false, error: "owner_required", message: "組織のオーナーだけが実行できます" },
        { status: 403 }
      ),
    };
  }
  return {
    ok: true,
    orgId: session.orgId,
    email: session.email || session.member.email,
    memberId: session.member.id,
  };
}

/** Owner/admin-only browser session for tenant-level secrets and integrations. */
export async function requireOrgAdminSession(): Promise<
  | { ok: true; orgId: string; email: string }
  | { ok: false; reason: "auth_required" | "admin_required"; response: NextResponse }
> {
  const session = await getSessionContext();
  const decision = orgAdminDecision(session);
  if (decision === "auth_required") {
    return { ok: false, reason: "auth_required", response: authRequiredResponse() };
  }
  if (decision === "admin_required") {
    return {
      ok: false,
      reason: "admin_required",
      response: jsonUtf8(
        { ok: false, error: "admin_required", message: "組織のオーナーまたは管理者権限が必要です" },
        { status: 403 }
      ),
    };
  }
  if (session.demo) {
    return { ok: true, orgId: session.orgId!, email: session.email || "owner@example.com" };
  }
  return { ok: true, orgId: session.orgId!, email: session.email || session.member!.email };
}
