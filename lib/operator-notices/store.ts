/**
 * 運営からのお知らせ — data layer (PR-A, design §2). Server only.
 *
 * - Every call refuses with `operator_notices_disabled` while OPERATOR_NOTICES_ENABLED is OFF
 *   (default), so nothing reads or writes the tables until the flag is turned on.
 * - Writes (draft / targets / publish / version / withdraw) are for the operator only; the
 *   entry points that call them (PR-C /admin/notices, PR-H admin MCP draft) do the
 *   super-admin / platform-ops authorization. Every body field passes the secret detector
 *   on every save (surface `operator_notice`), with no operator exception.
 * - Reads take a NoticeScope { orgId, employeeId } that callers build from the 社員証 only,
 *   never from tool arguments. Visibility is the ONE SQL function
 *   `list_visible_operator_notices` / `operator_notice_visible` (migration 20261013100000);
 *   the demo store mirrors it. The visible view never carries audience / target details.
 * - Receipts are only written for (scope, visible notice); the DB trigger refuses anything
 *   else even if this code had a bug.
 */
import { checkPayloadScanLimits, detectSecretInPayload } from "@/lib/security/secret-detector";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { getRuntimeEmployees, DEMO_ORG } from "@/lib/demo-data";
import { isOperatorNoticesEnabled } from "@/lib/operator-notices/flags";
import { NOTICE_ID_RE, newNoticeId, noticeBodyHash } from "@/lib/operator-notices/ids";

export type NoticeStatus = "draft" | "published" | "withdrawn";
export type NoticeSeverity = "info" | "normal" | "important" | "urgent";
export type AudienceScope = "all" | "orgs" | "employees";
export type ApplyMode = "none" | "self_rules" | "instructions_via_approval";
export type VersionKind = "initial" | "correction" | "minor";
export type ReceiptState = "delivered" | "read" | "applied" | "not_applicable" | "needs_tenant_approval" | "declined";

export type NoticeScope = { orgId: string; employeeId: string };
export type OperatorActor = { userId: string; email?: string | null };

export type OperatorNotice = {
  id: string; seq: number; version: number; ackRequiredVersion: number;
  status: NoticeStatus; severity: NoticeSeverity; title: string; changeSummary: string; aiUsageChange: string;
  effectiveAt: string; expiresAt: string | null; audienceScope: AudienceScope; sticky: boolean;
  relatedFlags: string[]; applyMode: ApplyMode; showToTenantAdmin: boolean; relatesToItemIds: string[];
  bodyHash: string; publishedAt: string | null; withdrawnAt: string | null; createdAt: string; updatedAt: string;
};
/** What an employee scope may see: no operator identities, no targets. */
export type VisibleNotice = Omit<OperatorNotice, "status" | "withdrawnAt" | "createdAt" | "updatedAt">;
export type NoticeTarget = { orgId: string; employeeId: string | null };
export type NoticeVersion = {
  noticeId: string; version: number; kind: VersionKind; changeNote: string; title: string;
  changeSummary: string; aiUsageChange: string; applyMode: ApplyMode; bodyHash: string; createdByUserId: string; createdAt: string;
};
export type NoticeReceipt = {
  noticeId: string; orgId: string; employeeId: string; firstListedAt: string; state: ReceiptState;
  ackedVersion: number | null; ackedAt: string | null; readAt: string | null; readVersion: number | null;
  applyEvidence: "self_reported" | "config_change_applied" | null; configChangeApprovalId: string | null; note: string | null;
};

export type DraftInput = {
  title: string; changeSummary?: string; aiUsageChange?: string; severity?: NoticeSeverity;
  effectiveAt?: string; expiresAt?: string | null; audienceScope?: AudienceScope; sticky?: boolean;
  relatedFlags?: string[]; applyMode?: ApplyMode; showToTenantAdmin?: boolean; relatesToItemIds?: string[];
};
export type DraftPatch = Partial<Omit<DraftInput, "audienceScope" | "sticky">> & { audienceScope?: AudienceScope; sticky?: boolean };
export type VersionPatch = Partial<Pick<DraftInput, "title" | "changeSummary" | "aiUsageChange" | "applyMode" | "severity" | "expiresAt" | "relatedFlags" | "showToTenantAdmin" | "relatesToItemIds">>;

