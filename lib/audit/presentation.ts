import type { AuditEvent } from "@/lib/types";
import { resolveAuditActor } from "./actor";
import { refineResultWithApproval, resolveAuditApproval } from "./approval";
import { auditOperationLabelJa } from "./labels-ja";
import { clipAuditText, opaqueAuditId, sanitizeAuditDisplayText } from "./mask";
import { classifyAuditResult } from "./result";
import type {
  AuditPresentationLookups,
  AuditRowView,
  AuditSafeMeta,
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
  const view: AuditRowView = {
    id: event.id,
    createdAt: event.createdAt,
    createdAtJst: formatAuditJst(event.createdAt, false),
    createdAtJstPrecise: formatAuditJst(event.createdAt, true),
    actor: resolveAuditActor(event, lookups),
    action,
    target: presentTargetPlaceholder(),
    summary: clipAuditText(cleaned, AUDIT_SUMMARY_LIST_MAX),
    summaryDetail: clipAuditText(cleaned, AUDIT_SUMMARY_DETAIL_MAX),
    approval,
    result: refineResultWithApproval(classifyAuditResult(event), approval),
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
