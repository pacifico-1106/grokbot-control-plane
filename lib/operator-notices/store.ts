/**
 * Operator-notice persistence. Demo: in-memory. Production: service-role
 * only (migration 20261016100000; RLS on, no policy).
 *
 * Org / employee are taken from the caller (the employee badge). The SQL
 * path never filters in JS: `operator_notices_for_employee` is the single
 * visibility query. A receipt insert that would cross orgs is rejected by
 * trigger `operator_notice_receipt_visible`.
 *
 * Publishing is not exposed here for employees (operator-only, later PR).
 * Seed helpers are test-only.
 */
import { isOperatorNoticesEnabled } from "@/lib/feature-flags";
import { DEMO_EMPLOYEES, DEMO_ORG } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { noticeBodyHash } from "./hash";
import { isNoticeId, newNoticeId } from "./ids";
import type {
  NoticeApplyEvidence,
  NoticeApplyMode,
  NoticeAudienceScope,
  NoticeReceiptState,
  NoticeSeverity,
  NoticeStatus,
  NoticeVersionKind,
  NoticeWakeState,
  OperatorNotice,
  OperatorNoticeReceipt,
  OperatorNoticeTarget,
  OperatorNoticeVersion,
} from "./types";
import {
  isNoticeCurrentlyVisible,
  noticeAudienceMatches,
} from "./visibility";

export class OperatorNoticeIsolationError extends Error {
  constructor(readonly code: "operator_notice_cross_org" | "operator_notice_receipt_not_visible" | "operator_notice_all_has_no_targets" | "operator_notice_targets_locked") {
    super(code);
    this.name = "OperatorNoticeIsolationError";
  }
}

export type StoreFailCode = "feature_disabled" | "unavailable" | "org_required" | "employee_not_found";

type DemoState = {
  notices: Map<string, OperatorNotice>;
  versions: OperatorNoticeVersion[];
  targets: OperatorNoticeTarget[];
  receipts: Map<string, OperatorNoticeReceipt>;
  employees: Map<string, { orgId: string }>;
  orgCreatedAt: Map<string, string>;
  seq: number;
};

const DEFAULT_ORG_CREATED_AT = "2020-01-01T00:00:00.000Z";

function emptyDemo(): DemoState {
  const employees = new Map<string, { orgId: string }>();
  for (const e of DEMO_EMPLOYEES) employees.set(e.id, { orgId: e.orgId });
  const orgCreatedAt = new Map<string, string>([[DEMO_ORG.id, DEFAULT_ORG_CREATED_AT]]);
  return { notices: new Map(), versions: [], targets: [], receipts: new Map(), employees, orgCreatedAt, seq: 0 };
}

let demo = emptyDemo();

export function __resetDemoOperatorNotices(): void {
  demo = emptyDemo();
}

export function __setDemoOrgCreatedAt(orgId: string, createdAt: string): void {
  demo.orgCreatedAt.set(orgId, createdAt);
}

export function __registerDemoEmployee(employeeId: string, orgId: string): void {
  demo.employees.set(employeeId, { orgId });
  if (!demo.orgCreatedAt.has(orgId)) demo.orgCreatedAt.set(orgId, DEFAULT_ORG_CREATED_AT);
}

function receiptKey(noticeId: string, employeeId: string): string {
  return `${noticeId}\n${employeeId}`;
}

function nowIso(at?: Date): string {
  return (at ?? new Date()).toISOString();
}

export type SeedNoticeInput = {
  id?: string;
  status?: NoticeStatus;
  severity?: NoticeSeverity;
  title: string;
  changeSummary: string;
  aiUsageChange: string;
  effectiveAt?: string;
  expiresAt?: string | null;
  audienceScope: NoticeAudienceScope;
  sticky?: boolean;
  relatedFlags?: string[];
  applyMode?: NoticeApplyMode;
  showToTenantAdmin?: boolean;
  relatesToItemIds?: string[];
  targets?: { orgId: string; employeeId: string | null }[];
  publishedAt?: string | null;
  version?: number;
  versionKind?: NoticeVersionKind;
  changeNote?: string | null;
  createdAt?: string;
  createdByUserId?: string | null;
  createdByEmail?: string | null;
};

