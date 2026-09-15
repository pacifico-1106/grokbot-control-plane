import { NextResponse } from "next/server";
import { getSuperAdminAccess } from "@/lib/admin/access";
import { getOrgMeta } from "@/lib/data/org-context";
import { appendAuditEvent } from "@/lib/data";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isDemoMode } from "@/lib/mode";
import { DEMO_ORG } from "@/lib/demo-data";

export const runtime = "nodejs";

const ORG_NAME_MAX_LENGTH = 200;

/**
 * POST /api/admin/org-rename
 * Super admin only — rename an organization.
 * Does NOT require always_human approval — the Super Admin is the human deciding.
 * Requires audit log entry.
 */
export async function POST(req: Request) {
  const access = await getSuperAdminAccess();
  if (!access.allowed) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: access.reason === "unauthenticated" ? 401 : 403 }
    );
  }

  let body: { orgId?: string; newName?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 }
    );
  }

  const orgId = (body.orgId || "").trim();
  const newName = (body.newName || "").trim();
  const reason = (body.reason || "").trim();

  if (!orgId) {
    return NextResponse.json(
      { ok: false, error: "org_id_required" },
      { status: 400 }
    );
  }

  if (!newName) {
    return NextResponse.json(
      { ok: false, error: "name_required" },
      { status: 400 }
    );
  }

  if (newName.length > ORG_NAME_MAX_LENGTH) {
    return NextResponse.json(
      { ok: false, error: "name_too_long" },
      { status: 400 }
    );
  }

  try {
    let previousName: string;
    
    if (isDemoMode()) {
      previousName = DEMO_ORG.name;
      DEMO_ORG.name = newName;
    } else {
      const admin = createSupabaseAdminClient();
      if (!admin) {
        return NextResponse.json(
          { ok: false, error: "supabase_not_configured" },
          { status: 500 }
        );
      }

      const orgMeta = await getOrgMeta(orgId);
      previousName = orgMeta.name;

      if (previousName === newName) {
        return NextResponse.json({
          ok: true,
          noChange: true,
          previousName,
          newName,
        });
      }

      const { error } = await admin
        .from("orgs")
        .update({
          name: newName,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orgId);

      if (error) {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }
    }

    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      action: "admin.org_patch",
      purpose: null,
      summary: `組織名を変更しました（${previousName} → ${newName}）`,
      metadata: {
        adminAction: "rename_org",
        adminEmail: access.actor.email,
        previousName,
        newName,
        reason: reason || null,
      },
    });

    return NextResponse.json({
      ok: true,
      previousName,
      newName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
