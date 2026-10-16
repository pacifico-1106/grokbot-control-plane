import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAppOrigin } from "@/lib/approvals/tokens";
import { verifyIdentityLinkCallbackActor } from "@/lib/auth/identity-link-gate";
import { appendAuditEvent } from "@/lib/data/audit";
import { bindEmployeeGoogleIdentity, getEmployeeGoogleIdentity } from "@/lib/data/google-identities";
import { isGoogleCalendarReadEnabled, isMailSendGmailLiveEnabled } from "@/lib/feature-flags";
import {
  GOOGLE_OAUTH_COOKIE,
  GOOGLE_PKCE_COOKIE,
  decodeIdToken,
  exchangeGoogleCode,
  validateIdToken,
  verifyGoogleOAuthState,
} from "@/lib/google/oauth";
import {
  GOOGLE_SCOPE_GMAIL_SEND,
  grantedScopesInclude,
  mergeGoogleScopes,
  parseGoogleOAuthIntent,
  validateGrantedScopes,
} from "@/lib/google/scopes";
import { jsonUtf8 } from "@/lib/http/json-utf8";

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
  const flagsOff =
    !isGoogleCalendarReadEnabled() && !isMailSendGmailLiveEnabled();
  if (flagsOff) {
    return jsonUtf8(
      { error: "google_oauth_disabled", message: "Google identity linking is disabled" },
      { status: 404 }
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() || "";
  const state = url.searchParams.get("state")?.trim() || "";
  const oauthError = url.searchParams.get("error")?.trim() || "";

  const jar = await cookies();
  const nonce = jar.get(GOOGLE_OAUTH_COOKIE)?.value || "";
  const codeVerifier = jar.get(GOOGLE_PKCE_COOKIE)?.value || "";
  jar.delete(GOOGLE_OAUTH_COOKIE);
  jar.delete(GOOGLE_PKCE_COOKIE);

  const parsed = verifyGoogleOAuthState(state, nonce);
  if (!parsed) {
    return NextResponse.redirect(new URL("/app/employees?google=error", getAppOrigin()));
  }

  const intent = parseGoogleOAuthIntent(parsed.intent);
  if (intent === "gmail.send" && !isMailSendGmailLiveEnabled()) {
    return redirectEmployee(parsed.employeeId, "error");
  }
  if (intent === "calendar" && !isGoogleCalendarReadEnabled()) {
    return redirectEmployee(parsed.employeeId, "error");
  }

  // Only the member who started the link (still holding
  // hire_issue_credentials, same org, employee still in the org) can finish
  // it. Checked before the code exchange, so no token is ever obtained.
  if (!(await verifyIdentityLinkCallbackActor(parsed).catch(() => false))) {
    return redirectEmployee(parsed.employeeId, "forbidden");
  }

  if (oauthError) {
    const errorParam =
      oauthError === "admin_policy_enforced"
        ? "admin_blocked"
        : oauthError === "access_denied"
          ? "denied"
          : "error";
    return redirectEmployee(parsed.employeeId, errorParam);
  }

  if (!code || !codeVerifier) {
    return redirectEmployee(parsed.employeeId, "error");
  }

  try {
    const exchanged = await exchangeGoogleCode(code, codeVerifier);

    if (exchanged.error) {
      return redirectEmployee(parsed.employeeId, "error");
    }

    if (!exchanged.access_token) {
      return redirectEmployee(parsed.employeeId, "error");
    }

    const existing = await getEmployeeGoogleIdentity(parsed.employeeId);
    let refreshToken = exchanged.refresh_token?.trim() || "";
    // Incremental consent often omits refresh_token; keep the stored one.
    if (!refreshToken && existing?.status !== "linked") {
      return redirectEmployee(parsed.employeeId, "error");
    }
    // If a new refresh token arrives without a previously granted extra
    // scope (e.g. calendar re-consent dropping gmail.send), keep the stored
    // token. include_granted_scopes should prevent this; this is the belt.
    if (
      refreshToken &&
      existing?.status === "linked" &&
      grantedScopesInclude(existing.grantedScopes, GOOGLE_SCOPE_GMAIL_SEND) &&
      !grantedScopesInclude(exchanged.scope || "", GOOGLE_SCOPE_GMAIL_SEND)
    ) {
      refreshToken = "";
    }

    const scopeValidation = validateGrantedScopes(exchanged.scope || "", intent);
    if (!scopeValidation.valid) {
      await appendAuditEvent({
        orgId: parsed.orgId,
        employeeId: parsed.employeeId,
        credentialId: null,
        action: "google.identity_connected",
        purpose: "google.oauth.callback",
        summary: `Google OAuth scope validation failed: ${scopeValidation.reason}`,
        metadata: {
          reason: scopeValidation.reason,
          forbidden: scopeValidation.forbidden,
          unknown: scopeValidation.unknown,
          intent,
        },
      });
      return redirectEmployee(parsed.employeeId, "scope_error");
    }

    if (!exchanged.id_token) {
      return redirectEmployee(parsed.employeeId, "error");
    }

    const idTokenPayload = decodeIdToken(exchanged.id_token);
    if (!idTokenPayload) {
      return redirectEmployee(parsed.employeeId, "error");
    }

    const idTokenValidation = validateIdToken(idTokenPayload);
    if (!idTokenValidation.valid) {
      await appendAuditEvent({
        orgId: parsed.orgId,
        employeeId: parsed.employeeId,
        credentialId: null,
        action: "google.identity_connected",
        purpose: "google.oauth.callback",
        summary: `Google OAuth ID token validation failed: ${idTokenValidation.reason}`,
        metadata: { reason: idTokenValidation.reason },
      });
      return redirectEmployee(parsed.employeeId, "error");
    }

    await bindEmployeeGoogleIdentity({
      employeeId: parsed.employeeId,
      orgId: parsed.orgId,
      googleSub: idTokenPayload.sub!,
      googleEmail: idTokenPayload.email || "",
      grantedScopes: mergeGoogleScopes(existing?.grantedScopes || "", exchanged.scope || ""),
      refreshToken,
    });

    await appendAuditEvent({
      orgId: parsed.orgId,
      employeeId: parsed.employeeId,
      credentialId: null,
      action: "google.identity_connected",
      purpose: "google.oauth.callback",
      summary:
        intent === "gmail.send"
          ? `Google Gmail send connected: ${idTokenPayload.email || idTokenPayload.sub}`
          : `Google Calendar connected: ${idTokenPayload.email || idTokenPayload.sub}`,
      metadata: {
        googleEmail: idTokenPayload.email,
        grantedScopes: mergeGoogleScopes(existing?.grantedScopes || "", exchanged.scope || ""),
        intent,
      },
    });

    return redirectEmployee(parsed.employeeId, intent === "gmail.send" ? "gmail_ok" : "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "google_identity_account_mismatch") {
      return redirectEmployee(parsed.employeeId, "account_mismatch");
    }
    return redirectEmployee(parsed.employeeId, "error");
  }
}