/** Test / later-admin helper. Does not publish via MCP. Enforces isolation the same way as SQL. */
export function __seedDemoNotice(input: SeedNoticeInput): OperatorNotice {
  const id = input.id ?? newNoticeId();
  const publishedAt =
    input.status === "published" ? (input.publishedAt ?? nowIso()) : (input.publishedAt ?? null);
  const createdAt = input.createdAt ?? nowIso();
  const version = input.version ?? 1;
  const notice: OperatorNotice = {
    id,
    seq: ++demo.seq,
    version,
    status: input.status ?? "published",
    severity: input.severity ?? "normal",
    title: input.title,
    changeSummary: input.changeSummary,
    aiUsageChange: input.aiUsageChange,
    effectiveAt: input.effectiveAt ?? createdAt,
    expiresAt: input.expiresAt ?? null,
    audienceScope: input.audienceScope,
    sticky: input.sticky ?? false,
    relatedFlags: input.relatedFlags ?? [],
    applyMode: input.applyMode ?? "self_rules",
    showToTenantAdmin: input.showToTenantAdmin ?? true,
    relatesToItemIds: input.relatesToItemIds ?? [],
    bodyHash: noticeBodyHash(input),
    createdByUserId: input.createdByUserId ?? null,
    createdByEmail: input.createdByEmail ?? "operator@staffpass.test",
    publishedByUserId: input.status === "published" ? "op" : null,
    publishedByEmail: input.status === "published" ? "operator@staffpass.test" : null,
    createdAt,
    publishedAt,
    withdrawnAt: input.status === "withdrawn" ? nowIso() : null,
    updatedAt: createdAt,
  };
  if (notice.audienceScope === "all" && (input.targets?.length ?? 0) > 0) {
    throw new OperatorNoticeIsolationError("operator_notice_all_has_no_targets");
  }
  for (const t of input.targets ?? []) {
    if (t.employeeId) {
      const emp = demo.employees.get(t.employeeId);
      if (!emp || emp.orgId !== t.orgId) throw new OperatorNoticeIsolationError("operator_notice_cross_org");
    }
  }
  demo.notices.set(id, notice);
  demo.targets = demo.targets.filter((t) => t.noticeId !== id);
  demo.targets.push(...(input.targets ?? []).map((t) => ({ noticeId: id, orgId: t.orgId, employeeId: t.employeeId })));
  demo.versions = demo.versions.filter((v) => !(v.noticeId === id && v.version === version));
  demo.versions.push({
    noticeId: id,
    version,
    kind: input.versionKind ?? (version === 1 ? "initial" : "correction"),
    changeNote: input.changeNote ?? null,
    title: notice.title,
    changeSummary: notice.changeSummary,
    aiUsageChange: notice.aiUsageChange,
    bodyHash: notice.bodyHash,
    createdByUserId: null,
    createdAt,
  });
  return notice;
}

function demoEmployeeInOrg(orgId: string, employeeId: string): boolean {
  return demo.employees.get(employeeId)?.orgId === orgId;
}

function demoVisibleNotices(orgId: string, employeeId: string, now?: Date): OperatorNotice[] {
  if (!demoEmployeeInOrg(orgId, employeeId)) return [];
  const orgCreatedAt = demo.orgCreatedAt.get(orgId) ?? DEFAULT_ORG_CREATED_AT;
  const ctx = { orgId, employeeId, orgCreatedAt, now };
  return [...demo.notices.values()]
    .filter((n) => isNoticeCurrentlyVisible(n, demo.targets, ctx))
    .sort((a, b) => {
      const pa = a.publishedAt ?? "";
      const pb = b.publishedAt ?? "";
      if (pa !== pb) return pb.localeCompare(pa);
      return b.seq - a.seq;
    });
}

