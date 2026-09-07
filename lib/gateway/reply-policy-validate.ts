/**
 * B2 reply policy validation and normalization.
 * Mirrors A1 scheduling.policy / F1 mouth-routing validation pattern.
 * Fail-closed: missing/conflicting rules → draft only / hold for approval.
 */
import type {
  AfterHoursMode,
  BusinessHoursWindow,
  ConversationSurface,
  EmojiMode,
  OrgReplyPolicy,
  ReplyPolicyRule,
  ShortReplyMode,
  ThreadAffinityMode,
} from "@/lib/types";

const CONVERSATION_SURFACES: ConversationSurface[] = ["slack", "line", "mail", "phone", "web"];
const AFTER_HOURS_MODES: AfterHoursMode[] = ["draft_only", "allow_send", "hold_approval"];
const SHORT_REPLY_MODES: ShortReplyMode[] = ["allow", "deny", "warn"];
const EMOJI_MODES: EmojiMode[] = ["allow", "deny", "limited"];
const THREAD_AFFINITY_MODES: ThreadAffinityMode[] = ["prefer_thread", "new_thread_per_topic", "channel_root"];

export type ValidationError = {
  ruleIndex?: number;
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ValidationResult =
  | { ok: true; policy: OrgReplyPolicy }
  | { ok: false; errors: ValidationError[] };

function generateRuleId(): string {
  return `rpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function generatePolicyId(): string {
  return `rpp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function isAfterHoursMode(value: unknown): value is AfterHoursMode {
  return typeof value === "string" && AFTER_HOURS_MODES.includes(value as AfterHoursMode);
}

function isShortReplyMode(value: unknown): value is ShortReplyMode {
  return typeof value === "string" && SHORT_REPLY_MODES.includes(value as ShortReplyMode);
}

function isEmojiMode(value: unknown): value is EmojiMode {
  return typeof value === "string" && EMOJI_MODES.includes(value as EmojiMode);
}

function isThreadAffinityMode(value: unknown): value is ThreadAffinityMode {
  return typeof value === "string" && THREAD_AFFINITY_MODES.includes(value as ThreadAffinityMode);
}

function isConversationSurface(value: unknown): value is ConversationSurface {
  return typeof value === "string" && CONVERSATION_SURFACES.includes(value as ConversationSurface);
}

function isValidBusinessHours(value: unknown): value is BusinessHoursWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.dayOfWeek)) return false;
  if (!rec.dayOfWeek.every((d) => typeof d === "number" && d >= 0 && d <= 6)) return false;
  if (typeof rec.startTime !== "string" || !/^\d{2}:\d{2}$/.test(rec.startTime)) return false;
  if (typeof rec.endTime !== "string" || !/^\d{2}:\d{2}$/.test(rec.endTime)) return false;
  return true;
}

