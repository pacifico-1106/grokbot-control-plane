/**
 * Project knowledge walls (WHICH) on the employee badge.
 * Fourth axis: WHO (audience) × WHAT (class) × HOW (voice) × WHICH (project).
 * Fail-closed. Default hire access is company-wide general knowledge only.
 */
import type {
  Employee,
  EmployeeProjectAccess,
  InformationAsset,
  OrgProject,
  ProjectAccessMode,
} from "@/lib/types";

export const COMPANY_PROJECT_SLUG = "company";
export const COMPANY_PROJECT_NAME_JA = "会社全般";

export const DEFAULT_PROJECT_ACCESS: EmployeeProjectAccess = {
  mode: "company",
  projectIds: [],
};

export const PROJECT_SCOPE_DENIED_CODE = "project_scope_denied";
export const PROJECT_SCOPE_DENIED_MESSAGE_JA =
  "この社員のプロジェクト範囲外のナレッジです。";

export const PROJECT_ACCESS_HELPER_JA =
  "デフォルトは会社全般です。他案件のナレッジは社内にも出しません。";

export const PROJECT_ACCESS_MODE_LABELS_JA: Record<ProjectAccessMode, string> = {
  company: "会社全般",
  selected: "指定プロジェクト",
  all: "すべて",
};

const MODES: ProjectAccessMode[] = ["company", "selected", "all"];

function isMode(value: unknown): value is ProjectAccessMode {
  return typeof value === "string" && MODES.includes(value as ProjectAccessMode);
}

export function defaultProjectAccess(): EmployeeProjectAccess {
  return { mode: "company", projectIds: [] };
}

export function normalizeProjectAccess(value: unknown): EmployeeProjectAccess {
  if (!value || typeof value !== "object") return defaultProjectAccess();
  const rec = value as Record<string, unknown>;
  const mode = isMode(rec.mode) ? rec.mode : "company";
  const raw = rec.projectIds ?? rec.project_ids;
  const projectIds: string[] = [];
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    for (const item of raw) {
      const id = String(item ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      projectIds.push(id);
    }
  }
  if (mode !== "selected") {
    return { mode, projectIds: [] };
  }
  return { mode: "selected", projectIds };
}

export function employeeCanAccessProject(
  employee: Pick<Employee, "projectAccess"> | { projectAccess?: EmployeeProjectAccess | null },
  projectId: string,
  defaultProjectId: string
): boolean {
  const access = normalizeProjectAccess(employee.projectAccess);
  const id = projectId.trim();
  if (access.mode === "all") return true;
  if (!id) return false;
  if (access.mode === "company") return id === defaultProjectId;
  return access.projectIds.includes(id);
}

/**
 * Unknown / missing asset: deny unless mode=all (class/voice may still apply).
 * Null projectId on a known asset → org default 会社全般.
 */
export function employeeCanAccessAsset(
  employee: Pick<Employee, "projectAccess"> | { projectAccess?: EmployeeProjectAccess | null },
  asset: Pick<InformationAsset, "projectId"> | null | undefined,
  defaultProjectId: string
): boolean {
  const access = normalizeProjectAccess(employee.projectAccess);
  if (!asset) return access.mode === "all";
  const projectId = asset.projectId?.trim() || defaultProjectId;
  return employeeCanAccessProject(employee, projectId, defaultProjectId);
}

/** When entering selected mode, include 会社全般 unless Staffpass turned it off. */
export function defaultSelectedProjectIds(
  defaultProjectId: string,
  current?: EmployeeProjectAccess | null
): string[] {
  const access = normalizeProjectAccess(current);
  if (access.mode === "selected") {
    return access.projectIds.length ? access.projectIds : [defaultProjectId];
  }
  return [defaultProjectId];
}

export function accessibleProjects(
  employee: Pick<Employee, "projectAccess">,
  projects: OrgProject[],
  defaultProjectId: string
): OrgProject[] {
  return projects.filter((project) =>
    employeeCanAccessProject(employee, project.id, defaultProjectId)
  );
}
