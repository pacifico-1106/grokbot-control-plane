import { getEmployee } from "@/lib/data/employees";
import { isDemoMode } from "@/lib/mode";
import {
  decryptNotificationSecrets,
  encryptNotificationSecrets,
} from "@/lib/notify/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type GoogleIdentityStatus = "linked" | "needs_reauth" | "revoked";

export interface EmployeeGoogleIdentity {
  employeeId: string;
  orgId: string;
  googleSub: string;
  googleEmail: string;
  grantedScopes: string;
  status: GoogleIdentityStatus;
  connectedAt: string;
  revokedAt: string | null;
  updatedAt: string;
}

type DemoRow = {
  public: EmployeeGoogleIdentity;
  secrets: { refreshToken: string };
};

const demoIdentities = new Map<string, DemoRow>();

function nowIso(): string {
  return new Date().toISOString();
}

function isStatus(value: string): value is GoogleIdentityStatus {
  return value === "linked" || value === "needs_reauth" || value === "revoked";
}

function mapPublic(row: Record<string, unknown>): EmployeeGoogleIdentity {
  const statusRaw = String(row.status || "linked");
  return {
    employeeId: String(row.employee_id ?? row.employeeId),
    orgId: String(row.org_id ?? row.orgId),
    googleSub: String(row.google_sub ?? row.googleSub ?? ""),
    googleEmail: String(row.google_email ?? row.googleEmail ?? ""),
    grantedScopes: String(row.granted_scopes ?? row.grantedScopes ?? ""),
    status: isStatus(statusRaw) ? statusRaw : "linked",
    connectedAt: String(row.connected_at ?? row.connectedAt ?? nowIso()),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

function encryptRefreshToken(refreshToken: string): string {
  return encryptNotificationSecrets({ refreshToken });
}

function decryptRefreshToken(ciphertext: string): string {
  const secrets = decryptNotificationSecrets(ciphertext);
  return secrets.refreshToken?.trim() || "";
}

/** Public binding only — never returns secrets. */
export async function getEmployeeGoogleIdentity(
  employeeId: string
): Promise<EmployeeGoogleIdentity | null> {
  const id = employeeId.trim();
  if (!id) return null;
  if (isDemoMode()) return demoIdentities.get(id)?.public ?? null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("employee_google_identities")
    .select(
      "employee_id,org_id,google_sub,google_email,granted_scopes,status,connected_at,revoked_at,updated_at"
    )
    .eq("employee_id", id)
    .maybeSingle();
  if (error || !data) return null;
  return mapPublic(data as Record<string, unknown>);
}

/** Get linked refresh token for calendar API calls. Never log or return to client. */
export async function getLinkedGoogleRefreshToken(
  employeeId: string
): Promise<string> {
  const id = employeeId.trim();
  if (!id) return "";
  if (isDemoMode()) {
    const row = demoIdentities.get(id);
    if (!row || row.public.status !== "linked") return "";
    return row.secrets.refreshToken?.trim() || "";
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return "";
  const { data: identity, error } = await admin
    .from("employee_google_identities")
    .select("status")
    .eq("employee_id", id)
    .maybeSingle();
  if (error || !identity || String(identity.status) !== "linked") return "";
  const { data: secret } = await admin
    .from("employee_google_identity_secrets")
    .select("credentials_ciphertext")
    .eq("employee_id", id)
    .maybeSingle();
  const ciphertext = String(secret?.credentials_ciphertext || "");
  if (!ciphertext) return "";
  try {
    return decryptRefreshToken(ciphertext);
  } catch (error) {
    console.error("google_identity_decrypt_failed", id, error);
    return "";
  }
}

/** Bind Google identity after successful OAuth callback. */
export async function bindEmployeeGoogleIdentity(input: {
  employeeId: string;
  orgId: string;
  googleSub: string;
  googleEmail: string;
  grantedScopes: string;
  refreshToken: string;
}): Promise<EmployeeGoogleIdentity> {
  const employeeId = input.employeeId.trim();
  const orgId = input.orgId.trim();
  const googleSub = input.googleSub.trim();
  const googleEmail = input.googleEmail.trim();
  const grantedScopes = input.grantedScopes.trim();
  const refreshToken = input.refreshToken.trim();

  if (!employeeId || !orgId || !googleSub || !refreshToken) {
    throw new Error("google_identity_incomplete");
  }

  const employee = await getEmployee(employeeId, orgId);
  if (!employee) throw new Error("employee_not_found");

  const publicRow: EmployeeGoogleIdentity = {
    employeeId,
    orgId,
    googleSub,
    googleEmail,
    grantedScopes,
    status: "linked",
    connectedAt: nowIso(),
    revokedAt: null,
    updatedAt: nowIso(),
  };

  if (isDemoMode()) {
    demoIdentities.set(employeeId, {
      public: publicRow,
      secrets: { refreshToken },
    });
    return publicRow;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const ciphertext = encryptRefreshToken(refreshToken);

  const { data, error } = await admin
    .from("employee_google_identities")
    .upsert(
      {
        employee_id: employeeId,
        org_id: orgId,
        google_sub: googleSub,
        google_email: googleEmail,
        granted_scopes: grantedScopes,
        status: "linked",
        connected_at: publicRow.connectedAt,
        revoked_at: null,
        updated_at: publicRow.updatedAt,
      },
      { onConflict: "employee_id" }
    )
    .select(
      "employee_id,org_id,google_sub,google_email,granted_scopes,status,connected_at,revoked_at,updated_at"
    )
    .single();

  if (error || !data) {
    throw new Error(error?.message || "google_identity_save_failed");
  }

  const { error: secretError } = await admin
    .from("employee_google_identity_secrets")
    .upsert(
      {
        employee_id: employeeId,
        credentials_ciphertext: ciphertext,
        updated_at: publicRow.updatedAt,
      },
      { onConflict: "employee_id" }
    );

  if (secretError) {
    throw new Error(secretError.message || "google_identity_secret_save_failed");
  }

  return mapPublic(data as Record<string, unknown>);
}

/** Mark identity as needs_reauth (e.g., refresh token expired). */
export async function markGoogleIdentityNeedsReauth(
  employeeId: string
): Promise<void> {
  const id = employeeId.trim();
  if (!id) return;

  if (isDemoMode()) {
    const row = demoIdentities.get(id);
    if (row) {
      row.public.status = "needs_reauth";
      row.public.updatedAt = nowIso();
    }
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return;

  await admin
    .from("employee_google_identities")
    .update({ status: "needs_reauth", updated_at: nowIso() })
    .eq("employee_id", id);
}

/** Revoke/disconnect Google identity. Deletes secrets. */
export async function revokeEmployeeGoogleIdentity(input: {
  employeeId: string;
  orgId: string;
}): Promise<void> {
  const employeeId = input.employeeId.trim();
  const orgId = input.orgId.trim();
  if (!employeeId || !orgId) return;

  if (isDemoMode()) {
    demoIdentities.delete(employeeId);
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  await admin
    .from("employee_google_identity_secrets")
    .delete()
    .eq("employee_id", employeeId);

  await admin
    .from("employee_google_identities")
    .update({ status: "revoked", revoked_at: nowIso(), updated_at: nowIso() })
    .eq("employee_id", employeeId)
    .eq("org_id", orgId);
}

/** List all linked Google identities for an org (admin dashboard). */
export async function listOrgGoogleIdentities(
  orgId: string
): Promise<EmployeeGoogleIdentity[]> {
  const id = orgId.trim();
  if (!id) return [];

  if (isDemoMode()) {
    return [...demoIdentities.values()]
      .map((row) => row.public)
      .filter((p) => p.orgId === id);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("employee_google_identities")
    .select(
      "employee_id,org_id,google_sub,google_email,granted_scopes,status,connected_at,revoked_at,updated_at"
    )
    .eq("org_id", id)
    .order("connected_at", { ascending: false });

  if (error || !data) return [];
  return data.map((row) => mapPublic(row as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Calendar Read Grants
// ---------------------------------------------------------------------------

export interface CalendarReadGrant {
  id: string;
  orgId: string;
  employeeId: string | null;
  calendarId: string;
  label: string;
  createdBy: string | null;
  approvalId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

function mapGrant(row: Record<string, unknown>): CalendarReadGrant {
  return {
    id: String(row.id ?? ""),
    orgId: String(row.org_id ?? row.orgId ?? ""),
    employeeId: row.employee_id ? String(row.employee_id) : null,
    calendarId: String(row.calendar_id ?? row.calendarId ?? ""),
    label: String(row.label ?? ""),
    createdBy: row.created_by ? String(row.created_by) : null,
    approvalId: row.approval_id ? String(row.approval_id) : null,
    createdAt: String(row.created_at ?? row.createdAt ?? nowIso()),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

const demoGrants = new Map<string, CalendarReadGrant>();

/** Get active calendar read grants for an employee (includes org-wide grants). */
export async function getCalendarReadGrants(input: {
  orgId: string;
  employeeId: string;
}): Promise<CalendarReadGrant[]> {
  const orgId = input.orgId.trim();
  const employeeId = input.employeeId.trim();
  if (!orgId || !employeeId) return [];

  if (isDemoMode()) {
    return [...demoGrants.values()].filter(
      (g) =>
        g.orgId === orgId &&
        (g.employeeId === null || g.employeeId === employeeId) &&
        !g.revokedAt
    );
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("calendar_read_grants")
    .select("*")
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .or(`employee_id.is.null,employee_id.eq.${employeeId}`);

  if (error || !data) return [];
  return data.map((row) => mapGrant(row as Record<string, unknown>));
}

/** Get allowed calendar IDs for an employee. */
export async function getAllowedCalendarIds(input: {
  orgId: string;
  employeeId: string;
}): Promise<Set<string>> {
  const grants = await getCalendarReadGrants(input);
  return new Set(grants.map((g) => g.calendarId));
}

/** Add a calendar read grant. Requires approval_id from forceNeedsApproval tool. */
export async function addCalendarReadGrant(input: {
  orgId: string;
  employeeId?: string | null;
  calendarId: string;
  label?: string;
  createdBy?: string | null;
  approvalId: string;
}): Promise<CalendarReadGrant> {
  const orgId = input.orgId.trim();
  const calendarId = input.calendarId.trim();
  const approvalId = input.approvalId.trim();

  if (!orgId || !calendarId || !approvalId) {
    throw new Error("calendar_grant_incomplete");
  }

  const grant: CalendarReadGrant = {
    id: crypto.randomUUID(),
    orgId,
    employeeId: input.employeeId?.trim() || null,
    calendarId,
    label: input.label?.trim() || "",
    createdBy: input.createdBy?.trim() || null,
    approvalId,
    createdAt: nowIso(),
    revokedAt: null,
  };

  if (isDemoMode()) {
    demoGrants.set(grant.id, grant);
    return grant;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const { data, error } = await admin
    .from("calendar_read_grants")
    .insert({
      id: grant.id,
      org_id: grant.orgId,
      employee_id: grant.employeeId,
      calendar_id: grant.calendarId,
      label: grant.label,
      created_by: grant.createdBy,
      approval_id: grant.approvalId,
      created_at: grant.createdAt,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "calendar_grant_save_failed");
  }

  return mapGrant(data as Record<string, unknown>);
}

/** Revoke a calendar read grant. */
export async function revokeCalendarReadGrant(input: {
  grantId: string;
  orgId: string;
}): Promise<void> {
  const grantId = input.grantId.trim();
  const orgId = input.orgId.trim();
  if (!grantId || !orgId) return;

  if (isDemoMode()) {
    const grant = demoGrants.get(grantId);
    if (grant && grant.orgId === orgId) {
      grant.revokedAt = nowIso();
    }
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return;

  await admin
    .from("calendar_read_grants")
    .update({ revoked_at: nowIso() })
    .eq("id", grantId)
    .eq("org_id", orgId);
}
