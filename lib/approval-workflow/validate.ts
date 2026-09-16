/**
 * F8 Approval Workflow Policy Validation
 *
 * Validates and normalizes workflow policies, provides Japanese summaries.
 */

import type {
  ApprovalLane,
  OrgApprovalWorkflowPolicy,
  QuorumRule,
} from "@/lib/types";

export interface ValidationError {
  code: string;
  path?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  normalized?: OrgApprovalWorkflowPolicy;
}

function isValidQuorumRule(rule: unknown): rule is QuorumRule {
  if (!rule || typeof rule !== "object") return false;
  const r = rule as Record<string, unknown>;

  if (r.type === "any") return true;
  if (r.type === "count" && typeof r.n === "number" && Number.isSafeInteger(r.n) && r.n >= 1) return true;
  if (
    r.type === "ratio" &&
    typeof r.numerator === "number" &&
    typeof r.denominator === "number" &&
    Number.isSafeInteger(r.numerator) && Number.isSafeInteger(r.denominator) &&
    r.numerator >= 1 &&
    r.denominator >= 1 &&
    r.numerator <= r.denominator
  ) {
    return true;
  }
  if (r.type === "majority") return true;

  return false;
}

function isValidLane(lane: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `stages[${index}]`;

  if (!lane || typeof lane !== "object") {
    errors.push({ code: "invalid_lane", path, message: "stage must be an object" });
    return errors;
  }

  const l = lane as Record<string, unknown>;

  if (typeof l.id !== "string" || !l.id.trim()) {
    errors.push({ code: "missing_lane_id", path: `${path}.id`, message: "stage id is required" });
  }
  if (l.id === "final_go") errors.push({ code: "reserved_stage_id", path: `${path}.id`, message: "final_go is reserved" });

  if (typeof l.nameJa !== "string" || !l.nameJa.trim()) {
    errors.push({ code: "missing_lane_name", path: `${path}.nameJa`, message: "stage nameJa is required" });
  }

  if (!Array.isArray(l.voterUserIds) || l.voterUserIds.length === 0) {
    errors.push({
      code: "missing_voters",
      path: `${path}.voterUserIds`,
      message: "stage must have at least one voter",
    });
  } else if (l.voterUserIds.some((v: unknown) => typeof v !== "string" || !v.trim() || v !== v.trim())) {
    errors.push({
      code: "invalid_voter_id",
      path: `${path}.voterUserIds`,
      message: "all voter ids must be non-empty strings",
    });
  }
  if (Array.isArray(l.voterUserIds) && new Set(l.voterUserIds).size !== l.voterUserIds.length) {
    errors.push({ code: "duplicate_voter", path: `${path}.voterUserIds`, message: "voters must be unique" });
  }
  if (isValidQuorumRule(l.quorum) && l.quorum.type === "count" && Array.isArray(l.voterUserIds) && l.quorum.n > l.voterUserIds.length) {
    errors.push({ code: "unreachable_quorum", path: `${path}.quorum`, message: "count exceeds voters" });
  }

  if (!isValidQuorumRule(l.quorum)) {
    errors.push({
      code: "invalid_quorum",
      path: `${path}.quorum`,
      message: "invalid quorum rule (any | count(n>=1) | ratio | majority)",
    });
  }

  const onReject = l.onReject;
  if (onReject !== "fail_closed" && onReject !== "count_as_vote") {
    errors.push({
      code: "invalid_on_reject",
      path: `${path}.onReject`,
      message: "onReject must be fail_closed or count_as_vote",
    });
  }

  return errors;
}

