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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function normalizeMemberEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Production write id: keep a real UUID, otherwise mint one (never mem_*). */
export function resolveProductionMemberId(id?: string | null): string {
  return isUuid(id) ? id : crypto.randomUUID();
}

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const msg = (error.message ?? "").toLowerCase();
  return (
    code === "23505" ||
    msg.includes("duplicate key") ||
    msg.includes("unique constraint")
  );
}

export async function listMembers(orgId?: string | null): Promise<OrgMember[]> {
  if (isDemoMode()) return getRuntimeMembers();
  if (!orgId) return [];
  const admin = createSupabaseAdminClient();
  if (!admin) {
    throw new Error("supabase_not_configured");
  }
  const { data, error } = await admin
    .from("org_members")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(error.message || "member_list_failed");
  }
  return (data ?? []).map((r) => mapMemberRow(r as Record<string, unknown>));
}

export async function getMemberById(
  id: string,
  orgId?: string | null
): Promise<OrgMember | null> {
  if (isDemoMode()) return getRuntimeMemberById(id);
  const members = await listMembers(orgId);
  return members.find((m) => m.id === id) ?? null;
}

type MemberWriteFields = {
  org_id: string;
  email: string;
  display_name: string;
  role: OrgMember["role"];
  job_role: string;
  job_label: string | null;
  capabilities: NonNullable<OrgMember["capabilities"]>;
};

async function writeMemberAudit(
  oid: string,
  member: OrgMember,
  savedId: string
): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin) return;
  await admin.from("audit_events").insert({
    org_id: oid,
    action: "member.invited",
    summary: `チーム更新: ${member.displayName}（${member.jobRole ?? member.role}）`,
    metadata: {
      memberId: savedId,
      jobRole: member.jobRole,
      capabilities: member.capabilities ?? [],
    },
  });
}

async function findOrgMemberByEmail(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  oid: string,
  email: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin
    .from("org_members")
    .select("*")
    .eq("org_id", oid)
    .eq("email", email)
    .maybeSingle();
  if (error) {
    throw new Error(error.message || "member_lookup_failed");
  }
  if (data) return data as Record<string, unknown>;

  const { data: rows, error: listErr } = await admin
    .from("org_members")
    .select("*")
    .eq("org_id", oid);
  if (listErr) {
    throw new Error(listErr.message || "member_lookup_failed");
  }
  const hit = (rows ?? []).find(
    (r: { email?: string }) =>
      String(r.email ?? "").trim().toLowerCase() === email
  );
  return hit ? (hit as Record<string, unknown>) : null;
}

export async function upsertMember(
  member: OrgMember,
  orgId?: string | null
): Promise<OrgMember> {
  if (isDemoMode()) {
    return upsertRuntimeMember({
      ...member,
      email: normalizeMemberEmail(member.email),
    });
  }
  const admin = createSupabaseAdminClient();
  const oid = orgId || member.orgId;
  if (!oid || oid === "org_demo") {
    throw new Error("org_id_required");
  }
  if (!admin) {
    throw new Error("supabase_not_configured");
  }

  const email = normalizeMemberEmail(member.email);
  const writeFields: MemberWriteFields = {
    org_id: oid,
    email,
    display_name: member.displayName,
    role: member.role,
    job_role: member.jobRole ?? "custom",
    job_label: member.jobLabel ?? null,
    capabilities: member.capabilities ?? [],
  };

  const updateExisting = async (id: string) => {
    const { data, error } = await admin
      .from("org_members")
      .update(writeFields)
      .eq("id", id)
      .eq("org_id", oid)
      .select("*")
      .maybeSingle();
    if (error) {
      throw new Error(error.message || "member_upsert_failed");
    }
    return data as Record<string, unknown> | null;
  };

  if (isUuid(member.id)) {
    const updated = await updateExisting(member.id);
    if (updated) {
      await writeMemberAudit(oid, member, String(updated.id));
      return mapMemberRow(updated);
    }
  }

  const insertId = resolveProductionMemberId(member.id);
  const { data: inserted, error: insertError } = await admin
    .from("org_members")
    .insert({
      id: insertId,
      ...writeFields,
      status: member.status || "invited",
      invited_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (!insertError && inserted) {
    await writeMemberAudit(oid, member, String((inserted as { id: string }).id));
    return mapMemberRow(inserted as Record<string, unknown>);
  }

  if (isUniqueViolation(insertError)) {
    const existing = await findOrgMemberByEmail(admin, oid, email);
    if (!existing?.id) {
      throw new Error(insertError?.message || "member_upsert_failed");
    }
    const updated = await updateExisting(String(existing.id));
    if (!updated) {
      throw new Error("member_upsert_failed");
    }
    await writeMemberAudit(oid, member, String(updated.id));
    return mapMemberRow(updated);
  }

  throw new Error(insertError?.message || "member_upsert_failed");
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
