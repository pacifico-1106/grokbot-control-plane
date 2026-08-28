import { NextResponse } from "next/server";
import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  deleteOrgProject,
  listOrgProjects,
  upsertOrgProject,
} from "@/lib/data";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const projects = await listOrgProjects(gate.orgId);
  return NextResponse.json({ ok: true, projects });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name || "").trim();
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });
  try {
    const project = await upsertOrgProject({
      orgId: gate.orgId,
      id: body.id ? String(body.id) : undefined,
      name,
      slug: body.slug ? String(body.slug) : undefined,
      description: body.description != null ? String(body.description) : "",
    });
    return NextResponse.json({ ok: true, project });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upsert_failed";
    const status = message === "cannot_delete_default" ? 400 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id_required" }, { status: 400 });
  try {
    const ok = await deleteOrgProject(gate.orgId, id);
    return NextResponse.json({ ok });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delete_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