export function validateReplyPolicyRule(
  raw: unknown,
  index: number
): { ok: true; rule: ReplyPolicyRule } | { ok: false; errors: ValidationError[] } {
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

  const rule: ReplyPolicyRule = {
    id,
    afterHoursMode: "draft_only",
    shortReplyMode: "allow",
    emojiMode: "limited",
    threadAffinity: "prefer_thread",
  };

  if (typeof rec.priority === "number") {
    rule.priority = rec.priority;
  }

  if (rec.surface !== undefined) {
    if (!isConversationSurface(rec.surface)) {
      errors.push({
        ruleIndex: index,
        field: "surface",
        code: "invalid_surface",
        message: `surface must be one of: ${CONVERSATION_SURFACES.join(", ")}`,
        messageJa: `surfaceは ${CONVERSATION_SURFACES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.surface = rec.surface;
    }
  }

  if (rec.afterHoursMode !== undefined) {
    if (!isAfterHoursMode(rec.afterHoursMode)) {
      errors.push({
        ruleIndex: index,
        field: "afterHoursMode",
        code: "invalid_after_hours_mode",
        message: `afterHoursMode must be one of: ${AFTER_HOURS_MODES.join(", ")}`,
        messageJa: `営業時間外モードは ${AFTER_HOURS_MODES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.afterHoursMode = rec.afterHoursMode;
    }
  }

  if (rec.businessHours !== undefined) {
    if (!isValidBusinessHours(rec.businessHours)) {
      errors.push({
        ruleIndex: index,
        field: "businessHours",
        code: "invalid_business_hours",
        message: "businessHours must have dayOfWeek (0-6 array), startTime (HH:MM), endTime (HH:MM)",
        messageJa: "営業時間は dayOfWeek (0-6配列)、startTime (HH:MM)、endTime (HH:MM) が必要です",
      });
    } else {
      rule.businessHours = rec.businessHours as BusinessHoursWindow;
    }
  }

  if (rec.shortReplyMode !== undefined) {
    if (!isShortReplyMode(rec.shortReplyMode)) {
      errors.push({
        ruleIndex: index,
        field: "shortReplyMode",
        code: "invalid_short_reply_mode",
        message: `shortReplyMode must be one of: ${SHORT_REPLY_MODES.join(", ")}`,
        messageJa: `短文返信モードは ${SHORT_REPLY_MODES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.shortReplyMode = rec.shortReplyMode;
    }
  }

  if (typeof rec.shortReplyMinChars === "number") {
    if (rec.shortReplyMinChars < 1 || rec.shortReplyMinChars > 1000) {
      errors.push({
        ruleIndex: index,
        field: "shortReplyMinChars",
        code: "invalid_short_reply_min_chars",
        message: "shortReplyMinChars must be between 1 and 1000",
        messageJa: "短文の最小文字数は1〜1000の範囲です",
      });
    } else {
      rule.shortReplyMinChars = rec.shortReplyMinChars;
    }
  }

  if (rec.emojiMode !== undefined) {
    if (!isEmojiMode(rec.emojiMode)) {
      errors.push({
        ruleIndex: index,
        field: "emojiMode",
        code: "invalid_emoji_mode",
        message: `emojiMode must be one of: ${EMOJI_MODES.join(", ")}`,
        messageJa: `絵文字モードは ${EMOJI_MODES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.emojiMode = rec.emojiMode;
    }
  }

  if (Array.isArray(rec.allowedEmojis)) {
    if (!rec.allowedEmojis.every((e) => typeof e === "string")) {
      errors.push({
        ruleIndex: index,
        field: "allowedEmojis",
        code: "invalid_allowed_emojis",
        message: "allowedEmojis must be an array of strings",
        messageJa: "許可絵文字は文字列の配列です",
      });
    } else {
      rule.allowedEmojis = rec.allowedEmojis as string[];
    }
  }

  if (rec.threadAffinity !== undefined) {
    if (!isThreadAffinityMode(rec.threadAffinity)) {
      errors.push({
        ruleIndex: index,
        field: "threadAffinity",
        code: "invalid_thread_affinity",
        message: `threadAffinity must be one of: ${THREAD_AFFINITY_MODES.join(", ")}`,
        messageJa: `スレッド親和性は ${THREAD_AFFINITY_MODES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.threadAffinity = rec.threadAffinity;
    }
  }

  if (typeof rec.topicChangeThreshold === "number") {
    if (rec.topicChangeThreshold < 0 || rec.topicChangeThreshold > 1) {
      errors.push({
        ruleIndex: index,
        field: "topicChangeThreshold",
        code: "invalid_topic_change_threshold",
        message: "topicChangeThreshold must be between 0 and 1",
        messageJa: "トピック変更閾値は0〜1の範囲です",
      });
    } else {
      rule.topicChangeThreshold = rec.topicChangeThreshold;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rule };
}

export interface ValidateReplyPolicyOptions {
  requireHighRiskConsent?: boolean;
  existingConsent?: { at: string; by: string } | null;
}

export function validateReplyPolicy(
  input: unknown,
  options: ValidateReplyPolicyOptions = {}
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
      : "既定の返信ポリシー";

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

  const validatedRules: ReplyPolicyRule[] = [];
  let hasRiskyRule = false;

  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateReplyPolicyRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
      if (result.rule.afterHoursMode === "allow_send") {
        hasRiskyRule = true;
      }
    } else {
      errors.push(...result.errors);
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
          "Enabling allow_send after hours requires explicit tenant consent",
        messageJa:
          "営業時間外の自動送信にはテナントの明示的な承諾が必要です",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const policy: OrgReplyPolicy = {
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

export const DEFAULT_REPLY_POLICY_RULE: ReplyPolicyRule = {
  id: "rpr_default",
  afterHoursMode: "draft_only",
  shortReplyMode: "allow",
  emojiMode: "limited",
  threadAffinity: "prefer_thread",
};

export function defaultReplyPolicy(): OrgReplyPolicy {
  return {
    version: 1,
    policyId: generatePolicyId(),
    policyName: "既定の返信ポリシー",
    rules: [{ ...DEFAULT_REPLY_POLICY_RULE, id: generateRuleId() }],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function normalizeReplyPolicy(value: unknown): OrgReplyPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultReplyPolicy();
  }
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.rules) || rec.rules.length === 0) {
    return defaultReplyPolicy();
  }

  const validatedRules: ReplyPolicyRule[] = [];
  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateReplyPolicyRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
    }
  }

  if (validatedRules.length === 0) {
    return defaultReplyPolicy();
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
        : "返信ポリシー",
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

export function isDefaultReplyPolicy(policy: OrgReplyPolicy): boolean {
  if (policy.rules.length !== 1) return false;
  const rule = policy.rules[0];
  return (
    rule.afterHoursMode === "draft_only" &&
    rule.shortReplyMode === "allow" &&
    rule.emojiMode === "limited" &&
    rule.threadAffinity === "prefer_thread"
  );
}

export function policyHasHighRiskAutoSend(policy: OrgReplyPolicy): boolean {
  return policy.rules.some((r) => r.afterHoursMode === "allow_send");
}

export function summarizeReplyPolicyJa(policy: OrgReplyPolicy): string {
  if (policy.rules.length === 0) return "ルールなし";
  if (isDefaultReplyPolicy(policy)) {
    return "デフォルト: 営業時間外は下書きのみ、絵文字制限、スレッド優先";
  }

  const parts: string[] = [];
  for (const rule of policy.rules) {
    const surfaceJa = rule.surface ? `${rule.surface}: ` : "";
    const afterHoursJa =
      rule.afterHoursMode === "draft_only"
        ? "時間外は下書き"
        : rule.afterHoursMode === "allow_send"
          ? "時間外も送信"
          : "時間外は承認必須";
    const emojiJa =
      rule.emojiMode === "allow"
        ? "絵文字OK"
        : rule.emojiMode === "deny"
          ? "絵文字禁止"
          : "絵文字制限";
    const threadJa =
      rule.threadAffinity === "prefer_thread"
        ? "スレッド優先"
        : rule.threadAffinity === "new_thread_per_topic"
          ? "トピック別スレッド"
          : "チャネル直接";
    parts.push(`${surfaceJa}${afterHoursJa} / ${emojiJa} / ${threadJa}`);
  }
  return parts.join(" → ");
}

export function nextStepReplyPolicyJa(policy: OrgReplyPolicy): string {
  if (isDefaultReplyPolicy(policy)) {
    return "デフォルトの安全設定です。営業時間外は下書きのみ、絵文字は制限、返信はスレッド優先です。";
  }

  const hasRiskyRule = policyHasHighRiskAutoSend(policy);
  if (hasRiskyRule) {
    if (!policy.highRiskConsentAt) {
      return "営業時間外の自動送信が許可されていますが、テナント承諾が未記録です。";
    }
    return `営業時間外の自動送信が有効です（承諾: ${policy.highRiskConsentBy} / ${policy.highRiskConsentAt}）。運用に注意してください。`;
  }

  return "返信ポリシー設定完了。Slack/LINE返信時に適用されます。";
}
