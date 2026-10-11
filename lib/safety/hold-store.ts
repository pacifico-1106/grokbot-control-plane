/**
 * S3 store for employee / org holds. Production goes ONLY through the S1 functions
 * (`start_employee_hold`, `request_employee_hold_release`, `release_employee_hold`); direct
 * writes to the hold columns are refused by the S1 triggers. Demo mode mirrors the same rules
 * in memory so the surfaces can be exercised end to end (and so tests run without a DB).
 */
import { randomUUID } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { demoListApprovals, demoUpdateApproval, demoGetApproval } from "@/lib/data/demo-approvals-store";
import { appendAuditEvent } from "@/lib/data/audit";
import { getRuntimeMembers } from "@/lib/demo-data";
import { getDesignatedAdminMemberIds } from "@/lib/approver-authority/designated-admins";
import {
  demoGetEmployeeHold,
  demoGetOrgHold,
  demoSetEmployeeHold,
  demoSetOrgHold,
  type HoldKind,
} from "@/lib/safety/hold";
import { HOLD_RELEASE_TOOL } from "@/lib/safety/hold-config";

export type HoldVia = "web" | "slack" | "line" | "telegram" | "ops_console" | "anomaly";

export type HoldRecord = {
  id: string;
  orgId: string;
  employeeId: string | null;
  kind: HoldKind;
  reason: string | null;
  startedBy: string;
  startedVia: HoldVia;
  startedAt: string;
  trigger: string | null;
  releaseRequestedBy: string | null;
  releaseRequestedAt: string | null;
  releaseReason: string | null;
  releaseApprovalId: string | null;
};

export type StartHoldInput = {
  orgId: string;
  employeeId: string | null;
  kind: HoldKind;
  reason: string | null;
  startedBy: string;
  startedVia: HoldVia;
  trigger: string | null;
};
export type StartHoldOutcome = { holdId: string; created: boolean; upgraded: boolean; heldTickets: number };

/** A refusal or failure from the store. `sqlState` carries Postgres codes (40P01, 40001, …). */
export class HoldStoreError extends Error {
  readonly code: string;
  readonly sqlState: string | null;
  constructor(code: string, sqlState: string | null = null) {
    super(code);
    this.name = "HoldStoreError";
    this.code = code;
    this.sqlState = sqlState;
  }
}

export interface HoldStore {
  start(input: StartHoldInput): Promise<StartHoldOutcome>;
  requestRelease(input: { orgId: string; holdId: string; requestedBy: string; reason: string; approvalId: string }): Promise<void>;
  release(input: { orgId: string; holdId: string; auditSummary: string; auditMetadata: Record<string, unknown> }): Promise<{ closedTickets: number }>;
  getOpenHold(orgId: string, employeeId: string | null): Promise<HoldRecord | null>;
  getHold(orgId: string, holdId: string): Promise<HoldRecord | null>;
}

/** Same ranks as `public.employee_hold_rank` (木村 10/12): ops 4 > detector 3 > tenant stop 2 > leave 1. */
export function holdRank(kind: HoldKind, via: HoldVia): number {
  if (via === "ops_console") return 4;
  if (via === "anomaly" || kind === "quarantined") return 3;
  if (kind === "stopped") return 2;
  if (kind === "leave") return 1;
  return 0;
}

/** S1 raises these as `raise exception '<code>'`; anything else is unexpected. */
const KNOWN_REFUSALS = [
  "employee_not_found", "org_not_found", "hold_not_found", "ops_hold_ops_only",
  "release_already_requested", "release_approver_not_allowed", "release_not_approved",
  "release_not_requested", "release_reason_required", "release_requester_invalid", "release_ticket_invalid",
] as const;

export function holdStoreErrorFrom(error: { code?: string | null; message?: string | null } | null | undefined): HoldStoreError {
  const message = String(error?.message ?? "");
  const known = KNOWN_REFUSALS.find((code) => message.includes(code));
  if (known) return new HoldStoreError(known, error?.code ?? null);
  return new HoldStoreError("hold_store_failed", error?.code ?? null);
}

