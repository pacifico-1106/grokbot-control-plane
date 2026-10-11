import { requireOrgAdminSession } from "@/lib/auth/require-org";
import {
  deleteOrgProject,
  listOrgProjects,
  upsertOrgProject,
} from "@/lib/data";
import { jsonUtf8 } from "@/lib/http/json-utf8";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const projects = await listOrgProjects(gate.orgId);
  return jsonUtf8({ ok: true, projects });
}

export async function PUT(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name || "").trim();
  if (!name) return jsonUtf8({ error: "name_required" }, { status: 400 });
  try {
    const project = await upsertOrgProject({
      orgId: gate.orgId,
      id: body.id ? String(body.id) : undefined,
      name,
      slug: body.slug ? String(body.slug) : undefined,
      description: body.description != null ? String(body.description) : "",
    });
    return jsonUtf8({ ok: true, project });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upsert_failed";
    // Another org's project id and an unknown id → the same 404 (no existence oracle).
    const status = message === "project_not_found" ? 404 : 400;
    return jsonUtf8({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (!id) return jsonUtf8({ error: "id_required" }, { status: 400 });
  try {
    const ok = await deleteOrgProject(gate.orgId, id);
    return jsonUtf8({ ok });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delete_failed";
    return jsonUtf8({ error: message }, { status: 400 });
  }
}
