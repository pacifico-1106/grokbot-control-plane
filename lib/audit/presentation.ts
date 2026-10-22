import { isAuditPageSixFieldEnabledForOrg } from "@/lib/feature-flags";
import type { AuditEvent } from "@/lib/types";
import { resolveAuditActor } from "./actor";
import { refineResultWithApproval, resolveAuditApproval } from "./approval";
import { auditOperationLabelJa } from "./labels-ja";
import {
  clipAuditText,
  isEmailLike,
  OPAQUE_AUDIT_ID_RE,
  opaqueAuditId,
  sanitizeAuditDisplayText,
} from "./mask";
import { classifyAuditResult, presentStoredSixFieldResult } from "./result";
import type {
  AuditPresentationLookups,
  AuditRowView,
  AuditSafeMeta,
  AuditTargetKind,
  AuditTargetView,
} from "./types";

export const AUDIT_SUMMARY_LIST_MAX = 80;
export const AUDIT_SUMMARY_DETAIL_MAX = 200;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function metaRecord(event: AuditEvent): Record<string, unknown> {
  return event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
}

function conversationSurface(meta: Record<string, unknown>): string | null {
  const direct = asString(meta.surface);
  if (direct) return direct;
  const conversation = meta.conversation;
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    return asString((conversation as Record<string, unknown>).surface);
  }
  return asString(meta.destinationSurface);
}

export function formatAuditJst(iso: string, withSeconds = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  });
  return `${fmt.format(d).replace(", ", " ")} JST`;
}

function prefixId(id: string | null): string | null {
  if (!id) return null;
  return id.length <= 8 ? id : id.slice(0, 8);
}

function safeMetaText(value: string | null): string | null {
  if (!value) return null;
  const cleaned = clipAuditText(sanitizeAuditDisplayText(value), 80);
  return cleaned || null;
}

function presentSafeMeta(event: AuditEvent, meta: Record<string, unknown>): AuditSafeMeta {
  const approvalId = opaqueAuditId(asString(meta.approvalId) ?? asString(meta.approval_id));
  return {
    purpose: safeMetaText(event.purpose) ?? safeMetaText(asString(meta.purpose)),
    jobId: opaqueAuditId(asString(meta.jobId) ?? asString(meta.job_id)),
    risk: opaqueAuditId(asString(meta.risk)),
    informationClass: opaqueAuditId(asString(meta.informationClass) ?? asString(meta.information_class)),
    audience: safeMetaText(asString(meta.audience)),
    approvalIdPrefix: prefixId(approvalId),
  };
}

function presentTargetPlaceholder(): AuditTargetView {
  return { kind: "none", labelJa: "—", rawId: null };
}

const TARGET_TYPE_JA: Record<string, { kind: AuditTargetKind; labelJa: string }> = {
  employee: { kind: "employee", labelJa: "社員" },
  member: { kind: "member", labelJa: "メンバー" },
  org: { kind: "other", labelJa: "組織" },
  org_internal_audience_rule: { kind: "other", labelJa: "社内相手ルール" },
  approval: { kind: "other", labelJa: "承認票" },
  channel: { kind: "slack_channel", labelJa: "チャネル" },
  slack_channel: { kind: "slack_channel", labelJa: "チャネル" },
  party: { kind: "other", labelJa: "相手" },
  credential: { kind: "other", labelJa: "認証" },
  mailbox: { kind: "email", labelJa: "メールボックス" },
  notification_channel: { kind: "other", labelJa: "通知チャネル" },
  admin_agent: { kind: "other", labelJa: "管理エージェント" },
};

function presentStoredTarget(
  event: AuditEvent,
  meta: Record<string, unknown>,
  lookups: AuditPresentationLookups
): AuditTargetView {
  if (!isAuditPageSixFieldEnabledForOrg(event.orgId)) return presentTargetPlaceholder();
  const raw = meta.target;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return presentTargetPlaceholder();
  const type = asString((raw as Record<string, unknown>).type);
  const id = asString((raw as Record<string, unknown>).id);
  if (!type || !id) return presentTargetPlaceholder();
  if (
    type === "email" ||
    type.includes("@") ||
    id.includes("@") ||
    isEmailLike(type) ||
    isEmailLike(id) ||
    !OPAQUE_AUDIT_ID_RE.test(type)
  ) {
    return presentTargetPlaceholder();
  }
  const mapped = TARGET_TYPE_JA[type] ?? {
    kind: "other" as const,
    labelJa: sanitizeAuditDisplayText(type).trim() || "対象",
  };
  let labelJa = mapped.labelJa;
  const opaqueId = opaqueAuditId(id);
  if (mapped.kind === "employee" && opaqueId) {
    const emp = lookups.employeesById?.get(opaqueId);
    const name = emp?.displayName ? sanitizeAuditDisplayText(emp.displayName).trim() : "";
    if (name) labelJa = `社員（${name}）`;
  }
  return {
    kind: mapped.kind,
    labelJa,
    rawId: opaqueId ? (opaqueId.length > 8 ? opaqueId.slice(0, 8) : opaqueId) : null,
  };
}

export function presentAuditRow(
  event: AuditEvent,
  lookups: AuditPresentationLookups = {}
): AuditRowView {
  const meta = metaRecord(event);
  const tool = asString(meta.tool) ?? asString(meta.adminTool);
  const action = auditOperationLabelJa({
    action: event.action,
    tool,
    surface: conversationSurface(meta),
  });
  const cleaned = sanitizeAuditDisplayText(event.summary ?? "");
  const approval = resolveAuditApproval(event, lookups);
  const inferred = refineResultWithApproval(classifyAuditResult(event), approval);
  const stored = isAuditPageSixFieldEnabledForOrg(event.orgId)
    ? presentStoredSixFieldResult(meta)
    : null;
  const view: AuditRowView = {
    id: event.id,
    createdAt: event.createdAt,
    createdAtJst: formatAuditJst(event.createdAt, false),
    createdAtJstPrecise: formatAuditJst(event.createdAt, true),
    actor: resolveAuditActor(event, lookups),
    action,
    target: presentStoredTarget(event, meta, lookups),
    summary: clipAuditText(cleaned, AUDIT_SUMMARY_LIST_MAX),
    summaryDetail: clipAuditText(cleaned, AUDIT_SUMMARY_DETAIL_MAX),
    approval,
    result: stored ?? inferred,
    safeMeta: presentSafeMeta(event, meta),
  };
  return view;
}

export function presentAuditRows(
  events: AuditEvent[],
  lookups: AuditPresentationLookups = {}
): AuditRowView[] {
  const orgId = lookups.orgId;
  return events
    .filter((event) => !orgId || event.orgId === orgId)
    .map((event) => presentAuditRow(event, lookups));
}
