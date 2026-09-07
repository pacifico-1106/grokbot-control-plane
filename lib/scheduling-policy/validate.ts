/**
 * A1 scheduling.policy validation and normalization.
 * First rule-pack that locks the shared pack shape for all future situation policies.
 * Fail-closed: missing/conflicting rules → do not widen candidates; escalate to human.
 */
import type {
  ConfirmAutomationLevel,
  LocationAffinity,
  OnlineMeetingPack,
  OnlineVideoToolEntry,
  OrgSchedulingPolicy,
  SchedulingRule,
  TimeWindow,
} from "@/lib/types";

const LOCATION_AFFINITY_VALUES: LocationAffinity[] = [
  "office_first",
  "remote_first",
  "hybrid",
  "any",
];

const CONFIRM_AUTOMATION_VALUES: ConfirmAutomationLevel[] = [
  "always_human",
  "risk_based",
  "conditional",
  "full_auto",
];

const HIGH_RISK_AUTOMATION_LEVELS: ConfirmAutomationLevel[] = [
  "risk_based",
  "conditional",
  "full_auto",
];

export type ValidationError = {
  ruleIndex?: number;
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ValidationResult =
  | { ok: true; policy: OrgSchedulingPolicy }
  | { ok: false; errors: ValidationError[] };

function isLocationAffinity(value: unknown): value is LocationAffinity {
  return (
    typeof value === "string" &&
    LOCATION_AFFINITY_VALUES.includes(value as LocationAffinity)
  );
}

function isConfirmAutomation(value: unknown): value is ConfirmAutomationLevel {
  return (
    typeof value === "string" &&
    CONFIRM_AUTOMATION_VALUES.includes(value as ConfirmAutomationLevel)
  );
}

function isHighRiskAutomation(level: ConfirmAutomationLevel): boolean {
  return HIGH_RISK_AUTOMATION_LEVELS.includes(level);
}

function generateRuleId(): string {
  return `spr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function generatePolicyId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function validateTimeWindow(
  raw: unknown,
  index: number,
  fieldName: string,
  windowIndex: number
): { ok: true; window: TimeWindow } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      ruleIndex: index,
      field: `${fieldName}[${windowIndex}]`,
      code: "invalid_time_window_format",
      message: "Time window must be an object",
      messageJa: "時間窓はオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = raw as Record<string, unknown>;
  const window: TimeWindow = {};

  if (rec.dayOfWeek !== undefined) {
    if (!Array.isArray(rec.dayOfWeek)) {
      errors.push({
        ruleIndex: index,
        field: `${fieldName}[${windowIndex}].dayOfWeek`,
        code: "invalid_day_of_week",
        message: "dayOfWeek must be an array of numbers (0-6)",
        messageJa: "dayOfWeek は 0〜6 の数値配列でなければなりません",
      });
    } else {
      const days = rec.dayOfWeek.filter(
        (d): d is number => typeof d === "number" && d >= 0 && d <= 6
      );
      if (days.length > 0) {
        window.dayOfWeek = days;
      }
    }
  }

  if (typeof rec.startTime === "string" && rec.startTime.trim()) {
    window.startTime = rec.startTime.trim();
  }
  if (typeof rec.endTime === "string" && rec.endTime.trim()) {
    window.endTime = rec.endTime.trim();
  }
  if (typeof rec.startDate === "string" && rec.startDate.trim()) {
    window.startDate = rec.startDate.trim();
  }
  if (typeof rec.endDate === "string" && rec.endDate.trim()) {
    window.endDate = rec.endDate.trim();
  }
  if (typeof rec.reason === "string" && rec.reason.trim()) {
    window.reason = rec.reason.trim();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, window };
}

function validateOnlinePack(
  raw: unknown,
  index: number
): { ok: true; pack: OnlineMeetingPack } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      ruleIndex: index,
      field: "onlinePack",
      code: "invalid_online_pack_format",
      message: "onlinePack must be an object",
      messageJa: "オンライン設定はオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = raw as Record<string, unknown>;

  const pack: OnlineMeetingPack = {
    enabled: rec.enabled === true,
    videoToolAllowlist: [],
  };

  if (typeof rec.calendarTarget === "string" && rec.calendarTarget.trim()) {
    pack.calendarTarget = rec.calendarTarget.trim();
  }

  if (Array.isArray(rec.videoToolAllowlist)) {
    const allowlist: OnlineVideoToolEntry[] = [];
    for (const item of rec.videoToolAllowlist) {
      if (typeof item === "string" && item.trim()) {
        allowlist.push({ tool: item.trim() });
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.tool === "string" && entry.tool.trim()) {
          allowlist.push({
            tool: entry.tool.trim(),
            isDefault: entry.isDefault === true,
          });
        }
      }
    }
    pack.videoToolAllowlist = allowlist;

    const defaultTool = allowlist.find((e) => e.isDefault);
    if (defaultTool) {
      pack.defaultVideoTool = defaultTool.tool;
    }
  }

  if (typeof rec.defaultVideoTool === "string" && rec.defaultVideoTool.trim()) {
    pack.defaultVideoTool = rec.defaultVideoTool.trim();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, pack };
}

export function validateSchedulingRule(
  raw: unknown,
  index: number
): { ok: true; rule: SchedulingRule } | { ok: false; errors: ValidationError[] } {
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

  const rule: SchedulingRule = {
    id,
    confirmAutomation: "always_human",
  };

  if (typeof rec.priority === "number") {
    rule.priority = rec.priority;
  }

  if (rec.locationAffinity !== undefined) {
    if (!isLocationAffinity(rec.locationAffinity)) {
      errors.push({
        ruleIndex: index,
        field: "locationAffinity",
        code: "invalid_location_affinity",
        message: `locationAffinity must be one of: ${LOCATION_AFFINITY_VALUES.join(", ")}`,
        messageJa: `場所親和は ${LOCATION_AFFINITY_VALUES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.locationAffinity = rec.locationAffinity;
    }
  }

  if (rec.travelBufferMinutes !== undefined) {
    const buffer = Number(rec.travelBufferMinutes);
    if (!Number.isFinite(buffer) || buffer < 0) {
      errors.push({
        ruleIndex: index,
        field: "travelBufferMinutes",
        code: "invalid_travel_buffer",
        message: "travelBufferMinutes must be a non-negative number",
        messageJa: "移動バッファは 0 以上の数値でなければなりません",
      });
    } else {
      rule.travelBufferMinutes = buffer;
    }
  }

  if (rec.onlinePack !== undefined) {
    const packResult = validateOnlinePack(rec.onlinePack, index);
    if (packResult.ok) {
      rule.onlinePack = packResult.pack;
    } else {
      errors.push(...packResult.errors);
    }
  }

  if (Array.isArray(rec.hardBlackout)) {
    const blackouts: TimeWindow[] = [];
    for (let i = 0; i < rec.hardBlackout.length; i++) {
      const result = validateTimeWindow(rec.hardBlackout[i], index, "hardBlackout", i);
      if (result.ok) {
        blackouts.push(result.window);
      } else {
        errors.push(...result.errors);
      }
    }
    if (blackouts.length > 0) {
      rule.hardBlackout = blackouts;
    }
  }

  if (Array.isArray(rec.softPrefer)) {
    const prefers: TimeWindow[] = [];
    for (let i = 0; i < rec.softPrefer.length; i++) {
      const result = validateTimeWindow(rec.softPrefer[i], index, "softPrefer", i);
      if (result.ok) {
        prefers.push(result.window);
      } else {
        errors.push(...result.errors);
      }
    }
    if (prefers.length > 0) {
      rule.softPrefer = prefers;
    }
  }

  if (rec.costCapJpy !== undefined) {
    const cap = Number(rec.costCapJpy);
    if (!Number.isFinite(cap) || cap < 0) {
      errors.push({
        ruleIndex: index,
        field: "costCapJpy",
        code: "invalid_cost_cap",
        message: "costCapJpy must be a non-negative number",
        messageJa: "コスト上限は 0 以上の数値でなければなりません",
      });
    } else {
      rule.costCapJpy = cap;
    }
  }

  if (!isConfirmAutomation(rec.confirmAutomation)) {
    errors.push({
      ruleIndex: index,
      field: "confirmAutomation",
      code: "invalid_confirm_automation",
      message: `confirmAutomation must be one of: ${CONFIRM_AUTOMATION_VALUES.join(", ")}`,
      messageJa: `確定の自動化レベルは ${CONFIRM_AUTOMATION_VALUES.join(" / ")} のいずれかです`,
    });
  } else {
    rule.confirmAutomation = rec.confirmAutomation;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rule };
}

