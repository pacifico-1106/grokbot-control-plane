/**
 * Org projects (WHICH). Dual DEMO in-memory + Supabase.
 * Always ensure a default 会社全般 project. Default cannot be deleted.
 */
import { DEMO_ORG } from "@/lib/demo-data";
import {
  COMPANY_PROJECT_NAME_JA,
  COMPANY_PROJECT_SLUG,
} from "@/lib/employees/project-access";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type { OrgProject } from "@/lib/types";

function nowIso(): string {
  return new Date().toISOString();
}

function demoId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const DEMO_COMPANY_PROJECT_ID = "prj_company";
export const DEMO_PROJECT_A_ID = "prj_project_a";

const runtimeProjects: OrgProject[] = [
  {
    id: DEMO_COMPANY_PROJECT_ID,
    orgId: DEMO_ORG.id,
    slug: COMPANY_PROJECT_SLUG,
    name: COMPANY_PROJECT_NAME_JA,
    description: "組織全体の一般ナレッジ。新規雇用の既定範囲です。",
    isDefault: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: DEMO_PROJECT_A_ID,
    orgId: DEMO_ORG.id,
    slug: "project-a",
    name: "新規事業A",
    description: "デモ用の指名プロジェクト。会社全般とは別壁です。",
    isDefault: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

function mapProjectRow(row: Record<string, unknown>): OrgProject {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    slug: String(row.slug ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

function slugFromName(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `project-${Date.now().toString(36)}`;
}

export async function ensureDefaultOrgProject(orgId: string): Promise<OrgProject> {
  if (!orgId) throw new Error("org_id_required");
  if (isDemoMode()) {
    const existing = runtimeProjects.find((row) => row.orgId === orgId && row.isDefault);
    if (existing) return existing;
    const row: OrgProject = {
      id: demoId("prj"),
      orgId,
      slug: COMPANY_PROJECT_SLUG,
      name: COMPANY_PROJECT_NAME_JA,
      description: "",
      isDefault: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    runtimeProjects.unshift(row);
    return row;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data: found } = await admin
    .from("org_projects")
    .select("*")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (found) return mapProjectRow(found as Record<string, unknown>);
  const { data, error } = await admin
    .from("org_projects")
    .upsert(
      {
        org_id: orgId,
        slug: COMPANY_PROJECT_SLUG,
        name: COMPANY_PROJECT_NAME_JA,
        description: "",
        is_default: true,
        updated_at: nowIso(),
      },
      { onConflict: "org_id,slug" }
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "default_project_ensure_failed");
  return mapProjectRow(data as Record<string, unknown>);
}

export async function listOrgProjects(orgId?: string | null): Promise<OrgProject[]> {
  if (!orgId) return [];
  await ensureDefaultOrgProject(orgId);
  if (isDemoMode()) {
    return runtimeProjects
      .filter((row) => row.orgId === orgId)
      .slice()
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name, "ja"));
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("org_projects")
    .select("*")
    .eq("org_id", orgId)
    .order("is_default", { ascending: false })
    .order("name");
  if (error || !data) return [];
  return data.map((row) => mapProjectRow(row as Record<string, unknown>));
}

export async function getOrgProject(orgId: string, id: string): Promise<OrgProject | null> {
  if (!orgId || !id) return null;
  if (isDemoMode()) {
    return runtimeProjects.find((row) => row.orgId === orgId && row.id === id) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("org_projects")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return mapProjectRow(data as Record<string, unknown>);
}

export async function getDefaultOrgProject(orgId: string): Promise<OrgProject | null> {
  if (!orgId) return null;
  try {
    return await ensureDefaultOrgProject(orgId);
  } catch {
    return null;
  }
}

export async function upsertOrgProject(input: {
  orgId: string;
  id?: string;
  name: string;
  slug?: string;
  description?: string;
}): Promise<OrgProject> {
  const name = input.name.trim();
  if (!name) throw new Error("name_required");
  const description = (input.description ?? "").trim();
  if (isDemoMode()) {
    if (input.id) {
      const existing = runtimeProjects.find((row) => row.id === input.id && row.orgId === input.orgId);
      if (!existing) throw new Error("project_not_found");
      existing.name = existing.isDefault ? COMPANY_PROJECT_NAME_JA : name;
      existing.description = description;
      if (!existing.isDefault && input.slug?.trim()) {
        const slug = slugFromName(input.slug);
        const clash = runtimeProjects.find(
          (row) => row.orgId === input.orgId && row.slug === slug && row.id !== existing.id
        );
        if (clash) throw new Error("slug_taken");
        existing.slug = slug;
      }
      existing.updatedAt = nowIso();
      return existing;
    }
    let slug = slugFromName(input.slug?.trim() || name);
    const taken = new Set(
      runtimeProjects.filter((row) => row.orgId === input.orgId).map((row) => row.slug)
    );
    if (taken.has(slug)) {
      let n = 2;
      while (taken.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    const row: OrgProject = {
      id: demoId("prj"),
      orgId: input.orgId,
      slug,
      name,
      description,
      isDefault: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    runtimeProjects.unshift(row);
    return row;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  if (input.id) {
    const current = await getOrgProject(input.orgId, input.id);
    if (!current) throw new Error("project_not_found");
    const patch: Record<string, unknown> = {
      name: current.isDefault ? COMPANY_PROJECT_NAME_JA : name,
      description,
      updated_at: nowIso(),
    };
    if (!current.isDefault && input.slug?.trim()) patch.slug = slugFromName(input.slug);
    const { data, error } = await admin
      .from("org_projects")
      .update(patch)
      .eq("id", input.id)
      .eq("org_id", input.orgId)
      .select("*")
      .single();
    if (error || !data) throw new Error(error?.message || "project_update_failed");
    return mapProjectRow(data as Record<string, unknown>);
  }
  let slug = slugFromName(input.slug?.trim() || name);
  const { data: existingSlug } = await admin
    .from("org_projects")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("slug", slug)
    .maybeSingle();
  if (existingSlug) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }
  const { data, error } = await admin
    .from("org_projects")
    .insert({
      org_id: input.orgId,
      slug,
      name,
      description,
      is_default: false,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "project_insert_failed");
  return mapProjectRow(data as Record<string, unknown>);
}

export async function deleteOrgProject(orgId: string, id: string): Promise<boolean> {
  if (!orgId || !id) return false;
  if (isDemoMode()) {
    const idx = runtimeProjects.findIndex((row) => row.id === id && row.orgId === orgId);
    if (idx < 0) return false;
    if (runtimeProjects[idx].isDefault) throw new Error("cannot_delete_default");
    runtimeProjects.splice(idx, 1);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const current = await getOrgProject(orgId, id);
  if (!current) return false;
  if (current.isDefault) throw new Error("cannot_delete_default");
  const { error } = await admin.from("org_projects").delete().eq("id", id).eq("org_id", orgId);
  return !error;
}
