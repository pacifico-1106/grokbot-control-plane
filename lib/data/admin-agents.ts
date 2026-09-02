/**
 * One top-level admin agent per tenant.
 * Not an employee badge. Secret prefix gb_adm_ (never gb_emp_).
 */
import { randomBytes } from "node:crypto";
import { fingerprintSecret } from "@/lib/bindings";
import { DEMO_ORG } from "@/lib/demo-data";
import { ADMIN_CREDENTIAL_PREFIX } from "@/lib/mcp/admin-public";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { OrgAdminAgent } from "@/lib/types";

/** Demo-only seed secret. Prefix gb_adm_. Never log. */
export const DEMO_ADMIN_SECRET = "gb_adm_demo_seed_not_a_real_secret";

const runtimeAgents = new Map<string, OrgAdminAgent>();

function nowIso(): string {
  return new Date().toISOString();
}

function mapRow(row: Record<string, unknown>): OrgAdminAgent {
  return {
    id: String(row.id),
    orgId: String(row.org_id ?? row.orgId),
    grokBotAgentId:
      row.grok_bot_agent_id != null
        ? String(row.grok_bot_agent_id)
        : row.grokBotAgentId != null
          ? String(row.grokBotAgentId)
          : null,
    grokBotWorkspaceId:
      row.grok_bot_workspace_id != null
        ? String(row.grok_bot_workspace_id)
        : row.grokBotWorkspaceId != null
          ? String(row.grokBotWorkspaceId)
          : null,
    credentialFingerprint:
      row.credential_fingerprint != null
        ? String(row.credential_fingerprint)
        : row.credentialFingerprint != null
          ? String(row.credentialFingerprint)
          : null,
    secretPrefix: String(row.secret_prefix ?? row.secretPrefix ?? ADMIN_CREDENTIAL_PREFIX),
    credentialGeneration: Number(row.credential_generation ?? row.credentialGeneration ?? 0),
    status: (row.status as OrgAdminAgent["status"]) || "unlinked",
    opsDocLocation:
      row.ops_doc_location != null
        ? String(row.ops_doc_location)
        : row.opsDocLocation != null
          ? String(row.opsDocLocation)
          : null,
    createdAt: String(row.created_at ?? row.createdAt ?? nowIso()),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? nowIso()),
  };
}

