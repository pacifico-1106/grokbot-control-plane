import { requireIdentityLinkManager } from "@/lib/auth/identity-link-gate";
import { appendAuditEvent } from "@/lib/data/audit";
import { getEmployee } from "@/lib/data";
import {
  getEmployeeGoogleIdentity,
  getLinkedGoogleRefreshToken,
  revokeEmployeeGoogleIdentity,
} from "@/lib/data/google-identities";
import { isGoogleCalendarReadEnabled } from "@/lib/feature-flags";
import { revokeGoogleToken } from "@/lib/google/oauth";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

/**
 * Disconnects an AI employee's Google Calendar identity.
 * 401 no session; 403 without hire_issue_credentials (code / nextStep /
 * retryable); 404 for an employee outside the caller's org.
 */
export async function POST(req: Request) {
  if (!isGoogleCalendarReadEnabled()) {
    return jsonUtf8(
      { error: "google_calendar_disabled", message: "Google Calendar integration is disabled" },
      { status: 404 }
    );
  }

  const gate = await requireIdentityLinkManager(req);
  if (!gate.ok) return gate.response;

  let body: { employeeId?: string };
  try {
    body = (await req.json()) as { employeeId?: string };
  } catch {
    return jsonUtf8({ error: "invalid_json" }, { status: 400 });
  }

  const employeeId = body.employeeId?.trim() || "";
  if (!employeeId) {
    return jsonUtf8({ error: "employee_id_required" }, { status: 400 });
  }

  const employee = await getEmployee(employeeId, gate.orgId);
  if (!employee) {
    return jsonUtf8({ error: "employee_not_found" }, { status: 404 });
  }

  const identity = await getEmployeeGoogleIdentity(employeeId);
  if (!identity) {
    return jsonUtf8({ error: "no_google_identity" }, { status: 404 });
  }

  const refreshToken = await getLinkedGoogleRefreshToken(employeeId);
  if (refreshToken) {
    await revokeGoogleToken(refreshToken);
  }

  await revokeEmployeeGoogleIdentity({
    employeeId,
    orgId: gate.orgId,
  });

  await appendAuditEvent({
    orgId: gate.orgId,
    employeeId,
    credentialId: null,
    actorEmail: gate.actor.email,
    action: "google.identity_revoked",
    purpose: "google.oauth.disconnect",
    summary: `Google Calendar disconnected: ${identity.googleEmail || identity.googleSub}`,
    metadata: {
      googleEmail: identity.googleEmail,
    },
  });

  return jsonUtf8({ ok: true });
}
