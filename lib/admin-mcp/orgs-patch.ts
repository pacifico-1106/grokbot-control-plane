/**
 * Platform super-admin org patch via Admin MCP (orgs.patch).
 * Supports name updates. Behind platform-ops gate (same as orgs.create / orgs.status).
 *
 * Design note: NOT always_human — human Super Admin / platform-ops actor is already
 * making the decision (same rationale as trial-extension via UI). The MCP path is
 * for ops automation; the UI path is for setup代行 without MCP.
 */
import type { PlatformOpsActor } from "@/lib/admin/platform-ops-gate";
import { getOrgMeta } from "@/lib/data/org-context";
import { isDemoMode } from "@/lib/mode";
import { DEMO_ORG } from "@/lib/demo-data";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { appendAuditEvent } from "@/lib/data";

export const ORG_NAME_MAX_LENGTH = 200;

export type OrgPatchInput = {
  orgId: string;
  name: string;
};

export type OrgPatchSuccess = {
  orgId: string;
  previousName: string;
  newName: string;
  summaryJa: string;
};

export function validateOrgPatchInput(
  args: Record<string, unknown>
):
  | { ok: true; value: OrgPatchInput }
  | { ok: false; code: string; message: string } {
  const orgId = String(args.orgId || "").trim();
  const name = String(args.name || "").trim();

  if (!orgId) {
    return { ok: false, code: "org_id_required", message: "orgId が必要です" };
  }

  if (!name) {
    return { ok: false, code: "name_required", message: "name が必要です（空にはできません）" };
  }

  if (name.length > ORG_NAME_MAX_LENGTH) {
    return {
      ok: false,
      code: "name_too_long",
      message: `name は ${ORG_NAME_MAX_LENGTH} 文字以内にしてください`,
    };
  }

  return {
    ok: true,
    value: { orgId, name },
  };
}

export async function platformPatchOrg(
  input: OrgPatchInput,
  actor: PlatformOpsActor
): Promise<OrgPatchSuccess> {
  const { orgId, name: newName } = input;

  if (isDemoMode()) {
    const previousName = DEMO_ORG.name;
    DEMO_ORG.name = newName;
    return {
      orgId,
      previousName,
      newName,
      summaryJa: `デモ: ${previousName} → ${newName} に名称変更しました`,
    };
  }

  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const orgMeta = await getOrgMeta(orgId);
  const previousName = orgMeta.name;

  if (previousName === newName) {
    return {
      orgId,
      previousName,
      newName,
      summaryJa: `${previousName} は既にこの名称です（変更なし）`,
    };
  }

  const { error } = await admin
    .from("orgs")
    .update({
      name: newName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orgId);

  if (error) {
    throw new Error(error.message);
  }

  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    action: "admin.org_patch",
    purpose: "admin.org_patch",
    summary: `${previousName} → ${newName} に名称変更（プラットフォーム運用）`,
    metadata: {
      auditClass: "admin",
      previousName,
      newName,
      actorEmail: actor.email,
      actorUserId: actor.userId,
      adminAction: "rename_org",
    },
  });

  return {
    orgId,
    previousName,
    newName,
    summaryJa: `${previousName} → ${newName} に名称変更しました`,
  };
}
