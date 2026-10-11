import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { loginRedirectUrl } from "@/lib/auth/safe-next";
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
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SLACK_SHARED_APPROVAL_APP_ENABLED: "Add to Slack" for the shared approval app
 * 「Staffpass承認」. Owner/admin session only; org comes from the session.
 * Not logged in → /login?next=<this path> (fixed path, validated by the shared
 * safe-next rule), so the link in setup notices works from a logged-out browser.
 */
const INSTALL_START_PATH = "/api/slack/approval-app/install/start";

export async function GET(req: Request) {
  if (!isSharedApprovalAppEnabled()) {
    return jsonUtf8({ error: "not_found" }, { status: 404 });
  }
  const gate = await requireOrgAdminSession();
  if (!gate.ok) {
    if (gate.reason !== "auth_required") return gate.response;
    const login = NextResponse.redirect(loginRedirectUrl(INSTALL_START_PATH, req.url), 303);
    login.headers.set("cache-control", "no-store");
    login.headers.set("referrer-policy", "no-referrer");
    return login;
  }
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
