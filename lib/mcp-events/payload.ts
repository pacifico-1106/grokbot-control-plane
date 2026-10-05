/**
 * Event bodies: ids + status only (spec "Payload Minimality"; no secrets, no
 * approval content, no model instructions). One event per request, ≤ 256 KiB.
 */
import type { ApprovalRequest } from "@/lib/types";
import { parseFulfillment } from "@/lib/approvals/fulfill";
import type { McpEventName } from "./catalog";

const SAFE_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;
const safeId = (v: unknown): string | null => (typeof v === "string" && SAFE_ID.test(v) ? v : null);

export type ExpiredReason = "ttl_elapsed" | "deadline_exceeded" | "closed_at_fulfil";

export type ApprovalEventData =
  | {
      approvalId: string; employeeId: string; jobId: string | null; tool: string | null; risk: string;
      status: string; decidedAt: string | null;
      fulfillment: "server_completed" | "server_failed" | "not_attempted" | "not_applicable";
    }
  | {
      approvalId: string; employeeId: string; jobId: string | null; tool: string | null; risk: string;
      status: string; reason: ExpiredReason; expiredAt: string;
    };

export function eventStatus(approval: ApprovalRequest, name: McpEventName): string {
  if (name === "approval.expired") return approval.status === "rejected" ? "rejected" : "expired";
  return approval.status;
}

export function buildApprovalEventData(
  approval: ApprovalRequest,
  name: McpEventName,
  opts: { reason?: ExpiredReason; nowIso: string }
): ApprovalEventData {
  const base = {
    approvalId: approval.id,
    employeeId: approval.employeeId,
    jobId: safeId(approval.jobId),
    tool: safeId(approval.tool),
    risk: approval.risk,
  };
  if (name === "approval.expired") {
    return { ...base, status: eventStatus(approval, name), reason: opts.reason ?? "ttl_elapsed", expiredAt: opts.nowIso };
  }
  let fulfillment: "server_completed" | "server_failed" | "not_attempted" | "not_applicable" = "not_applicable";
  if (approval.status === "approved") {
    const f = parseFulfillment(approval.metadata);
    fulfillment = f ? (f.ok ? "server_completed" : "server_failed") : "not_attempted";
  }
  return { ...base, status: approval.status, decidedAt: approval.resolvedAt ?? null, fulfillment };
}

export function buildEventBody(input: { eventId: string; name: McpEventName; timestampIso: string; data: ApprovalEventData }): string {
  return JSON.stringify({ eventId: input.eventId, name: input.name, timestamp: input.timestampIso, data: input.data, cursor: null });
}
