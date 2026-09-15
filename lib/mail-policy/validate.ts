/**
 * B1 mail policy validation and normalization.
 * Mirrors A1 scheduling.policy / B2 reply-policy validation pattern.
 * Fail-closed: unknown fields rejected; auto sendMode requires highRiskConsent.
 */
import type {
  MailAttachmentPolicyRef,
  MailPolicyAudience,
  MailPolicyRule,
  MailSendMode,
  OrgMailPolicy,
} from "@/lib/types";

const MAIL_SEND_MODES: MailSendMode[] = ["draft_only", "needs_approval", "auto"];
const MAIL_AUDIENCES: MailPolicyAudience[] = ["internal", "external", "any"];
const ATTACHMENT_POLICY_REFS: MailAttachmentPolicyRef[] = ["inherit_d1", "forbid"];

const POLICY_ALLOWED_KEYS = new Set([
  "version",
  "policyId",
  "policyName",
  "rules",
  "highRiskConsentAt",
  "highRiskConsentBy",
  "updatedAt",
  "updatedBy",
]);

const RULE_ALLOWED_KEYS = new Set([
  "id",
  "priority",
  "audience",
  "toDomainAllowlist",
  "toDomainDenylist",
  "sendMode",
  "draftMailbox",
  "requireHumanFinalSend",
  "allowCc",
  "allowBcc",
  "attachmentPolicyRef",
]);

export type ValidationError = {
  ruleIndex?: number;
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ValidationResult =
  | { ok: true; policy: OrgMailPolicy }
  | { ok: false; errors: ValidationError[] };

function generateRuleId(): string {
  return `mpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function generatePolicyId(): string {
  return `mpp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function isMailSendMode(value: unknown): value is MailSendMode {
  return typeof value === "string" && MAIL_SEND_MODES.includes(value as MailSendMode);
}

function isMailAudience(value: unknown): value is MailPolicyAudience {
  return typeof value === "string" && MAIL_AUDIENCES.includes(value as MailPolicyAudience);
}

function isAttachmentPolicyRef(value: unknown): value is MailAttachmentPolicyRef {
  return typeof value === "string" && ATTACHMENT_POLICY_REFS.includes(value as MailAttachmentPolicyRef);
}

function normalizeDomainList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean);
}

function collectUnknownFieldErrors(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
  ruleIndex?: number
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push({
        ruleIndex,
        field: prefix ? `${prefix}.${key}` : key,
        code: "unknown_field",
        message: `Unknown field: ${key}`,
        messageJa: `未知のフィールド: ${key}`,
      });
    }
  }
  return errors;
}