export function validateApprovalWorkflowPolicy(
  input: unknown,
  opts: { requireHighRiskConsent?: boolean; existingConsent?: { at: string; by: string } | null } = {}
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== "object") {
    return { ok: false, errors: [{ code: "invalid_input", message: "policy must be an object" }] };
  }

  const policy = input as Record<string, unknown>;

  if (typeof policy.policyName !== "string" || !policy.policyName.trim()) {
    errors.push({ code: "missing_policy_name", path: "policyName", message: "policyName is required" });
  }

  if (!Array.isArray(policy.stages)) {
    errors.push({ code: "missing_stages", path: "stages", message: "stages array is required" });
  } else if (policy.stages.length === 0) {
    errors.push({ code: "empty_stages", path: "stages", message: "at least one stage is required" });
  } else {
    for (let i = 0; i < policy.stages.length; i++) {
      errors.push(...isValidLane(policy.stages[i], i));
    }
    const ids = policy.stages.map((s: unknown) => s && typeof s === "object" ? String((s as Record<string, unknown>).id).trim() : undefined);
    if (new Set(ids).size !== ids.length) errors.push({ code: "duplicate_stage", path: "stages", message: "stage IDs must be unique" });
  }

  if (policy.finalGoUserId !== undefined && policy.finalGoUserId !== null) {
    if (typeof policy.finalGoUserId !== "string" || !policy.finalGoUserId.trim()) {
      errors.push({
        code: "invalid_final_go_user",
        path: "finalGoUserId",
        message: "finalGoUserId must be a non-empty string when set",
      });
    }
  }

  if (policy.match !== undefined && policy.match !== null) {
    if (typeof policy.match !== "object") {
      errors.push({ code: "invalid_match", path: "match", message: "match must be an object" });
    } else {
      const match = policy.match as Record<string, unknown>;
      for (const key of ["tools", "purposes"]) {
        if (Array.isArray(match[key]) && (match[key] as unknown[]).some(v => typeof v !== "string" || !v.trim())) {
          errors.push({ code: "invalid_match_value", path: `match.${key}`, message: "match entries must be non-empty strings" });
        }
      }
      if (match.tools !== undefined && !Array.isArray(match.tools)) {
        errors.push({ code: "invalid_match_tools", path: "match.tools", message: "match.tools must be an array" });
      }
      if (match.purposes !== undefined && !Array.isArray(match.purposes)) {
        errors.push({
          code: "invalid_match_purposes",
          path: "match.purposes",
          message: "match.purposes must be an array",
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}

export function normalizeApprovalWorkflowPolicy(
  input: Record<string, unknown>
): OrgApprovalWorkflowPolicy {
  const now = new Date().toISOString();
  const policyId =
    typeof input.policyId === "string" && input.policyId.trim()
      ? input.policyId.trim()
      : `awp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const stages = (input.stages as unknown[]).map((s, i) => {
    const lane = s as Record<string, unknown>;
    const normalized: ApprovalLane = {
      id:
        typeof lane.id === "string" && lane.id.trim()
          ? lane.id.trim()
          : `stage_${i}`,
      nameJa:
        typeof lane.nameJa === "string" && lane.nameJa.trim()
          ? lane.nameJa.trim()
          : `ステージ ${i + 1}`,
      voterUserIds: (lane.voterUserIds as string[]).filter(Boolean),
      quorum: lane.quorum as QuorumRule,
      onReject:
        lane.onReject === "count_as_vote" ? "count_as_vote" : "fail_closed",
    };
    return normalized;
  });

  const policy: OrgApprovalWorkflowPolicy = {
    version: 1,
    policyId,
    policyName:
      typeof input.policyName === "string" ? input.policyName.trim() : "承認ワークフロー",
    stages,
    updatedAt: now,
    updatedBy: typeof input.updatedBy === "string" ? input.updatedBy : "admin_mcp",
  };

  if (typeof input.finalGoUserId === "string" && input.finalGoUserId.trim()) {
    policy.finalGoUserId = input.finalGoUserId.trim();
  }

  if (input.match && typeof input.match === "object") {
    const match = input.match as Record<string, unknown>;
    policy.match = {};
    if (Array.isArray(match.tools) && match.tools.length > 0) {
      policy.match.tools = match.tools.filter((t): t is string => typeof t === "string" && Boolean(t));
    }
    if (Array.isArray(match.purposes) && match.purposes.length > 0) {
      policy.match.purposes = match.purposes.filter((p): p is string => typeof p === "string" && Boolean(p));
    }
    if (Object.keys(policy.match).length === 0) {
      delete policy.match;
    }
  }

  if (input.notifyMouth && typeof input.notifyMouth === "object") {
    const mouth = input.notifyMouth as Record<string, unknown>;
    if (["slack", "line", "telegram", "web"].includes(String(mouth.surface))) {
      policy.notifyMouth = { surface: mouth.surface as "slack" | "line" | "telegram" | "web" };
    }
  }

  if (typeof input.highRiskConsentAt === "string" && input.highRiskConsentAt) {
    policy.highRiskConsentAt = input.highRiskConsentAt;
  }
  if (typeof input.highRiskConsentBy === "string" && input.highRiskConsentBy) {
    policy.highRiskConsentBy = input.highRiskConsentBy;
  }

  return policy;
}

function quorumDisplayJa(rule: QuorumRule): string {
  switch (rule.type) {
    case "any":
      return "1人";
    case "count":
      return `${rule.n}人`;
    case "ratio":
      return `${rule.numerator}/${rule.denominator}`;
    case "majority":
      return "過半数";
    default:
      return "不明";
  }
}

export function summarizeApprovalWorkflowPolicyJa(
  policy: OrgApprovalWorkflowPolicy | null
): string {
  if (!policy) {
    return "ワークフロー未設定（現行の1人承認）";
  }

  const parts: string[] = [`ポリシー: ${policy.policyName}`];

  for (let i = 0; i < policy.stages.length; i++) {
    const stage = policy.stages[i];
    const quorum = quorumDisplayJa(stage.quorum);
    parts.push(
      `${i + 1}. ${stage.nameJa}: ${stage.voterUserIds.length}名から${quorum}承認 (${stage.onReject === "fail_closed" ? "1却下で即終了" : "得票のみ"})`
    );
  }

  if (policy.finalGoUserId) {
    parts.push(`最終Go: ${policy.finalGoUserId}`);
  }

  if (policy.match) {
    const matchParts: string[] = [];
    if (policy.match.tools?.length) {
      matchParts.push(`ツール: ${policy.match.tools.join(", ")}`);
    }
    if (policy.match.purposes?.length) {
      matchParts.push(`目的: ${policy.match.purposes.join(", ")}`);
    }
    if (matchParts.length > 0) {
      parts.push(`対象: ${matchParts.join(" / ")}`);
    }
  }

  return parts.join(" / ");
}

export function nextStepApprovalWorkflowJa(
  policy: OrgApprovalWorkflowPolicy | null
): string {
  if (!policy) {
    return "approvalWorkflow.patch でワークフローポリシーを設定すると、合議・定足数・最終Goが使えます。未設定の場合は現行の1人承認（OR）のままです。";
  }

  const steps: string[] = [];

  if (policy.stages.length === 0) {
    steps.push("ステージを1つ以上追加してください。");
  }

  const emptyVoters = policy.stages.filter((s) => s.voterUserIds.length === 0);
  if (emptyVoters.length > 0) {
    steps.push(
      `投票者が未設定のステージがあります: ${emptyVoters.map((s) => s.nameJa).join(", ")}`
    );
  }

  if (steps.length === 0) {
    const desc = policy.finalGoUserId
      ? `${policy.stages.length}ステージ + 最終Go`
      : `${policy.stages.length}ステージ`;
    return `ワークフロー設定済み（${desc}）。承認依頼が作成されると自動でワークフローが開始されます。`;
  }

  return steps.join(" ");
}
