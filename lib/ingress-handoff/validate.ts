/**
 * Ingress handoff policy validation and normalization.
 * Convenience default; tighten for external/sensitive via ordered rules (first match wins).
 */
import type {
  AttachmentApproval,
  AttachmentHandoff,
  BodyHandoff,
  IngressApplyTo,
  IngressHandoffRule,
  OrgIngressHandoffPolicy,
  SealithHandoff,
  SealithRequiredHint,
} from "@/lib/types";

const APPLY_TO_VALUES: IngressApplyTo[] = ["all", "channels", "classified_external_sensitive"];
const BODY_HANDOFF_VALUES: BodyHandoff[] = ["full", "prefix", "none"];
const ATTACHMENT_HANDOFF_VALUES: AttachmentHandoff[] = ["file", "meta", "none"];
const ATTACHMENT_APPROVAL_VALUES: AttachmentApproval[] = ["none", "manager"];
const SEALITH_HANDOFF_VALUES: SealithHandoff[] = ["off", "suggest", "required"];
const SEALITH_HINT_VALUES: SealithRequiredHint[] = ["contract", "nda", "quote", "other"];

const BODY_PREFIX_MIN = 1;
const BODY_PREFIX_MAX = 4000;

export type ValidationError = {
  ruleIndex?: number;
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ValidationResult =
  | { ok: true; policy: OrgIngressHandoffPolicy }
  | { ok: false; errors: ValidationError[] };

function isApplyTo(value: unknown): value is IngressApplyTo {
  return typeof value === "string" && APPLY_TO_VALUES.includes(value as IngressApplyTo);
}

function isBodyHandoff(value: unknown): value is BodyHandoff {
  return typeof value === "string" && BODY_HANDOFF_VALUES.includes(value as BodyHandoff);
}

function isAttachmentHandoff(value: unknown): value is AttachmentHandoff {
  return typeof value === "string" && ATTACHMENT_HANDOFF_VALUES.includes(value as AttachmentHandoff);
}

function isAttachmentApproval(value: unknown): value is AttachmentApproval {
  return typeof value === "string" && ATTACHMENT_APPROVAL_VALUES.includes(value as AttachmentApproval);
}

function isSealithHandoff(value: unknown): value is SealithHandoff {
  return typeof value === "string" && SEALITH_HANDOFF_VALUES.includes(value as SealithHandoff);
}

function isSealithHint(value: unknown): value is SealithRequiredHint {
  return typeof value === "string" && SEALITH_HINT_VALUES.includes(value as SealithRequiredHint);
}

function generateRuleId(): string {
  return `ihr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function generatePolicyId(): string {
  return `ihp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function validateRule(
  raw: unknown,
  index: number
): { ok: true; rule: IngressHandoffRule } | { ok: false; errors: ValidationError[] } {
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

  const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : generateRuleId();

  if (!isApplyTo(rec.applyTo)) {
    errors.push({
      ruleIndex: index,
      field: "applyTo",
      code: "invalid_apply_to",
      message: `applyTo must be one of: ${APPLY_TO_VALUES.join(", ")}`,
      messageJa: `対象は ${APPLY_TO_VALUES.join(" / ")} のいずれかです`,
    });
  }
  const applyTo: IngressApplyTo = isApplyTo(rec.applyTo) ? rec.applyTo : "all";

  let channelIds: string[] | undefined;
  if (applyTo === "channels") {
    if (!Array.isArray(rec.channelIds) || rec.channelIds.length === 0) {
      errors.push({
        ruleIndex: index,
        field: "channelIds",
        code: "channel_ids_required",
        message: "channelIds required when applyTo=channels",
        messageJa: "対象がchannelsの場合、チャネルIDの指定が必要です",
      });
    } else {
      channelIds = rec.channelIds.filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim());
      if (channelIds.length === 0) {
        errors.push({
          ruleIndex: index,
          field: "channelIds",
          code: "channel_ids_empty",
          message: "channelIds must contain at least one valid id",
          messageJa: "有効なチャネルIDが少なくとも1つ必要です",
        });
      }
    }
  }

  if (!isBodyHandoff(rec.body)) {
    errors.push({
      ruleIndex: index,
      field: "body",
      code: "invalid_body_handoff",
      message: `body must be one of: ${BODY_HANDOFF_VALUES.join(", ")}`,
      messageJa: `本文の渡し方は ${BODY_HANDOFF_VALUES.join(" / ")} のいずれかです`,
    });
  }
  const body: BodyHandoff = isBodyHandoff(rec.body) ? rec.body : "full";

  let bodyPrefixChars: number | undefined;
  if (body === "prefix") {
    const chars = Number(rec.bodyPrefixChars);
    if (!Number.isInteger(chars) || chars < BODY_PREFIX_MIN || chars > BODY_PREFIX_MAX) {
      errors.push({
        ruleIndex: index,
        field: "bodyPrefixChars",
        code: "invalid_body_prefix_chars",
        message: `bodyPrefixChars required (${BODY_PREFIX_MIN}-${BODY_PREFIX_MAX}) when body=prefix`,
        messageJa: `body=prefixの場合、先頭の文字数(${BODY_PREFIX_MIN}〜${BODY_PREFIX_MAX})が必要です`,
      });
    } else {
      bodyPrefixChars = chars;
    }
  }

  if (!isAttachmentHandoff(rec.attachment)) {
    errors.push({
      ruleIndex: index,
      field: "attachment",
      code: "invalid_attachment_handoff",
      message: `attachment must be one of: ${ATTACHMENT_HANDOFF_VALUES.join(", ")}`,
      messageJa: `添付の渡し方は ${ATTACHMENT_HANDOFF_VALUES.join(" / ")} のいずれかです`,
    });
  }
  const attachment: AttachmentHandoff = isAttachmentHandoff(rec.attachment) ? rec.attachment : "meta";

  let attachmentApproval: AttachmentApproval | undefined;
  if (attachment !== "none") {
    if (rec.attachmentApproval !== undefined) {
      if (!isAttachmentApproval(rec.attachmentApproval)) {
        errors.push({
          ruleIndex: index,
          field: "attachmentApproval",
          code: "invalid_attachment_approval",
          message: `attachmentApproval must be one of: ${ATTACHMENT_APPROVAL_VALUES.join(", ")}`,
          messageJa: `添付を渡す前の承認は ${ATTACHMENT_APPROVAL_VALUES.join(" / ")} のいずれかです`,
        });
      } else {
        attachmentApproval = rec.attachmentApproval;
      }
    } else {
      attachmentApproval = "none";
    }
  }

  if (!isSealithHandoff(rec.sealith)) {
    errors.push({
      ruleIndex: index,
      field: "sealith",
      code: "invalid_sealith_handoff",
      message: `sealith must be one of: ${SEALITH_HANDOFF_VALUES.join(", ")}`,
      messageJa: `Sealithへの暗号化受け渡しは ${SEALITH_HANDOFF_VALUES.join(" / ")} のいずれかです`,
    });
  }
  const sealith: SealithHandoff = isSealithHandoff(rec.sealith) ? rec.sealith : "off";

  let sealithRequiredHints: SealithRequiredHint[] | undefined;
  let sealithRequiredOtherText: string | undefined;
  if (sealith === "required" && Array.isArray(rec.sealithRequiredHints)) {
    sealithRequiredHints = rec.sealithRequiredHints.filter(isSealithHint);
    if (sealithRequiredHints.includes("other") && typeof rec.sealithRequiredOtherText === "string") {
      sealithRequiredOtherText = rec.sealithRequiredOtherText.trim() || undefined;
    }
  }

  const auditRaw = rec.audit;
  let sealithTransferId = false;
  if (auditRaw && typeof auditRaw === "object" && !Array.isArray(auditRaw)) {
    const auditRec = auditRaw as Record<string, unknown>;
    sealithTransferId = sealith !== "off" && auditRec.sealithTransferId === true;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const rule: IngressHandoffRule = {
    id,
    applyTo,
    ...(channelIds ? { channelIds } : {}),
    body,
    ...(bodyPrefixChars !== undefined ? { bodyPrefixChars } : {}),
    attachment,
    ...(attachmentApproval !== undefined ? { attachmentApproval } : {}),
    sealith,
    ...(sealithRequiredHints && sealithRequiredHints.length > 0 ? { sealithRequiredHints } : {}),
    ...(sealithRequiredOtherText ? { sealithRequiredOtherText } : {}),
    audit: { jobId: true, sealithTransferId },
  };

  return { ok: true, rule };
}

export type ValidationOptions = {
  requireHighRiskConsent?: boolean;
  existingConsent?: { at: string; by: string } | null;
};

export function validateIngressHandoffPolicy(
  input: unknown,
  options: ValidationOptions = {}
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

  const validatedRules: IngressHandoffRule[] = [];
  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
    } else {
      errors.push(...result.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const hasHighRisk = policyHasHighRiskAutomation({ rules: validatedRules });
  const existingConsent = options.existingConsent;
  const newConsentAt = typeof rec.highRiskConsentAt === "string" ? rec.highRiskConsentAt : undefined;
  const newConsentBy = typeof rec.highRiskConsentBy === "string" ? rec.highRiskConsentBy : undefined;

  if (hasHighRisk && options.requireHighRiskConsent) {
    const hasConsent = (newConsentAt && newConsentBy) || existingConsent;
    if (!hasConsent) {
      errors.push({
        field: "highRiskConsent",
        code: "high_risk_consent_required",
        message: "High-risk configuration (attachment=file + sealith=off + external_sensitive) requires explicit tenant consent",
        messageJa: "高リスク設定（添付=ファイル + Sealith=オフ + 外部/機密分類）にはテナント承諾が必要です",
      });
      return { ok: false, errors };
    }
  }

  const policyId = typeof rec.policyId === "string" && rec.policyId.trim()
    ? rec.policyId.trim()
    : generatePolicyId();
  const policyName = typeof rec.policyName === "string" && rec.policyName.trim()
    ? rec.policyName.trim()
    : "受信の渡し方ポリシー";

  const policy: OrgIngressHandoffPolicy = {
    version: 1,
    policyId,
    policyName,
    rules: validatedRules,
    ...(hasHighRisk && (newConsentAt || existingConsent?.at)
      ? {
          highRiskConsentAt: newConsentAt || existingConsent?.at,
          highRiskConsentBy: newConsentBy || existingConsent?.by,
        }
      : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };

  return { ok: true, policy };
}

export const DEFAULT_INGRESS_HANDOFF_RULE: IngressHandoffRule = {
  id: "ihr_default",
  applyTo: "all",
  body: "full",
  attachment: "meta",
  attachmentApproval: "none",
  sealith: "off",
  audit: { jobId: true, sealithTransferId: false },
};

export function defaultIngressHandoffPolicy(): OrgIngressHandoffPolicy {
  return {
    version: 1,
    policyId: generatePolicyId(),
    policyName: "デフォルト（便利設定）",
    rules: [{ ...DEFAULT_INGRESS_HANDOFF_RULE, id: generateRuleId() }],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

/**
 * Check if a policy has high-risk automation configuration.
 * High-risk: attachment=file + sealith=off on classified_external_sensitive scope.
 * This pattern exposes raw file bodies to external/sensitive channels without
 * encryption handoff protection. Requires explicit tenant consent.
 */
export function policyHasHighRiskAutomation(
  policy: Pick<OrgIngressHandoffPolicy, "rules">
): boolean {
  for (const rule of policy.rules) {
    if (
      rule.applyTo === "classified_external_sensitive" &&
      rule.attachment === "file" &&
      rule.sealith === "off"
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeIngressHandoffPolicy(value: unknown): OrgIngressHandoffPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultIngressHandoffPolicy();
  }
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.rules) || rec.rules.length === 0) {
    return defaultIngressHandoffPolicy();
  }
  const validatedRules: IngressHandoffRule[] = [];
  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
    }
  }
  if (validatedRules.length === 0) {
    return defaultIngressHandoffPolicy();
  }
  const policyId = typeof rec.policyId === "string" && rec.policyId.trim()
    ? rec.policyId.trim()
    : generatePolicyId();
  const policyName = typeof rec.policyName === "string" && rec.policyName.trim()
    ? rec.policyName.trim()
    : "受信の渡し方ポリシー";
  const hasHighRisk = policyHasHighRiskAutomation({ rules: validatedRules });
  return {
    version: 1,
    policyId,
    policyName,
    rules: validatedRules,
    ...(hasHighRisk && rec.highRiskConsentAt
      ? {
          highRiskConsentAt: String(rec.highRiskConsentAt),
          highRiskConsentBy: typeof rec.highRiskConsentBy === "string" ? rec.highRiskConsentBy : undefined,
        }
      : {}),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function isDefaultIngressHandoffPolicy(policy: OrgIngressHandoffPolicy): boolean {
  if (policy.rules.length !== 1) return false;
  const rule = policy.rules[0];
  return (
    rule.applyTo === "all" &&
    rule.body === "full" &&
    rule.attachment === "meta" &&
    rule.sealith === "off" &&
    rule.audit.sealithTransferId === false
  );
}

export function hasHighRiskConsentRecorded(policy: OrgIngressHandoffPolicy): boolean {
  return Boolean(policy.highRiskConsentAt && policy.highRiskConsentBy);
}

export function summarizeIngressHandoffPolicyJa(policy: OrgIngressHandoffPolicy): string {
  if (policy.rules.length === 0) return "ルールなし";
  if (isDefaultIngressHandoffPolicy(policy)) {
    return "デフォルト: 本文=全文, 添付=メタ情報のみ, Sealith=オフ";
  }
  const parts: string[] = [];
  for (const rule of policy.rules) {
    const applyToJa =
      rule.applyTo === "all"
        ? "全て"
        : rule.applyTo === "channels"
          ? `チャネル(${rule.channelIds?.length ?? 0}件)`
          : "外部/機密分類";
    const bodyJa =
      rule.body === "full"
        ? "全文"
        : rule.body === "prefix"
          ? `先頭${rule.bodyPrefixChars}文字`
          : "なし";
    const attachmentJa =
      rule.attachment === "file"
        ? "ファイル"
        : rule.attachment === "meta"
          ? "メタ情報"
          : "なし";
    const sealithJa =
      rule.sealith === "off" ? "オフ" : rule.sealith === "suggest" ? "推奨" : "必須";
    const approvalJa = rule.attachmentApproval === "manager" ? " (上長承認)" : "";
    parts.push(`${applyToJa}: 本文=${bodyJa}, 添付=${attachmentJa}${approvalJa}, Sealith=${sealithJa}`);
  }
  const hasHighRisk = policyHasHighRiskAutomation(policy);
  const hasConsent = hasHighRiskConsentRecorded(policy);
  if (hasHighRisk && hasConsent) {
    parts.push("【高リスク承諾済】");
  } else if (hasHighRisk) {
    parts.push("【高リスク警告】");
  }
  return parts.join(" / ");
}

export function nextStepIngressHandoffJa(policy: OrgIngressHandoffPolicy): string {
  if (isDefaultIngressHandoffPolicy(policy)) {
    return "デフォルトの便利設定です。外部/機密チャネルにはルールを追加してください。AI社員ごとにオーバーライドも可能です。";
  }
  const hasHighRisk = policyHasHighRiskAutomation(policy);
  const hasConsent = hasHighRiskConsentRecorded(policy);
  if (hasHighRisk && !hasConsent) {
    return "【高リスク警告】外部/機密チャネルに対してファイル本体をSealithなしで渡す設定があります。テナント承諾 (highRiskConsentAt/By) が必要です。";
  }
  const hasSealithRequired = policy.rules.some((r) => r.sealith === "required");
  const hasManagerApproval = policy.rules.some((r) => r.attachmentApproval === "manager");
  if (hasSealithRequired) {
    return "Sealith必須ルールがあります。暗号化受け渡しの設定を確認してください。AI社員ごとにオーバーライドも可能です。";
  }
  if (hasManagerApproval) {
    return "上長承認ルールがあります。添付ファイルは承認後に渡されます（fail-closed）。AI社員ごとにオーバーライドも可能です。";
  }
  return "ルール設定完了。チャネル分類と連動します。AI社員ごとにオーバーライドも可能です。";
}