export type OperatorNoticeErrorCode =
  | "operator_notices_disabled" | "secret_detected" | "invalid_input" | "not_found" | "not_draft"
  | "targets_locked" | "cross_org" | "scope_mismatch" | "no_targets" | "store_unavailable";
export class OperatorNoticeError extends Error {
  readonly code: OperatorNoticeErrorCode;
  readonly detail: string | null;
  constructor(code: OperatorNoticeErrorCode, detail: string | null = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------------------------
// validation (mirrors the table CHECKs)
// ---------------------------------------------------------------------------------------------
const SEVERITIES: ReadonlySet<string> = new Set(["info", "normal", "important", "urgent"]);
const SCOPES: ReadonlySet<string> = new Set(["all", "orgs", "employees"]);
const APPLY: ReadonlySet<string> = new Set(["none", "self_rules", "instructions_via_approval"]);
const FLAG_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ITEM_RE = /^fb_[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const len = (s: string) => Array.from(s).length;

function bad(detail: string): never {
  throw new OperatorNoticeError("invalid_input", detail);
}
function iso(v: unknown, field: string): string {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) bad(field);
  return new Date(t).toISOString();
}

type Body = { title: string; changeSummary: string; aiUsageChange: string };
function checkBody(b: Body): void {
  if (len(b.title.trim()) < 1 || len(b.title) > 120) bad("title");
  if (len(b.changeSummary) > 4000) bad("change_summary");
  if (len(b.aiUsageChange) > 4000) bad("ai_usage_change");
  if (len(b.changeSummary) + len(b.aiUsageChange) > 8000) bad("body_total");
}
/** Secret detector on every text field (design §6.3-6). Blocked → nothing is saved. */
function scanSecrets(fields: Record<string, unknown>): void {
  const limit = checkPayloadScanLimits(fields, { perString: true });
  if (limit) throw new OperatorNoticeError("secret_detected", limit.pattern);
  const r = detectSecretInPayload(fields);
  if (!r.ok) throw new OperatorNoticeError("secret_detected", r.pattern);
}
function checkMeta(n: Pick<OperatorNotice, "severity" | "audienceScope" | "applyMode" | "relatedFlags" | "relatesToItemIds" | "effectiveAt" | "expiresAt">): void {
  if (!SEVERITIES.has(n.severity)) bad("severity");
  if (!SCOPES.has(n.audienceScope)) bad("audience_scope");
  if (!APPLY.has(n.applyMode)) bad("apply_mode");
  if (n.relatedFlags.length > 10 || n.relatedFlags.some((f) => !FLAG_RE.test(f))) bad("related_flags");
  if (n.relatesToItemIds.length > 20 || n.relatesToItemIds.some((f) => !ITEM_RE.test(f))) bad("relates_to_item_ids");
  if (n.expiresAt && Date.parse(n.expiresAt) <= Date.parse(n.effectiveAt)) bad("expires_at");
}
function assertEnabled(): void {
  if (!isOperatorNoticesEnabled()) throw new OperatorNoticeError("operator_notices_disabled");
}
function assertScope(scope: NoticeScope): void {
  if (!scope || typeof scope.orgId !== "string" || typeof scope.employeeId !== "string" || !scope.orgId || !scope.employeeId) {
    throw new OperatorNoticeError("invalid_input", "scope");
  }
}
function assertActor(op: OperatorActor): void {
  if (!op || typeof op.userId !== "string" || !op.userId.trim() || op.userId.length > 128) bad("actor");
}
const toVisible = (n: OperatorNotice): VisibleNotice => {
  const { status: _s, withdrawnAt: _w, createdAt: _c, updatedAt: _u, ...rest } = n;
  return { ...rest, relatedFlags: [...n.relatedFlags], relatesToItemIds: [...n.relatesToItemIds] };
};
/** unread = no receipt, only delivered, or acked below the newest initial / correction version. */
function isUnread(n: Pick<OperatorNotice, "ackRequiredVersion">, r: NoticeReceipt | undefined): boolean {
  if (!r || r.state === "delivered") return true;
  return (r.ackedVersion ?? r.readVersion ?? 0) < n.ackRequiredVersion;
}
function isPendingApply(n: Pick<OperatorNotice, "applyMode" | "ackRequiredVersion">, r: NoticeReceipt | undefined): boolean {
  if (n.applyMode === "none") return false;
  if (!r) return true;
  if ((r.ackedVersion ?? 0) < n.ackRequiredVersion) return true;
  return !["applied", "not_applicable", "declined"].includes(r.state);
}

// ---------------------------------------------------------------------------------------------
// store interface
// ---------------------------------------------------------------------------------------------
interface Backend {
  insertNotice(n: OperatorNotice, createdBy: OperatorActor): Promise<OperatorNotice>;
  getNotice(id: string): Promise<OperatorNotice | null>;
  updateNotice(id: string, from: NoticeStatus, patch: Partial<OperatorNotice>, publishedBy?: OperatorActor): Promise<OperatorNotice | null>;
  getTargets(id: string): Promise<NoticeTarget[]>;
  replaceTargets(id: string, targets: NoticeTarget[]): Promise<void>;
  employeeInOrg(employeeId: string, orgId: string): Promise<boolean>;
  insertVersion(v: NoticeVersion): Promise<void>;
  listVisible(scope: NoticeScope, now: Date): Promise<OperatorNotice[]>;
  receipts(scope: NoticeScope, ids: string[]): Promise<NoticeReceipt[]>;
  insertReceipts(scope: NoticeScope, ids: string[], now: Date): Promise<void>;
}

// --- demo -----------------------------------------------------------------------------------
type DemoDir = { orgs: Array<{ id: string; createdAt: string }>; employees: Array<{ id: string; orgId: string }> };
const demo = {
  notices: new Map<string, OperatorNotice>(),
  targets: new Map<string, NoticeTarget[]>(),
  versions: new Map<string, NoticeVersion[]>(),
  receipts: new Map<string, NoticeReceipt>(),
  seq: 0,
  dir: null as DemoDir | null,
};
function demoDir(): DemoDir {
  if (demo.dir) return demo.dir;
  return {
    orgs: [{ id: DEMO_ORG.id, createdAt: new Date(0).toISOString() }],
    employees: getRuntimeEmployees().map((e) => ({ id: e.id, orgId: e.orgId })),
  };
}
function demoVisible(n: OperatorNotice, scope: NoticeScope, now: Date): boolean {
  if (n.status !== "published") return false;
  if (n.expiresAt && Date.parse(n.expiresAt) <= now.getTime()) return false;
  const dir = demoDir();
  if (!dir.employees.some((e) => e.id === scope.employeeId && e.orgId === scope.orgId)) return false;
  if (n.audienceScope === "all") {
    const org = dir.orgs.find((o) => o.id === scope.orgId);
    if (!org) return false;
    return n.sticky || Date.parse(n.publishedAt ?? "") >= Date.parse(org.createdAt);
  }
  return (demo.targets.get(n.id) ?? []).some((t) => t.orgId === scope.orgId && (t.employeeId === null || t.employeeId === scope.employeeId));
}
const rkey = (noticeId: string, employeeId: string) => `${noticeId}\u0000${employeeId}`;
const clone = <T>(x: T): T => structuredClone(x);

const demoBackend: Backend = {
  async insertNotice(n) {
    const row = { ...clone(n), seq: ++demo.seq };
    demo.notices.set(n.id, row);
    return clone(row);
  },
  async getNotice(id) {
    const n = demo.notices.get(id);
    return n ? clone(n) : null;
  },
  async updateNotice(id, from, patch) {
    const n = demo.notices.get(id);
    if (!n || n.status !== from) return null;
    Object.assign(n, clone(patch), { updatedAt: new Date().toISOString() });
    return clone(n);
  },
  async getTargets(id) {
    return clone(demo.targets.get(id) ?? []);
  },
  async replaceTargets(id, targets) {
    demo.targets.set(id, clone(targets));
  },
  async employeeInOrg(employeeId, orgId) {
    return demoDir().employees.some((e) => e.id === employeeId && e.orgId === orgId);
  },
  async insertVersion(v) {
    const list = demo.versions.get(v.noticeId) ?? [];
    if (list.some((x) => x.version === v.version)) throw new OperatorNoticeError("store_unavailable", "version_exists");
    list.push(clone(v));
    demo.versions.set(v.noticeId, list);
  },
  async listVisible(scope, now) {
    return [...demo.notices.values()].filter((n) => demoVisible(n, scope, now))
      .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") || b.seq - a.seq).slice(0, 200).map(clone);
  },
  async receipts(scope, ids) {
    return ids.map((id) => demo.receipts.get(rkey(id, scope.employeeId))).filter((r): r is NoticeReceipt => !!r && r.orgId === scope.orgId).map(clone);
  },
  async insertReceipts(scope, ids, now) {
    for (const id of ids) {
      const n = demo.notices.get(id);
      if (!n || !demoVisible(n, scope, now)) continue; // the DB trigger refuses these
      const k = rkey(id, scope.employeeId);
      if (demo.receipts.has(k)) continue;
      demo.receipts.set(k, {
        noticeId: id, orgId: scope.orgId, employeeId: scope.employeeId, firstListedAt: now.toISOString(), state: "delivered",
        ackedVersion: null, ackedAt: null, readAt: null, readVersion: null, applyEvidence: null, configChangeApprovalId: null, note: null,
      });
    }
  },
};

// --- supabase -------------------------------------------------------------------------------
type Row = Record<string, unknown>;
const NOTICE_COLS = "id,seq,version,ack_required_version,status,severity,title,change_summary,ai_usage_change,effective_at,expires_at,audience_scope,sticky,related_flags,apply_mode,show_to_tenant_admin,relates_to_item_ids,body_hash,published_at,withdrawn_at,created_at,updated_at";
function fromRow(r: Row): OperatorNotice {
  return {
    id: String(r.id), seq: Number(r.seq), version: Number(r.version), ackRequiredVersion: Number(r.ack_required_version),
    status: r.status as NoticeStatus, severity: r.severity as NoticeSeverity, title: String(r.title),
    changeSummary: String(r.change_summary ?? ""), aiUsageChange: String(r.ai_usage_change ?? ""),
    effectiveAt: String(r.effective_at), expiresAt: (r.expires_at as string | null) ?? null,
    audienceScope: r.audience_scope as AudienceScope, sticky: Boolean(r.sticky),
    relatedFlags: (r.related_flags as string[] | null) ?? [], applyMode: r.apply_mode as ApplyMode,
    showToTenantAdmin: Boolean(r.show_to_tenant_admin), relatesToItemIds: (r.relates_to_item_ids as string[] | null) ?? [],
    bodyHash: String(r.body_hash), publishedAt: (r.published_at as string | null) ?? null, withdrawnAt: (r.withdrawn_at as string | null) ?? null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}
function receiptFromRow(r: Row): NoticeReceipt {
  return {
    noticeId: String(r.notice_id), orgId: String(r.org_id), employeeId: String(r.employee_id), firstListedAt: String(r.first_listed_at),
    state: r.state as ReceiptState, ackedVersion: (r.acked_version as number | null) ?? null, ackedAt: (r.acked_at as string | null) ?? null,
    readAt: (r.read_at as string | null) ?? null, readVersion: (r.read_version as number | null) ?? null,
    applyEvidence: (r.apply_evidence as NoticeReceipt["applyEvidence"]) ?? null,
    configChangeApprovalId: (r.config_change_approval_id as string | null) ?? null, note: (r.note as string | null) ?? null,
  };
}
const TRIGGER_CODES: Array<[string, OperatorNoticeErrorCode]> = [
  ["operator_notice_cross_org", "cross_org"], ["operator_notice_targets_locked", "targets_locked"],
  ["operator_notice_scope_mismatch", "scope_mismatch"], ["operator_notice_no_targets", "no_targets"],
  ["operator_notice_audience_locked", "not_draft"], ["operator_notice_withdrawn", "not_draft"],
];
function dbError(e: { message?: string } | null | undefined): OperatorNoticeError {
  const m = e?.message ?? "";
  for (const [needle, code] of TRIGGER_CODES) if (m.includes(needle)) return new OperatorNoticeError(code);
  return new OperatorNoticeError("store_unavailable");
}
function admin() {
  const c = createSupabaseAdminClient();
  if (!c) throw new OperatorNoticeError("store_unavailable");
  return c;
}
const supabaseBackend: Backend = {
  async insertNotice(n, by) {
    const { data, error } = await admin().from("operator_notices").insert({
      id: n.id, version: n.version, ack_required_version: n.ackRequiredVersion, status: n.status, severity: n.severity,
      title: n.title, change_summary: n.changeSummary, ai_usage_change: n.aiUsageChange, effective_at: n.effectiveAt,
      expires_at: n.expiresAt, audience_scope: n.audienceScope, sticky: n.sticky, related_flags: n.relatedFlags,
      apply_mode: n.applyMode, show_to_tenant_admin: n.showToTenantAdmin, relates_to_item_ids: n.relatesToItemIds,
      body_hash: n.bodyHash, created_by_user_id: by.userId, created_by_email: by.email ?? null,
    }).select(NOTICE_COLS).single();
    if (error || !data) throw dbError(error);
    return fromRow(data as Row);
  },
  async getNotice(id) {
    const { data, error } = await admin().from("operator_notices").select(NOTICE_COLS).eq("id", id).maybeSingle();
    if (error) throw dbError(error);
    return data ? fromRow(data as Row) : null;
  },
  async updateNotice(id, from, p, publishedBy) {
    const row: Row = { updated_at: new Date().toISOString() };
    const map: Array<[keyof OperatorNotice, string]> = [
      ["version", "version"], ["ackRequiredVersion", "ack_required_version"], ["status", "status"], ["severity", "severity"],
      ["title", "title"], ["changeSummary", "change_summary"], ["aiUsageChange", "ai_usage_change"], ["effectiveAt", "effective_at"],
      ["expiresAt", "expires_at"], ["audienceScope", "audience_scope"], ["sticky", "sticky"], ["relatedFlags", "related_flags"],
      ["applyMode", "apply_mode"], ["showToTenantAdmin", "show_to_tenant_admin"], ["relatesToItemIds", "relates_to_item_ids"],
      ["bodyHash", "body_hash"], ["publishedAt", "published_at"], ["withdrawnAt", "withdrawn_at"],
    ];
    for (const [k, col] of map) if (k in p) row[col] = p[k] as unknown;
    if (publishedBy) { row.published_by_user_id = publishedBy.userId; row.published_by_email = publishedBy.email ?? null; }
    const { data, error } = await admin().from("operator_notices").update(row).eq("id", id).eq("status", from).select(NOTICE_COLS);
    if (error) throw dbError(error);
    return Array.isArray(data) && data.length === 1 ? fromRow(data[0] as Row) : null;
  },
  async getTargets(id) {
    const { data, error } = await admin().from("operator_notice_targets").select("org_id,employee_id").eq("notice_id", id).limit(1000);
    if (error) throw dbError(error);
    return ((data ?? []) as Row[]).map((r) => ({ orgId: String(r.org_id), employeeId: (r.employee_id as string | null) ?? null }));
  },
  async replaceTargets(id, targets) {
    const c = admin();
    const del = await c.from("operator_notice_targets").delete().eq("notice_id", id);
    if (del.error) throw dbError(del.error);
    if (targets.length === 0) return;
    const ins = await c.from("operator_notice_targets").insert(targets.map((t) => ({ notice_id: id, org_id: t.orgId, employee_id: t.employeeId })));
    if (ins.error) throw dbError(ins.error);
  },
  async employeeInOrg(employeeId, orgId) {
    const { data, error } = await admin().from("employees").select("id").eq("id", employeeId).eq("org_id", orgId).maybeSingle();
    if (error) throw dbError(error);
    return !!data;
  },
  async insertVersion(v) {
    const { error } = await admin().from("operator_notice_versions").insert({
      notice_id: v.noticeId, version: v.version, kind: v.kind, change_note: v.changeNote, title: v.title,
      change_summary: v.changeSummary, ai_usage_change: v.aiUsageChange, apply_mode: v.applyMode, body_hash: v.bodyHash,
      created_by_user_id: v.createdByUserId,
    });
    if (error) throw dbError(error);
  },
  async listVisible(scope, now) {
    // ONE SQL definition of visibility (migration 20261013100000); no application-side filter.
    const { data, error } = await admin().rpc("list_visible_operator_notices", { p_org: scope.orgId, p_employee: scope.employeeId, p_now: now.toISOString() });
    if (error) throw dbError(error);
    return ((data ?? []) as Row[]).map(fromRow);
  },
  async receipts(scope, ids) {
    if (ids.length === 0) return [];
    const { data, error } = await admin().from("operator_notice_receipts").select("*")
      .eq("org_id", scope.orgId).eq("employee_id", scope.employeeId).in("notice_id", ids);
    if (error) throw dbError(error);
    return ((data ?? []) as Row[]).map(receiptFromRow);
  },
  async insertReceipts(scope, ids, now) {
    if (ids.length === 0) return;
    const { error } = await admin().from("operator_notice_receipts").upsert(
      ids.map((id) => ({ notice_id: id, org_id: scope.orgId, employee_id: scope.employeeId, first_listed_at: now.toISOString() })),
      { onConflict: "notice_id,employee_id", ignoreDuplicates: true });
    if (error) throw dbError(error);
  },
};

let backendOverride: Backend | null = null;
function backend(): Backend {
  return backendOverride ?? (isDemoMode() ? demoBackend : supabaseBackend);
}

// ---------------------------------------------------------------------------------------------
// operator writes
// ---------------------------------------------------------------------------------------------
export async function createDraft(input: DraftInput, op: OperatorActor): Promise<OperatorNotice> {
  assertEnabled();
  assertActor(op);
  const body: Body = { title: String(input.title ?? ""), changeSummary: String(input.changeSummary ?? ""), aiUsageChange: String(input.aiUsageChange ?? "") };
  checkBody(body);
  const now = new Date().toISOString();
  const n: OperatorNotice = {
    id: newNoticeId(), seq: 0, version: 1, ackRequiredVersion: 1, status: "draft",
    severity: input.severity ?? "normal", ...body,
    effectiveAt: input.effectiveAt ? iso(input.effectiveAt, "effective_at") : now,
    expiresAt: input.expiresAt ? iso(input.expiresAt, "expires_at") : null,
    audienceScope: input.audienceScope ?? "all", sticky: input.sticky ?? false,
    relatedFlags: [...(input.relatedFlags ?? [])], applyMode: input.applyMode ?? "self_rules",
    showToTenantAdmin: input.showToTenantAdmin ?? true, relatesToItemIds: [...(input.relatesToItemIds ?? [])],
    bodyHash: noticeBodyHash(body), publishedAt: null, withdrawnAt: null, createdAt: now, updatedAt: now,
  };
  checkMeta(n);
  scanSecrets({ ...body });
  return backend().insertNotice(n, op);
}

export async function updateDraft(id: string, patch: DraftPatch, op: OperatorActor): Promise<OperatorNotice> {
  assertEnabled();
  assertActor(op);
  const cur = await mustGet(id);
  if (cur.status !== "draft") throw new OperatorNoticeError("not_draft");
  const next = { ...cur, ...normPatch(patch) };
  const body: Body = { title: next.title, changeSummary: next.changeSummary, aiUsageChange: next.aiUsageChange };
  checkBody(body);
  checkMeta(next);
  scanSecrets({ ...body });
  if (next.audienceScope !== cur.audienceScope && (await backend().getTargets(id)).length > 0) throw new OperatorNoticeError("scope_mismatch");
  const out = await backend().updateNotice(id, "draft", { ...normPatch(patch), bodyHash: noticeBodyHash(body) });
  if (!out) throw new OperatorNoticeError("not_draft");
  return out;
}

export async function setTargets(id: string, targets: NoticeTarget[], op: OperatorActor): Promise<void> {
  assertEnabled();
  assertActor(op);
  const cur = await mustGet(id);
  if (cur.status !== "draft") throw new OperatorNoticeError("targets_locked");
  if (!Array.isArray(targets) || targets.length > 1000) bad("targets");
  const seen = new Set<string>();
  const clean: NoticeTarget[] = [];
  for (const t of targets) {
    if (!t || typeof t.orgId !== "string" || !t.orgId) bad("target_org");
    const employeeId = t.employeeId ?? null;
    if (employeeId !== null && typeof employeeId !== "string") bad("target_employee");
    if (cur.audienceScope === "all") throw new OperatorNoticeError("scope_mismatch");
    if (cur.audienceScope === "orgs" && employeeId !== null) throw new OperatorNoticeError("scope_mismatch");
    if (cur.audienceScope === "employees" && employeeId === null) throw new OperatorNoticeError("scope_mismatch");
    if (employeeId !== null && !(await backend().employeeInOrg(employeeId, t.orgId))) throw new OperatorNoticeError("cross_org");
    const k = `${t.orgId}\u0000${employeeId ?? ""}`;
    if (!seen.has(k)) { seen.add(k); clean.push({ orgId: t.orgId, employeeId }); }
  }
  await backend().replaceTargets(id, clean);
}

export async function publish(id: string, op: OperatorActor, opts: { now?: Date } = {}): Promise<OperatorNotice> {
  assertEnabled();
  assertActor(op);
  const cur = await mustGet(id);
  if (cur.status !== "draft") throw new OperatorNoticeError("not_draft");
  if (cur.audienceScope !== "all" && (await backend().getTargets(id)).length === 0) throw new OperatorNoticeError("no_targets");
  scanSecrets({ title: cur.title, changeSummary: cur.changeSummary, aiUsageChange: cur.aiUsageChange });
  const now = (opts.now ?? new Date()).toISOString();
  await backend().insertVersion({
    noticeId: id, version: 1, kind: "initial", changeNote: "", title: cur.title, changeSummary: cur.changeSummary,
    aiUsageChange: cur.aiUsageChange, applyMode: cur.applyMode, bodyHash: cur.bodyHash, createdByUserId: op.userId, createdAt: now,
  });
  const out = await backend().updateNotice(id, "draft", { status: "published", publishedAt: now }, op);
  if (!out) throw new OperatorNoticeError("not_draft");
  return out;
}

/** A new version of a published notice. `minor` becomes `correction` when an apply-relevant field changes (§2.2). */
export async function publishVersion(id: string, input: { kind: "correction" | "minor"; changeNote: string; patch: VersionPatch }, op: OperatorActor): Promise<OperatorNotice> {
  assertEnabled();
  assertActor(op);
  const cur = await mustGet(id);
  if (cur.status !== "published") throw new OperatorNoticeError("not_draft");
  if (input.kind !== "correction" && input.kind !== "minor") bad("kind");
  const changeNote = String(input.changeNote ?? "");
  if (len(changeNote) > 500) bad("change_note");
  const patch = normPatch(input.patch ?? {});
  const next = { ...cur, ...patch };
  const body: Body = { title: next.title, changeSummary: next.changeSummary, aiUsageChange: next.aiUsageChange };
  checkBody(body);
  checkMeta(next);
  scanSecrets({ ...body, changeNote });
  const applyRelevant = next.aiUsageChange !== cur.aiUsageChange || next.applyMode !== cur.applyMode;
  const kind: VersionKind = input.kind === "minor" && !applyRelevant ? "minor" : "correction";
  const version = cur.version + 1;
  const ackRequiredVersion = kind === "correction" ? version : cur.ackRequiredVersion;
  const bodyHash = noticeBodyHash(body);
  await backend().insertVersion({
    noticeId: id, version, kind, changeNote, ...body, applyMode: next.applyMode, bodyHash, createdByUserId: op.userId,
    createdAt: new Date().toISOString(),
  });
  const out = await backend().updateNotice(id, "published", { ...patch, version, ackRequiredVersion, bodyHash });
  if (!out) throw new OperatorNoticeError("not_draft");
  return out;
}

export async function withdraw(id: string, op: OperatorActor): Promise<OperatorNotice> {
  assertEnabled();
  assertActor(op);
  const out = await backend().updateNotice(id, "published", { status: "withdrawn", withdrawnAt: new Date().toISOString() });
  if (!out) throw new OperatorNoticeError("not_found");
  return out;
}

function normPatch(p: DraftPatch | VersionPatch): Partial<OperatorNotice> {
  const o: Partial<OperatorNotice> = {};
  const src = p as DraftPatch;
  if (src.title !== undefined) o.title = String(src.title);
  if (src.changeSummary !== undefined) o.changeSummary = String(src.changeSummary);
  if (src.aiUsageChange !== undefined) o.aiUsageChange = String(src.aiUsageChange);
  if (src.severity !== undefined) o.severity = src.severity;
  if (src.effectiveAt !== undefined) o.effectiveAt = iso(src.effectiveAt, "effective_at");
  if (src.expiresAt !== undefined) o.expiresAt = src.expiresAt ? iso(src.expiresAt, "expires_at") : null;
  if (src.audienceScope !== undefined) o.audienceScope = src.audienceScope;
  if (src.sticky !== undefined) o.sticky = Boolean(src.sticky);
  if (src.relatedFlags !== undefined) o.relatedFlags = [...src.relatedFlags];
  if (src.applyMode !== undefined) o.applyMode = src.applyMode;
  if (src.showToTenantAdmin !== undefined) o.showToTenantAdmin = Boolean(src.showToTenantAdmin);
  if (src.relatesToItemIds !== undefined) o.relatesToItemIds = [...src.relatesToItemIds];
  return o;
}
async function mustGet(id: string): Promise<OperatorNotice> {
  if (typeof id !== "string" || !NOTICE_ID_RE.test(id)) throw new OperatorNoticeError("not_found");
  const n = await backend().getNotice(id);
  if (!n) throw new OperatorNoticeError("not_found");
  return n;
}

// ---------------------------------------------------------------------------------------------
// employee-scope reads (scope = from the 社員証 only)
// ---------------------------------------------------------------------------------------------
export async function listVisible(scope: NoticeScope, opts: { now?: Date } = {}): Promise<VisibleNotice[]> {
  assertEnabled();
  assertScope(scope);
  return (await backend().listVisible(scope, opts.now ?? new Date())).map(toVisible);
}

/** null when the id is unknown OR not visible to this scope (never says which). */
export async function getVisible(scope: NoticeScope, noticeId: string, opts: { now?: Date } = {}): Promise<VisibleNotice | null> {
  assertEnabled();
  assertScope(scope);
  if (typeof noticeId !== "string" || !NOTICE_ID_RE.test(noticeId)) return null;
  const list = await backend().listVisible(scope, opts.now ?? new Date());
  const n = list.find((x) => x.id === noticeId);
  return n ? toVisible(n) : null;
}

/** First listing = delivered. Only visible notices; idempotent (first_listed_at kept). */
export async function recordListed(scope: NoticeScope, noticeIds: string[], opts: { now?: Date } = {}): Promise<void> {
  assertEnabled();
  assertScope(scope);
  const now = opts.now ?? new Date();
  const ids = [...new Set(noticeIds.filter((id) => typeof id === "string" && NOTICE_ID_RE.test(id)))].slice(0, 50);
  if (ids.length === 0) return;
  const visible = new Set((await backend().listVisible(scope, now)).map((n) => n.id));
  await backend().insertReceipts(scope, ids.filter((id) => visible.has(id)), now);
}

export async function getReceipts(scope: NoticeScope, noticeIds: string[]): Promise<NoticeReceipt[]> {
  assertEnabled();
  assertScope(scope);
  const ids = [...new Set(noticeIds.filter((id) => typeof id === "string" && NOTICE_ID_RE.test(id)))].slice(0, 200);
  return backend().receipts(scope, ids);
}

/** whoami counts (design §3.3): from the same visibility SQL, so another tenant's notice is never counted. */
export async function countForWhoami(scope: NoticeScope, opts: { now?: Date } = {}): Promise<{ unread: number; urgentUnread: number; pendingApply: number }> {
  assertEnabled();
  assertScope(scope);
  const list = await backend().listVisible(scope, opts.now ?? new Date());
  const receipts = new Map((await backend().receipts(scope, list.map((n) => n.id))).map((r) => [r.noticeId, r]));
  let unread = 0, urgentUnread = 0, pendingApply = 0;
  for (const n of list) {
    const r = receipts.get(n.id);
    if (isUnread(n, r)) { unread++; if (n.severity === "urgent") urgentUnread++; }
    if (isPendingApply(n, r)) pendingApply++;
  }
  return { unread, urgentUnread, pendingApply };
}

// ---------------------------------------------------------------------------------------------
// test hooks (demo only)
// ---------------------------------------------------------------------------------------------
export function __resetDemoOperatorNoticesForTests(dir: DemoDir | null = null): void {
  demo.notices.clear(); demo.targets.clear(); demo.versions.clear(); demo.receipts.clear(); demo.seq = 0;
  demo.dir = dir ? clone(dir) : null;
}
export function __demoNoticeCountForTests(): number {
  return demo.notices.size;
}
export function __demoVersionsForTests(id: string): NoticeVersion[] {
  return clone(demo.versions.get(id) ?? []);
}
/** PR-B implements the real ack; this only sets the demo receipt for count tests. */
export async function __demoAckForTests(scope: NoticeScope, noticeId: string, version: number, state: ReceiptState): Promise<void> {
  const r = demo.receipts.get(rkey(noticeId, scope.employeeId));
  if (!r || r.orgId !== scope.orgId) throw new OperatorNoticeError("not_found");
  Object.assign(r, { state, ackedVersion: version, ackedAt: new Date().toISOString(), readVersion: version, readAt: new Date().toISOString() });
}
export function __setOperatorNoticeBackendForTests(b: Backend | null): void {
  backendOverride = b;
}
export type { Backend as OperatorNoticeBackend };