function mapNoticeRow(row: Record<string, unknown>): OperatorNotice {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    version: Number(row.version),
    status: row.status as OperatorNotice["status"],
    severity: row.severity as OperatorNotice["severity"],
    title: String(row.title ?? ""),
    changeSummary: String(row.change_summary ?? ""),
    aiUsageChange: String(row.ai_usage_change ?? ""),
    effectiveAt: String(row.effective_at),
    expiresAt: row.expires_at != null ? String(row.expires_at) : null,
    audienceScope: row.audience_scope as OperatorNotice["audienceScope"],
    sticky: row.sticky === true,
    relatedFlags: Array.isArray(row.related_flags) ? (row.related_flags as unknown[]).map(String) : [],
    applyMode: row.apply_mode as OperatorNotice["applyMode"],
    showToTenantAdmin: row.show_to_tenant_admin !== false,
    relatesToItemIds: Array.isArray(row.relates_to_item_ids) ? (row.relates_to_item_ids as unknown[]).map(String) : [],
    bodyHash: String(row.body_hash ?? ""),
    createdByUserId: row.created_by_user_id != null ? String(row.created_by_user_id) : null,
    createdByEmail: row.created_by_email != null ? String(row.created_by_email) : null,
    publishedByUserId: row.published_by_user_id != null ? String(row.published_by_user_id) : null,
    publishedByEmail: row.published_by_email != null ? String(row.published_by_email) : null,
    createdAt: String(row.created_at),
    publishedAt: row.published_at != null ? String(row.published_at) : null,
    withdrawnAt: row.withdrawn_at != null ? String(row.withdrawn_at) : null,
    updatedAt: String(row.updated_at),
  };
}

function mapReceiptRow(row: Record<string, unknown>): OperatorNoticeReceipt {
  return {
    noticeId: String(row.notice_id),
    orgId: String(row.org_id),
    employeeId: String(row.employee_id),
    firstListedAt: String(row.first_listed_at),
    readAt: row.read_at != null ? String(row.read_at) : null,
    readVersion: row.read_version != null ? Number(row.read_version) : null,
    state: row.state as NoticeReceiptState,
    ackedVersion: row.acked_version != null ? Number(row.acked_version) : null,
    ackedAt: row.acked_at != null ? String(row.acked_at) : null,
    applyEvidence: (row.apply_evidence as NoticeApplyEvidence | null) ?? null,
    configChangeApprovalId: row.config_change_approval_id != null ? String(row.config_change_approval_id) : null,
    note: row.note != null ? String(row.note) : null,
    wakeState: (row.wake_state as NoticeWakeState) ?? "none",
    updatedAt: String(row.updated_at),
  };
}

function mapVersionRow(row: Record<string, unknown>): OperatorNoticeVersion {
  return {
    noticeId: String(row.notice_id),
    version: Number(row.version),
    kind: row.kind as NoticeVersionKind,
    changeNote: row.change_note != null ? String(row.change_note) : null,
    title: String(row.title ?? ""),
    changeSummary: String(row.change_summary ?? ""),
    aiUsageChange: String(row.ai_usage_change ?? ""),
    bodyHash: String(row.body_hash ?? ""),
    createdByUserId: row.created_by_user_id != null ? String(row.created_by_user_id) : null,
    createdAt: String(row.created_at),
  };
}

export type VisibleListOk = {
  ok: true;
  notices: OperatorNotice[];
  receipts: Map<string, OperatorNoticeReceipt>;
  versions: Map<string, OperatorNoticeVersion>;
};

