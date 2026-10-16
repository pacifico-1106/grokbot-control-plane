import { listApprovalsByIds, listApprovalsByJobIds, listEmployees, listMembers } from "@/lib/data";
import type { AuditEvent } from "@/lib/types";
import { indexApprovalsForOrg, ticketToAuditApprovalLookup } from "./approval";
import { opaqueAuditId } from "./mask";
import type { AuditMemberLookup, AuditPresentationLookups } from "./types";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function eventApprovalId(event: AuditEvent): string | null {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return asString((meta as Record<string, unknown>).approvalId) ?? asString((meta as Record<string, unknown>).approval_id);
}

function eventJobId(event: AuditEvent): string | null {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return asString((meta as Record<string, unknown>).jobId) ?? asString((meta as Record<string, unknown>).job_id);
}

export async function loadAuditApprovals(
  orgId: string,
  events: AuditEvent[]
): Promise<Pick<AuditPresentationLookups, "approvalsById" | "approvalsByJobEmployee">> {
  if (!orgId) return { approvalsById: new Map(), approvalsByJobEmployee: new Map() };
  const scoped = events.filter((event) => event.orgId === orgId);
  const approvalIds = [
    ...new Set(
      scoped
        .map(eventApprovalId)
        .filter((id): id is string => Boolean(opaqueAuditId(id)))
    ),
  ];
  const jobIds = [
    ...new Set(
      scoped
        .filter((event) => !eventApprovalId(event))
        .map(eventJobId)
        .filter((id): id is string => Boolean(opaqueAuditId(id)))
    ),
  ];
  const [byIdRows, byJobRows] = await Promise.all([
    listApprovalsByIds(orgId, approvalIds),
    listApprovalsByJobIds(orgId, jobIds),
  ]);
  const seen = new Set<string>();
  const tickets = [];
  for (const row of [...byIdRows, ...byJobRows]) {
    if (row.orgId !== orgId || seen.has(row.id)) continue;
    seen.add(row.id);
    tickets.push(ticketToAuditApprovalLookup(row));
  }
  return indexApprovalsForOrg(orgId, tickets);
}

export async function loadAuditPresentationLookups(
  orgId: string,
  events: AuditEvent[]
): Promise<AuditPresentationLookups> {
  const [employees, members, approvals] = await Promise.all([
    listEmployees(orgId),
    listMembers(orgId).catch(() => []),
    loadAuditApprovals(orgId, events),
  ]);
  const employeesById = new Map(
    employees
      .filter((e) => !e.orgId || e.orgId === orgId)
      .map((e) => [e.id, { displayName: e.displayName }])
  );
  const membersByEmail = new Map<string, AuditMemberLookup>();
  const membersById = new Map<string, AuditMemberLookup>();
  for (const member of members) {
    if (member.orgId !== orgId) continue;
    const lookup: AuditMemberLookup = { displayName: member.displayName, email: member.email };
    membersById.set(member.id, lookup);
    const email = String(member.email || "").trim().toLowerCase();
    if (!email) continue;
    membersByEmail.set(email, lookup);
  }
  return {
    orgId,
    employeesById,
    membersByEmail,
    membersById,
    ...approvals,
  };
}
