import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  listInformationAssets,
  listOrgChannels,
  listOrgParties,
  upsertInformationAsset,
} from "@/lib/data";
import type { InformationClass } from "@/lib/types";
import { DASHBOARD_DIRECTORY_LOCKED_JA } from "@/lib/dashboard/policy-lock";
import {
  ProjectAccessOrgError,
  projectAccessRefusalBody,
  projectAccessRefusalStatus,
} from "@/lib/employees/project-access-org";

function directoryLocked() {
  return NextResponse.json(
    { error: "directory_admin_mcp_required", message: DASHBOARD_DIRECTORY_LOCKED_JA },
    { status: 403 }
  );
}

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const [parties, channels, assets] = await Promise.all([
    listOrgParties(gate.orgId),
    listOrgChannels(gate.orgId),
    listInformationAssets(gate.orgId),
  ]);
  return NextResponse.json({ ok: true, parties, channels, assets });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.record || body.type || "");
  try {
    if (kind === "party" || kind === "channel") {
      return directoryLocked();
    }
    if (kind === "asset") {
      const ref = String(body.ref || "").trim();
      const infoClass = String(body.class || "confidential") as InformationClass;
      if (!ref) return NextResponse.json({ error: "ref_required" }, { status: 400 });
      const projectId =
        body.projectId === undefined || body.projectId === null
          ? body.projectId === undefined
            ? undefined
            : null
          : String(body.projectId);
      const asset = await upsertInformationAsset({
        orgId: gate.orgId,
        ref,
        class: infoClass,
        projectId,
        projectAudit: { path: "web.settings.directory", actorEmail: gate.email },
      });
      return NextResponse.json({ ok: true, asset });
    }
    return NextResponse.json({ error: "invalid_record" }, { status: 400 });
  } catch (error) {
    if (error instanceof ProjectAccessOrgError) {
      return NextResponse.json(projectAccessRefusalBody(error), { status: projectAccessRefusalStatus(error) });
    }
    const message = error instanceof Error ? error.message : "upsert_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const record = url.searchParams.get("record") || "";
  const id = url.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
  if (record === "channel" || record === "party" || record === "") {
    return directoryLocked();
  }
  return NextResponse.json({ error: "invalid_record" }, { status: 400 });
}
