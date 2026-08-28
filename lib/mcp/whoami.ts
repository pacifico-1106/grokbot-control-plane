/**
 * staffpass_whoami payload. Badge voice always; no conversation so the
 * polite external floor is noted, not applied.
 */
import { WHOAMI_VOICE_NOTE_JA, normalizeVoice } from "@/lib/employees/voice";
import {
  accessibleProjects,
  normalizeProjectAccess,
} from "@/lib/employees/project-access";
import type { Employee, EmployeeBinding, OrgProject } from "@/lib/types";

export function buildStaffpassWhoamiPayload(input: {
  employee: Employee;
  orgId: string;
  binding?: Pick<
    EmployeeBinding,
    "status" | "credentialGeneration" | "grokBotAgentId"
  > | null;
  generation?: number;
  projects?: OrgProject[];
  defaultProjectId?: string;
}): Record<string, unknown> {
  const { employee, orgId, binding } = input;
  const status = binding?.status ?? "unlinked";
  const projectAccess = normalizeProjectAccess(employee.projectAccess);
  const defaultProjectId =
    input.defaultProjectId ||
    input.projects?.find((item) => item.isDefault)?.id ||
    "";
  const resolvedProjects =
    input.projects && defaultProjectId
      ? accessibleProjects(employee, input.projects, defaultProjectId).map((item) => ({
          id: item.id,
          slug: item.slug,
          name: item.name,
          isDefault: item.isDefault,
        }))
      : undefined;
  return {
    ok: true,
    employeeId: employee.id,
    displayName: employee.displayName,
    roleLabel: employee.roleLabel,
    orgId: orgId || employee.orgId,
    status: employee.status,
    bindingStatus: status,
    generation: binding?.credentialGeneration ?? input.generation ?? 0,
    scopes: employee.scopes,
    allowedPurposes: employee.allowedPurposes,
    approvalPolicy: employee.approvalPolicy,
    grokBotAgentId: binding?.grokBotAgentId ?? null,
    voice: normalizeVoice(employee.voice),
    voiceNoteJa: WHOAMI_VOICE_NOTE_JA,
    projectAccess,
    ...(resolvedProjects ? { projects: resolvedProjects } : {}),
    messageJa:
      status === "needs_reauth"
        ? "要再連携 — invoke は拒否されます"
        : status === "linked"
          ? "連携済み"
          : "未連携または実行不可",
  };
}
