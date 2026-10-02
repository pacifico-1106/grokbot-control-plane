/**
 * P1 Channel Scope — CS5 Admin MCP channelScope.reconcile.
 *
 * - dryRun (default true): read-only. Lists the employee's channels via users.conversations and
 *   returns the planned additions / stricter classifications / scope moves / leaves. Nothing is
 *   written (no DB write, no audit, no ticket).
 * - dryRun=false: always_human (approvalClass admin, kind=account). The plan is computed now and
 *   stored on the ticket; after a different human approves, fulfill re-lists and applies ONLY the
 *   approved item keys, never wider than the approved membership state, and skips rows a real
 *   event changed since (lib/channel-scope/reconcile.ts). New differences found at fulfill time
 *   are reported, not applied.
 *
 * Flag: P1_CHANNEL_SCOPE_ENABLED must be ON (OFF ⇒ feature_disabled, no Slack / DB access).
 */
import { randomUUID } from "node:crypto";
import type { ApprovalRequest } from "@/lib/types";
import { appendAuditEvent } from "@/lib/data/audit";
import { getEmployee } from "@/lib/data/employees";
import { isChannelScopeEnabled } from "@/lib/feature-flags";
import {
  countByAction,
  reconcileEmployeeChannelScope,
  type EmployeeReconcileResult,
  type ReconcileAction,
  type ReconcileDeps,
  type ReconcileItem,
} from "./reconcile";

export const CHANNEL_SCOPE_RECONCILE_TOOL = "channelScope.reconcile";
export const CHANNEL_SCOPE_RECONCILE_TITLE_JA = "チャンネル範囲の照合結果の適用";
export const CHANNEL_SCOPE_RECONCILE_SNAPSHOT_KEY = "__channelScopeReconcile";
/** Items an approval can cover in one ticket (re-run for the rest). */
export const RECONCILE_APPROVAL_ITEM_CAP = 500;
const OUTPUT_ITEM_CAP = 200;
const EMPLOYEE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FLAG_OFF_MESSAGE_JA = "P1_CHANNEL_SCOPE_ENABLED が OFF のため、チャンネル範囲の照合は使用できません";

const ACTION_JA: Record<ReconcileAction, string> = {
  add: "取りこぼした参加の記録",
  classify: "未分類チャンネルの分類",
  stricter: "分類の厳格化",
  in_scope: "範囲内へ移動",
  out_of_scope: "範囲外へ移動",
  leave: "退出・削除の記録",
};

type Fail = { ok: false; code: string; message: string; status: number };

export interface ChannelScopeReconcileSnapshot {
  employeeId: string;
  keys: string[];
  counts: Record<ReconcileAction, number>;
  widening: number;
  summaryLines: string[];
  preparedAt: string;
  truncated: boolean;
}

function viewItem(i: ReconcileItem) {
  return {
    key: i.key,
    action: i.action,
    via: i.via,
    channelId: i.channelId,
    state: i.state ?? null,
    previousState: i.previousState,
    ledger: i.ledger ? { from: i.ledger.from, to: { classification: i.ledger.to.classification, mixed: i.ledger.to.mixed }, basis: i.ledger.auto.basis } : null,
    widens: i.widens,
  };
}

function allItems(r: EmployeeReconcileResult): ReconcileItem[] {
  return r.vias.flatMap((v) => v.items);
}

function view(r: EmployeeReconcileResult) {
  const items = allItems(r);
  return {
    employeeId: r.employeeId,
    mode: r.mode,
    includeSlackConnect: r.includeSlackConnect,
    scopeSource: r.scopeSource,
    counts: countByAction(items),
    widening: items.filter((i) => i.widens).length,
    vias: r.vias.map((v) => ({
      via: v.via,
      status: v.status,
      reason: v.reason ?? null,
      listing: v.listing ?? null,
      membershipsTruncated: v.membershipsTruncated ?? false,
      leavesSuppressed: v.status === "reconciled" && !(v.listing?.complete && !v.membershipsTruncated),
      itemCount: v.items.length,
    })),
    items: items.slice(0, OUTPUT_ITEM_CAP).map(viewItem),
    itemsTruncated: items.length > OUTPUT_ITEM_CAP,
  };
}

