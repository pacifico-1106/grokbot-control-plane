/**
 * PR-D: classify a ticket at filing (createApproval). Flag OFF → null (no change).
 */
import { isApproverAuthorityEnabled } from "@/lib/feature-flags";
import { getEmployee } from "@/lib/data/employees";
import {
  classifyApproverRequirement,
  isApproverAuthorityTargetTool,
  type ApproverClassificationContext,
  requiredApprovalCount,
  schedulingCostCapsSignature,
  type ApproverRequirement,
} from "./targets";
import { requesterMemberIdsFromMetadata, type ApproverAuthorityDenyReason } from "./decide";
import { checkApproverAuthority } from "./verify";
import { approverAuthorityNextStepJa, approverAuthorityReplyJa } from "./card";

function employeeIdOf(metadata: Record<string, unknown> | null | undefined): string {
  const mutation = metadata?.adminMutation;
  if (!mutation || typeof mutation !== "object") return "";
  const id = (mutation as Record<string, unknown>).employeeId;
  return typeof id === "string" ? id.trim() : "";
}

/** Server-side state for content rules. Read failure → null (rules then go to owner). */
async function loadContext(
  orgId: string,
  tool: string,
  metadata: Record<string, unknown> | null | undefined
): Promise<ApproverClassificationContext | null> {
  if (tool === "schedulingPolicy.patch") return loadSchedulingContext(orgId, metadata);
  if (tool !== "policy.patch" && tool !== "employees.reinstate") return null;
  const employeeId = employeeIdOf(metadata);
  if (!employeeId) return null;
  try {
    const employee = await getEmployee(employeeId, orgId);
    if (!employee || employee.orgId !== orgId) return null;
    return {
      currentEmployeeScopes: [...(employee.scopes ?? [])],
      currentEmployeeApprovalPolicy: employee.approvalPolicy ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * schedulingPolicy.patch: cost caps in force now and after clearOverride.
 * Read with error checks (the storage helpers fall back to the default policy
 * on a failed read, which would hide a cap) — any read error → null (→ owner).
 */
async function loadSchedulingContext(
  orgId: string,
  metadata: Record<string, unknown> | null | undefined
): Promise<ApproverClassificationContext | null> {
  try {
    const employeeId = employeeIdOf(metadata) || null;
    const { defaultSchedulingPolicy, normalizeSchedulingPolicy } = await import("@/lib/scheduling-policy/validate");
    const { isDemoMode } = await import("@/lib/mode");
    let orgPolicy: { rules?: unknown } | null;
    let employeePolicy: { rules?: unknown } | null = null;
    if (isDemoMode()) {
      const { getEffectiveSchedulingPolicy } = await import("@/lib/data/scheduling-policy");
      const effective = await getEffectiveSchedulingPolicy(orgId, employeeId);
      orgPolicy = effective.orgPolicy;
      employeePolicy = effective.employeeOverride;
    } else {
      const { createSupabaseAdminClient } = await import("@/lib/supabase");
      const admin = createSupabaseAdminClient();
      if (!admin) return null;
      const org = await admin.from("orgs").select("scheduling_policy").eq("id", orgId).maybeSingle();
      if (org.error || !org.data) return null;
      const rawOrg = (org.data as { scheduling_policy?: unknown }).scheduling_policy;
      orgPolicy = rawOrg ? normalizeSchedulingPolicy(rawOrg) : null;
      if (employeeId) {
        const emp = await admin.from("employees").select("scheduling_policy").eq("id", employeeId).eq("org_id", orgId).maybeSingle();
        if (emp.error || !emp.data) return null;
        const rawEmp = (emp.data as { scheduling_policy?: unknown }).scheduling_policy;
        employeePolicy = rawEmp ? normalizeSchedulingPolicy(rawEmp) : null;
      }
    }
    const inherited = orgPolicy ?? defaultSchedulingPolicy();
    return {
      schedulingCostCaps: {
        current: schedulingCostCapsSignature(employeePolicy ?? inherited),
        ifCleared: schedulingCostCapsSignature(inherited),
      },
    };
  } catch {
    return null;
  }
}

export async function approverRequirementForFiling(input: {
  orgId: string;
  tool: string | null | undefined;
  metadata?: Record<string, unknown> | null;
}): Promise<(ApproverRequirement & { requiredApprovals: number }) | null> {
  if (!isApproverAuthorityEnabled()) return null;
  const tool = (input.tool || "").trim();
  if (!isApproverAuthorityTargetTool(tool)) return null;
  const context = await loadContext(input.orgId, tool, input.metadata);
  const requirement = classifyApproverRequirement({ tool, metadata: input.metadata ?? null, context });
  return requirement ? { ...requirement, requiredApprovals: requiredApprovalCount({ kind: requirement.kind, tool }) } : null;
}

/** Reasons that make a ticket impossible to satisfy, so filing stops up front. */
const FILING_STOP_REASONS: ReadonlySet<ApproverAuthorityDenyReason> = new Set([
  "org_has_no_owner",
  "no_owner_other_than_requester",
]);

export interface ApproverFilingStop {
  reason: "org_has_no_owner" | "no_owner_other_than_requester";
  requiredApproverKind: ApproverRequirement["kind"];
  messageJa: string;
  nextStepJa: string;
}

/**
 * Stop filing when nobody other than the requester could ever approve it
 * (zero active owners, or every owner is the requester — 八坂 2026-10-05:
 * with several owners any one owner other than the requester suffices).
 * Flag OFF / not a target / verification read failure → null (the approval-time
 * and fulfil checks still fail closed).
 */
export async function approverFilingStop(input: {
  orgId: string;
  tool: string | null | undefined;
  metadata?: Record<string, unknown> | null;
}): Promise<ApproverFilingStop | null> {
  const requirement = await approverRequirementForFiling(input);
  if (!requirement) return null;
  const decision = await checkApproverAuthority({
    orgId: input.orgId,
    memberId: null,
    requiredKind: requirement.kind,
    requesterMemberIds: requesterMemberIdsFromMetadata(input.metadata),
  });
  if (decision.outcome !== "deny" || !FILING_STOP_REASONS.has(decision.reason)) return null;
  const reason = decision.reason as ApproverFilingStop["reason"];
  return {
    reason,
    requiredApproverKind: requirement.kind,
    messageJa: approverAuthorityReplyJa(reason) ?? reason,
    nextStepJa: approverAuthorityNextStepJa(reason) ?? "",
  };
}
