/**
 * staffpass_whoami payload. Badge voice always; no conversation so the
 * polite external floor is noted, not applied.
 */
import { WHOAMI_VOICE_NOTE_JA, normalizeVoice } from "@/lib/employees/voice";
import {
  accessibleProjects,
  normalizeProjectAccess,
} from "@/lib/employees/project-access";
import { credentialExpiry } from "@/lib/employees/credential-expiry";
import type { Employee, EmployeeBinding, OrgProject } from "@/lib/types";

export type WhoamiCredentialKind = "gb_emp" | "oauth";

export type WhoamiCredentialInfo = {
  kind: WhoamiCredentialKind;
  expiresAt: string | null;
  orgName: string | null;
  now?: Date;
};

export function formatWhoamiExpiryDateJa(expiresAt: string): string | null {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value])
  );
  const year = parts.year;
  const month = parts.month;
  const day = parts.day;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

export function whoamiExpiringSoonNextStepJa(expiresAt: string): string | null {
  const ymd = formatWhoamiExpiryDateJa(expiresAt);
  if (!ymd) return null;
  return `社員証の期限が近づいています（${ymd} まで）。管理者に再発行を依頼してください。`;
}

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
  /**
   * config.change_request (flag ON only): the human-approved Instructions
   * overlay and the self-change rule. Omitted entirely when the flag is OFF.
   */
  configChange?: {
    ruleJa: string;
    approvedInstructions: { text: string; approvalId: string; appliedAt: string } | null;
  } | null;
  /**
   * WHOAMI_CREDENTIAL_INFO_ENABLED (flag ON only). Omitted entirely when OFF
   * so the JSON stays byte-identical to today.
   */
  credentialInfo?: WhoamiCredentialInfo | null;
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
  const payload: Record<string, unknown> = {
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
    ...(input.configChange
      ? {
          approvedInstructions: input.configChange.approvedInstructions,
          configChangeRuleJa: input.configChange.ruleJa,
        }
      : {}),
    messageJa:
      status === "needs_reauth"
        ? "要再連携 — invoke は拒否されます"
        : status === "linked"
          ? "連携済み"
          : "未連携または実行不可",
  };
  const info = input.credentialInfo;
  if (!info) return payload;
  payload.credential = { kind: info.kind, expiresAt: info.expiresAt };
  payload.org = { name: info.orgName };
  if (info.expiresAt) {
    const expiry = credentialExpiry(
      { credentialId: "whoami", credentialExpiresAt: info.expiresAt },
      info.now ?? new Date()
    );
    if (expiry.state === "expiring" || expiry.state === "expired") {
      const nextStepJa = whoamiExpiringSoonNextStepJa(info.expiresAt);
      if (nextStepJa) {
        payload.expiringSoon = true;
        payload.nextStepJa = nextStepJa;
      }
    }
  }
  return payload;
}
