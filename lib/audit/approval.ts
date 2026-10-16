import type { AuditEvent } from "@/lib/types";
import { presentNamedPerson } from "./actor";
import { opaqueAuditId } from "./mask";
import type {
  AuditApprovalLookup,
  AuditApprovalStatus,
  AuditApprovalView,
  AuditPresentationLookups,
  AuditResultView,
} from "./types";

const READ_OR_PING = new Set([
  "tools.ping",
  "tools.read",
  "calendar.read",
  "calendar.freebusy_read",
  "files.read",
  "knowledge.search",
  "staffpass_whoami",
  "staffpass_health",
  "staffpass_get_approval_status",
  "staffpass_sensitive_topics",
  "staffpass_profile",
]);

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

export function jobEmployeeKey(jobId: string, employeeId: string | null | undefined): string {
  return `${jobId}::${employeeId ?? ""}`;
}

export function ticketToAuditApprovalLookup(ticket: {
  id: string;
  orgId: string;
  status: string;
  resolvedBy?: string | null;
  employeeId?: string | null;
  jobId?: string | null;
}): AuditApprovalLookup {
  return {
    id: ticket.id,
    orgId: ticket.orgId,
    status: ticket.status,
    resolvedBy: ticket.resolvedBy ?? null,
    employeeId: ticket.employeeId ?? null,
    jobId: ticket.jobId ?? null,
  };
}

export function indexApprovalsForOrg(
  orgId: string,
  tickets: readonly AuditApprovalLookup[]
): Pick<AuditPresentationLookups, "approvalsById" | "approvalsByJobEmployee"> {
  const byId = new Map<string, AuditApprovalLookup>();
  const buckets = new Map<string, AuditApprovalLookup[]>();
  for (const ticket of tickets) {
    if (!ticket.id || ticket.orgId !== orgId) continue;
    byId.set(ticket.id, ticket);
    if (ticket.jobId) {
      const key = jobEmployeeKey(ticket.jobId, ticket.employeeId);
      const list = buckets.get(key) ?? [];
      list.push(ticket);
      buckets.set(key, list);
    }
  }
  const byJobEmployee = new Map<string, readonly AuditApprovalLookup[]>();
  for (const [key, list] of buckets) {
    if (list.length === 1) byJobEmployee.set(key, list);
  }
  return { approvalsById: byId, approvalsByJobEmployee: byJobEmployee };
}

function mapTicketStatus(status: string): AuditApprovalStatus {
  if (status === "pending") return "pending";
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "expired") return "expired";
  if (status === "revision_requested") return "revision_requested";
  return "unknown";
}

function eventApprovalId(event: AuditEvent): string | null {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return asString((meta as Record<string, unknown>).approvalId) ?? asString((meta as Record<string, unknown>).approval_id);
}

function eventJobId(event: AuditEvent): string | null {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return asString((meta as Record<string, unknown>).jobId) ?? asString((meta as Record<string, unknown>).job_id);
}

function eventTool(event: AuditEvent): string {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return asString((meta as Record<string, unknown>).tool) ?? event.action;
}

function pickTicket(event: AuditEvent, lookups: AuditPresentationLookups): AuditApprovalLookup | null {
  const orgId = lookups.orgId ?? event.orgId;
  const byId = eventApprovalId(event);
  if (byId) {
    const row = lookups.approvalsById?.get(byId) ?? null;
    if (!row || row.orgId !== orgId || row.orgId !== event.orgId) return null;
    return row;
  }
  const jobId = eventJobId(event);
  if (!jobId || !event.employeeId) return null;
  const list = lookups.approvalsByJobEmployee?.get(jobEmployeeKey(jobId, event.employeeId)) ?? [];
  if (list.length !== 1) return null;
  const row = list[0];
  if (!row || row.orgId !== orgId || row.orgId !== event.orgId) return null;
  return row;
}

export function resolveAuditApproval(
  event: AuditEvent,
  lookups: AuditPresentationLookups = {}
): AuditApprovalView {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const approvalId = opaqueAuditId(eventApprovalId(event));
  const ticket = pickTicket(event, lookups);
  const tool = eventTool(event);
  const auto = (meta as Record<string, unknown>).auto === true;

  if (ticket) {
    const status = mapTicketStatus(ticket.status);
    const resolvedRaw =
      ticket.resolvedBy ?? asString((meta as Record<string, unknown>).resolvedBy);
    const person = presentNamedPerson(resolvedRaw, lookups);
    return {
      needed: true,
      approvalId: opaqueAuditId(ticket.id),
      status,
      approverName: status === "approved" || status === "rejected" ? person.name : null,
      approverEmailMasked:
        status === "approved" || status === "rejected" ? person.emailMasked : null,
    };
  }

  if (event.action === "approval.requested" || event.action === "topic_gate.triggered") {
    return {
      needed: true,
      approvalId,
      status: "pending",
      approverName: null,
      approverEmailMasked: null,
    };
  }
  if (event.action === "approval.revision_requested") {
    return { needed: true, approvalId, status: "revision_requested", approverName: null, approverEmailMasked: null };
  }
  if (event.action === "approval.expired") {
    return { needed: true, approvalId, status: "expired", approverName: null, approverEmailMasked: null };
  }
  if (event.action === "approval.resolved") {
    const decision = asString((meta as Record<string, unknown>).decision);
    const resolvedRaw = asString((meta as Record<string, unknown>).resolvedBy);
    const person = presentNamedPerson(resolvedRaw, lookups);
    const status: AuditApprovalStatus =
      decision === "rejected" ? "rejected" : decision === "expired" ? "expired" : "approved";
    return {
      needed: true,
      approvalId,
      status,
      approverName: person.name,
      approverEmailMasked: person.emailMasked,
    };
  }

  if ((auto && !eventApprovalId(event)) || READ_OR_PING.has(tool)) {
    return { needed: false, approvalId: null, status: "none", approverName: null, approverEmailMasked: null };
  }

  return {
    needed: null,
    approvalId,
    status: "unknown",
    approverName: null,
    approverEmailMasked: null,
  };
}

export function refineResultWithApproval(
  result: AuditResultView,
  approval: AuditApprovalView
): AuditResultView {
  if (result.kind !== "unknown") return result;
  if (approval.status === "rejected" || approval.status === "expired") {
    return {
      kind: "denied",
      reasonCode: approval.status,
      reasonJa: approval.status === "expired" ? "承認期限が切れました" : "承認者が却下しました",
    };
  }
  if (approval.status === "pending" || approval.status === "revision_requested") {
    return {
      kind: "pending",
      reasonCode: approval.status === "revision_requested" ? "revision_requested" : "needs_approval",
      reasonJa:
        approval.status === "revision_requested"
          ? "修正依頼です。まだ実行していません"
          : "人の承認待ち",
    };
  }
  return result;
}