export function validateMailPolicyRule(
  raw: unknown,
  index: number
): { ok: true; rule: MailPolicyRule } | { ok: false; errors: ValidationError[] } {
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
  errors.push(...collectUnknownFieldErrors(rec, RULE_ALLOWED_KEYS, "rule", index));

  const id =
    typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : generateRuleId();

  const rule: MailPolicyRule = {
    id,
    sendMode: "draft_only",
  };

  if (typeof rec.priority === "number") {
    rule.priority = rec.priority;
  }

  if (rec.audience !== undefined) {
    if (!isMailAudience(rec.audience)) {
      errors.push({
        ruleIndex: index,
        field: "audience",
        code: "invalid_audience",
        message: `audience must be one of: ${MAIL_AUDIENCES.join(", ")}`,
        messageJa: `audienceは ${MAIL_AUDIENCES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.audience = rec.audience;
    }
  }

  if (rec.toDomainAllowlist !== undefined) {
    const domains = normalizeDomainList(rec.toDomainAllowlist);
    if (!domains) {
      errors.push({
        ruleIndex: index,
        field: "toDomainAllowlist",
        code: "invalid_domain_list",
        message: "toDomainAllowlist must be an array of strings",
        messageJa: "toDomainAllowlistは文字列の配列です",
      });
    } else {
      rule.toDomainAllowlist = domains;
    }
  }

  if (rec.toDomainDenylist !== undefined) {
    const domains = normalizeDomainList(rec.toDomainDenylist);
    if (!domains) {
      errors.push({
        ruleIndex: index,
        field: "toDomainDenylist",
        code: "invalid_domain_list",
        message: "toDomainDenylist must be an array of strings",
        messageJa: "toDomainDenylistは文字列の配列です",
      });
    } else {
      rule.toDomainDenylist = domains;
    }
  }

  if (rec.sendMode !== undefined) {
    if (!isMailSendMode(rec.sendMode)) {
      errors.push({
        ruleIndex: index,
        field: "sendMode",
        code: "invalid_send_mode",
        message: `sendMode must be one of: ${MAIL_SEND_MODES.join(", ")}`,
        messageJa: `sendModeは ${MAIL_SEND_MODES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.sendMode = rec.sendMode;
    }
  }

  if (typeof rec.draftMailbox === "string" && rec.draftMailbox.trim()) {
    rule.draftMailbox = rec.draftMailbox.trim();
  }

  if (rec.requireHumanFinalSend !== undefined) {
    rule.requireHumanFinalSend = rec.requireHumanFinalSend === true;
  }

  if (rec.allowCc !== undefined) {
    rule.allowCc = rec.allowCc === true;
  }

  if (rec.allowBcc !== undefined) {
    rule.allowBcc = rec.allowBcc === true;
  }

  if (rec.attachmentPolicyRef !== undefined) {
    if (!isAttachmentPolicyRef(rec.attachmentPolicyRef)) {
      errors.push({
        ruleIndex: index,
        field: "attachmentPolicyRef",
        code: "invalid_attachment_policy_ref",
        message: `attachmentPolicyRef must be one of: ${ATTACHMENT_POLICY_REFS.join(", ")}`,
        messageJa: `attachmentPolicyRefは ${ATTACHMENT_POLICY_REFS.join(" / ")} のいずれかです`,
      });
    } else {
      rule.attachmentPolicyRef = rec.attachmentPolicyRef;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rule };
}

export function defaultMailPolicy(): OrgMailPolicy {
  const now = new Date().toISOString();
  return {
    version: 1,
    policyId: "mpp_default",
    policyName: "Default Mail Policy",
    rules: [
      {
        id: "mpr_default_external",
        audience: "external",
        sendMode: "draft_only",
        attachmentPolicyRef: "inherit_d1",
      },
    ],
    updatedAt: now,
    updatedBy: "system",
  };
}

export function isDefaultMailPolicy(policy: OrgMailPolicy): boolean {
  return (
    policy.policyId === "mpp_default" &&
    policy.rules.length === 1 &&
    policy.rules[0]?.id === "mpr_default_external" &&
    policy.rules[0]?.sendMode === "draft_only"
  );
}

export function policyHasHighRiskAutoSend(policy: OrgMailPolicy): boolean {
  return policy.rules.some((r) => r.sendMode === "auto");
}

export function validateMailPolicy(
  input: {
    policyName?: unknown;
    rules?: unknown;
    highRiskConsentAt?: unknown;
    highRiskConsentBy?: unknown;
  },
  options?: {
    requireHighRiskConsent?: boolean;
    existingConsent?: { at: string; by: string } | null;
  }
): ValidationResult {
  const errors: ValidationError[] = [];
  const rules: MailPolicyRule[] = [];

  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    errors.push({
      field: "rules",
      code: "rules_required",
      message: "At least one rule is required",
      messageJa: "ルールが1件以上必要です",
    });
    return { ok: false, errors };
  }

  for (let i = 0; i < input.rules.length; i++) {
    const result = validateMailPolicyRule(input.rules[i], i);
    if (!result.ok) {
      errors.push(...result.errors);
    } else {
      rules.push(result.rule);
    }
  }

  const policyName =
    typeof input.policyName === "string" && input.policyName.trim()
      ? input.policyName.trim()
      : "Mail Policy";

  const highRiskConsentAt =
    typeof input.highRiskConsentAt === "string" && input.highRiskConsentAt.trim()
      ? input.highRiskConsentAt.trim()
      : options?.existingConsent?.at;

  const highRiskConsentBy =
    typeof input.highRiskConsentBy === "string" && input.highRiskConsentBy.trim()
      ? input.highRiskConsentBy.trim()
      : options?.existingConsent?.by;

  const draftPolicy: OrgMailPolicy = {
    version: 1,
    policyId: generatePolicyId(),
    policyName,
    rules,
    highRiskConsentAt,
    highRiskConsentBy,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };

  if (options?.requireHighRiskConsent && policyHasHighRiskAutoSend(draftPolicy)) {
    if (!draftPolicy.highRiskConsentAt || !draftPolicy.highRiskConsentBy) {
      errors.push({
        field: "highRiskConsentAt",
        code: "high_risk_consent_required",
        message: "sendMode auto requires explicit tenant consent (highRiskConsentAt/By)",
        messageJa: "sendMode auto にはテナントの明示的な承諾（highRiskConsentAt/By）が必要です",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, policy: draftPolicy };
}

export function normalizeMailPolicy(value: unknown): OrgMailPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultMailPolicy();
  }

  const rec = value as Record<string, unknown>;
  const validation = validateMailPolicy({
    policyName: rec.policyName,
    rules: rec.rules,
    highRiskConsentAt: rec.highRiskConsentAt,
    highRiskConsentBy: rec.highRiskConsentBy,
  });

  if (!validation.ok) {
    return defaultMailPolicy();
  }

  const policy = validation.policy;
  return {
    ...policy,
    version: 1,
    policyId:
      typeof rec.policyId === "string" && rec.policyId.trim()
        ? rec.policyId.trim()
        : policy.policyId,
    updatedAt:
      typeof rec.updatedAt === "string" ? rec.updatedAt : policy.updatedAt,
    updatedBy:
      typeof rec.updatedBy === "string" ? rec.updatedBy : policy.updatedBy,
  };
}

export function summarizeMailPolicyJa(policy: OrgMailPolicy): string {
  if (policy.rules.length === 0) return "ルールなし";
  if (isDefaultMailPolicy(policy)) {
    return "デフォルト: 外部宛は下書きのみ (draft_only)";
  }

  const parts: string[] = [];
  for (const rule of policy.rules) {
    const audienceJa =
      rule.audience === "internal"
        ? "社内"
        : rule.audience === "external"
          ? "外部"
          : "全宛先";
    const sendModeJa =
      rule.sendMode === "draft_only"
        ? "下書きのみ"
        : rule.sendMode === "needs_approval"
          ? "承認必須"
          : "自動送信";
    const domainParts: string[] = [];
    if (rule.toDomainAllowlist?.length) {
      domainParts.push(`許可: ${rule.toDomainAllowlist.join(",")}`);
    }
    if (rule.toDomainDenylist?.length) {
      domainParts.push(`拒否: ${rule.toDomainDenylist.join(",")}`);
    }
    const attachJa =
      rule.attachmentPolicyRef === "forbid" ? "添付禁止" : "D1継承";
    parts.push(
      `[${audienceJa}] ${sendModeJa}${domainParts.length ? ` (${domainParts.join(" / ")})` : ""} / ${attachJa}`
    );
  }
  return parts.join(" · ");
}

export function nextStepMailPolicyJa(policy: OrgMailPolicy): string {
  if (isDefaultMailPolicy(policy)) {
    return "外部宛メールは mail.send → mail.draft に降格されます。送信承認が必要な場合は sendMode: needs_approval のルールを設定してください。";
  }
  if (policyHasHighRiskAutoSend(policy)) {
    if (!policy.highRiskConsentAt) {
      return "sendMode auto が設定されていますが、テナント承諾が未記録です。mailPolicy.patch で highRiskConsentAt/By を設定してください。";
    }
    return `sendMode auto が有効です（承諾: ${policy.highRiskConsentBy} / ${policy.highRiskConsentAt}）。運用に注意してください。`;
  }
  return "メールポリシー設定完了。mail.send 呼び出し時に適用されます。";
}
