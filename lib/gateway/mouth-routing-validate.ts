/**
 * F1 mouth routing policy validation and normalization.
 * Mirrors A1 scheduling.policy validation pattern.
 * Fail-closed: missing/conflicting rules → hold for approval / do not leak internal content.
 */
import type {
  ConversationSurface,
  MouthPriority,
  MouthRoutingRule,
  OrgMouthRoutingPolicy,
} from "@/lib/types";

const CONVERSATION_SURFACES: ConversationSurface[] = ["slack", "line", "mail", "phone", "web"];

export type ValidationError = {
  ruleIndex?: number;
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ValidationResult =
  | { ok: true; policy: OrgMouthRoutingPolicy }
  | { ok: false; errors: ValidationError[] };

function isConversationSurface(value: unknown): value is ConversationSurface {
  return typeof value === "string" && CONVERSATION_SURFACES.includes(value as ConversationSurface);
}

function isMouthPriority(value: unknown): value is MouthPriority {
  if (!Array.isArray(value)) return false;
  return value.every(isConversationSurface);
}

function generateRuleId(): string {
  return `mrr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function generatePolicyId(): string {
  return `mrp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function validateMouthRoutingRule(
  raw: unknown,
  index: number
): { ok: true; rule: MouthRoutingRule } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      ruleIndex: index,
      field: "rule",
      code: "invalid_rule_format",
      message: "Rule must be an object",
      messageJa: "ルールはオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = raw as Record<string, unknown>;

  const id =
    typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : generateRuleId();

  const rule: MouthRoutingRule = {
    id,
    preferDmForInternal: true,
    holdOnUnknownInternal: true,
  };

  if (typeof rec.priority === "number") {
    rule.priority = rec.priority;
  }

  if (rec.mouthPriority !== undefined) {
    if (!isMouthPriority(rec.mouthPriority)) {
      errors.push({
        ruleIndex: index,
        field: "mouthPriority",
        code: "invalid_mouth_priority",
        message: `mouthPriority must be an array of: ${CONVERSATION_SURFACES.join(", ")}`,
        messageJa: `口の優先度は ${CONVERSATION_SURFACES.join(" / ")} の配列です`,
      });
    } else {
      rule.mouthPriority = rec.mouthPriority;
    }
  }

  if (rec.preferDmForInternal !== undefined) {
    rule.preferDmForInternal = rec.preferDmForInternal === true;
  }

  if (rec.holdOnUnknownInternal !== undefined) {
    rule.holdOnUnknownInternal = rec.holdOnUnknownInternal === true;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rule };
}

export interface ValidateMouthRoutingPolicyOptions {
  requireHighRiskConsent?: boolean;
  existingConsent?: { at: string; by: string } | null;
}

export function validateMouthRoutingPolicy(
  input: unknown,
  options: ValidateMouthRoutingPolicyOptions = {}
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      field: "policy",
      code: "invalid_policy_format",
      message: "Policy must be an object",
      messageJa: "ポリシーはオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = input as Record<string, unknown>;

  const policyId =
    typeof rec.policyId === "string" && rec.policyId.trim()
      ? rec.policyId.trim()
      : generatePolicyId();

  const policyName =
    typeof rec.policyName === "string" && rec.policyName.trim()
      ? rec.policyName.trim()
      : "既定の口ルーティングポリシー";

  if (!Array.isArray(rec.rules)) {
    errors.push({
      field: "rules",
      code: "rules_required",
      message: "rules array is required",
      messageJa: "ルール配列が必要です",
    });
    return { ok: false, errors };
  }

  if (rec.rules.length === 0) {
    errors.push({
      field: "rules",
      code: "rules_empty",
      message: "At least one rule is required",
      messageJa: "ルールは少なくとも1つ必要です",
    });
    return { ok: false, errors };
  }

  const validatedRules: MouthRoutingRule[] = [];
  let hasRiskyRule = false;

  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateMouthRoutingRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
      if (result.rule.holdOnUnknownInternal === false) {
        hasRiskyRule = true;
      }
    } else {
      errors.push(...result.errors);
    }
  }

  let defaultMouthPriority: MouthPriority = ["slack", "line"];
  if (rec.defaultMouthPriority !== undefined) {
    if (!isMouthPriority(rec.defaultMouthPriority)) {
      errors.push({
        field: "defaultMouthPriority",
        code: "invalid_default_mouth_priority",
        message: `defaultMouthPriority must be an array of: ${CONVERSATION_SURFACES.join(", ")}`,
        messageJa: `既定の口優先度は ${CONVERSATION_SURFACES.join(" / ")} の配列です`,
      });
    } else {
      defaultMouthPriority = rec.defaultMouthPriority;
    }
  }

  if (hasRiskyRule && options.requireHighRiskConsent) {
    const hasConsent =
      options.existingConsent ||
      (typeof rec.highRiskConsentAt === "string" &&
        typeof rec.highRiskConsentBy === "string");

    if (!hasConsent) {
      errors.push({
        field: "highRiskConsent",
        code: "high_risk_consent_required",
        message:
          "Disabling holdOnUnknownInternal requires explicit tenant consent",
        messageJa:
          "未知の内部パーティでの hold 無効化にはテナントの明示的な承諾が必要です",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const policy: OrgMouthRoutingPolicy = {
    version: 1,
    policyId,
    policyName,
    rules: validatedRules,
    defaultMouthPriority,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };

  if (
    typeof rec.highRiskConsentAt === "string" &&
    typeof rec.highRiskConsentBy === "string"
  ) {
    policy.highRiskConsentAt = rec.highRiskConsentAt;
    policy.highRiskConsentBy = rec.highRiskConsentBy;
  } else if (options.existingConsent) {
    policy.highRiskConsentAt = options.existingConsent.at;
    policy.highRiskConsentBy = options.existingConsent.by;
  }

  return { ok: true, policy };
}

export const DEFAULT_MOUTH_ROUTING_RULE: MouthRoutingRule = {
  id: "mrr_default",
  preferDmForInternal: true,
  holdOnUnknownInternal: true,
};

export function defaultMouthRoutingPolicy(): OrgMouthRoutingPolicy {
  return {
    version: 1,
    policyId: generatePolicyId(),
    policyName: "既定の口ルーティングポリシー",
    rules: [{ ...DEFAULT_MOUTH_ROUTING_RULE, id: generateRuleId() }],
    defaultMouthPriority: ["slack", "line"],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function normalizeMouthRoutingPolicy(value: unknown): OrgMouthRoutingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultMouthRoutingPolicy();
  }
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.rules) || rec.rules.length === 0) {
    return defaultMouthRoutingPolicy();
  }

  const validatedRules: MouthRoutingRule[] = [];
  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateMouthRoutingRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
    }
  }

  if (validatedRules.length === 0) {
    return defaultMouthRoutingPolicy();
  }

  let defaultMouthPriority: MouthPriority = ["slack", "line"];
  if (isMouthPriority(rec.defaultMouthPriority)) {
    defaultMouthPriority = rec.defaultMouthPriority;
  }

  return {
    version: 1,
    policyId:
      typeof rec.policyId === "string" && rec.policyId.trim()
        ? rec.policyId.trim()
        : generatePolicyId(),
    policyName:
      typeof rec.policyName === "string" && rec.policyName.trim()
        ? rec.policyName.trim()
        : "口ルーティングポリシー",
    rules: validatedRules,
    defaultMouthPriority,
    highRiskConsentAt:
      typeof rec.highRiskConsentAt === "string" ? rec.highRiskConsentAt : undefined,
    highRiskConsentBy:
      typeof rec.highRiskConsentBy === "string" ? rec.highRiskConsentBy : undefined,
    updatedAt:
      typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function isDefaultMouthRoutingPolicy(policy: OrgMouthRoutingPolicy): boolean {
  if (policy.rules.length !== 1) return false;
  const rule = policy.rules[0];
  return (
    rule.preferDmForInternal === true &&
    rule.holdOnUnknownInternal === true &&
    rule.mouthPriority === undefined
  );
}

export function summarizeMouthRoutingPolicyJa(policy: OrgMouthRoutingPolicy): string {
  if (policy.rules.length === 0) return "ルールなし";
  if (isDefaultMouthRoutingPolicy(policy)) {
    return "デフォルト: 内部コンテンツはDMへ、未知の内部パーティは保留";
  }

  const parts: string[] = [];
  for (const rule of policy.rules) {
    const dmJa = rule.preferDmForInternal ? "DM優先" : "スレッド優先";
    const holdJa = rule.holdOnUnknownInternal ? "未知は保留" : "未知も送信";
    const priorityJa = rule.mouthPriority
      ? `優先: ${rule.mouthPriority.join(" → ")}`
      : "";
    const parts2 = [dmJa, holdJa, priorityJa].filter(Boolean);
    parts.push(parts2.join(" / "));
  }
  return parts.join(" → ");
}

export function nextStepMouthRoutingPolicyJa(policy: OrgMouthRoutingPolicy): string {
  if (isDefaultMouthRoutingPolicy(policy)) {
    return "デフォルトの安全設定です。内部向けコンテンツはDMへルーティング、未知の内部パーティは保留されます。";
  }

  const hasRiskyRule = policy.rules.some((r) => r.holdOnUnknownInternal === false);
  if (hasRiskyRule) {
    if (!policy.highRiskConsentAt) {
      return "未知の内部パーティへの送信が許可されていますが、テナント承諾が未記録です。";
    }
    return `未知の内部パーティへの送信が有効です（承諾: ${policy.highRiskConsentBy} / ${policy.highRiskConsentAt}）。運用に注意してください。`;
  }

  return "口ルーティングポリシー設定完了。会話投稿時に適用されます。";
}
