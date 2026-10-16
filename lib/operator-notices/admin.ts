/**
 * Operator-only notice writes for /admin/notices (PR-C).
 * Super-admin screen only. Employee MCP cannot publish.
 * Org/employee for preview come from the operator picker but visibility is
 * the same SQL/predicate as the employee badge path. Notice bodies are never
 * written to audit metadata or console.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import { DEMO_EMPLOYEES, DEMO_ORG } from "@/lib/demo-data";
import { isOperatorNoticesEnabled } from "@/lib/feature-flags";
import { isDemoMode } from "@/lib/mode";
import { CONSENT_MAX_LOGIN_AGE_SEC } from "@/lib/mcp-oauth/config";
import { createSupabaseAdminClient } from "@/lib/supabase";
import {
  auditSecretDetectionBlocked,
  auditSecretDetectionSuspected,
} from "@/lib/security/secret-detection-audit";
import { checkPayloadScanLimits, detectSecretInPayload } from "@/lib/security/secret-detector";
import { lintNoticeCopy } from "./copy-lint";
import { isKnownFeatureFlagName } from "./flag-names";
import { noticeBodyHash } from "./hash";
import { isNoticeId, newNoticeId } from "./ids";
import {
  OPERATOR_NOTICES_CONTENT_TRUST,
  OPERATOR_NOTICES_GUARD_JA,
  OPERATOR_NOTICES_SOURCE,
} from "./copy";
import { runNoticesList, wireNotice } from "./service";
import {
  OperatorNoticeIsolationError,
  __getDemoNotice,
  __listDemoNotices,
  __listDemoReceipts,
  __listDemoTargets,
  __listDemoVersions,
  __pushDemoVersion,
  __registerDemoEmployee,
  __replaceDemoNotice,
  __replaceDemoTargets,
  __seedDemoNotice,
  countUrgentPublishedSince,
} from "./store";
import {
  AI_USAGE_CHANGE_MAX,
  BODY_FIELDS_COMBINED_MAX,
  CHANGE_NOTE_MAX,
  CHANGE_SUMMARY_MAX,
  RELATED_FLAGS_MAX,
  TITLE_MAX,
  isNoticeApplyMode,
  isNoticeAudienceScope,
  isNoticeSeverity,
  type NoticeApplyMode,
  type NoticeAudienceScope,
  type NoticeSeverity,
  type NoticeVersionKind,
  type NoticeTargetPicker,
  type OperatorNotice,
  type OperatorNoticeReceipt,
  type OperatorNoticeTarget,
  type OperatorNoticeVersion,
} from "./types";
import { isNoticeCurrentlyVisible } from "./visibility";

export const URGENT_PER_DAY_GLOBAL = 5;
export const URGENT_PER_DAY_PER_ORG = 3;

export type OperatorActor = {
  userId: string;
  email: string;
  lastSignInAt?: string | null;
};

export type AdminFailCode =
  | "feature_disabled"
  | "secret_detected_in_payload"
  | "login_too_old"
  | "confirm_required"
  | "operator_notice_cross_org"
  | "operator_notice_audience_locked"
  | "operator_notice_all_has_no_targets"
  | "urgent_daily_cap"
  | "not_found"
  | "invalid_args"
  | "unavailable"
  | "not_draft"
  | "warnings_unacked";

export type AdminFail = { ok: false; code: AdminFailCode; messageJa?: string; pattern?: string };

export type DraftInput = {
  id?: string;
  title: string;
  changeSummary: string;
  aiUsageChange: string;
  audienceScope: NoticeAudienceScope;
  sticky?: boolean;
  severity?: NoticeSeverity;
  applyMode?: NoticeApplyMode;
  showToTenantAdmin?: boolean;
  relatedFlags?: string[];
  targets?: { orgId: string; employeeId: string | null }[];
  effectiveAt?: string;
  expiresAt?: string | null;
  relatesToItemIds?: string[];
};

function fail(code: AdminFailCode, messageJa?: string, extra?: { pattern?: string }): AdminFail {
  return { ok: false, code, ...(messageJa ? { messageJa } : {}), ...extra };
}

export function isLoginFresh(lastSignInAt: string | null | undefined, now = new Date()): boolean {
  const t = lastSignInAt ? Date.parse(lastSignInAt) : NaN;
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= -60_000 && age <= CONSENT_MAX_LOGIN_AGE_SEC * 1000;
}

function requireFlag(): AdminFail | null {
  if (!isOperatorNoticesEnabled()) return fail("feature_disabled");
  return null;
}

function requireFreshConfirm(actor: OperatorActor, confirmed: boolean): AdminFail | null {
  if (!confirmed) return fail("confirm_required", "公開内容を確認してチェックを入れてください。");
  if (!isLoginFresh(actor.lastSignInAt)) {
    return fail("login_too_old", "安全のため、15 分以内にログインし直してから公開してください。");
  }
  return null;
}

function validateBody(input: {
  title: string;
  changeSummary: string;
  aiUsageChange: string;
  relatedFlags?: string[];
}): AdminFail | null {
  const title = input.title.trim();
  if (!title || title.length > TITLE_MAX) return fail("invalid_args", `題名は 1〜${TITLE_MAX} 文字です。`);
  if (input.changeSummary.length > CHANGE_SUMMARY_MAX || input.aiUsageChange.length > AI_USAGE_CHANGE_MAX) {
    return fail("invalid_args", "本文が長すぎます。");
  }
  if (input.changeSummary.length + input.aiUsageChange.length > BODY_FIELDS_COMBINED_MAX) {
    return fail("invalid_args", "本文 2 欄の合計は 8,000 文字までです。");
  }
  const flags = input.relatedFlags ?? [];
  if (flags.length > RELATED_FLAGS_MAX) return fail("invalid_args", "関連フラグは 10 個までです。");
  if (flags.some((f) => !isKnownFeatureFlagName(f))) return fail("invalid_args", "未知のフラグ名です。");
  return null;
}

async function scanNoticeText(
  actor: OperatorActor,
  payload: Record<string, string>
): Promise<AdminFail | { ok: true; suspected: boolean }> {
  const oversized = checkPayloadScanLimits(payload, { perString: true });
  const secret = oversized ?? detectSecretInPayload(payload);
  const opsOrg = (process.env.PLATFORM_OPS_ORG_ID || "").trim() || null;
  if (!secret.ok) {
    await auditSecretDetectionBlocked(
      {
        orgId: opsOrg,
        employeeId: null,
        credentialId: null,
        surface: "operator_notice",
        tool: "admin.notices",
        jobId: actor.userId,
      },
      secret
    );
    return fail("secret_detected_in_payload", secret.messageJa, { pattern: secret.pattern });
  }
  if (secret.suspected) {
    await auditSecretDetectionSuspected(
      {
        orgId: opsOrg,
        employeeId: null,
        credentialId: null,
        surface: "operator_notice",
        tool: "admin.notices",
        jobId: actor.userId,
      },
      secret.suspected
    );
  }
  return { ok: true, suspected: Boolean(secret.suspected) };
}

function auditMeta(notice: OperatorNotice, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    noticeId: notice.id,
    seq: notice.seq,
    version: notice.version,
    status: notice.status,
    severity: notice.severity,
    audienceScope: notice.audienceScope,
    ...extra,
  };
}

function isolationFromMessage(message: string): AdminFail | null {
  if (message.includes("operator_notice_cross_org")) return fail("operator_notice_cross_org");
  if (message.includes("operator_notice_audience_locked")) return fail("operator_notice_audience_locked");
  if (message.includes("operator_notice_all_has_no_targets")) return fail("operator_notice_all_has_no_targets");
  return null;
}

function isolationFromUnknown(err: unknown): AdminFail | null {
  if (err instanceof OperatorNoticeIsolationError) return fail(err.code as AdminFailCode);
  const message =
    err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message ?? "") : String(err ?? "");
  return isolationFromMessage(message);
}

function mapNotice(row: Record<string, unknown>): OperatorNotice {
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
    relatedFlags: Array.isArray(row.related_flags) ? row.related_flags.map(String) : [],
    applyMode: row.apply_mode as OperatorNotice["applyMode"],
    showToTenantAdmin: row.show_to_tenant_admin !== false,
    relatesToItemIds: Array.isArray(row.relates_to_item_ids) ? row.relates_to_item_ids.map(String) : [],
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

function mapTarget(row: Record<string, unknown>): OperatorNoticeTarget {
  return {
    noticeId: String(row.notice_id),
    orgId: String(row.org_id),
    employeeId: row.employee_id != null ? String(row.employee_id) : null,
  };
}

function mapReceipt(row: Record<string, unknown>): OperatorNoticeReceipt {
  return {
    noticeId: String(row.notice_id),
    orgId: String(row.org_id),
    employeeId: String(row.employee_id),
    firstListedAt: String(row.first_listed_at),
    readAt: row.read_at != null ? String(row.read_at) : null,
    readVersion: row.read_version != null ? Number(row.read_version) : null,
    state: row.state as OperatorNoticeReceipt["state"],
    ackedVersion: row.acked_version != null ? Number(row.acked_version) : null,
    ackedAt: row.acked_at != null ? String(row.acked_at) : null,
    applyEvidence: (row.apply_evidence as OperatorNoticeReceipt["applyEvidence"]) ?? null,
    configChangeApprovalId: row.config_change_approval_id != null ? String(row.config_change_approval_id) : null,
    note: row.note != null ? String(row.note) : null,
    wakeState: (row.wake_state as OperatorNoticeReceipt["wakeState"]) ?? "none",
    updatedAt: String(row.updated_at),
  };
}

function mapVersion(row: Record<string, unknown>): OperatorNoticeVersion {
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

function noticeWriteRow(notice: OperatorNotice): Record<string, unknown> {
  return {
    id: notice.id,
    version: notice.version,
    status: notice.status,
    severity: notice.severity,
    title: notice.title,
    change_summary: notice.changeSummary,
    ai_usage_change: notice.aiUsageChange,
    effective_at: notice.effectiveAt,
    expires_at: notice.expiresAt,
    audience_scope: notice.audienceScope,
    sticky: notice.sticky,
    related_flags: notice.relatedFlags,
    apply_mode: notice.applyMode,
    show_to_tenant_admin: notice.showToTenantAdmin,
    relates_to_item_ids: notice.relatesToItemIds,
    body_hash: notice.bodyHash,
    created_by_user_id: notice.createdByUserId,
    created_by_email: notice.createdByEmail,
    published_by_user_id: notice.publishedByUserId,
    published_by_email: notice.publishedByEmail,
    created_at: notice.createdAt,
    published_at: notice.publishedAt,
    withdrawn_at: notice.withdrawnAt,
    updated_at: notice.updatedAt,
  };
}

type AdminClient = NonNullable<ReturnType<typeof createSupabaseAdminClient>>;

async function requireNotice(id: string): Promise<{ ok: true; notice: OperatorNotice } | AdminFail> {
  if (isDemoMode()) {
    const n = __getDemoNotice(id);
    if (!n) return fail("not_found");
    return { ok: true, notice: n };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const { data, error } = await admin.from("operator_notices").select("*").eq("id", id).maybeSingle();
  if (error) return fail("unavailable");
  if (!data) return fail("not_found");
  return { ok: true, notice: mapNotice(data as Record<string, unknown>) };
}

async function loadTargets(noticeId: string): Promise<OperatorNoticeTarget[] | AdminFail> {
  if (isDemoMode()) return __listDemoTargets(noticeId);
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const { data, error } = await admin.from("operator_notice_targets").select("*").eq("notice_id", noticeId);
  if (error) return fail("unavailable");
  return ((data ?? []) as Record<string, unknown>[]).map(mapTarget);
}

async function loadReceipts(noticeId: string): Promise<OperatorNoticeReceipt[] | AdminFail> {
  if (isDemoMode()) return __listDemoReceipts(noticeId);
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const { data, error } = await admin.from("operator_notice_receipts").select("*").eq("notice_id", noticeId);
  if (error) return fail("unavailable");
  return ((data ?? []) as Record<string, unknown>[]).map(mapReceipt);
}

async function loadVersions(noticeId: string): Promise<OperatorNoticeVersion[] | AdminFail> {
  if (isDemoMode()) return __listDemoVersions(noticeId);
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const { data, error } = await admin.from("operator_notice_versions").select("*").eq("notice_id", noticeId);
  if (error) return fail("unavailable");
  return ((data ?? []) as Record<string, unknown>[]).map(mapVersion);
}

async function persistNotice(admin: AdminClient, notice: OperatorNotice, mode: "insert" | "update"): Promise<OperatorNotice | AdminFail> {
  const row = noticeWriteRow(notice);
  if (mode === "insert") {
    const { data, error } = await admin.from("operator_notices").insert(row).select("*").maybeSingle();
    if (error) return isolationFromMessage(error.message) ?? fail("unavailable");
    if (!data) return fail("unavailable");
    return mapNotice(data as Record<string, unknown>);
  }
  const { data, error } = await admin.from("operator_notices").update(row).eq("id", notice.id).select("*").maybeSingle();
  if (error) return isolationFromMessage(error.message) ?? fail("unavailable");
  if (!data) return fail("unavailable");
  return mapNotice(data as Record<string, unknown>);
}

async function replaceTargets(
  admin: AdminClient,
  noticeId: string,
  targets: { orgId: string; employeeId: string | null }[]
): Promise<AdminFail | null> {
  const del = await admin.from("operator_notice_targets").delete().eq("notice_id", noticeId);
  if (del.error) return isolationFromMessage(del.error.message) ?? fail("unavailable");
  if (targets.length === 0) return null;
  const ins = await admin.from("operator_notice_targets").insert(
    targets.map((t) => ({ notice_id: noticeId, org_id: t.orgId, employee_id: t.employeeId }))
  );
  if (ins.error) return isolationFromMessage(ins.error.message) ?? fail("unavailable");
  return null;
}

async function persistVersion(admin: AdminClient, row: OperatorNoticeVersion): Promise<AdminFail | null> {
  const { error } = await admin.from("operator_notice_versions").upsert(
    {
      notice_id: row.noticeId,
      version: row.version,
      kind: row.kind,
      change_note: row.changeNote,
      title: row.title,
      change_summary: row.changeSummary,
      ai_usage_change: row.aiUsageChange,
      body_hash: row.bodyHash,
      created_by_user_id: row.createdByUserId,
      created_at: row.createdAt,
    },
    { onConflict: "notice_id,version" }
  );
  if (error) return isolationFromMessage(error.message) ?? fail("unavailable");
  return null;
}

function jstDayStartUtc(now: Date): Date {
  const shifted = new Date(now.getTime() + 9 * 3600_000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0);
  return new Date(start - 9 * 3600_000);
}

async function urgentCounts(orgIds: string[]): Promise<{ global: number; perOrg: Map<string, number> } | AdminFail> {
  if (isDemoMode()) {
    const perOrg = new Map<string, number>();
    for (const orgId of orgIds) perOrg.set(orgId, countUrgentPublishedSince({ orgId }).forOrg);
    return { global: countUrgentPublishedSince({}).global, perOrg };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const start = jstDayStartUtc(new Date()).toISOString();
  const { data, error } = await admin
    .from("operator_notices")
    .select("id, audience_scope, published_at, status")
    .eq("severity", "urgent")
    .neq("status", "draft")
    .gte("published_at", start);
  if (error) return fail("unavailable");
  const rows = (data ?? []) as Record<string, unknown>[];
  const global = rows.length;
  const perOrg = new Map<string, number>();
  if (orgIds.length === 0) return { global, perOrg };
  const ids = rows.map((r) => String(r.id));
  if (ids.length === 0) {
    for (const orgId of orgIds) perOrg.set(orgId, 0);
    return { global, perOrg };
  }
  const tgt = await admin.from("operator_notice_targets").select("notice_id, org_id").in("notice_id", ids);
  if (tgt.error) return fail("unavailable");
  const hits = (tgt.data ?? []) as { notice_id: string; org_id: string }[];
  for (const orgId of orgIds) {
    const noticeIds = new Set(hits.filter((t) => t.org_id === orgId).map((t) => t.notice_id));
    perOrg.set(orgId, noticeIds.size);
  }
  return { global, perOrg };
}

async function writeNoticeAudit(
  action: string,
  summary: string,
  notice: OperatorNotice,
  actor: OperatorActor
): Promise<void> {
  const metadata = auditMeta(notice, { adminAction: action, actorUserId: actor.userId });
  const opsOrg = (process.env.PLATFORM_OPS_ORG_ID || "").trim();
  if (opsOrg) {
    await appendAuditEvent({
      orgId: opsOrg,
      employeeId: null,
      credentialId: null,
      actorEmail: actor.email,
      action,
      purpose: "operator_notice",
      summary,
      metadata,
    });
  }
  if (!notice.showToTenantAdmin || notice.audienceScope === "all") return;
  const loaded = await loadTargets(notice.id);
  const targets = Array.isArray(loaded) ? loaded : [];
  const orgIds = [...new Set(targets.map((t) => t.orgId))];
  for (const orgId of orgIds) {
    if (orgId === opsOrg) continue;
    await appendAuditEvent({
      orgId,
      employeeId: null,
      credentialId: null,
      actorEmail: actor.email,
      action,
      purpose: "operator_notice",
      summary,
      metadata,
    });
  }
}

export type ReceiptSummary = {
  total: number;
  delivered: number;
  read: number;
  applied: number;
  pendingApply: number;
  declined: number;
  notApplicable: number;
  needsTenantApproval: number;
  wakeFailed: number;
};

export function summarizeReceipts(rows: OperatorNoticeReceipt[]): ReceiptSummary {
  const s: ReceiptSummary = {
    total: rows.length,
    delivered: 0,
    read: 0,
    applied: 0,
    pendingApply: 0,
    declined: 0,
    notApplicable: 0,
    needsTenantApproval: 0,
    wakeFailed: 0,
  };
  for (const r of rows) {
    if (r.state === "delivered") s.delivered += 1;
    if (r.state === "read") s.read += 1;
    if (r.state === "applied") s.applied += 1;
    if (r.state === "declined") s.declined += 1;
    if (r.state === "not_applicable") s.notApplicable += 1;
    if (r.state === "needs_tenant_approval") s.needsTenantApproval += 1;
    if (r.wakeState === "failed") s.wakeFailed += 1;
    if (r.state === "delivered" || r.state === "read" || r.state === "needs_tenant_approval") s.pendingApply += 1;
  }
  return s;
}

export async function listOperatorNoticesForAdmin(
  _actor: OperatorActor
): Promise<{ ok: true; notices: OperatorNotice[] } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  if (isDemoMode()) return { ok: true, notices: __listDemoNotices() };
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const { data, error } = await admin.from("operator_notices").select("*").order("seq", { ascending: false }).limit(200);
  if (error) return fail("unavailable");
  return { ok: true, notices: ((data ?? []) as Record<string, unknown>[]).map(mapNotice) };
}

export async function listOperatorNoticesWithStats(
  actor: OperatorActor
): Promise<{ ok: true; rows: Array<{ notice: OperatorNotice; stats: ReceiptSummary }> } | AdminFail> {
  const listed = await listOperatorNoticesForAdmin(actor);
  if (!listed.ok) return listed;
  const rows: Array<{ notice: OperatorNotice; stats: ReceiptSummary }> = [];
  for (const notice of listed.notices) {
    const receipts = await loadReceipts(notice.id);
    if (!Array.isArray(receipts)) return receipts;
    rows.push({ notice, stats: summarizeReceipts(receipts) });
  }
  return { ok: true, rows };
}

export async function listNoticeTargetPicker(): Promise<{ ok: true; picker: NoticeTargetPicker } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  if (isDemoMode()) {
    return {
      ok: true,
      picker: {
        orgs: [{ id: DEMO_ORG.id, name: DEMO_ORG.name }],
        employees: DEMO_EMPLOYEES.map((e) => ({ id: e.id, orgId: e.orgId, name: e.displayName })),
      },
    };
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return fail("unavailable");
  const [orgs, employees] = await Promise.all([
    admin.from("orgs").select("id, name").order("created_at", { ascending: false }).limit(500),
    admin.from("employees").select("id, org_id, display_name").order("created_at", { ascending: false }).limit(2000),
  ]);
  if (orgs.error || employees.error) return fail("unavailable");
  return {
    ok: true,
    picker: {
      orgs: ((orgs.data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        name: String(r.name || "名称未設定"),
      })),
      employees: ((employees.data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        orgId: String(r.org_id),
        name: String(r.display_name || r.id),
      })),
    },
  };
}

export async function saveOperatorNoticeDraft(
  actor: OperatorActor,
  input: DraftInput
): Promise<{ ok: true; notice: OperatorNotice } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  if (!isNoticeAudienceScope(input.audienceScope)) return fail("invalid_args");
  const severity = input.severity ?? "normal";
  const applyMode = input.applyMode ?? "self_rules";
  if (!isNoticeSeverity(severity) || !isNoticeApplyMode(applyMode)) return fail("invalid_args");
  const bodyFail = validateBody(input);
  if (bodyFail) return bodyFail;
  const scanned = await scanNoticeText(actor, {
    title: input.title,
    changeSummary: input.changeSummary,
    aiUsageChange: input.aiUsageChange,
  });
  if (!scanned.ok) return scanned;
  const targets = input.targets ?? [];
  if (input.audienceScope === "all" && targets.length > 0) return fail("operator_notice_all_has_no_targets");
  if (input.audienceScope !== "all" && targets.length === 0) return fail("invalid_args", "宛先を選んでください。");

  try {
    if (input.id && isNoticeId(input.id)) {
      const existing = await requireNotice(input.id);
      if (!existing.ok) return existing;
      if (existing.notice.status !== "draft") return fail("not_draft", "公開後の編集は訂正から行ってください。");
      const next: OperatorNotice = {
        ...existing.notice,
        title: input.title.trim(),
        changeSummary: input.changeSummary,
        aiUsageChange: input.aiUsageChange,
        audienceScope: input.audienceScope,
        sticky: input.sticky ?? false,
        severity,
        applyMode,
        showToTenantAdmin: input.showToTenantAdmin ?? true,
        relatedFlags: input.relatedFlags ?? [],
        effectiveAt: input.effectiveAt ?? existing.notice.effectiveAt,
        expiresAt: input.expiresAt === undefined ? existing.notice.expiresAt : input.expiresAt,
        relatesToItemIds: input.relatesToItemIds ?? existing.notice.relatesToItemIds,
        bodyHash: noticeBodyHash(input),
        updatedAt: new Date().toISOString(),
      };
      const versionRow: OperatorNoticeVersion = {
        noticeId: next.id,
        version: 1,
        kind: "initial",
        changeNote: null,
        title: next.title,
        changeSummary: next.changeSummary,
        aiUsageChange: next.aiUsageChange,
        bodyHash: next.bodyHash,
        createdByUserId: actor.userId,
        createdAt: next.updatedAt,
      };
      if (isDemoMode()) {
        __replaceDemoNotice(next);
        __replaceDemoTargets(
          next.id,
          targets.map((t) => ({ noticeId: next.id, orgId: t.orgId, employeeId: t.employeeId }))
        );
        __pushDemoVersion(versionRow);
        return { ok: true, notice: next };
      }
      const admin = createSupabaseAdminClient();
      if (!admin) return fail("unavailable");
      const saved = await persistNotice(admin, next, "update");
      if ("ok" in saved && saved.ok === false) return saved;
      const tgt = await replaceTargets(admin, next.id, input.audienceScope === "all" ? [] : targets);
      if (tgt) return tgt;
      const ver = await persistVersion(admin, versionRow);
      if (ver) return ver;
      return { ok: true, notice: saved as OperatorNotice };
    }

    if (isDemoMode()) {
      const notice = __seedDemoNotice({
        status: "draft",
        title: input.title.trim(),
        changeSummary: input.changeSummary,
        aiUsageChange: input.aiUsageChange,
        audienceScope: input.audienceScope,
        sticky: input.sticky ?? false,
        severity,
        applyMode,
        showToTenantAdmin: input.showToTenantAdmin ?? true,
        relatedFlags: input.relatedFlags ?? [],
        targets,
        effectiveAt: input.effectiveAt,
        expiresAt: input.expiresAt ?? null,
        relatesToItemIds: input.relatesToItemIds ?? [],
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
      });
      return { ok: true, notice };
    }

    const admin = createSupabaseAdminClient();
    if (!admin) return fail("unavailable");
    const at = new Date().toISOString();
    const created: OperatorNotice = {
      id: newNoticeId(),
      seq: 0,
      version: 1,
      status: "draft",
      severity,
      title: input.title.trim(),
      changeSummary: input.changeSummary,
      aiUsageChange: input.aiUsageChange,
      effectiveAt: input.effectiveAt ?? at,
      expiresAt: input.expiresAt ?? null,
      audienceScope: input.audienceScope,
      sticky: input.sticky ?? false,
      relatedFlags: input.relatedFlags ?? [],
      applyMode,
      showToTenantAdmin: input.showToTenantAdmin ?? true,
      relatesToItemIds: input.relatesToItemIds ?? [],
      bodyHash: noticeBodyHash(input),
      createdByUserId: actor.userId,
      createdByEmail: actor.email,
      publishedByUserId: null,
      publishedByEmail: null,
      createdAt: at,
      publishedAt: null,
      withdrawnAt: null,
      updatedAt: at,
    };
    const saved = await persistNotice(admin, created, "insert");
    if ("ok" in saved && saved.ok === false) return saved;
    const notice = saved as OperatorNotice;
    const ver = await persistVersion(admin, {
      noticeId: notice.id,
      version: 1,
      kind: "initial",
      changeNote: null,
      title: notice.title,
      changeSummary: notice.changeSummary,
      aiUsageChange: notice.aiUsageChange,
      bodyHash: notice.bodyHash,
      createdByUserId: actor.userId,
      createdAt: at,
    });
    if (ver) return ver;
    const tgt = await replaceTargets(admin, notice.id, input.audienceScope === "all" ? [] : targets);
    if (tgt) return tgt;
    return { ok: true, notice };
  } catch (err) {
    return isolationFromUnknown(err) ?? fail("unavailable");
  }
}

export async function publishOperatorNotice(
  actor: OperatorActor,
  input: { noticeId: string; confirmed: boolean; acknowledgeWarnings?: boolean }
): Promise<{ ok: true; notice: OperatorNotice; warnings: ReturnType<typeof lintNoticeCopy>["warnings"] } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  const gate = requireFreshConfirm(actor, input.confirmed);
  if (gate) return gate;
  if (!isNoticeId(input.noticeId)) return fail("not_found");
  const loaded = await requireNotice(input.noticeId);
  if (!loaded.ok) return loaded;
  const notice = loaded.notice;
  if (notice.status !== "draft") return fail("not_draft");
  const scanned = await scanNoticeText(actor, {
    title: notice.title,
    changeSummary: notice.changeSummary,
    aiUsageChange: notice.aiUsageChange,
  });
  if (!scanned.ok) return scanned;
  const lint = lintNoticeCopy(notice);
  if ((lint.warnings.length > 0 || scanned.suspected) && !input.acknowledgeWarnings && !input.confirmed) {
    return fail("warnings_unacked");
  }
  if (notice.severity === "urgent") {
    const targets = await loadTargets(notice.id);
    if (!Array.isArray(targets)) return targets;
    const targetOrgs = [...new Set(targets.map((t) => t.orgId))];
    const counts = await urgentCounts(targetOrgs);
    if ("ok" in counts && counts.ok === false) return counts;
    const { global, perOrg } = counts as { global: number; perOrg: Map<string, number> };
    if (global >= URGENT_PER_DAY_GLOBAL) {
      return fail("urgent_daily_cap", "urgent は全体で 1 日 5 件までです。");
    }
    for (const orgId of targetOrgs) {
      if ((perOrg.get(orgId) ?? 0) >= URGENT_PER_DAY_PER_ORG) {
        return fail("urgent_daily_cap", "urgent はテナントごとに 1 日 3 件までです。");
      }
    }
  }
  const at = new Date().toISOString();
  const published: OperatorNotice = {
    ...notice,
    status: "published",
    publishedAt: at,
    publishedByUserId: actor.userId,
    publishedByEmail: actor.email,
    updatedAt: at,
  };
  if (isDemoMode()) {
    __replaceDemoNotice(published);
  } else {
    const admin = createSupabaseAdminClient();
    if (!admin) return fail("unavailable");
    const saved = await persistNotice(admin, published, "update");
    if ("ok" in saved && saved.ok === false) return saved;
  }
  await writeNoticeAudit("operator_notice.published", "運営お知らせを公開しました", published, actor);
  return { ok: true, notice: published, warnings: lint.warnings };
}

export async function correctOperatorNotice(
  actor: OperatorActor,
  input: {
    noticeId: string;
    kind: NoticeVersionKind;
    changeNote: string;
    title: string;
    changeSummary: string;
    aiUsageChange: string;
    applyMode?: NoticeApplyMode;
    audienceScope?: NoticeAudienceScope;
    confirmed: boolean;
    acknowledgeWarnings?: boolean;
  }
): Promise<{ ok: true; notice: OperatorNotice; storedKind: NoticeVersionKind } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  const gate = requireFreshConfirm(actor, input.confirmed);
  if (gate) return gate;
  const loaded = await requireNotice(input.noticeId);
  if (!loaded.ok) return loaded;
  const notice = loaded.notice;
  if (notice.status !== "published") return fail("not_found");
  if (input.audienceScope && input.audienceScope !== notice.audienceScope) {
    return fail("operator_notice_audience_locked");
  }
  const bodyFail = validateBody(input);
  if (bodyFail) return bodyFail;
  if (input.changeNote.length > CHANGE_NOTE_MAX) return fail("invalid_args", "訂正メモは 500 文字までです。");
  const scanned = await scanNoticeText(actor, {
    title: input.title,
    changeSummary: input.changeSummary,
    aiUsageChange: input.aiUsageChange,
    changeNote: input.changeNote,
  });
  if (!scanned.ok) return scanned;
  const applyMode = input.applyMode ?? notice.applyMode;
  const usageChanged = input.aiUsageChange !== notice.aiUsageChange;
  const applyChanged = applyMode !== notice.applyMode;
  let storedKind: NoticeVersionKind = input.kind === "initial" ? "correction" : input.kind;
  if (storedKind === "minor" && (usageChanged || applyChanged)) storedKind = "correction";
  const at = new Date().toISOString();
  const next: OperatorNotice = {
    ...notice,
    version: notice.version + 1,
    title: input.title.trim(),
    changeSummary: input.changeSummary,
    aiUsageChange: input.aiUsageChange,
    applyMode,
    bodyHash: noticeBodyHash(input),
    updatedAt: at,
  };
  const versionRow: OperatorNoticeVersion = {
    noticeId: next.id,
    version: next.version,
    kind: storedKind,
    changeNote: input.changeNote.trim() || null,
    title: next.title,
    changeSummary: next.changeSummary,
    aiUsageChange: next.aiUsageChange,
    bodyHash: next.bodyHash,
    createdByUserId: actor.userId,
    createdAt: at,
  };
  if (isDemoMode()) {
    __replaceDemoNotice(next);
    __pushDemoVersion(versionRow);
  } else {
    const admin = createSupabaseAdminClient();
    if (!admin) return fail("unavailable");
    const saved = await persistNotice(admin, next, "update");
    if ("ok" in saved && saved.ok === false) return saved;
    const ver = await persistVersion(admin, versionRow);
    if (ver) return ver;
  }
  await writeNoticeAudit("operator_notice.corrected", "運営お知らせを訂正しました", next, actor);
  return { ok: true, notice: next, storedKind };
}

export async function withdrawOperatorNotice(
  actor: OperatorActor,
  input: { noticeId: string; confirmed: boolean }
): Promise<{ ok: true; notice: OperatorNotice } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  const gate = requireFreshConfirm(actor, input.confirmed);
  if (gate) return gate;
  const loaded = await requireNotice(input.noticeId);
  if (!loaded.ok) return loaded;
  const notice = loaded.notice;
  const at = new Date().toISOString();
  const next: OperatorNotice = {
    ...notice,
    status: "withdrawn",
    withdrawnAt: at,
    updatedAt: at,
  };
  if (isDemoMode()) {
    __replaceDemoNotice(next);
  } else {
    const admin = createSupabaseAdminClient();
    if (!admin) return fail("unavailable");
    const saved = await persistNotice(admin, next, "update");
    if ("ok" in saved && saved.ok === false) return saved;
  }
  await writeNoticeAudit("operator_notice.withdrawn", "運営お知らせを取り下げました", next, actor);
  return { ok: true, notice: next };
}

export async function previewOperatorNotice(
  _actor: OperatorActor,
  input: { noticeId: string; orgId: string; employeeId: string }
): Promise<
  | { ok: true; visible: false }
  | {
      ok: true;
      visible: true;
      payload: {
        ok: true;
        source: typeof OPERATOR_NOTICES_SOURCE;
        contentTrust: typeof OPERATOR_NOTICES_CONTENT_TRUST;
        guardJa: string;
        unreadCount: number;
        hasMore: boolean;
        notices: ReturnType<typeof wireNotice>[];
      };
    }
  | AdminFail
> {
  const gated = requireFlag();
  if (gated) return gated;
  if (!isNoticeId(input.noticeId) || !input.orgId || !input.employeeId) return fail("invalid_args");
  if (isDemoMode()) __registerDemoEmployee(input.employeeId, input.orgId);
  const loaded = await requireNotice(input.noticeId);
  if (!loaded.ok) return loaded;
  const notice = loaded.notice;
  if (notice.status === "published") {
    const listed = await runNoticesList(
      input.orgId,
      input.employeeId,
      { noticeId: input.noticeId, unreadOnly: false },
      { recordDelivery: false }
    );
    if (listed.isError) {
      const code = (listed.data as { code?: string }).code;
      if (code === "not_found") return { ok: true, visible: false };
      return fail("unavailable");
    }
    const notices = (listed.data.notices as ReturnType<typeof wireNotice>[]) ?? [];
    if (notices.length === 0) return { ok: true, visible: false };
    return {
      ok: true,
      visible: true,
      payload: {
        ok: true,
        source: OPERATOR_NOTICES_SOURCE,
        contentTrust: OPERATOR_NOTICES_CONTENT_TRUST,
        guardJa: OPERATOR_NOTICES_GUARD_JA,
        unreadCount: Number(listed.data.unreadCount ?? 0),
        hasMore: Boolean(listed.data.hasMore),
        notices,
      },
    };
  }
  const simulated = {
    ...notice,
    status: "published" as const,
    publishedAt: notice.publishedAt ?? notice.createdAt,
  };
  const loadedTargets = await loadTargets(notice.id);
  if (!Array.isArray(loadedTargets)) return loadedTargets;
  let orgCreatedAt = "2020-01-01T00:00:00.000Z";
  if (!isDemoMode()) {
    const admin = createSupabaseAdminClient();
    if (!admin) return fail("unavailable");
    const { data } = await admin.from("orgs").select("created_at").eq("id", input.orgId).maybeSingle();
    if (data && (data as { created_at?: unknown }).created_at) {
      orgCreatedAt = String((data as { created_at: unknown }).created_at);
    }
  }
  const visible = isNoticeCurrentlyVisible(simulated, loadedTargets, {
    orgId: input.orgId,
    employeeId: input.employeeId,
    orgCreatedAt,
  });
  if (!visible) return { ok: true, visible: false };
  const versions = await loadVersions(notice.id);
  if (!Array.isArray(versions)) return versions;
  const latest = versions.find((v) => v.version === notice.version);
  return {
    ok: true,
    visible: true,
    payload: {
      ok: true,
      source: OPERATOR_NOTICES_SOURCE,
      contentTrust: OPERATOR_NOTICES_CONTENT_TRUST,
      guardJa: OPERATOR_NOTICES_GUARD_JA,
      unreadCount: 1,
      hasMore: false,
      notices: [wireNotice(simulated, undefined, latest)],
    },
  };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function listOperatorNoticeReceipts(
  _actor: OperatorActor,
  noticeId: string
): Promise<{ ok: true; receipts: OperatorNoticeReceipt[] } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  if (!isNoticeId(noticeId)) return fail("not_found");
  const loaded = await requireNotice(noticeId);
  if (!loaded.ok) return loaded;
  const rows = await loadReceipts(noticeId);
  if (!Array.isArray(rows)) return rows;
  return { ok: true, receipts: rows };
}

export async function listOperatorNoticeReceiptsCsv(
  actor: OperatorActor,
  input: { noticeId: string }
): Promise<{ ok: true; csv: string } | AdminFail> {
  const listed = await listOperatorNoticeReceipts(actor, input.noticeId);
  if (!listed.ok) return listed;
  const header = [
    "notice_id",
    "org_id",
    "employee_id",
    "state",
    "first_listed_at",
    "read_at",
    "acked_version",
    "acked_at",
    "apply_evidence",
    "wake_state",
  ];
  const lines = [header.join(",")];
  for (const r of listed.receipts) {
    lines.push(
      [
        r.noticeId,
        r.orgId,
        r.employeeId,
        r.state,
        r.firstListedAt,
        r.readAt ?? "",
        r.ackedVersion == null ? "" : String(r.ackedVersion),
        r.ackedAt ?? "",
        r.applyEvidence ?? "",
        r.wakeState,
      ]
        .map((v) => csvEscape(String(v)))
        .join(",")
    );
  }
  return { ok: true, csv: `${lines.join("\n")}\n` };
}

export async function getOperatorNoticeBundle(
  _actor: OperatorActor,
  noticeId: string
): Promise<{ ok: true; notice: OperatorNotice; targets: OperatorNoticeTarget[] } | AdminFail> {
  const gated = requireFlag();
  if (gated) return gated;
  if (!isNoticeId(noticeId)) return fail("not_found");
  const loaded = await requireNotice(noticeId);
  if (!loaded.ok) return loaded;
  const targets = await loadTargets(noticeId);
  if (!Array.isArray(targets)) return targets;
  return { ok: true, notice: loaded.notice, targets };
}
