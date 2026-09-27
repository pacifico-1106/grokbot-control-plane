import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { appendAuditEvent } from "@/lib/data/audit";
import { bindEmployeeGoogleIdentity } from "@/lib/data/google-identities";
import { isGoogleCalendarReadEnabled } from "@/lib/feature-flags";
import {
  GOOGLE_OAUTH_COOKIE,
  decodeIdToken,
  exchangeGoogleCode,
  verifyGoogleOAuthState,
} from "@/lib/google/oauth";
import { validateGrantedScopes } from "@/lib/google/scopes";

export const runtime = "nodejs";

function redirectEmployee(employeeId: string, google: string): NextResponse {
  const dest = new URL(
    `/app/employees/${encodeURIComponent(employeeId)}`,
    getAppOrigin()
  );
  dest.searchParams.set("google", google);
  return NextResponse.redirect(dest);
}

export async function GET(req: Request) {
  if (!isGoogleCalendarReadEnabled()) {
    return NextResponse.json(
      { error: "google_calendar_disabled", message: "Google Calendar integration is disabled" },
      { status: 404 }
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() || "";
  const state = url.searchParams.get("state")?.trim() || "";
  const oauthError = url.searchParams.get("error")?.trim() || "";

  const jar = await cookies();
  const nonce = jar.get(GOOGLE_OAUTH_COOKIE)?.value || "";
  jar.delete(GOOGLE_OAUTH_COOKIE);

  const parsed = verifyGoogleOAuthState(state, nonce);
  if (!parsed) {
    return NextResponse.redirect(new URL("/app/employees?google=error", getAppOrigin()));
  }

  if (oauthError) {
    return redirectEmployee(
      parsed.employeeId,
      oauthError === "access_denied" ? "denied" : "error"
    );
  }

  if (!code) {
    return redirectEmployee(parsed.employeeId, "error");
  }

  try {
    const exchanged = await exchangeGoogleCode(code, parsed.codeVerifier);

    if (exchanged.error) {
      console.error("google_oauth_exchange_error", exchanged.error, exchanged.error_description);
      return redirectEmployee(parsed.employeeId, "error");
    }

    if (!exchanged.access_token || !exchanged.refresh_token) {
      console.error("google_oauth_missing_tokens", {
        hasAccessToken: Boolean(exchanged.access_token),
        hasRefreshToken: Boolean(exchanged.refresh_token),
      });
      return redirectEmployee(parsed.employeeId, "error");
    }

    const scopeValidation = validateGrantedScopes(exchanged.scope || "");
    if (!scopeValidation.valid) {
      console.error("google_oauth_scope_validation_failed", scopeValidation);
      await appendAuditEvent({
        orgId: parsed.orgId,
        employeeId: parsed.employeeId,
        action: "google.identity_connected",
        purpose: "google.oauth.callback",
        summary: `Google OAuth scope validation failed: ${scopeValidation.reason}`,
        metadata: {
          reason: scopeValidation.reason,
          forbidden: scopeValidation.forbidden,
          unknown: scopeValidation.unknown,
        },
      });
      return redirectEmployee(parsed.employeeId, "scope_error");
    }

    if (!exchanged.id_token) {
      console.error("google_oauth_missing_id_token");
      return redirectEmployee(parsed.employeeId, "error");
    }

    const idTokenPayload = decodeIdToken(exchanged.id_token);
    if (!idTokenPayload?.sub) {
      console.error("google_oauth_invalid_id_token");
      return redirectEmployee(parsed.employeeId, "error");
    }

    await bindEmployeeGoogleIdentity({
      employeeId: parsed.employeeId,
      orgId: parsed.orgId,
      googleSub: idTokenPayload.sub,
      googleEmail: idTokenPayload.email || "",
      grantedScopes: exchanged.scope || "",
      refreshToken: exchanged.refresh_token,
    });

    await appendAuditEvent({
      orgId: parsed.orgId,
      employeeId: parsed.employeeId,
      action: "google.identity_connected",
      purpose: "google.oauth.callback",
      summary: `Google Calendar connected: ${idTokenPayload.email || idTokenPayload.sub}`,
      metadata: {
        googleEmail: idTokenPayload.email,
        grantedScopes: exchanged.scope,
      },
    });

    return redirectEmployee(parsed.employeeId, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error("google_oauth_callback_error", message);
    return redirectEmployee(parsed.employeeId, "error");
  }
}
