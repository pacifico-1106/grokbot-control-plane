import {
  DEMO_ORG,
  getRuntimeMemberById,
  getRuntimeMembers,
  upsertRuntimeMember,
} from "../demo-data";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient } from "../supabase";
import { mapMemberRow } from "./mappers";
import type { OrgMember } from "../types";

export async function listMembers(orgId?: string | null): Promise<OrgMember[]> {
  if (isDemoMode()) return getRuntimeMembers();
  const admin = createSupabaseAdminClient();
  if (!admin || !orgId) return [];
  const { data, error } = await admin
    .from("org_members")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.map((r) => mapMemberRow(r as Record<string, unknown>));
}

export async function getMemberById(
  id: string,
  orgId?: string | null
): Promise<OrgMember | null> {
  if (isDemoMode()) return getRuntimeMemberById(id);
  const members = await listMembers(orgId);
  return members.find((m) => m.id === id) ?? null;
}

export async function upsertMember(
  member: OrgMember,
  orgId?: string | null
): Promise<OrgMember> {
  if (isDemoMode()) {
    return upsertRuntimeMember(member);
  }
  const admin = createSupabaseAdminClient();
  const oid = orgId || member.orgId;
  if (!admin || !oid) throw new Error("supabase_not_configured");

  const payload = {
    id: member.id.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
      ? member.id
      : undefined,
    org_id: oid,
    email: member.email,
    display_name: member.displayName,
    role: member.role,
    job_role: member.jobRole ?? "custom",
    job_label: member.jobLabel ?? null,
    capabilities: member.capabilities ?? [],
    status: member.status,
  };

  const { data, error } = await admin
    .from("org_members")
    .upsert(payload, { onConflict: "org_id,email" })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "member_upsert_failed");
  }

  await admin.from("audit_events").insert({
    org_id: oid,
    action: "member.invited",
    summary: `チーム更新: ${member.displayName}（${member.jobRole ?? member.role}）`,
    metadata: {
      memberId: (data as { id: string }).id,
      jobRole: member.jobRole,
      capabilities: member.capabilities ?? [],
    },
  });

  return mapMemberRow(data as Record<string, unknown>);
}

/** Resolve actor for capability checks — DEMO falls back to mem_1. */
export async function resolveActorMember(
  actorId: string | null | undefined,
  orgId?: string | null
): Promise<OrgMember> {
  if (isDemoMode()) {
    return (
      getRuntimeMemberById(actorId || "mem_1") ??
      getRuntimeMembers().find((m) => m.role === "owner") ??
      getRuntimeMembers()[0] ?? {
        id: "mem_1",
        orgId: DEMO_ORG.id,
        email: "owner@example.com",
        displayName: "山田 太郎",
        role: "owner" as const,
        jobRole: "owner" as const,
        capabilities: [
          "view_dashboard",
          "view_employees",
          "view_audit",
          "approve_actions",
          "manage_spend_limits",
          "hire_issue_credentials",
          "manage_team",
          "manage_billing",
        ],
        status: "active" as const,
      }
    );
  }
  const members = await listMembers(orgId);
  if (actorId) {
    const found = members.find((m) => m.id === actorId);
    if (found) return found;
  }
  return (
    members.find((m) => m.role === "owner") ??
    members[0] ?? {
      id: "unknown",
      orgId: orgId || "",
      email: "unknown@example.com",
      displayName: "不明",
      role: "member" as const,
      capabilities: [],
      status: "active" as const,
    }
  );
}
