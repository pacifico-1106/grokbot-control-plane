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
/** No org to check against (caller bug / lost session): refused before any lookup or audit. */
export const PROJECT_ACCESS_ORG_REQUIRED = "project_access_org_required";
export type ProjectAccessOrgCode =
  | typeof PROJECT_ACCESS_CROSS_ORG
  | typeof PROJECT_ACCESS_UNVERIFIED
  | typeof PROJECT_ACCESS_ORG_REQUIRED;
export const PROJECT_ACCESS_REFUSED_AUDIT_ACTION = "employee.project_access_refused";
/** information_assets.project_id refused (web settings/directory and any other caller of upsertInformationAsset). */
export const ASSET_PROJECT_REFUSED_AUDIT_ACTION = "information_asset.project_refused";

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
  project_access_org_required: {
    message: "組織を特定できなかったため、プロジェクトの所属を確認できませんでした。",
    nextStep: "何も保存・発行していません。ログインし直す（または組織を選び直す）してから、もう一度お試しください。",
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
  // Up front: no org → nothing to check against and no org to audit under.
  const orgId = (input.orgId || "").trim();
  if (!orgId) throw new ProjectAccessOrgError(PROJECT_ACCESS_ORG_REQUIRED, []);
  const check = await findProjectIdsOutsideOrg(orgId, access.projectIds);
  const code: ProjectAccessOrgCode | null = !check.ok
    ? PROJECT_ACCESS_UNVERIFIED
    : check.outside.length
      ? PROJECT_ACCESS_CROSS_ORG
      : null;
  if (!code) return;
  const refused = check.ok ? check.outside : [];
  await appendAuditEvent({
    orgId,
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

/**
 * information_assets.project_id must be null (= 会社全般) or a project of
 * `orgId`. Same lookup, same codes, ONE audit row with IDs only (no asset ref,
 * no names). Stricter-only, no flag.
 */
export async function assertAssetProjectSameOrg(input: {
  orgId: string;
  projectId: string | null | undefined;
  audit: Pick<ProjectAccessAuditContext, "path" | "actorEmail">;
}): Promise<void> {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  if (!projectId) return;
  const orgId = (input.orgId || "").trim();
  if (!orgId) throw new ProjectAccessOrgError(PROJECT_ACCESS_ORG_REQUIRED, []);
  const check = await findProjectIdsOutsideOrg(orgId, [projectId]);
  const code: ProjectAccessOrgCode | null = !check.ok
    ? PROJECT_ACCESS_UNVERIFIED
    : check.outside.length
      ? PROJECT_ACCESS_CROSS_ORG
      : null;
  if (!code) return;
  const refused = check.ok ? check.outside : [];
  await appendAuditEvent({
    orgId,
    employeeId: null,
    credentialId: null,
    ...(input.audit.actorEmail ? { actorEmail: input.audit.actorEmail } : {}),
    action: ASSET_PROJECT_REFUSED_AUDIT_ACTION,
    purpose: null,
    summary:
      code === PROJECT_ACCESS_CROSS_ORG
        ? "この組織のものではないプロジェクトが指定されたため、情報資産のプロジェクトを保存しなかった"
        : "プロジェクトの所属を確認できなかったため、情報資産のプロジェクトを保存しなかった",
    metadata: {
      reason: code,
      path: input.audit.path,
      refusedProjectIds: refused,
      refusedCount: refused.length,
    },
  }).catch(() => undefined);
  throw new ProjectAccessOrgError(code, refused);
}

/** How many refused ids the nextStep spells out (the rest are counted). */
const NEXT_STEP_MAX_IDS = 20;
/** Each listed id is cut to this many characters (+ "…"); a uuid (36) is never cut. */
const NEXT_STEP_ID_MAX_CHARS = 40;
function shortId(id: string): string {
  const chars = Array.from(id);
  return chars.length > NEXT_STEP_ID_MAX_CHARS ? `${chars.slice(0, NEXT_STEP_ID_MAX_CHARS).join("")}…` : id;
}

/**
 * Japanese nextStep. For a cross-org refusal it lists the project IDs to
 * remove (IDs only — the ids the caller sent; never a project name, which for
 * another org's project would leak that org's data).
 */
export function projectAccessRefusalNextStep(error: ProjectAccessOrgError): string {
  const text = PROJECT_ACCESS_ORG_MESSAGES_JA[error.code];
  if (error.code !== PROJECT_ACCESS_CROSS_ORG || !error.refusedProjectIds.length) return text.nextStep;
  const shown = error.refusedProjectIds.slice(0, NEXT_STEP_MAX_IDS).map(shortId);
  const rest = error.refusedProjectIds.length - shown.length;
  return `何も保存・発行していません。この組織のプロジェクトではない ID: ${shown.join("、")}${rest > 0 ? ` ほか ${rest} 件` : ""}。これらのプロジェクト ID を除いて保存し直してください。`;
}

export function projectAccessRefusalBody(error: ProjectAccessOrgError): {
  ok: false; code: ProjectAccessOrgCode; error: ProjectAccessOrgCode; message: string; nextStep: string; refusedProjectIds: string[];
} {
  const text = PROJECT_ACCESS_ORG_MESSAGES_JA[error.code];
  return {
    ok: false, code: error.code, error: error.code, message: text.message,
    nextStep: projectAccessRefusalNextStep(error), refusedProjectIds: error.refusedProjectIds,
  };
}

export function projectAccessRefusalStatus(error: ProjectAccessOrgError): number {
  return error.code === PROJECT_ACCESS_UNVERIFIED ? 503 : 400; // cross_org / org_required → 400
}
