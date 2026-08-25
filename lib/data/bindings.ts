import {
  assertExecutable as demoAssertExecutable,
  bindingPublicView,
  countNeedsReauth as demoCountNeedsReauth,
  ensureBindingRow as demoEnsure,
  findBindingByCredentialFingerprint as demoFindByFingerprint,
  getBinding as demoGet,
  linkAgent as demoLink,
  listBindingsForOrg as demoList,
  recordHealthFailure as demoFail,
  recordHealthSuccess as demoOk,
  revokeBinding as demoRevoke,
  rotateCredential as demoRotate,
} from "../bindings";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapBindingRow } from "./mappers";
import type {
  ActionLimits,
  ApprovalPolicy,
  EmployeeScope,
  EmployeeBinding,
  ExecutableAllow,
  ExecutableDeny,
  SpendLimits,
} from "../types";

export { bindingPublicView };

export async function getBinding(
  employeeId: string
): Promise<EmployeeBinding | undefined> {
  if (isDemoMode()) return demoGet(employeeId);
  const admin = createSupabaseAdminClient();
  if (!admin) return undefined;
  const { data } = await admin
    .from("employee_bindings")
    .select("*")
    .eq("employee_id", employeeId)
    .maybeSingle();
  if (!data) return undefined;
  return mapBindingRow(data as Record<string, unknown>);
}


export async function findBindingByCredentialFingerprint(
  fingerprint: string
): Promise<EmployeeBinding | undefined> {
  if (!fingerprint) return undefined;
  if (isDemoMode()) return demoFindByFingerprint(fingerprint);
  const admin = createSupabaseAdminClient();
  if (!admin) return undefined;
  const { data } = await admin
    .from("employee_bindings")
    .select("*")
    .eq("credential_fingerprint", fingerprint)
    .maybeSingle();
  if (!data) return undefined;
  return mapBindingRow(data as Record<string, unknown>);
}

export async function listBindingsForOrg(
  orgId: string
): Promise<EmployeeBinding[]> {
  if (isDemoMode()) return demoList(orgId);
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data } = await admin
    .from("employee_bindings")
    .select("*")
    .eq("org_id", orgId);
  return (data || []).map((r) => mapBindingRow(r as Record<string, unknown>));
}

export async function countNeedsReauth(orgId?: string): Promise<number> {
  if (isDemoMode()) return demoCountNeedsReauth(orgId);
  const admin = createSupabaseAdminClient();
  if (!admin) return 0;
  let q = admin
    .from("employee_bindings")
    .select("employee_id", { count: "exact", head: true })
    .eq("status", "needs_reauth");
  if (orgId) q = q.eq("org_id", orgId);
  const { count } = await q;
  return count ?? 0;
}

