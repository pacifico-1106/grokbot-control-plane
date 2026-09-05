import { getBinding } from "@/lib/data/bindings";
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

export type SlackMentionTarget = {
  employeeId: string;
  orgId: string;
  slackUserId: string;
  slackTeamId: string;
  displayName: string;
  grokBotAgentId: string | null;
  wakeWebhookUrl: string | null;
  hasWakeWebhook: boolean;
};

function preferTeam(
  rows: EmployeeSlackIdentity[],
  teamId?: string | null
): EmployeeSlackIdentity[] {
  const team = (teamId || "").trim().toUpperCase();
  if (!team || !rows.length) return rows;
  const groups = new Map<string, EmployeeSlackIdentity[]>();
  for (const row of rows) {
    const key = row.slackUserId.trim().toUpperCase();
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const selected: EmployeeSlackIdentity[] = [];
  for (const group of groups.values()) {
    const matched = group.filter(
      (row) => row.slackTeamId.trim().toUpperCase() === team
    );
    // Prefer the same Slack team when several rows share a user id.
    // Never drop the only user-id match because team_id differs.
    selected.push(...(matched.length ? matched : group));
  }
  return selected;
}

async function withBinding(row: EmployeeSlackIdentity): Promise<SlackMentionTarget> {
  const binding = await getBinding(row.employeeId);
  return {
    employeeId: row.employeeId,
    orgId: row.orgId,
    slackUserId: row.slackUserId,
    slackTeamId: row.slackTeamId,
    displayName: row.displayName,
    grokBotAgentId: binding?.grokBotAgentId ?? null,
    wakeWebhookUrl: binding?.wakeWebhookUrl ?? null,
    hasWakeWebhook: Boolean(binding?.hasWakeWebhook),
  };
}

/** Resolve one employee as a wake target without requiring an outbound Slack identity. */
export async function getSlackWakeTargetByEmployeeId(input: {
  employeeId: string;
  orgId: string;
}): Promise<SlackMentionTarget | null> {
  const employee = await getEmployee(input.employeeId.trim(), input.orgId.trim());
  if (!employee || employee.status !== "active") return null;
  const identity = await getEmployeeSlackIdentity(employee.id);
  const linkedIdentity =
    identity?.orgId === employee.orgId && identity.status === "linked"
      ? identity
      : null;
  const binding = await getBinding(employee.id);
  return {
    employeeId: employee.id,
    orgId: employee.orgId,
    slackUserId: linkedIdentity?.slackUserId ?? "",
    slackTeamId: linkedIdentity?.slackTeamId ?? "",
    displayName: linkedIdentity?.displayName || employee.displayName,
    grokBotAgentId: binding?.grokBotAgentId ?? null,
    wakeWebhookUrl: binding?.wakeWebhookUrl ?? null,
    hasWakeWebhook: Boolean(binding?.hasWakeWebhook),
  };
}

function demoLinked(): EmployeeSlackIdentity[] {
  return [...demoIdentities.values()]
    .map((row) => row.public)
    .filter((row) => row.status === "linked" && row.slackUserId);
}

/** Admin-client lookup (not RLS browser). Linked identities only. */
export async function getEmployeesBySlackUserIds(
  ids: string[],
  teamId?: string | null
): Promise<SlackMentionTarget[]> {
  const rawIds = ids.map((id) => id.trim()).filter(Boolean);
  const wanted = new Set(rawIds.map((id) => id.toUpperCase()));
  if (!wanted.size) return [];
  const matchWanted = (row: EmployeeSlackIdentity) =>
    wanted.has(row.slackUserId.trim().toUpperCase());
  if (isDemoMode()) {
    const rows = demoLinked().filter(matchWanted);
    return Promise.all(preferTeam(rows, teamId).map(withBinding));
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  // Slack user ids are compared case-insensitively. Postgres `.in()` is
  // case-sensitive and stored ids may not be uppercase, so query original /
  // upper / lower variants then filter in JS. If any wanted id is still
  // missing (mixed case in the DB), scan linked rows.
  const lookupIds = [
    ...new Set([
      ...rawIds,
      ...wanted,
      ...[...wanted].map((id) => id.toLowerCase()),
    ]),
  ];
  const selectCols =
    "employee_id,org_id,slack_user_id,slack_team_id,display_name,status,updated_at";
  const first = await admin
    .from("employee_slack_identities")
    .select(selectCols)
    .in("slack_user_id", lookupIds)
    .eq("status", "linked");
  if (first.error) return [];
  let rows = (first.data ?? [])
    .map((row) => mapPublic(row as Record<string, unknown>))
    .filter(matchWanted);
  const found = new Set(rows.map((row) => row.slackUserId.trim().toUpperCase()));
  if ([...wanted].some((id) => !found.has(id))) {
    const fallback = await admin
      .from("employee_slack_identities")
      .select(selectCols)
      .eq("status", "linked");
    if (!fallback.error && fallback.data) {
      rows = fallback.data
        .map((row) => mapPublic(row as Record<string, unknown>))
        .filter(matchWanted);
    }
  }
  return Promise.all(preferTeam(rows, teamId).map(withBinding));
}

/** Linked identities in a Slack team (app_mention fallback: wake only if exactly one). */
export async function listLinkedSlackIdentitiesForTeam(
  teamId?: string | null
): Promise<SlackMentionTarget[]> {
  const team = (teamId || "").trim();
  if (isDemoMode()) {
    const rows = demoLinked().filter((row) => !team || row.slackTeamId === team);
    return Promise.all(rows.map(withBinding));
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  let query = admin
    .from("employee_slack_identities")
    .select("employee_id,org_id,slack_user_id,slack_team_id,display_name,status,updated_at")
    .eq("status", "linked");
  if (team) query = query.eq("slack_team_id", team);
  const { data, error } = await query;
  if (error || !data) return [];
  return Promise.all(
    data.map((row) => withBinding(mapPublic(row as Record<string, unknown>)))
  );
}
