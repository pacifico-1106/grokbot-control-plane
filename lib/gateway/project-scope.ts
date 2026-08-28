/**
 * Project wall (WHICH) composed with audience × class × voice.
 * Deny wins over allow. Internal dest does not bypass.
 */
import { getInformationAsset } from "@/lib/data/directory";
import { ensureDefaultOrgProject, listOrgProjects } from "@/lib/data/projects";
import {
  PROJECT_SCOPE_DENIED_CODE,
  PROJECT_SCOPE_DENIED_MESSAGE_JA,
  employeeCanAccessAsset,
  normalizeProjectAccess,
} from "@/lib/employees/project-access";
import { collectAssetRefs } from "@/lib/gateway/information-class";
import { isAudienceGatedTool } from "@/lib/gateway/tools";
import type {
  Employee,
  EmployeeProjectAccess,
  GatewayInvokeRequest,
  OrgProject,
} from "@/lib/types";

export type ProjectScopeOk = {
  denied: false;
  checked: boolean;
  refs: string[];
  projectAccess: EmployeeProjectAccess;
  defaultProjectId: string;
  projects: OrgProject[];
};

export type ProjectScopeDenied = {
  denied: true;
  checked: true;
  code: typeof PROJECT_SCOPE_DENIED_CODE;
  messageJa: string;
  refs: string[];
  projectAccess: EmployeeProjectAccess;
  defaultProjectId: string;
};

export type ProjectScopeVerdict = ProjectScopeOk | ProjectScopeDenied;

export function isProjectScopedTool(tool: string): boolean {
  return tool === "knowledge.search" || tool === "files.read" || isAudienceGatedTool(tool);
}

export async function evaluateProjectScope(input: {
  orgId: string;
  employee: Employee;
  tool: string;
  body: GatewayInvokeRequest;
}): Promise<ProjectScopeVerdict> {
  const projectAccess = normalizeProjectAccess(input.employee.projectAccess);
  if (!isProjectScopedTool(input.tool)) {
    return {
      denied: false,
      checked: false,
      refs: [],
      projectAccess,
      defaultProjectId: "",
      projects: [],
    };
  }
  const defaultProject = await ensureDefaultOrgProject(input.orgId);
  const projects = await listOrgProjects(input.orgId);
  const args =
    input.body.args && typeof input.body.args === "object"
      ? (input.body.args as Record<string, unknown>)
      : {};
  const refs = collectAssetRefs(args);
  if (!refs.length) {
    return {
      denied: false,
      checked: true,
      refs,
      projectAccess,
      defaultProjectId: defaultProject.id,
      projects,
    };
  }
  for (const ref of refs) {
    const asset = await getInformationAsset(input.orgId, ref);
    if (!employeeCanAccessAsset(input.employee, asset, defaultProject.id)) {
      return {
        denied: true,
        checked: true,
        code: PROJECT_SCOPE_DENIED_CODE,
        messageJa: PROJECT_SCOPE_DENIED_MESSAGE_JA,
        refs,
        projectAccess,
        defaultProjectId: defaultProject.id,
      };
    }
  }
  return {
    denied: false,
    checked: true,
    refs,
    projectAccess,
    defaultProjectId: defaultProject.id,
    projects,
  };
}
