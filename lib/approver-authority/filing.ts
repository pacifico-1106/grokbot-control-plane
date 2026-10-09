/**
 * PR-D: classify a ticket at filing (createApproval). Flag OFF → null (no change).
 */
import { createHash } from "node:crypto";
import { isApproverAuthorityEnabled } from "@/lib/feature-flags";
import { getEmployee } from "@/lib/data/employees";
import {
  classifyApproverRequirement,
  isApproverAuthorityTargetTool,
  type ApproverClassificationContext,
  requiredApprovalCount,
  schedulingRulesState,
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
export async function loadApproverClassificationContext(
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
      // Problem A: raw stored values (normalized by the classifier like the save path).
      currentEmployeeActionLimits: { ...((employee.actionLimits ?? {}) as Record<string, unknown>) },
      currentEmployeeToolApprovalDefaults: { ...((employee.toolApprovalDefaults ?? {}) as Record<string, unknown>) },
    };
  } catch {
    return null;
  }
}

/**
 * schedulingPolicy.patch: rules (and caps) in force now and after clearOverride.
 * Read with error checks (the storage helpers fall back to the default policy
 * on a failed read, which would hide a cap) — any read error → null (→ owner).
 * The built-in default gets a fixed rule id (defaultSchedulingPolicy() makes a
 * random one per call, which would look like a change at every read); a
 * stored policy with rules that no longer validate counts as unreadable.
 */
async function loadSchedulingContext(
  orgId: string,
  metadata: Record<string, unknown> | null | undefined
): Promise<ApproverClassificationContext | null> {
  try {
    const employeeId = employeeIdOf(metadata) || null;
    const { DEFAULT_SCHEDULING_RULE, normalizeSchedulingPolicy } = await import("@/lib/scheduling-policy/validate");
    const { isDemoMode } = await import("@/lib/mode");
    const strict = (raw: unknown): { rules?: unknown } | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const rawRules = (raw as { rules?: unknown }).rules;
      if (!Array.isArray(rawRules) || rawRules.length === 0) return null;
      const normalized = normalizeSchedulingPolicy(raw);
      if (normalized.rules.length !== rawRules.length) throw new Error("scheduling_policy_unreadable");
      return normalized;
    };
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
      orgPolicy = strict((org.data as { scheduling_policy?: unknown }).scheduling_policy);
      if (employeeId) {
        const emp = await admin.from("employees").select("scheduling_policy").eq("id", employeeId).eq("org_id", orgId).maybeSingle();
        if (emp.error || !emp.data) return null;
        employeePolicy = strict((emp.data as { scheduling_policy?: unknown }).scheduling_policy);
      }
    }
    const inherited = orgPolicy ?? { rules: [{ ...DEFAULT_SCHEDULING_RULE, id: "default" }] };
    return {
      schedulingRules: {
        current: schedulingRulesState(employeePolicy ?? inherited),
        ifCleared: schedulingRulesState(inherited),
      },
    };
  } catch {
    return null;
  }
}

/**
 * 木村 round 3 F2: tools whose classification depends on current state. The
 * state the ticket was judged on is stored at filing and compared right
 * before fulfil (verify.ts); a change in between → approver_context_changed.
 */
export const CONTEXT_PINNED_TOOLS: ReadonlySet<string> = new Set(["schedulingPolicy.patch", "policy.patch"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Key-sorted JSON so the fingerprint does not depend on stored key order. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
      : isPlainRecord(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sort(v[k])]))
      : v;
  return JSON.stringify(sort(value));
}

/** sha256 of the judged state; null = unreadable (never matches → fail closed). */
export function approverContextFingerprint(tool: string, context: ApproverClassificationContext | null): string | null {
  if (!context) return null;
  let material: string | null = null;
  if (tool === "schedulingPolicy.patch" && context.schedulingRules) {
    material = JSON.stringify(["scheduling", context.schedulingRules.current.rules, context.schedulingRules.ifCleared.rules]);
  } else if (tool === "policy.patch" && context.currentEmployeeScopes) {
    if (!isPlainRecord(context.currentEmployeeActionLimits) || !isPlainRecord(context.currentEmployeeToolApprovalDefaults)) return null;
    material = JSON.stringify([
      "policy",
      [...context.currentEmployeeScopes].sort(),
      context.currentEmployeeApprovalPolicy ?? null,
      // Problem A: money limits are part of the judged state too.
      canonicalJson(context.currentEmployeeActionLimits),
      canonicalJson(context.currentEmployeeToolApprovalDefaults),
    ]);
  }
  return material === null ? null : createHash("sha256").update(material).digest("hex");
}

export async function approverRequirementForFiling(input: {
  orgId: string;
  tool: string | null | undefined;
  metadata?: Record<string, unknown> | null;
}): Promise<(ApproverRequirement & { requiredApprovals: number; contextFingerprint?: string | null }) | null> {
  if (!isApproverAuthorityEnabled()) return null;
  const tool = (input.tool || "").trim();
  if (!isApproverAuthorityTargetTool(tool)) return null;
  const context = await loadApproverClassificationContext(input.orgId, tool, input.metadata);
  const requirement = classifyApproverRequirement({ tool, metadata: input.metadata ?? null, context });
  if (!requirement) return null;
  const out: ApproverRequirement & { requiredApprovals: number; contextFingerprint?: string | null } = {
    ...requirement,
    requiredApprovals: requiredApprovalCount({ kind: requirement.kind, tool }),
  };
  if (CONTEXT_PINNED_TOOLS.has(tool)) out.contextFingerprint = approverContextFingerprint(tool, context);
  return out;
}

/** Stored approver_authority jsonb for a new ticket. */
export function approverAuthorityRecordForFiling(
  requirement: ApproverRequirement & { requiredApprovals: number; contextFingerprint?: string | null }
): Record<string, unknown> {
  const record: Record<string, unknown> = { reasons: requirement.reasons, requiredApprovals: requirement.requiredApprovals };
  if (requirement.contextFingerprint !== undefined) record.contextFingerprint = requirement.contextFingerprint;
  return record;
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
