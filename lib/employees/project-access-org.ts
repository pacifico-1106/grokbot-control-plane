/**
 * project_access.projectIds must name projects of the SAME org as the employee
 * being written (木村 2026-10-05 #284 decision 4). Any id that is not — another
 * org's, unknown, deleted or moved — refuses the whole write: nothing is
 * written, ONE audit row with IDs only, Japanese nextStep. Checked inside the
 * data writers (issueEmployee / updateEmployeePolicy), so every caller is
 * covered; the Admin MCP queue also checks at filing. Stricter-only, no flag.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { getOrgProject } from "@/lib/data/projects";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { normalizeProjectAccess } from "./project-access";

export const PROJECT_ACCESS_CROSS_ORG = "project_access_cross_org";
export const PROJECT_ACCESS_UNVERIFIED = "project_access_unverified";
export type ProjectAccessOrgCode = typeof PROJECT_ACCESS_CROSS_ORG | typeof PROJECT_ACCESS_UNVERIFIED;
export const PROJECT_ACCESS_REFUSED_AUDIT_ACTION = "employee.project_access_refused";

export const PROJECT_ACCESS_ORG_MESSAGES_JA: Record<ProjectAccessOrgCode, { message: string; nextStep: string }> = {
  project_access_cross_org: {
    message: "指定したプロジェクトの一部がこの組織にありません（他の組織のもの・存在しない・削除済みのいずれか）。",
    nextStep:
      "何も保存・発行していません。プロジェクト一覧でこの組織のプロジェクトの ID を確認し、この組織のプロジェクトだけを指定してやり直してください。",
  },
  project_access_unverified: {
    message: "プロジェクトの所属を確認できませんでした。",
    nextStep: "何も保存・発行していません。少し時間をおいてから、この組織のプロジェクトを指定してもう一度お試しください。",
  },
};

export type ProjectAccessAuditContext = {
  /** Which write path, e.g. "web.employees.issue", "admin_mcp.employees.issue". */
  path: string;
  phase?: "write" | "file" | "fulfil";
  employeeId?: string | null;
  approvalId?: string | null;
  credentialId?: string | null;
  actorEmail?: string | null;
};

export class ProjectAccessOrgError extends Error {
  readonly code: ProjectAccessOrgCode;
  readonly refusedProjectIds: string[];
  constructor(code: ProjectAccessOrgCode, refusedProjectIds: string[]) {
    super(code);
    this.name = "ProjectAccessOrgError";
    this.code = code;
    this.refusedProjectIds = refusedProjectIds;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids (in request order) that are not a project of `orgId`. Lookup error → { ok: false } (fail closed). */
export async function findProjectIdsOutsideOrg(
  orgId: string,
  projectIds: string[]
): Promise<{ ok: true; outside: string[] } | { ok: false }> {
  if (!projectIds.length) return { ok: true, outside: [] };
  if (!orgId) return { ok: true, outside: [...projectIds] };
  if (isDemoMode()) {
    const outside: string[] = [];
    for (const id of projectIds) if (!(await getOrgProject(orgId, id))) outside.push(id);
    return { ok: true, outside };
  }
  const candidates = projectIds.filter((id) => UUID.test(id));
  let found = new Set<string>();
  if (candidates.length) {
    const admin = createSupabaseAdminClient();
    if (!admin) return { ok: false };
    try {
      const { data, error } = await admin.from("org_projects").select("id").eq("org_id", orgId).in("id", candidates);
      if (error) return { ok: false };
      found = new Set((data ?? []).map((r) => String((r as { id: unknown }).id).toLowerCase()));
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, outside: projectIds.filter((id) => !found.has(id.toLowerCase())) };
}

/**
 * Refuse (audit once, throw ProjectAccessOrgError) unless every projectId of a
 * "selected" access is a project of `orgId`. Other modes carry no ids → pass.
 */
export async function assertProjectAccessSameOrg(input: {
  orgId: string;
  projectAccess: unknown;
  audit: ProjectAccessAuditContext;
}): Promise<void> {
  if (input.projectAccess === undefined || input.projectAccess === null) return;
  const access = normalizeProjectAccess(input.projectAccess);
  if (access.mode !== "selected" || !access.projectIds.length) return;
  const check = await findProjectIdsOutsideOrg(input.orgId, access.projectIds);
  const code: ProjectAccessOrgCode | null = !check.ok
    ? PROJECT_ACCESS_UNVERIFIED
    : check.outside.length
      ? PROJECT_ACCESS_CROSS_ORG
      : null;
  if (!code) return;
  const refused = check.ok ? check.outside : [];
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.audit.employeeId ?? null,
    credentialId: input.audit.credentialId ?? null,
    ...(input.audit.actorEmail ? { actorEmail: input.audit.actorEmail } : {}),
    action: PROJECT_ACCESS_REFUSED_AUDIT_ACTION,
    purpose: null,
    summary:
      code === PROJECT_ACCESS_CROSS_ORG
        ? "この組織のものではないプロジェクトが指定されたため、プロジェクト範囲を保存しなかった"
        : "プロジェクトの所属を確認できなかったため、プロジェクト範囲を保存しなかった",
    metadata: {
      reason: code,
      path: input.audit.path,
      phase: input.audit.phase ?? "write",
      ...(input.audit.approvalId ? { approvalId: input.audit.approvalId } : {}),
      refusedProjectIds: refused.slice(0, 50),
      refusedCount: refused.length,
      requestedCount: access.projectIds.length,
    },
  }).catch(() => undefined);
  throw new ProjectAccessOrgError(code, refused);
}

export function projectAccessRefusalBody(error: ProjectAccessOrgError): {
  ok: false; code: ProjectAccessOrgCode; error: ProjectAccessOrgCode; message: string; nextStep: string; refusedProjectIds: string[];
} {
  const text = PROJECT_ACCESS_ORG_MESSAGES_JA[error.code];
  return { ok: false, code: error.code, error: error.code, message: text.message, nextStep: text.nextStep, refusedProjectIds: error.refusedProjectIds };
}

export function projectAccessRefusalStatus(error: ProjectAccessOrgError): number {
  return error.code === PROJECT_ACCESS_UNVERIFIED ? 503 : 400;
}
