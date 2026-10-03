import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  SHARED_APPROVAL_INSTALL_COOKIE,
  SHARED_APPROVAL_STATE_TTL_MS,
  isSharedApprovalAppEnabled,
  knownOrgSlackTeam,
  sharedApprovalAppConfig,
  sharedApprovalAuthorizeUrl,
  sharedApprovalResultHtml,
  signSharedApprovalInstallState,
} from "@/lib/slack/shared-approval-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: "Add to Slack" for the shared approval app
 * 「Staffpass承認」. Owner/admin session only; org comes from the session.
 */
export async function GET() {
  if (!isSharedApprovalAppEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  if (!sharedApprovalAppConfig()) return sharedApprovalResultHtml({ ok: false, code: "unconfigured" }, 503);
  const nonce = randomBytes(24).toString("base64url");
  const state = signSharedApprovalInstallState({ orgId: gate.orgId, nonce });
  const jar = await cookies();
  jar.set(SHARED_APPROVAL_INSTALL_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SHARED_APPROVAL_STATE_TTL_MS / 1000),
    secure: process.env.NODE_ENV === "production",
  });
  // Hint the workspace this org already uses (the callback enforces it anyway).
  const teamId = await knownOrgSlackTeam(gate.orgId);
  const response = NextResponse.redirect(sharedApprovalAuthorizeUrl(state, { teamId }));
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
