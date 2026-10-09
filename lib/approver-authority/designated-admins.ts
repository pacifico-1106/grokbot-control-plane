/**
 * PR-D: 指定管理者 (designated admins) = orgs.designated_admin_member_ids.
 * Only changed through the owner-approved approvers.designatedAdmins.set ticket.
 */
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { listMembers } from "@/lib/data/members";

export const DESIGNATED_ADMINS_MAX = 20;

const demoDesignatedAdmins = new Map<string, string[]>();

/** Test helper (demo only). */
export function resetDemoDesignatedAdminsForTests(): void {
  demoDesignatedAdmins.clear();
}

function normalizeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => String(id ?? "").trim()).filter(Boolean))];
}

/** Throws when the setting cannot be read (callers fail closed). */
export async function getDesignatedAdminMemberIds(orgId: string): Promise<string[]> {
  if (!orgId) throw new Error("org_required");
  if (isDemoMode()) return [...(demoDesignatedAdmins.get(orgId) ?? [])];
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("orgs")
    .select("designated_admin_member_ids")
    .eq("id", orgId)
    .maybeSingle();
  if (error || !data) throw new Error("designated_admins_unavailable");
  return normalizeIds((data as { designated_admin_member_ids?: unknown }).designated_admin_member_ids);
}

export async function writeDesignatedAdminMemberIds(orgId: string, ids: readonly string[]): Promise<void> {
  const next = normalizeIds([...ids]);
  if (isDemoMode()) {
    demoDesignatedAdmins.set(orgId, next);
    return;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { error } = await admin.from("orgs").update({ designated_admin_member_ids: next }).eq("id", orgId);
  if (error) throw new Error("designated_admins_write_failed");
}

export type DesignatedAdminsValidation =
  | { ok: true; memberIds: string[] }
  | { ok: false; code: "designated_admins_invalid"; messageJa: string; invalid: Array<{ memberId: string; reason: string }> };

/**
 * Each id must be an ACTIVE member of THIS org with role "admin" (owners are
 * already approvers; plain members cannot be designated). Max 20, deduped.
 */
export async function validateDesignatedAdminIds(orgId: string, raw: unknown): Promise<DesignatedAdminsValidation> {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    return { ok: false, code: "designated_admins_invalid", messageJa: "memberIds は文字列の配列で指定してください。", invalid: [] };
  }
  const ids = normalizeIds(raw);
  if (ids.length > DESIGNATED_ADMINS_MAX) {
    return {
      ok: false,
      code: "designated_admins_invalid",
      messageJa: `指定管理者は最大 ${DESIGNATED_ADMINS_MAX} 人までです。`,
      invalid: [],
    };
  }
  const members = (await listMembers(orgId)).filter((m) => m.orgId === orgId);
  const invalid: Array<{ memberId: string; reason: string }> = [];
  for (const id of ids) {
    const member = members.find((m) => m.id === id);
    if (!member) invalid.push({ memberId: id, reason: "member_not_found" });
    else if (member.status !== "active") invalid.push({ memberId: id, reason: "member_inactive" });
    else if (member.role !== "admin") invalid.push({ memberId: id, reason: "role_not_admin" });
  }
  if (invalid.length) {
    return {
      ok: false,
      code: "designated_admins_invalid",
      messageJa: "指定管理者にできるのは、この組織の有効な管理者（admin ロール）だけです。",
      invalid,
    };
  }
  return { ok: true, memberIds: ids };
}
