import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { isBrowserNavigation, requireIdentityLinkManager } from "@/lib/auth/identity-link-gate";
import { getEmployee } from "@/lib/data";
import { isGoogleCalendarReadEnabled, isMailSendGmailLiveEnabled } from "@/lib/feature-flags";
import {
  GOOGLE_OAUTH_COOKIE,
  GOOGLE_PKCE_COOKIE,
  generateCodeChallenge,
  generateCodeVerifier,
  googleAuthorizeUrl,
  googleOAuthConfigured,
  signGoogleOAuthState,
} from "@/lib/google/oauth";
import { parseGoogleOAuthIntent } from "@/lib/google/scopes";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

/**
 * Starts linking an AI employee's Google Calendar identity.
 * 401 no session; 403 without hire_issue_credentials (a browser navigation is
 * sent back to the employee page with ?google=forbidden); 404 for an employee
 * outside the caller's org. The signed state is bound to the initiating
 * member, org and employee; the callback re-checks all three.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const intent = parseGoogleOAuthIntent(url.searchParams.get("intent"));
  if (intent === "gmail.send") {
    if (!isMailSendGmailLiveEnabled()) {
      return jsonUtf8(
        { error: "mail_send_gmail_disabled", message: "Gmail live send is disabled" },
        { status: 404 }
      );
    }
  } else if (!isGoogleCalendarReadEnabled()) {
    return jsonUtf8(
      { error: "google_calendar_disabled", message: "Google Calendar integration is disabled" },
      { status: 404 }
    );
  }

  const employeeId = url.searchParams.get("employeeId")?.trim() || "";

  const gate = await requireIdentityLinkManager(req);
  if (!gate.ok) {
    if (gate.status === 403 && isBrowserNavigation(req)) {
      const dest = new URL(
        employeeId ? `/app/employees/${encodeURIComponent(employeeId)}` : "/app/employees",
        getAppOrigin()
      );
      dest.searchParams.set("google", "forbidden");
      return NextResponse.redirect(dest, 303);
    }
    return gate.response;
  }

  if (!googleOAuthConfigured()) {
    return jsonUtf8(
      { error: "google_oauth_unconfigured", message: "Google OAuth is not configured" },
      { status: 503 }
    );
  }

  if (!employeeId) {
    return jsonUtf8({ error: "employee_id_required" }, { status: 400 });
  }

  const employee = await getEmployee(employeeId, gate.orgId);
  if (!employee) {
    return jsonUtf8({ error: "employee_not_found" }, { status: 404 });
  }

  const nonce = randomBytes(16).toString("base64url");
  const codeVerifier = generateCodeVerifier();

  try {
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = signGoogleOAuthState({
      orgId: gate.orgId,
      employeeId,
      nonce,
      actorMemberId: gate.actor.id,
      intent,
    });

    const jar = await cookies();
    const cookieOptions = {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    };

    jar.set(GOOGLE_OAUTH_COOKIE, nonce, cookieOptions);
    jar.set(GOOGLE_PKCE_COOKIE, codeVerifier, cookieOptions);

    return NextResponse.redirect(googleAuthorizeUrl(state, codeChallenge, { intent }));
  } catch {
    return jsonUtf8(
      { error: "google_oauth_unconfigured", message: "Google OAuth is not configured" },
      { status: 503 }
    );
  }
}