export interface ValidateSchedulingPolicyOptions {
  requireHighRiskConsent?: boolean;
  existingConsent?: { at: string; by: string } | null;
}

export function validateSchedulingPolicy(
  input: unknown,
  options: ValidateSchedulingPolicyOptions = {}
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
      : "デフォルトスケジューリングポリシー";

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

  const validatedRules: SchedulingRule[] = [];
  let hasHighRiskRule = false;

  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateSchedulingRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
      if (isHighRiskAutomation(result.rule.confirmAutomation)) {
        hasHighRiskRule = true;
      }
    } else {
      errors.push(...result.errors);
    }
  }

  if (hasHighRiskRule && options.requireHighRiskConsent) {
    const hasConsent =
      options.existingConsent ||
      (typeof rec.highRiskConsentAt === "string" &&
        typeof rec.highRiskConsentBy === "string");

    if (!hasConsent) {
      errors.push({
        field: "highRiskConsent",
        code: "high_risk_consent_required",
        message:
          "High-risk automation levels (risk_based, conditional, full_auto) require explicit tenant consent",
        messageJa:
          "高リスク自動化レベル（risk_based, conditional, full_auto）にはテナントの明示的な承諾が必要です",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const policy: OrgSchedulingPolicy = {
    version: 1,
    policyId,
    policyName,
    rules: validatedRules,
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

export const DEFAULT_SCHEDULING_RULE: SchedulingRule = {
  id: "spr_default",
  locationAffinity: "any",
  confirmAutomation: "always_human",
};

export function defaultSchedulingPolicy(): OrgSchedulingPolicy {
  return {
    version: 1,
    policyId: generatePolicyId(),
    policyName: "デフォルトスケジューリングポリシー",
    rules: [{ ...DEFAULT_SCHEDULING_RULE, id: generateRuleId() }],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function normalizeSchedulingPolicy(value: unknown): OrgSchedulingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultSchedulingPolicy();
  }
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.rules) || rec.rules.length === 0) {
    return defaultSchedulingPolicy();
  }

  const validatedRules: SchedulingRule[] = [];
  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateSchedulingRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
    }
  }

  if (validatedRules.length === 0) {
    return defaultSchedulingPolicy();
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
        : "スケジューリングポリシー",
    rules: validatedRules,
    highRiskConsentAt:
      typeof rec.highRiskConsentAt === "string" ? rec.highRiskConsentAt : undefined,
    highRiskConsentBy:
      typeof rec.highRiskConsentBy === "string" ? rec.highRiskConsentBy : undefined,
    updatedAt:
      typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function isDefaultSchedulingPolicy(policy: OrgSchedulingPolicy): boolean {
  if (policy.rules.length !== 1) return false;
  const rule = policy.rules[0];
  return (
    rule.confirmAutomation === "always_human" &&
    (rule.locationAffinity === "any" || rule.locationAffinity === undefined) &&
    rule.travelBufferMinutes === undefined &&
    rule.onlinePack === undefined &&
    rule.hardBlackout === undefined &&
    rule.softPrefer === undefined &&
    rule.costCapJpy === undefined
  );
}

export function policyHasHighRiskAutomation(policy: OrgSchedulingPolicy): boolean {
  return policy.rules.some((r) => isHighRiskAutomation(r.confirmAutomation));
}

export function summarizeSchedulingPolicyJa(policy: OrgSchedulingPolicy): string {
  if (policy.rules.length === 0) return "ルールなし";
  if (isDefaultSchedulingPolicy(policy)) {
    return "デフォルト: 日程確定は常に人間承認 (always_human)";
  }

  const parts: string[] = [];
  for (const rule of policy.rules) {
    const locationJa =
      rule.locationAffinity === "office_first"
        ? "オフィス優先"
        : rule.locationAffinity === "remote_first"
          ? "リモート優先"
          : rule.locationAffinity === "hybrid"
            ? "ハイブリッド"
            : "場所不問";
    const automationJa =
      rule.confirmAutomation === "always_human"
        ? "常に人間承認"
        : rule.confirmAutomation === "risk_based"
          ? "リスクベース"
          : rule.confirmAutomation === "conditional"
            ? "条件付き自動"
            : "完全自動";
    const bufferJa = rule.travelBufferMinutes
      ? `移動${rule.travelBufferMinutes}分`
      : "";
    const parts2 = [locationJa, automationJa, bufferJa].filter(Boolean);
    parts.push(parts2.join(" / "));
  }
  return parts.join(" → ");
}

export function nextStepSchedulingPolicyJa(policy: OrgSchedulingPolicy): string {
  if (isDefaultSchedulingPolicy(policy)) {
    return "デフォルトの安全設定です。日程確定は常に人間承認が必要です。自動化レベルを変更するにはルールを追加してください。";
  }

  if (policyHasHighRiskAutomation(policy)) {
    if (!policy.highRiskConsentAt) {
      return "高リスク自動化が設定されていますが、テナント承諾が未記録です。schedulingPolicy.patch で highRiskConsentAt/By を設定してください。";
    }
    return `高リスク自動化が有効です（承諾: ${policy.highRiskConsentBy} / ${policy.highRiskConsentAt}）。運用に注意してください。`;
  }

  return "スケジューリングポリシー設定完了。calendar.propose 呼び出し時に適用されます。";
}