export async function listVisibleNotices(
  orgId: string,
  employeeId: string,
  opts: { noticeId?: string } = {}
): Promise<VisibleListOk | { ok: false; code: StoreFailCode }> {
  if (!isOperatorNoticesEnabled()) return { ok: false, code: "feature_disabled" };
  if (!orgId || !employeeId) return { ok: false, code: "org_required" };
  if (opts.noticeId && !isNoticeId(opts.noticeId)) {
    return { ok: true, notices: [], receipts: new Map(), versions: new Map() };
  }
  if (isDemoMode()) {
    let notices = demoVisibleNotices(orgId, employeeId);
    if (opts.noticeId) notices = notices.filter((n) => n.id === opts.noticeId);
    const receipts = new Map<string, OperatorNoticeReceipt>();
    const versions = new Map<string, OperatorNoticeVersion>();
    for (const n of notices) {
      const r = demo.receipts.get(receiptKey(n.id, employeeId));
      if (r && r.orgId === orgId) receipts.set(n.id, r);
      const v = demo.versions.find((x) => x.noticeId === n.id && x.version === n.version);
      if (v) versions.set(n.id, v);
    }
    return { ok: true, notices, receipts, versions };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "unavailable" };
  const { data, error } = await admin.rpc("operator_notices_for_employee", {
    p_org_id: orgId,
    p_employee_id: employeeId,
  });
  if (error) return { ok: false, code: "unavailable" };
  let notices = ((data as Record<string, unknown>[] | null) ?? []).map(mapNoticeRow);
  if (opts.noticeId) notices = notices.filter((n) => n.id === opts.noticeId);
  const receipts = new Map<string, OperatorNoticeReceipt>();
  const versions = new Map<string, OperatorNoticeVersion>();
  if (notices.length > 0) {
    const ids = notices.map((n) => n.id);
    const rec = await admin
      .from("operator_notice_receipts")
      .select("*")
      .eq("org_id", orgId)
      .eq("employee_id", employeeId)
      .in("notice_id", ids);
    if (rec.error) return { ok: false, code: "unavailable" };
    for (const row of rec.data ?? []) {
      const mapped = mapReceiptRow(row as Record<string, unknown>);
      receipts.set(mapped.noticeId, mapped);
    }
    const ver = await admin.from("operator_notice_versions").select("*").in("notice_id", ids);
    if (ver.error) return { ok: false, code: "unavailable" };
    for (const row of ver.data ?? []) {
      const mapped = mapVersionRow(row as Record<string, unknown>);
      const notice = notices.find((n) => n.id === mapped.noticeId);
      if (notice && mapped.version === notice.version) versions.set(mapped.noticeId, mapped);
    }
  }
  return { ok: true, notices, receipts, versions };
}

export type NoticeCounts =
  | { ok: true; unread: number; urgentUnread: number; pendingApply: number }
  | { ok: false; code: StoreFailCode };

export async function countVisibleNoticeStats(orgId: string, employeeId: string): Promise<NoticeCounts> {
  if (!isOperatorNoticesEnabled()) return { ok: false, code: "feature_disabled" };
  if (!orgId || !employeeId) return { ok: false, code: "org_required" };
  if (isDemoMode()) {
    const { isNoticeUnread, isPendingApply } = await import("./visibility");
    const notices = demoVisibleNotices(orgId, employeeId);
    let unread = 0;
    let urgentUnread = 0;
    let pendingApply = 0;
    for (const n of notices) {
      const r = demo.receipts.get(receiptKey(n.id, employeeId)) ?? null;
      const latest = demo.versions.find((v) => v.noticeId === n.id && v.version === n.version) ?? null;
      const u = isNoticeUnread(n, r, latest);
      if (u) {
        unread += 1;
        if (n.severity === "urgent") urgentUnread += 1;
      }
      if (isPendingApply(n, r)) pendingApply += 1;
    }
    return { ok: true, unread, urgentUnread, pendingApply };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "unavailable" };
  const { data, error } = await admin.rpc("operator_notice_counts_for_employee", {
    p_org_id: orgId,
    p_employee_id: employeeId,
  });
  if (error) return { ok: false, code: "unavailable" };
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : (data as Record<string, unknown> | null);
  if (!row) return { ok: true, unread: 0, urgentUnread: 0, pendingApply: 0 };
  return {
    ok: true,
    unread: Number(row.unread ?? 0),
    urgentUnread: Number(row.urgent_unread ?? 0),
    pendingApply: Number(row.pending_apply ?? 0),
  };
}

function assertDemoReceiptAllowed(noticeId: string, orgId: string, employeeId: string, op: "insert" | "update"): void {
  if (!demoEmployeeInOrg(orgId, employeeId)) {
    throw new OperatorNoticeIsolationError("operator_notice_receipt_not_visible");
  }
  const notice = demo.notices.get(noticeId);
  if (!notice) throw new OperatorNoticeIsolationError("operator_notice_receipt_not_visible");
  const ctx = {
    orgId,
    employeeId,
    orgCreatedAt: demo.orgCreatedAt.get(orgId) ?? DEFAULT_ORG_CREATED_AT,
  };
  if (op === "insert") {
    if (!isNoticeCurrentlyVisible(notice, demo.targets, ctx)) {
      throw new OperatorNoticeIsolationError("operator_notice_receipt_not_visible");
    }
  } else if (!noticeAudienceMatches(notice, demo.targets, ctx)) {
    throw new OperatorNoticeIsolationError("operator_notice_receipt_not_visible");
  }
}

