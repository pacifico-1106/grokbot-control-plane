/**
 * approvalReasons[] (木村 2026-10-09 B; triage #3 / ともり T1).
 *
 * Every reason a request went to human approval, as structured data — not
 * just the first one — computed by the gateway only (never taken from the
 * request), stored on the ticket (metadata.approvalReasons), returned in the
 * needs_approval answer, and rendered as ONE card line on every surface
 * (Slack / LINE / Telegram / Web) so the approver and the AI see the same
 * thing. Behind APPROVAL_REASONS_ENABLED (default OFF).
 *
 * Content rules: codes, tenant-configured topic words, class / audience
 * labels and fixed Japanese sentences only. Never the message body, tokens,
 * credentials or anything else from the request.
 *
 * This module only DESCRIBES the decision. It never changes it: the class
 * the AI asked for can only raise severity (information-class.ts), and the
 * topic gate / always_human / limits are evaluated elsewhere, unchanged.
 */
import type { ActionLimitResult } from "@/lib/action-gate";
import { isApprovalReasonsEnabled } from "@/lib/feature-flags";
import type { EgressVerdict, InformationClass } from "@/lib/types";

export const APPROVAL_REASONS_CARD_MAX_CHARS = 300;
const MAX_REASONS = 10;
const MAX_TOPICS = 10;
const MAX_TOPIC_CHARS = 40;
const MAX_TEXT_CHARS = 200;

const CLASS_RANK: Record<InformationClass, number> = { public: 0, internal: 1, confidential: 2, verbatim: 3 };
const CLASSES = Object.keys(CLASS_RANK) as InformationClass[];

export const AI_CANNOT_LOWER_NOTE_JA =
  "情報区分は宛先と扱う情報から Staffpass が決めます。AI の指定では下げられません（上げることはできます）。";

export type AlwaysHumanSource = "employee_policy" | "tool_setting" | "tool_default";

export type ApprovalReason =
  | { code: "topic_gate"; topics: string[]; scope: "main_board" | "any_channel"; messageJa: string }
  | {
      code: "egress";
      reason: string;
      informationClass: InformationClass;
      fidelity: "summary" | "source";
      audience: "internal" | "external";
      aiCannotLower: true;
      requestedInformationClass?: InformationClass;
      noteJa: string;
      messageJa: string;
    }
  | { code: "always_human"; source: AlwaysHumanSource; messageJa: string }
  | {
      code: "action_limit";
      reason: string;
      limit?: { period: "day" | "month"; value: number; count: number };
      messageJa: string;
    }
  | { code: "spend"; reason: string; messageJa: string }
  | { code: "mail_policy"; messageJa: string };

export type ApprovalReasonCode = ApprovalReason["code"];

export type BuildApprovalReasonsInput = {
  topicGate?: { requiresApproval: boolean; matchedTopics: string[]; reason: string } | null;
  egress?: EgressVerdict | null;
  employeeAlwaysHuman?: boolean;
  toolAlwaysHuman?: "tool_setting" | "tool_default" | null;
  actionLimit?: Pick<ActionLimitResult, "decision" | "reason" | "message" | "limit"> | null;
  spend?: { decision: string; reason: string; message: string } | null;
  mailPolicyForceApproval?: boolean;
  /** What the AI asked for (body / args). Echoed only when it was LOWER than the result. */
  requestedInformationClass?: InformationClass | null;
};

