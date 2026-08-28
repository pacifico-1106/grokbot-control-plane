import { getEmployee } from "@/lib/data/employees";
import { employeeAllowsSlackUser } from "@/lib/employees/posting-as";
import { isDemoMode } from "@/lib/mode";
import {
  decryptNotificationSecrets,
  encryptNotificationSecrets,
} from "@/lib/notify/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { EmployeeSlackIdentity, SlackIdentityStatus } from "@/lib/types";

type DemoRow = {
  public: EmployeeSlackIdentity;
  secrets: Record<string, string>;
};

const demoIdentities = new Map<string, DemoRow>();

function nowIso(): string {
  return new Date().toISOString();
}

function isStatus(value: string): value is SlackIdentityStatus {
  return value === "linked" || value === "needs_reauth" || value === "revoked";
}

function mapPublic(row: Record<string, unknown>): EmployeeSlackIdentity {
  const statusRaw = String(row.status || "linked");
  return {
    employeeId: String(row.employee_id ?? row.employeeId),
    orgId: String(row.org_id ?? row.orgId),
    slackUserId: String(row.slack_user_id ?? row.slackUserId ?? ""),
    slackTeamId: String(row.slack_team_id ?? row.slackTeamId ?? ""),
    displayName: String(row.display_name ?? row.displayName ?? ""),
    status: isStatus(statusRaw) ? statusRaw : "linked",
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

function encryptUserToken(userToken: string): string {
  return encryptNotificationSecrets({ userToken });
}

function decryptUserToken(ciphertext: string): string {
  const secrets = decryptNotificationSecrets(ciphertext);
  return secrets.userToken?.trim() || "";
}

/** Public binding only — never returns secrets. */
export async function getEmployeeSlackIdentity(
  employeeId: string
): Promise<EmployeeSlackIdentity | null> {
  const id = employeeId.trim();
  if (!id) return null;
  if (isDemoMode()) return demoIdentities.get(id)?.public ?? null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("employee_slack_identities")
    .select("employee_id,org_id,slack_user_id,slack_team_id,display_name,status,updated_at")
    .eq("employee_id", id)
    .maybeSingle();
  if (error || !data) return null;
  return mapPublic(data as Record<string, unknown>);
}

export async function getLinkedSlackUserToken(
  employeeId: string
): Promise<string> {
  const id = employeeId.trim();
  if (!id) return "";
  if (isDemoMode()) {
    const row = demoIdentities.get(id);
    if (!row || row.public.status !== "linked") return "";
    return row.secrets.userToken?.trim() || "";
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return "";
  const { data: identity, error } = await admin
    .from("employee_slack_identities")
    .select("status")
    .eq("employee_id", id)
    .maybeSingle();
  if (error || !identity || String(identity.status) !== "linked") return "";
  const { data: secret } = await admin
    .from("employee_slack_identity_secrets")
    .select("credentials_ciphertext")
    .eq("employee_id", id)
    .maybeSingle();
  const ciphertext = String(secret?.credentials_ciphertext || "");
  if (!ciphertext) return "";
  try {
    return decryptUserToken(ciphertext);
  } catch (error) {
    console.error("slack_identity_decrypt_failed", id, error);
    return "";
  }
}

export async function bindEmployeeSlackIdentity(input: {
  employeeId: string;
  orgId: string;
  slackUserId: string;
  slackTeamId?: string;
  displayName?: string;
  userToken: string;
}): Promise<EmployeeSlackIdentity> {
  const employeeId = input.employeeId.trim();
  const orgId = input.orgId.trim();
  const slackUserId = input.slackUserId.trim();
  const userToken = input.userToken.trim();
  if (!employeeId || !orgId || !slackUserId || !userToken) {
    throw new Error("slack_identity_incomplete");
  }
  const employee = await getEmployee(employeeId, orgId);
  if (!employee) throw new Error("employee_not_found");
  if (!employeeAllowsSlackUser(employee.allowedAccounts, slackUserId)) {
    throw new Error("slack_identity_mismatch");
  }
  const publicRow: EmployeeSlackIdentity = {
    employeeId,
    orgId,
    slackUserId,
    slackTeamId: (input.slackTeamId || "").trim(),
    displayName: (input.displayName || "").trim(),
    status: "linked",
    updatedAt: nowIso(),
  };
  if (isDemoMode()) {
    demoIdentities.set(employeeId, {
      public: publicRow,
      secrets: { userToken },
    });
    return publicRow;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const ciphertext = encryptUserToken(userToken);
  const { data, error } = await admin
    .from("employee_slack_identities")
    .upsert(
      {
        employee_id: employeeId,
        org_id: orgId,
        slack_user_id: slackUserId,
        slack_team_id: publicRow.slackTeamId,
        display_name: publicRow.displayName,
        status: "linked",
        updated_at: publicRow.updatedAt,
      },
      { onConflict: "employee_id" }
    )
    .select("employee_id,org_id,slack_user_id,slack_team_id,display_name,status,updated_at")
    .single();
  if (error || !data) throw new Error(error?.message || "slack_identity_save_failed");
  const { error: secretError } = await admin
    .from("employee_slack_identity_secrets")
    .upsert(
      {
        employee_id: employeeId,
        credentials_ciphertext: ciphertext,
        updated_at: publicRow.updatedAt,
      },
      { onConflict: "employee_id" }
    );
  if (secretError) throw new Error(secretError.message || "slack_identity_secret_save_failed");
  return mapPublic(data as Record<string, unknown>);
}

export async function revokeEmployeeSlackIdentity(input: {
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
  await admin.from("employee_slack_identity_secrets").delete().eq("employee_id", employeeId);
  await admin
    .from("employee_slack_identities")
    .delete()
    .eq("employee_id", employeeId)
    .eq("org_id", orgId);
}