export async function ensureDeliveredReceipt(
  orgId: string,
  employeeId: string,
  noticeId: string
): Promise<{ ok: true; receipt: OperatorNoticeReceipt } | { ok: false; code: StoreFailCode | "not_found" }> {
  if (!isOperatorNoticesEnabled()) return { ok: false, code: "feature_disabled" };
  if (!orgId || !employeeId || !isNoticeId(noticeId)) return { ok: false, code: "not_found" };
  const listed = await listVisibleNotices(orgId, employeeId, { noticeId });
  if (!listed.ok) return listed;
  if (!listed.notices.some((n) => n.id === noticeId)) return { ok: false, code: "not_found" };
  const existing = listed.receipts.get(noticeId);
  if (existing) return { ok: true, receipt: existing };
  const at = nowIso();
  const receipt: OperatorNoticeReceipt = {
    noticeId,
    orgId,
    employeeId,
    firstListedAt: at,
    readAt: null,
    readVersion: null,
    state: "delivered",
    ackedVersion: null,
    ackedAt: null,
    applyEvidence: null,
    configChangeApprovalId: null,
    note: null,
    wakeState: "none",
    updatedAt: at,
  };
  if (isDemoMode()) {
    try {
      assertDemoReceiptAllowed(noticeId, orgId, employeeId, "insert");
    } catch {
      return { ok: false, code: "not_found" };
    }
    demo.receipts.set(receiptKey(noticeId, employeeId), receipt);
    return { ok: true, receipt };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "unavailable" };
  const { data, error } = await admin
    .from("operator_notice_receipts")
    .insert({
      notice_id: noticeId,
      org_id: orgId,
      employee_id: employeeId,
      first_listed_at: at,
      state: "delivered",
      wake_state: "none",
      updated_at: at,
    })
    .select("*")
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const again = await getReceipt(orgId, employeeId, noticeId);
      if (again.ok) return again;
    }
    const msg = String((error as { message?: string }).message ?? "");
    if (msg.includes("operator_notice_receipt_not_visible")) return { ok: false, code: "not_found" };
    return { ok: false, code: "unavailable" };
  }
  if (!data) return { ok: false, code: "unavailable" };
  return { ok: true, receipt: mapReceiptRow(data as Record<string, unknown>) };
}

export async function getReceipt(
  orgId: string,
  employeeId: string,
  noticeId: string
): Promise<{ ok: true; receipt: OperatorNoticeReceipt } | { ok: false; code: StoreFailCode | "not_found" }> {
  if (!isOperatorNoticesEnabled()) return { ok: false, code: "feature_disabled" };
  if (!orgId || !employeeId) return { ok: false, code: "org_required" };
  if (isDemoMode()) {
    const r = demo.receipts.get(receiptKey(noticeId, employeeId));
    if (!r || r.orgId !== orgId) return { ok: false, code: "not_found" };
    return { ok: true, receipt: r };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "unavailable" };
  const { data, error } = await admin
    .from("operator_notice_receipts")
    .select("*")
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .eq("notice_id", noticeId)
    .maybeSingle();
  if (error) return { ok: false, code: "unavailable" };
  if (!data) return { ok: false, code: "not_found" };
  return { ok: true, receipt: mapReceiptRow(data as Record<string, unknown>) };
}

export type ReceiptPatch = {
  state?: NoticeReceiptState;
  readAt?: string | null;
  readVersion?: number | null;
  ackedVersion?: number | null;
  ackedAt?: string | null;
  applyEvidence?: NoticeApplyEvidence | null;
  configChangeApprovalId?: string | null;
  note?: string | null;
};