function summaryLines(items: ReconcileItem[]): string[] {
  const counts = countByAction(items);
  const lines = (Object.keys(counts) as ReconcileAction[]).filter((a) => counts[a] > 0).map((a) => `${ACTION_JA[a]}: ${counts[a]}件`);
  const widening = items.filter((i) => i.widens).length;
  if (widening) lines.push(`うち範囲が広がる変更: ${widening}件（Connect への送信は人の確定まで承認制のまま）`);
  return lines;
}

async function validate(orgId: string, args: Record<string, unknown>): Promise<{ ok: true; employeeId: string } | Fail> {
  if (!isChannelScopeEnabled()) return { ok: false, code: "feature_disabled", message: FLAG_OFF_MESSAGE_JA, status: 403 };
  const employeeId = typeof args.employeeId === "string" ? args.employeeId.trim() : "";
  if (!employeeId || !EMPLOYEE_ID_RE.test(employeeId)) {
    return { ok: false, code: "employee_id_required", message: "employeeId が必要です", status: 400 };
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") {
    return { ok: false, code: "validation_failed", message: "dryRun は boolean です", status: 400 };
  }
  if (!(await getEmployee(employeeId, orgId))) return { ok: false, code: "employee_not_found", message: "AI社員が見つかりません", status: 404 };
  return { ok: true, employeeId };
}

/** dryRun (default): read-only preview. */
export async function handleChannelScopeReconcilePreview(orgId: string, args: Record<string, unknown>, deps: ReconcileDeps = {}) {
  const v = await validate(orgId, args);
  if (!v.ok) return v;
  const r = await reconcileEmployeeChannelScope(
    { orgId, employeeId: v.employeeId, dryRun: true, trigger: "admin_mcp", runId: `preview-${randomUUID()}` },
    deps
  );
  if (!r.ok) return { ok: false as const, code: r.code ?? "reconcile_failed", message: FLAG_OFF_MESSAGE_JA, status: 403 };
  return {
    ok: true as const,
    dryRun: true,
    readOnly: true,
    ...view(r),
    nextStepJa: allItems(r).length
      ? "適用するには dryRun=false で再実行してください（人の承認後に適用されます）。"
      : "差分はありません。",
  };
}

/** dryRun=false: compute the plan for the approval ticket. */
export async function prepareChannelScopeReconcileApply(
  orgId: string,
  args: Record<string, unknown>,
  deps: ReconcileDeps = {}
): Promise<{ ok: true; snapshot: ChannelScopeReconcileSnapshot; summary: string; preview: ReturnType<typeof view> } | Fail> {
  const v = await validate(orgId, args);
  if (!v.ok) return v;
  const r = await reconcileEmployeeChannelScope(
    { orgId, employeeId: v.employeeId, dryRun: true, trigger: "admin_mcp", runId: `plan-${randomUUID()}` },
    deps
  );
  if (!r.ok) return { ok: false, code: r.code ?? "reconcile_failed", message: FLAG_OFF_MESSAGE_JA, status: 403 };
  const items = allItems(r);
  if (!items.length) return { ok: false, code: "no_change", message: "差分はありません", status: 400 };
  const approved = items.slice(0, RECONCILE_APPROVAL_ITEM_CAP);
  const lines = summaryLines(approved);
  const employee = await getEmployee(v.employeeId, orgId);
  const snapshot: ChannelScopeReconcileSnapshot = {
    employeeId: v.employeeId,
    keys: approved.map((i) => i.key),
    counts: countByAction(approved),
    widening: approved.filter((i) => i.widens).length,
    summaryLines: lines,
    preparedAt: new Date().toISOString(),
    truncated: items.length > approved.length,
  };
  const summary = [
    `AI社員「${employee?.displayName ?? v.employeeId}」のチャンネル参加状況を Slack と照合した結果を適用します（承認後）。`,
    "",
    "■ 予定:",
    ...lines.map((l) => `  ${l}`),
    ...(snapshot.truncated ? ["", `※ ${RECONCILE_APPROVAL_ITEM_CAP}件を超えた分は次回の照合で扱います。`] : []),
    "",
    "承認時点で再照合し、承認された項目だけを適用します（これより広い変更は行いません）。",
  ].join("\n");
  return { ok: true, snapshot, summary, preview: view(r) };
}