function clipText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("")}…`;
}

function cleanTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (!t) continue;
    out.push(clipText(t, MAX_TOPIC_CHARS));
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

const ALWAYS_HUMAN_LABEL_JA: Record<AlwaysHumanSource, string> = {
  employee_policy: "社員の承認ポリシー",
  tool_setting: "ツール設定",
  tool_default: "ツールの既定",
};

/** All reasons, fixed order: topic_gate, egress, always_human, action_limit, spend, mail_policy. */
export function buildApprovalReasons(input: BuildApprovalReasonsInput): ApprovalReason[] {
  const reasons: ApprovalReason[] = [];
  const tg = input.topicGate;
  if (tg?.requiresApproval) {
    const topics = cleanTopics(tg.matchedTopics);
    reasons.push({
      code: "topic_gate",
      topics,
      scope: tg.reason === "main_board_sensitive_topic" ? "main_board" : "any_channel",
      messageJa: `機密話題（${topics.join(", ")}）を含むため承認が必要です。`,
    });
  }
  const eg = input.egress;
  if (eg && eg.decision === "needs_approval") {
    const requested = input.requestedInformationClass;
    const lower = requested && CLASSES.includes(requested) && CLASS_RANK[requested] < CLASS_RANK[eg.informationClass];
    reasons.push({
      code: "egress",
      reason: eg.reason,
      informationClass: eg.informationClass,
      fidelity: eg.fidelity,
      audience: eg.effectiveAudience,
      aiCannotLower: true,
      ...(lower ? { requestedInformationClass: requested } : {}),
      noteJa: AI_CANNOT_LOWER_NOTE_JA,
      messageJa: clipText(eg.messageJa, MAX_TEXT_CHARS),
    });
  }
  const humanSource: AlwaysHumanSource | null = input.employeeAlwaysHuman
    ? "employee_policy"
    : input.toolAlwaysHuman ?? null;
  if (humanSource) {
    reasons.push({
      code: "always_human",
      source: humanSource,
      messageJa: `${ALWAYS_HUMAN_LABEL_JA[humanSource]}で「常に人の承認」になっています。`,
    });
  }
  const al = input.actionLimit;
  if (al && al.decision === "needs_approval") {
    reasons.push({
      code: "action_limit",
      reason: al.reason,
      ...(al.limit ? { limit: { period: al.limit.period, value: al.limit.value, count: al.limit.count } } : {}),
      messageJa: clipText(al.message, MAX_TEXT_CHARS),
    });
  }
  const sp = input.spend;
  if (sp && sp.decision === "needs_approval") {
    reasons.push({ code: "spend", reason: sp.reason, messageJa: clipText(sp.message, MAX_TEXT_CHARS) });
  }
  if (input.mailPolicyForceApproval) {
    reasons.push({ code: "mail_policy", messageJa: "メールポリシーで承認が必要な宛先・内容です。" });
  }
  return reasons;
}

function str(value: unknown, max = MAX_TEXT_CHARS): string | null {
  return typeof value === "string" && value.trim() ? clipText(value, max) : null;
}

function readOne(raw: unknown): ApprovalReason | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const messageJa = str(r.messageJa);
  if (!messageJa) return null;
  switch (r.code) {
    case "topic_gate": {
      if (!Array.isArray(r.topics)) return null;
      const scope = r.scope === "main_board" ? "main_board" : r.scope === "any_channel" ? "any_channel" : null;
      if (!scope) return null;
      return { code: "topic_gate", topics: cleanTopics(r.topics), scope, messageJa };
    }
    case "egress": {
      const reason = str(r.reason, 64);
      const cls = CLASSES.includes(r.informationClass as InformationClass) ? (r.informationClass as InformationClass) : null;
      const fidelity = r.fidelity === "summary" || r.fidelity === "source" ? r.fidelity : null;
      const audience = r.audience === "internal" || r.audience === "external" ? r.audience : null;
      if (!reason || !cls || !fidelity || !audience) return null;
      const requested = CLASSES.includes(r.requestedInformationClass as InformationClass)
        ? (r.requestedInformationClass as InformationClass)
        : null;
      return {
        code: "egress",
        reason,
        informationClass: cls,
        fidelity,
        audience,
        aiCannotLower: true,
        ...(requested ? { requestedInformationClass: requested } : {}),
        noteJa: AI_CANNOT_LOWER_NOTE_JA,
        messageJa,
      };
    }
    case "always_human": {
      const source = r.source === "employee_policy" || r.source === "tool_setting" || r.source === "tool_default" ? r.source : null;
      return source ? { code: "always_human", source, messageJa } : null;
    }
    case "action_limit": {
      const reason = str(r.reason, 64);
      if (!reason) return null;
      const l = r.limit as Record<string, unknown> | undefined;
      const limit =
        l && (l.period === "day" || l.period === "month") && Number.isFinite(l.value) && Number.isFinite(l.count)
          ? { period: l.period as "day" | "month", value: Number(l.value), count: Number(l.count) }
          : null;
      return { code: "action_limit", reason, ...(limit ? { limit } : {}), messageJa };
    }
    case "spend": {
      const reason = str(r.reason, 64);
      return reason ? { code: "spend", reason, messageJa } : null;
    }
    case "mail_policy":
      return { code: "mail_policy", messageJa };
    default:
      return null;
  }
}

/** Strict reader for stored metadata: known codes and fields only, at most 10. Absent / not an array → null. */
export function readApprovalReasons(metadata: unknown): ApprovalReason[] | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).approvalReasons;
  if (!Array.isArray(raw)) return null;
  const out: ApprovalReason[] = [];
  for (const item of raw) {
    const read = readOne(item);
    if (read) out.push(read);
    if (out.length >= MAX_REASONS) break;
  }
  return out;
}

const AUDIENCE_JA = { internal: "社内宛て", external: "社外宛て" } as const;

function partJa(reason: ApprovalReason): string {
  switch (reason.code) {
    case "topic_gate":
      return `機密話題（${reason.topics.join(", ")}）`;
    case "egress":
      return `情報区分 ${reason.informationClass}（${AUDIENCE_JA[reason.audience]}・AIの指定では下げられません）`;
    case "always_human":
      return `常に人の承認（${ALWAYS_HUMAN_LABEL_JA[reason.source]}）`;
    case "action_limit":
      return reason.limit
        ? `行為上限（${reason.limit.period === "day" ? "本日" : "今月"} ${reason.limit.count}/${reason.limit.value} 件）`
        : "行為上限";
    case "spend":
      return "発注金額の条件";
    case "mail_policy":
      return "メールポリシー";
  }
}

/** One line for every card surface; bounded to APPROVAL_REASONS_CARD_MAX_CHARS. */
export function approvalReasonsCardLine(reasons: ApprovalReason[]): string {
  return clipText(`承認が必要な理由: ${reasons.map(partJa).join("／")}`, APPROVAL_REASONS_CARD_MAX_CHARS);
}

/** Card line from ticket metadata; null when the flag is OFF or there is nothing to show. */
export function cardApprovalReasonsLine(metadata: unknown): string | null {
  if (!isApprovalReasonsEnabled()) return null;
  const reasons = readApprovalReasons(metadata);
  if (!reasons || reasons.length === 0) return null;
  return approvalReasonsCardLine(reasons);
}