export async function ensureBindingRow(
  employeeId: string,
  orgId: string
): Promise<EmployeeBinding> {
  if (isDemoMode()) return demoEnsure(employeeId, orgId);
  const existing = await getBinding(employeeId);
  if (existing) return existing;
  const admin = createSupabaseAdminClient();
  if (!admin) return demoEnsure(employeeId, orgId);
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("employee_bindings")
    .upsert({
      employee_id: employeeId,
      org_id: orgId,
      credential_generation: 0,
      status: "unlinked",
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "binding_ensure_failed");
  return mapBindingRow(data as Record<string, unknown>);
}

export async function linkAgent(
  employeeId: string,
  opts: {
    orgId: string;
    grokBotAgentId: string;
    grokBotWorkspaceId?: string | null;
  }
): Promise<EmployeeBinding> {
  if (isDemoMode()) return demoLink(employeeId, opts);
  const row = await ensureBindingRow(employeeId, opts.orgId);
  if (row.status === "revoked") {
    throw Object.assign(new Error("binding_revoked"), { code: "revoked" as const });
  }
  const agentId = opts.grokBotAgentId.trim();
  if (!agentId) {
    throw Object.assign(new Error("agent_id_required"), { code: "invalid" as const });
  }
  const admin = createSupabaseAdminClient()!;
  const { data, error } = await admin
    .from("employee_bindings")
    .update({
      grok_bot_agent_id: agentId,
      grok_bot_workspace_id:
        opts.grokBotWorkspaceId === undefined
          ? row.grokBotWorkspaceId
          : opts.grokBotWorkspaceId || null,
      status: "linked",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("employee_id", employeeId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "link_failed");
  return mapBindingRow(data as Record<string, unknown>);
}

export async function rotateCredential(
  employeeId: string,
  orgId: string,
  fingerprint: string,
  credential?: {
    secretPrefix: string;
    scopes: EmployeeScope[];
    allowedPurposes: string[];
    approvalPolicy: ApprovalPolicy;
    actionLimits: ActionLimits;
    spend?: SpendLimits | null;
    allowedAccounts?: Array<{ service: string; accountId: string; label?: string; browserRequired?: boolean }>;
  }
): Promise<{ binding: EmployeeBinding; generation: number }> {
  if (isDemoMode()) return demoRotate(employeeId, orgId, fingerprint);
  const row = await ensureBindingRow(employeeId, orgId);
  if (row.status === "revoked") {
    throw Object.assign(new Error("binding_revoked"), { code: "revoked" as const });
  }
  const generation = row.credentialGeneration + 1;
  const nextStatus = row.grokBotAgentId ? "linked" : "unlinked";
  const admin = createSupabaseAdminClient()!;
  const { data, error } = await admin
    .from("employee_bindings")
    .update({
      credential_generation: generation,
      credential_fingerprint: fingerprint,
      status: nextStatus,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("employee_id", employeeId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "rotate_failed");

  // Keep the credential snapshot aligned with the employee policy on every
  // rotation. Authentication prefers the binding fingerprint, while this row
  // remains the durable policy/audit source for the newly issued secret.
  if (credential) {
    const { data: rotatedCredential, error: credentialError } = await admin
      .from("credentials")
      .insert({
        org_id: orgId,
        employee_id: employeeId,
        secret_hash: fingerprint,
        secret_prefix: credential.secretPrefix,
        scopes: credential.scopes,
        allowed_purposes: credential.allowedPurposes,
        approval_policy: credential.approvalPolicy,
        action_limits: credential.actionLimits,
        spend: credential.spend ?? null,
        allowed_accounts: credential.allowedAccounts ?? [],
      })
      .select("id")
      .single();
    if (credentialError || !rotatedCredential) {
      throw new Error(credentialError?.message || "credential_rotate_insert_failed");
    }
    await admin
      .from("credentials")
      .update({ revoked_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("employee_id", employeeId)
      .is("revoked_at", null)
      .neq("id", String(rotatedCredential.id));
  }
  const binding = mapBindingRow(data as Record<string, unknown>);
  return { binding, generation };
}

export async function recordHealthSuccess(
  employeeId: string
): Promise<EmployeeBinding | undefined> {
  if (isDemoMode()) return demoOk(employeeId);
  const row = await getBinding(employeeId);
  if (!row) return undefined;
  if (row.status === "revoked") {
    return recordHealthFailure(employeeId, "revoked");
  }
  const admin = createSupabaseAdminClient()!;
  const { data } = await admin
    .from("employee_bindings")
    .update({
      status: row.grokBotAgentId ? "linked" : "unlinked",
      last_success_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("employee_id", employeeId)
    .select("*")
    .single();
  return data ? mapBindingRow(data as Record<string, unknown>) : undefined;
}

export async function recordHealthFailure(
  employeeId: string,
  error: string
): Promise<EmployeeBinding | undefined> {
  if (isDemoMode()) return demoFail(employeeId, error);
  const row = await getBinding(employeeId);
  if (!row) return undefined;
  const admin = createSupabaseAdminClient()!;
  const status = row.status === "revoked" ? "revoked" : "needs_reauth";
  const { data } = await admin
    .from("employee_bindings")
    .update({
      status,
      last_error: error || (row.status === "revoked" ? "revoked" : "health_failed"),
      updated_at: new Date().toISOString(),
    })
    .eq("employee_id", employeeId)
    .select("*")
    .single();
  return data ? mapBindingRow(data as Record<string, unknown>) : undefined;
}

export async function revokeBinding(
  employeeId: string
): Promise<EmployeeBinding | undefined> {
  if (isDemoMode()) return demoRevoke(employeeId);
  const admin = createSupabaseAdminClient();
  if (!admin) return undefined;
  const { data } = await admin
    .from("employee_bindings")
    .update({
      status: "revoked",
      last_error: "revoked",
      updated_at: new Date().toISOString(),
    })
    .eq("employee_id", employeeId)
    .select("*")
    .single();
  return data ? mapBindingRow(data as Record<string, unknown>) : undefined;
}

export async function assertExecutable(
  employeeId: string
): Promise<ExecutableAllow | ExecutableDeny> {
  if (isDemoMode()) return demoAssertExecutable(employeeId);
  const binding = await getBinding(employeeId);
  if (!binding) {
    return {
      ok: false,
      code: "not_found",
      message: "binding not found; refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "revoked") {
    return {
      ok: false,
      code: "revoked",
      message: "binding revoked; refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "unlinked" || !binding.grokBotAgentId) {
    return {
      ok: false,
      code: "unbound",
      message: "employee not linked to Grok Bot agent; refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "needs_reauth") {
    return {
      ok: false,
      code: "needs_reauth",
      message: "credentials need reauth (要再連携); refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "degraded") {
    return {
      ok: false,
      code: "degraded",
      message: "binding degraded; refuse invoke (fail-closed)",
    };
  }
  if (binding.status !== "linked") {
    return {
      ok: false,
      code: "health_failed",
      message: "binding not executable; refuse invoke (fail-closed)",
    };
  }
  return { ok: true, binding };
}