export async function updateReceipt(
  orgId: string,
  employeeId: string,
  noticeId: string,
  patch: ReceiptPatch
): Promise<{ ok: true; receipt: OperatorNoticeReceipt } | { ok: false; code: StoreFailCode | "not_found" }> {
  if (!isOperatorNoticesEnabled()) return { ok: false, code: "feature_disabled" };
  const existing = await getReceipt(orgId, employeeId, noticeId);
  if (!existing.ok) return existing;
  const next: OperatorNoticeReceipt = {
    ...existing.receipt,
    ...patch,
    updatedAt: nowIso(),
  };
  if (isDemoMode()) {
    try {
      assertDemoReceiptAllowed(noticeId, orgId, employeeId, "update");
    } catch {
      return { ok: false, code: "not_found" };
    }
    demo.receipts.set(receiptKey(noticeId, employeeId), next);
    return { ok: true, receipt: next };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return { ok: false, code: "unavailable" };
  const { data, error } = await admin
    .from("operator_notice_receipts")
    .update({
      state: next.state,
      read_at: next.readAt,
      read_version: next.readVersion,
      acked_version: next.ackedVersion,
      acked_at: next.ackedAt,
      apply_evidence: next.applyEvidence,
      config_change_approval_id: next.configChangeApprovalId,
      note: next.note,
      updated_at: next.updatedAt,
    })
    .eq("org_id", orgId)
    .eq("employee_id", employeeId)
    .eq("notice_id", noticeId)
    .select("*")
    .maybeSingle();
  if (error) {
    const msg = String((error as { message?: string }).message ?? "");
    if (msg.includes("operator_notice_receipt_not_visible")) return { ok: false, code: "not_found" };
    return { ok: false, code: "unavailable" };
  }
  if (!data) return { ok: false, code: "not_found" };
  return { ok: true, receipt: mapReceiptRow(data as Record<string, unknown>) };
}

/**
 * Test helper: attempt a receipt insert that should be rejected (wrong org).
 * Returns the isolation error code (demo) or throws in production (not used).
 */
export function __forceInsertDemoReceipt(input: {
  noticeId: string;
  orgId: string;
  employeeId: string;
}): OperatorNoticeReceipt {
  assertDemoReceiptAllowed(input.noticeId, input.orgId, input.employeeId, "insert");
  const at = nowIso();
  const receipt: OperatorNoticeReceipt = {
    noticeId: input.noticeId,
    orgId: input.orgId,
    employeeId: input.employeeId,
    firstListedAt: at,
    readAt: null,
    readVersion: null,
    state: "delivered",
    ackedVersion: null,
    ackedAt: null,
    applyEvidence: null,
    configChangeApprovalId: null,
    note: null,
    wakeState: "none",
    updatedAt: at,
  };
  demo.receipts.set(receiptKey(input.noticeId, input.employeeId), receipt);
  return receipt;
}

export function __getDemoNotice(id: string): OperatorNotice | undefined {
  return demo.notices.get(id);
}

export function __listDemoNotices(): OperatorNotice[] {
  return [...demo.notices.values()].sort((a, b) => b.seq - a.seq);
}

export function __listDemoTargets(noticeId: string): OperatorNoticeTarget[] {
  return demo.targets.filter((t) => t.noticeId === noticeId);
}

export function __listDemoVersions(noticeId: string): OperatorNoticeVersion[] {
  return demo.versions.filter((v) => v.noticeId === noticeId);
}

export function __listDemoReceipts(noticeId: string): OperatorNoticeReceipt[] {
  return [...demo.receipts.values()].filter((r) => r.noticeId === noticeId);
}

export function __replaceDemoNotice(notice: OperatorNotice): void {
  demo.notices.set(notice.id, notice);
}

export function __replaceDemoTargets(noticeId: string, targets: OperatorNoticeTarget[]): void {
  demo.targets = demo.targets.filter((t) => t.noticeId !== noticeId);
  demo.targets.push(...targets);
}

export function __pushDemoVersion(row: OperatorNoticeVersion): void {
  demo.versions = demo.versions.filter((v) => !(v.noticeId === row.noticeId && v.version === row.version));
  demo.versions.push(row);
}

function jstDayStartUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + 9 * 3600_000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0);
  return new Date(start - 9 * 3600_000);
}

export function countUrgentPublishedSince(opts: { now?: Date; orgId?: string | null }): {
  global: number;
  forOrg: number;
} {
  const start = jstDayStartUtc(opts.now ?? new Date()).toISOString();
  let global = 0;
  let forOrg = 0;
  for (const n of demo.notices.values()) {
    if (n.severity !== "urgent" || n.status === "draft") continue;
    if (!n.publishedAt || n.publishedAt < start) continue;
    global += 1;
    if (opts.orgId) {
      if (n.audienceScope === "all") continue;
      const hit = demo.targets.some((t) => t.noticeId === n.id && t.orgId === opts.orgId);
      if (hit) forOrg += 1;
    }
  }
  return { global, forOrg };
}