function seedDemo(): OrgAdminAgent {
  const existing = runtimeAgents.get(DEMO_ORG.id);
  if (existing) return existing;
  const seeded: OrgAdminAgent = {
    id: "adm_demo",
    orgId: DEMO_ORG.id,
    grokBotAgentId: "grok_admin_demo",
    grokBotWorkspaceId: null,
    credentialFingerprint: fingerprintSecret(DEMO_ADMIN_SECRET),
    secretPrefix: ADMIN_CREDENTIAL_PREFIX,
    credentialGeneration: 1,
    status: "linked",
    opsDocLocation: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  runtimeAgents.set(DEMO_ORG.id, seeded);
  return seeded;
}

export function mintAdminSecret(): { raw: string; hash: string; prefix: string } {
  const raw = `${ADMIN_CREDENTIAL_PREFIX}${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  return {
    raw,
    hash: fingerprintSecret(raw),
    prefix: raw.slice(0, 14),
  };
}

export async function getOrgAdminAgent(orgId?: string | null): Promise<OrgAdminAgent | null> {
  if (!orgId) return null;
  if (isDemoMode()) {
    seedDemo();
    return runtimeAgents.get(orgId) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("org_admin_agents")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data as Record<string, unknown>);
}

export async function findAdminAgentByFingerprint(
  fingerprint: string
): Promise<OrgAdminAgent | null> {
  if (!fingerprint) return null;
  if (isDemoMode()) {
    seedDemo();
    for (const row of runtimeAgents.values()) {
      if (row.credentialFingerprint === fingerprint && row.status !== "revoked") {
        return row;
      }
    }
    return null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("org_admin_agents")
    .select("*")
    .eq("credential_fingerprint", fingerprint)
    .maybeSingle();
  if (error || !data) return null;
  const mapped = mapRow(data as Record<string, unknown>);
  if (mapped.status === "revoked") return null;
  return mapped;
}

export async function issueOrgAdminAgent(input: {
  orgId: string;
  secretHash: string;
  secretPrefix: string;
}): Promise<OrgAdminAgent> {
  const now = nowIso();
  if (isDemoMode()) {
    const prev = runtimeAgents.get(input.orgId) ?? seedDemo();
    const next: OrgAdminAgent = {
      ...prev,
      orgId: input.orgId,
      credentialFingerprint: input.secretHash,
      secretPrefix: input.secretPrefix,
      credentialGeneration: (prev.credentialGeneration || 0) + 1,
      status: prev.grokBotAgentId ? "linked" : "unlinked",
      updatedAt: now,
    };
    runtimeAgents.set(input.orgId, next);
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const existing = await getOrgAdminAgent(input.orgId);
  if (existing) {
    const { data, error } = await admin
      .from("org_admin_agents")
      .update({
        credential_fingerprint: input.secretHash,
        secret_prefix: input.secretPrefix,
        credential_generation: existing.credentialGeneration + 1,
        status: existing.grokBotAgentId ? "linked" : "unlinked",
        updated_at: now,
      })
      .eq("org_id", input.orgId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message || "admin_agent_update_failed");
    return mapRow(data as Record<string, unknown>);
  }
  const { data, error } = await admin
    .from("org_admin_agents")
    .insert({
      org_id: input.orgId,
      credential_fingerprint: input.secretHash,
      secret_prefix: input.secretPrefix,
      credential_generation: 1,
      status: "unlinked",
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "admin_agent_insert_failed");
  return mapRow(data as Record<string, unknown>);
}

export async function linkOrgAdminAgent(input: {
  orgId: string;
  grokBotAgentId: string;
  grokBotWorkspaceId?: string | null;
}): Promise<OrgAdminAgent> {
  const agentId = input.grokBotAgentId.trim();
  if (!agentId) throw new Error("agent_id_required");
  const now = nowIso();
  if (isDemoMode()) {
    const prev = runtimeAgents.get(input.orgId) ?? seedDemo();
    const next: OrgAdminAgent = {
      ...prev,
      grokBotAgentId: agentId,
      grokBotWorkspaceId: input.grokBotWorkspaceId?.trim() || null,
      status: prev.status === "revoked" ? "revoked" : "linked",
      updatedAt: now,
    };
    if (next.status === "revoked") {
      throw Object.assign(new Error("revoked"), { code: "revoked" as const });
    }
    runtimeAgents.set(input.orgId, next);
    return next;
  }
  const existing = await getOrgAdminAgent(input.orgId);
  if (!existing) throw new Error("admin_agent_not_found");
  if (existing.status === "revoked") {
    throw Object.assign(new Error("revoked"), { code: "revoked" as const });
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("org_admin_agents")
    .update({
      grok_bot_agent_id: agentId,
      grok_bot_workspace_id: input.grokBotWorkspaceId?.trim() || null,
      status: "linked",
      updated_at: now,
    })
    .eq("org_id", input.orgId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "admin_link_failed");
  return mapRow(data as Record<string, unknown>);
}

export async function setOrgAdminOpsDocLocation(input: {
  orgId: string;
  opsDocLocation: string;
}): Promise<OrgAdminAgent> {
  const location = input.opsDocLocation.trim();
  const now = nowIso();
  if (isDemoMode()) {
    const prev = runtimeAgents.get(input.orgId) ?? seedDemo();
    const next: OrgAdminAgent = { ...prev, opsDocLocation: location || null, updatedAt: now };
    runtimeAgents.set(input.orgId, next);
    return next;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const existing = await getOrgAdminAgent(input.orgId);
  if (existing) {
    const { data, error } = await admin
      .from("org_admin_agents")
      .update({ ops_doc_location: location || null, updated_at: now })
      .eq("org_id", input.orgId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message || "ops_doc_update_failed");
    return mapRow(data as Record<string, unknown>);
  }
  const { data, error } = await admin
    .from("org_admin_agents")
    .insert({
      org_id: input.orgId,
      ops_doc_location: location || null,
      status: "unlinked",
      credential_generation: 0,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "ops_doc_insert_failed");
  return mapRow(data as Record<string, unknown>);
}

export function adminAgentPublicView(agent: OrgAdminAgent): Omit<
  OrgAdminAgent,
  "credentialFingerprint"
> & { connected: boolean } {
  return {
    id: agent.id,
    orgId: agent.orgId,
    grokBotAgentId: agent.grokBotAgentId,
    grokBotWorkspaceId: agent.grokBotWorkspaceId,
    secretPrefix: agent.secretPrefix,
    credentialGeneration: agent.credentialGeneration,
    status: agent.status,
    opsDocLocation: agent.opsDocLocation,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    connected: agent.status === "linked" && Boolean(agent.grokBotAgentId),
  };
}

/** Test helper: overwrite demo agent (process-local). */
export function resetDemoAdminAgent(row?: Partial<OrgAdminAgent>): OrgAdminAgent {
  const seeded = seedDemo();
  if (!row) return seeded;
  const next = { ...seeded, ...row, orgId: row.orgId ?? DEMO_ORG.id, updatedAt: nowIso() };
  runtimeAgents.set(next.orgId, next);
  return next;
}
