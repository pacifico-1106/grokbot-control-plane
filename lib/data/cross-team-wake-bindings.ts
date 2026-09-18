/**
 * G7 Cross-team wake routing data layer — Option A locked (2026-09-19).
 *
 * Provides explicit bind lookups for cross-org wake when a Connect guest is mentioned.
 * Feature flag G7_CONNECT_WAKE_ROUTING must be ON for the wake path to use these functions.
 *
 * SECURITY:
 * - Tenant isolation: binds are scoped to (receiving_org, target_org) pairs.
 * - Fail-closed: missing or ambiguous (>1) binds return null (no wake).
 * - No cross-org guessing by display name; explicit admin bind only.
 */

import { getEmployee } from "@/lib/data/employees";
import { getSlackWakeTargetByEmployeeId, type SlackMentionTarget } from "@/lib/data/slack-identities";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export interface CrossTeamWakeBinding {
  id: string;
  receivingOrgId: string;
  receivingTeamId: string;
  mentionedSlackUserId: string;
  targetOrgId: string;
  targetEmployeeId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const demoBindings = new Map<string, CrossTeamWakeBinding>();

function nowIso(): string {
  return new Date().toISOString();
}

function bindingKey(receivingOrgId: string, receivingTeamId: string, mentionedSlackUserId: string): string {
  return `${receivingOrgId.trim()}:${receivingTeamId.trim().toUpperCase()}:${mentionedSlackUserId.trim().toUpperCase()}`;
}

function mapRow(row: Record<string, unknown>): CrossTeamWakeBinding {
  return {
    id: String(row.id ?? ""),
    receivingOrgId: String(row.receiving_org_id ?? ""),
    receivingTeamId: String(row.receiving_team_id ?? ""),
    mentionedSlackUserId: String(row.mentioned_slack_user_id ?? ""),
    targetOrgId: String(row.target_org_id ?? ""),
    targetEmployeeId: String(row.target_employee_id ?? ""),
    enabled: Boolean(row.enabled ?? true),
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

/**
 * Feature flag check for G7 cross-team wake routing.
 * Default OFF — code paths using this are dead until explicitly enabled.
 */
export function isCrossTeamWakeRoutingEnabled(): boolean {
  return process.env.G7_CONNECT_WAKE_ROUTING === "1";
}

/**
 * Look up explicit cross-team wake binding by (receivingTeamId, mentionedSlackUserId).
 *
 * Fail-closed design:
 * - Returns null if 0 or >1 enabled bindings match (ambiguous = no wake).
 * - Returns the single binding if exactly 1 match.
 *
 * SECURITY: Does not verify employee is still active; caller must check.
 */
export async function getCrossTeamWakeBinding(input: {
  receivingTeamId: string;
  mentionedSlackUserId: string;
}): Promise<CrossTeamWakeBinding | null> {
  const teamId = input.receivingTeamId.trim().toUpperCase();
  const userId = input.mentionedSlackUserId.trim().toUpperCase();
  if (!teamId || !userId) return null;

  if (isDemoMode()) {
    const matches = [...demoBindings.values()].filter(
      (binding) =>
        binding.enabled &&
        binding.receivingTeamId.toUpperCase() === teamId &&
        binding.mentionedSlackUserId.toUpperCase() === userId
    );
    if (matches.length !== 1) return null;
    return matches[0];
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return null;

  const teamVariants = [...new Set([teamId, teamId.toLowerCase(), input.receivingTeamId.trim()])];
  const userVariants = [...new Set([userId, userId.toLowerCase(), input.mentionedSlackUserId.trim()])];

  const { data, error } = await admin
    .from("cross_team_wake_bindings")
    .select("*")
    .in("receiving_team_id", teamVariants)
    .in("mentioned_slack_user_id", userVariants)
    .eq("enabled", true);

  if (error || !data) return null;

  const rows = data
    .map((row) => mapRow(row as Record<string, unknown>))
    .filter(
      (binding) =>
        binding.receivingTeamId.toUpperCase() === teamId &&
        binding.mentionedSlackUserId.toUpperCase() === userId
    );

  if (rows.length !== 1) return null;
  return rows[0];
}

/**
 * Resolve cross-team wake binding to a wake target.
 *
 * Fail-closed design:
 * - Returns null if binding not found or employee inactive/missing.
 * - Returns SlackMentionTarget only when all conditions are met.
 */
export async function resolveCrossTeamWakeTarget(input: {
  receivingTeamId: string;
  mentionedSlackUserId: string;
}): Promise<SlackMentionTarget | null> {
  const binding = await getCrossTeamWakeBinding(input);
  if (!binding) return null;

  const employee = await getEmployee(binding.targetEmployeeId, binding.targetOrgId);
  if (!employee || employee.status !== "active") return null;

  return getSlackWakeTargetByEmployeeId({
    employeeId: binding.targetEmployeeId,
    orgId: binding.targetOrgId,
  });
}

/**
 * Upsert a cross-team wake binding (admin tooling only).
 *
 * For tests and future admin MCP. Production enable is separate GO.
 */
export async function upsertCrossTeamWakeBinding(input: {
  receivingOrgId: string;
  receivingTeamId: string;
  mentionedSlackUserId: string;
  targetOrgId: string;
  targetEmployeeId: string;
  enabled?: boolean;
}): Promise<CrossTeamWakeBinding> {
  const receivingOrgId = input.receivingOrgId.trim();
  const receivingTeamId = input.receivingTeamId.trim();
  const mentionedSlackUserId = input.mentionedSlackUserId.trim();
  const targetOrgId = input.targetOrgId.trim();
  const targetEmployeeId = input.targetEmployeeId.trim();
  const enabled = input.enabled ?? true;

  if (!receivingOrgId || !receivingTeamId || !mentionedSlackUserId || !targetOrgId || !targetEmployeeId) {
    throw new Error("invalid_cross_team_wake_binding");
  }

  const employee = await getEmployee(targetEmployeeId, targetOrgId);
  if (!employee) throw new Error("employee_not_found");
  if (employee.status !== "active") throw new Error("employee_not_active");

  const timestamp = nowIso();

  if (isDemoMode()) {
    const key = bindingKey(receivingOrgId, receivingTeamId, mentionedSlackUserId);
    const existing = demoBindings.get(key);
    const binding: CrossTeamWakeBinding = {
      id: existing?.id ?? `binding_${Date.now()}`,
      receivingOrgId,
      receivingTeamId,
      mentionedSlackUserId,
      targetOrgId,
      targetEmployeeId,
      enabled,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    demoBindings.set(key, binding);
    return binding;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const { data, error } = await admin
    .from("cross_team_wake_bindings")
    .upsert(
      {
        receiving_org_id: receivingOrgId,
        receiving_team_id: receivingTeamId,
        mentioned_slack_user_id: mentionedSlackUserId,
        target_org_id: targetOrgId,
        target_employee_id: targetEmployeeId,
        enabled,
        updated_at: timestamp,
      },
      { onConflict: "receiving_org_id,receiving_team_id,mentioned_slack_user_id" }
    )
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "cross_team_wake_binding_upsert_failed");
  return mapRow(data as Record<string, unknown>);
}

/**
 * Delete a cross-team wake binding by id (admin tooling only).
 */
export async function deleteCrossTeamWakeBinding(input: {
  id: string;
}): Promise<void> {
  const id = input.id.trim();
  if (!id) return;

  if (isDemoMode()) {
    for (const [key, binding] of demoBindings.entries()) {
      if (binding.id === id) {
        demoBindings.delete(key);
        return;
      }
    }
    return;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const { error } = await admin
    .from("cross_team_wake_bindings")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message || "cross_team_wake_binding_delete_failed");
}

/**
 * List cross-team wake bindings for a target org (admin tooling only).
 */
export async function listCrossTeamWakeBindingsByTargetOrg(orgId: string): Promise<CrossTeamWakeBinding[]> {
  if (!orgId) return [];

  if (isDemoMode()) {
    return [...demoBindings.values()].filter((binding) => binding.targetOrgId === orgId);
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return [];

  const { data, error } = await admin
    .from("cross_team_wake_bindings")
    .select("*")
    .eq("target_org_id", orgId)
    .order("created_at", { ascending: false });

  if (error || !data) return [];
  return data.map((row) => mapRow(row as Record<string, unknown>));
}

/**
 * Reset demo bindings (test utility).
 */
export function resetDemoCrossTeamWakeBindings(): void {
  demoBindings.clear();
}
