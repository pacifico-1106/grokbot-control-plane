import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireOrgSession } from "@/lib/auth/require-org";
import { getEmployee } from "@/lib/data";
import { isGoogleCalendarReadEnabled } from "@/lib/feature-flags";
import {
  GOOGLE_OAUTH_COOKIE,
  GOOGLE_PKCE_COOKIE,
  generateCodeChallenge,
  generateCodeVerifier,
  googleAuthorizeUrl,
  googleOAuthConfigured,
  signGoogleOAuthState,
} from "@/lib/google/oauth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!isGoogleCalendarReadEnabled()) {
    return NextResponse.json(
      { error: "google_calendar_disabled", message: "Google Calendar integration is disabled" },
      { status: 404 }
    );
  }

  const gate = await requireOrgSession();
  if (!gate.ok) return gate.response;

  if (!googleOAuthConfigured()) {
    return NextResponse.json(
      { error: "google_oauth_unconfigured", message: "Google OAuth is not configured" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employeeId")?.trim() || "";
  if (!employeeId) {
    return NextResponse.json({ error: "employee_id_required" }, { status: 400 });
  }

  const employee = await getEmployee(employeeId, gate.orgId);
  if (!employee) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }

  const nonce = randomBytes(16).toString("base64url");
  const codeVerifier = generateCodeVerifier();

  try {
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = signGoogleOAuthState({
      orgId: gate.orgId,
      employeeId,
      nonce,
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

    return NextResponse.redirect(googleAuthorizeUrl(state, codeChallenge));
  } catch {
    return NextResponse.json(
      { error: "google_oauth_unconfigured", message: "Google OAuth is not configured" },
      { status: 503 }
    );
  }
}