function mapHoldRow(row: Record<string, unknown>): HoldRecord {
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    employeeId: s(row.employee_id),
    kind: String(row.kind) as HoldKind,
    reason: s(row.reason),
    startedBy: String(row.started_by),
    startedVia: String(row.started_via) as HoldVia,
    startedAt: String(row.started_at),
    trigger: s(row.trigger),
    releaseRequestedBy: s(row.release_requested_by),
    releaseRequestedAt: s(row.release_requested_at),
    releaseReason: s(row.release_reason),
    releaseApprovalId: s(row.release_approval_id),
  };
}

const supabaseStore: HoldStore = {
  async start(input) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new HoldStoreError("supabase_not_configured");
    const { data, error } = await admin.rpc("start_employee_hold", {
      p_org: input.orgId, p_employee: input.employeeId, p_kind: input.kind, p_reason: input.reason,
      p_started_by: input.startedBy, p_started_via: input.startedVia, p_trigger: input.trigger, p_at: null,
    });
    if (error) throw holdStoreErrorFrom(error);
    const row = (data ?? {}) as Record<string, unknown>;
    if (!row.holdId) throw new HoldStoreError("hold_store_failed");
    return { holdId: String(row.holdId), created: row.created === true, upgraded: row.upgraded === true, heldTickets: Number(row.heldTickets ?? 0) };
  },
  async requestRelease(input) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new HoldStoreError("supabase_not_configured");
    const { error } = await admin.rpc("request_employee_hold_release", {
      p_org: input.orgId, p_hold: input.holdId, p_requested_by: input.requestedBy,
      p_reason: input.reason, p_approval: input.approvalId, p_at: null,
    });
    if (error) throw holdStoreErrorFrom(error);
  },
  async release(input) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new HoldStoreError("supabase_not_configured");
    const { data, error } = await admin.rpc("release_employee_hold", {
      p_org: input.orgId, p_hold: input.holdId, p_audit_summary: input.auditSummary,
      p_audit_metadata: input.auditMetadata, p_at: null,
    });
    if (error) throw holdStoreErrorFrom(error);
    return { closedTickets: Number((data as Record<string, unknown> | null)?.closedTickets ?? 0) };
  },
  async getOpenHold(orgId, employeeId) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new HoldStoreError("supabase_not_configured");
    let query = admin.from("employee_holds").select("*").eq("org_id", orgId).is("released_at", null).is("superseded_at", null);
    query = employeeId ? query.eq("employee_id", employeeId) : query.is("employee_id", null);
    const { data, error } = await query.maybeSingle();
    if (error) throw holdStoreErrorFrom(error);
    return data ? mapHoldRow(data as Record<string, unknown>) : null;
  },
  async getHold(orgId, holdId) {
    const admin = createSupabaseAdminClient();
    if (!admin) throw new HoldStoreError("supabase_not_configured");
    const { data, error } = await admin.from("employee_holds").select("*").eq("org_id", orgId).eq("id", holdId)
      .is("released_at", null).is("superseded_at", null).maybeSingle();
    if (error) throw holdStoreErrorFrom(error);
    return data ? mapHoldRow(data as Record<string, unknown>) : null;
  },
};

// ---------------------------------------------------------------------------------------------
// Demo: same rules as the S1 functions, in memory.
// ---------------------------------------------------------------------------------------------
const demoHolds = new Map<string, HoldRecord & { releasedAt: string | null; supersededAt: string | null }>();
const MEMBER_RE = /^member:(.+)$/;

function demoOpen(orgId: string, employeeId: string | null) {
  for (const h of demoHolds.values()) {
    if (h.orgId === orgId && h.employeeId === employeeId && !h.releasedAt && !h.supersededAt) return h;
  }
  return null;
}
function demoActiveMember(orgId: string, memberId: string) {
  void orgId; // demo has one org
  return getRuntimeMembers().find((m) => m.id === memberId && m.status === "active") ?? null;
}
function demoSync(orgId: string, employeeId: string | null, hold: HoldRecord | null) {
  const value = hold ? { kind: hold.kind, holdId: hold.id } : null;
  if (employeeId) demoSetEmployeeHold(employeeId, value);
  else demoSetOrgHold(orgId, value);
}