export function buildChannelScopeReconcileQueuedArgs(
  args: Record<string, unknown>,
  snapshot: ChannelScopeReconcileSnapshot
): Record<string, unknown> {
  return {
    employeeId: snapshot.employeeId,
    dryRun: false,
    ...(typeof args.jobId === "string" ? { jobId: args.jobId } : {}),
    [CHANNEL_SCOPE_RECONCILE_SNAPSHOT_KEY]: snapshot,
  };
}

function readSnapshot(args: Record<string, unknown>): ChannelScopeReconcileSnapshot | null {
  const raw = args[CHANNEL_SCOPE_RECONCILE_SNAPSHOT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.employeeId !== "string" || !EMPLOYEE_ID_RE.test(s.employeeId)) return null;
  if (!Array.isArray(s.keys) || s.keys.length === 0 || s.keys.length > RECONCILE_APPROVAL_ITEM_CAP) return null;
  if (!s.keys.every((k) => typeof k === "string" && /^(user|bot):[CG][A-Z0-9]{2,63}:[a-z_]{3,16}$/.test(k))) return null;
  return s as unknown as ChannelScopeReconcileSnapshot;
}

export async function fulfillChannelScopeReconcile(
  approval: ApprovalRequest,
  args: Record<string, unknown>,
  deps: ReconcileDeps = {}
): Promise<{ ok: boolean; code?: string; message?: string }> {
  if (!isChannelScopeEnabled()) return { ok: false, code: "feature_disabled", message: FLAG_OFF_MESSAGE_JA };
  const snapshot = readSnapshot(args);
  if (!snapshot) return { ok: false, code: "missing_snapshot", message: "承認チケットに照合結果のスナップショットがありません" };
  const orgId = approval.orgId;
  if (!(await getEmployee(snapshot.employeeId, orgId))) return { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" };
  const runId = `approval-${approval.id}`.slice(0, 100);
  const r = await reconcileEmployeeChannelScope(
    { orgId, employeeId: snapshot.employeeId, dryRun: false, trigger: "admin_mcp", runId, allowedKeys: new Set(snapshot.keys) },
    deps
  );
  if (!r.ok) return { ok: false, code: r.code ?? "reconcile_failed", message: FLAG_OFF_MESSAGE_JA };
  const applied = r.vias.reduce((n, v) => n + (v.applied?.applied ?? 0), 0);
  const failed = r.vias.reduce((n, v) => n + (v.applied?.failed ?? 0), 0);
  const skipped = r.vias.flatMap((v) => v.applied?.skipped ?? []);
  const notApproved = skipped.filter((s) => s.reason === "not_in_approved_plan").length;
  await appendAuditEvent({
    orgId,
    employeeId: snapshot.employeeId,
    credentialId: null,
    action: "channel_scope.reconcile_applied",
    purpose: "admin.policy",
    summary: `チャンネル範囲の照合結果を適用しました（人承認後・${applied}件）`,
    metadata: {
      approvalId: approval.id,
      filedBy: (approval.metadata?.adminRequester as { actorId?: string } | undefined)?.actorId ?? null,
      approvedBy: approval.resolvedBy ?? null,
      approvedCounts: snapshot.counts,
      approvedWidening: snapshot.widening,
      applied,
      failed,
      skippedChangedOrInactive: skipped.length - notApproved,
      newDifferencesNotApplied: notApproved,
    },
  }).catch(() => undefined);
  const message =
    `照合結果を ${applied} 件適用しました` +
    (notApproved ? `（承認後に見つかった ${notApproved} 件は未適用。必要なら再度照合してください）` : "") +
    (failed ? `。${failed} 件は失敗しました` : "");
  return failed && !applied ? { ok: false, code: "apply_failed", message } : { ok: true, message };
}