const demoStore: HoldStore = {
  async start(input) {
    const prev = demoOpen(input.orgId, input.employeeId);
    if (prev && holdRank(input.kind, input.startedVia) <= holdRank(prev.kind, prev.startedVia)) {
      return { holdId: prev.id, created: false, upgraded: false, heldTickets: 0 };
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    if (prev) prev.supersededAt = now;
    const row = {
      id, orgId: input.orgId, employeeId: input.employeeId, kind: input.kind, reason: input.reason?.trim() || null,
      startedBy: input.startedBy, startedVia: input.startedVia, startedAt: now, trigger: input.trigger,
      releaseRequestedBy: null, releaseRequestedAt: null, releaseReason: null, releaseApprovalId: null,
      releasedAt: null, supersededAt: null,
    };
    demoHolds.set(id, row);
    demoSync(input.orgId, input.employeeId, row);
    let heldTickets = 0;
    for (const a of await demoListApprovals()) {
      if (a.orgId !== input.orgId) continue;
      const md = a.metadata ?? {};
      if (prev && md.heldByHoldId === prev.id) {
        await demoUpdateApproval(a.id, { metadata: { ...md, heldByHoldId: id } });
        continue;
      }
      if (input.employeeId && a.employeeId !== input.employeeId) continue;
      if (!["pending", "revision_requested", "approved"].includes(a.status)) continue;
      const done = (k: string) => (md[k] as { ok?: unknown } | undefined)?.ok === true;
      if (done("fulfillment") || done("adminFulfillment")) continue;
      if ((md.adminTool ?? a.tool) === HOLD_RELEASE_TOOL) continue;
      const { holdOutcome: _drop, ...rest } = md as Record<string, unknown>;
      void _drop;
      await demoUpdateApproval(a.id, { metadata: { ...rest, heldByHoldId: id, heldAt: now } });
      heldTickets += 1;
    }
    return { holdId: id, created: !prev, upgraded: Boolean(prev), heldTickets };
  },
  async requestRelease(input) {
    const h = demoHolds.get(input.holdId);
    if (!h || h.orgId !== input.orgId || h.releasedAt || h.supersededAt) throw new HoldStoreError("hold_not_found");
    if (h.startedVia === "ops_console" || h.startedBy.startsWith("ops:")) throw new HoldStoreError("ops_hold_ops_only");
    const m = MEMBER_RE.exec(input.requestedBy);
    if (!m || !demoActiveMember(input.orgId, m[1])) throw new HoldStoreError("release_requester_invalid");
    if (!input.reason.trim()) throw new HoldStoreError("release_reason_required");
    if (h.releaseApprovalId) {
      const prevTicket = await demoGetApproval(h.releaseApprovalId);
      if (prevTicket && ["pending", "approved"].includes(prevTicket.status)) throw new HoldStoreError("release_already_requested");
    }
    const t = await demoGetApproval(input.approvalId);
    if (!t || t.orgId !== input.orgId || t.status !== "pending" || (t.metadata?.adminTool ?? t.tool) !== HOLD_RELEASE_TOOL
        || t.metadata?.holdId !== input.holdId || t.metadata?.requestedBy !== input.requestedBy) {
      throw new HoldStoreError("release_ticket_invalid");
    }
    h.releaseRequestedBy = input.requestedBy;
    h.releaseRequestedAt = new Date().toISOString();
    h.releaseReason = input.reason.trim();
    h.releaseApprovalId = input.approvalId;
  },
  async release(input) {
    const h = demoHolds.get(input.holdId);
    if (!h || h.orgId !== input.orgId || h.releasedAt || h.supersededAt) throw new HoldStoreError("hold_not_found");
    if (h.startedVia === "ops_console" || h.startedBy.startsWith("ops:")) throw new HoldStoreError("ops_hold_ops_only");
    if (!h.releaseApprovalId || !h.releaseRequestedBy) throw new HoldStoreError("release_not_requested");
    const t = await demoGetApproval(h.releaseApprovalId);
    if (!t || t.orgId !== input.orgId || (t.metadata?.adminTool ?? t.tool) !== HOLD_RELEASE_TOOL
        || t.metadata?.holdId !== h.id || t.metadata?.requestedBy !== h.releaseRequestedBy) {
      throw new HoldStoreError("release_ticket_invalid");
    }
    if (t.status !== "approved" || !t.resolvedBy) throw new HoldStoreError("release_not_approved");
    const approverId = String(t.resolvedBy);
    const approverMember = demoActiveMember(input.orgId, approverId);
    const designated = await getDesignatedAdminMemberIds(input.orgId);
    const eligible = getRuntimeMembers().filter((m) => m.status === "active" && (m.role === "owner" || designated.includes(m.id)));
    if (!approverMember || !eligible.some((m) => m.id === approverId)) throw new HoldStoreError("release_approver_not_allowed");
    const requesterId = MEMBER_RE.exec(h.releaseRequestedBy)?.[1] ?? "";
    if (!demoActiveMember(input.orgId, requesterId)) throw new HoldStoreError("release_requester_invalid");
    const approver = `member:${approverId}`;
    if (approver === h.releaseRequestedBy) {
      if (h.kind === "quarantined" || h.startedVia === "anomaly" || h.trigger) throw new HoldStoreError("release_approver_not_allowed");
      if (eligible.length !== 1 || t.metadata?.singleOwnerSelfRelease !== true || !h.releaseReason) {
        throw new HoldStoreError("release_approver_not_allowed");
      }
    }
    // Audit first; if it fails nothing below happens (S1 does both in one transaction).
    await appendAuditEvent({
      orgId: input.orgId, employeeId: h.employeeId, credentialId: null, action: "employee.hold.released",
      purpose: "employee.hold.released", summary: input.auditSummary.slice(0, 500),
      metadata: { ...input.auditMetadata, auditClass: "admin", holdId: h.id, approvalId: t.id, kind: h.kind,
        requestedBy: h.releaseRequestedBy, releasedBy: approver, singleOwnerSelfRelease: approver === h.releaseRequestedBy },
    });
    h.releasedAt = new Date().toISOString();
    demoSync(input.orgId, h.employeeId, null);
    let closedTickets = 0;
    for (const a of await demoListApprovals()) {
      if (a.orgId === input.orgId && a.metadata?.heldByHoldId === h.id) {
        await demoUpdateApproval(a.id, { metadata: { ...a.metadata, holdOutcome: "closed_by_hold", holdReleasedAt: h.releasedAt } });
        closedTickets += 1;
      }
    }
    return { closedTickets };
  },
  async getOpenHold(orgId, employeeId) {
    const h = demoOpen(orgId, employeeId);
    if (h) return { ...h };
    // Holds placed directly with the S2 demo setters (tests) still show up as open.
    const raw = employeeId ? demoGetEmployeeHold(employeeId) : demoGetOrgHold(orgId);
    return raw ? {
      id: raw.holdId, orgId, employeeId, kind: raw.kind, reason: null, startedBy: "system:anomaly", startedVia: "anomaly",
      startedAt: new Date(0).toISOString(), trigger: "demo", releaseRequestedBy: null, releaseRequestedAt: null,
      releaseReason: null, releaseApprovalId: null,
    } : null;
  },
  async getHold(orgId, holdId) {
    const h = demoHolds.get(holdId);
    return h && h.orgId === orgId && !h.releasedAt && !h.supersededAt ? { ...h } : null;
  },
};

let override: HoldStore | null = null;
export function getHoldStore(): HoldStore {
  if (override) return override;
  return isDemoMode() ? demoStore : supabaseStore;
}
export function __setHoldStoreForTests(store: HoldStore | null): void {
  override = store;
}
export function __demoHoldStoreForTests(): HoldStore {
  return demoStore;
}
export function __resetDemoHoldsForTests(): void {
  for (const h of demoHolds.values()) demoSync(h.orgId, h.employeeId, null);
  demoHolds.clear();
}
