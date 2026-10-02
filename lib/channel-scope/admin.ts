/**
 * P1 Channel Scope — Admin MCP / Web API handlers (CS2)
 *
 * Tools:
 * - channelScope.get              read-only
 * - channelScope.listMemberships  read-only
 * - channelScope.patch            always_human, approvalClass admin, kind=account (owner approval)
 *
 * Mirrors approvalRoutes.patch: validate → before/after snapshots + diff card → queue
 * (always_human) → after a *different* human approves, fulfill re-checks the before-state hash,
 * re-validates, persists, and writes audit. The Web API (/api/channel-scope) only files the same
 * ticket; it never writes directly.
 *
 * Flags: P1_CHANNEL_SCOPE_ENABLED OFF ⇒ get/list report disabled without touching the new
 * columns, patch/fulfill return feature_disabled. includeSlackConnect=true is accepted only when
 * P1_CHANNEL_SCOPE_CONNECT_ENABLED is ON (filing and fulfill).
 */
import { createHash } from "node:crypto";
import type { ApprovalRequest } from "@/lib/types";
import { getEmployee } from "@/lib/data/employees";
import { appendAuditEvent } from "@/lib/data/audit";
import { isChannelScopeConnectEnabled, isChannelScopeEnabled } from "@/lib/feature-flags";
import type { ChannelClassification } from "@/lib/types";
import type {
  ChannelScopeChannel,
  ChannelScopePolicy,
  ChannelScopeSource,
  EmployeeChannelMembership,
  MembershipState,
} from "./types";
import { MEMBERSHIP_STATES } from "./types";
import { applyChannelScopePatch, validateChannelScopePolicy, type ChannelScopeValidationError } from "./validate";
import { readChannelScopeFlags, resolveEffectiveChannelScope } from "./resolve";
import {
  getEmployeeChannelScopeOverrideRaw,
  getOrgChannelScopePolicyRaw,
  listChannelScopeChannels,
  listEmployeeChannelMemberships,
  listUnconfirmedConnectChannels,
  MEMBERSHIP_LIST_MAX,
  setEmployeeChannelScopeOverride,
  setOrgChannelScopePolicy,
} from "./data";

export const CHANNEL_SCOPE_PATCH_TOOL = "channelScope.patch";
export const CHANNEL_SCOPE_TITLE_JA = "チャンネル範囲設定の変更";
/** Key inside the queued args (approval.metadata.adminMutation) holding the server-built snapshots. */
export const CHANNEL_SCOPE_SNAPSHOT_KEY = "__channelScope";

const FLAG_OFF_MESSAGE_JA = "P1_CHANNEL_SCOPE_ENABLED が OFF のため、チャンネル範囲設定は使用できません（現在は登録済みのみ）";
const CONNECT_OFF_MESSAGE_JA =
  "P1_CHANNEL_SCOPE_CONNECT_ENABLED が OFF のため、includeSlackConnect=true は指定できません";
const EMPLOYEE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type ChannelScopeLayer = "org" | "employee";

export interface ChannelScopeSnapshot {
  layer: ChannelScopeLayer;
  employeeId: string | null;
  /** Raw stored JSON of the target layer (null = not set). */
  before: unknown | null;
  beforeStateHash: string;
  /** Policy to store (null = clear the employee override). updatedAt/updatedBy are set at fulfill. */
  after: ChannelScopePolicy | null;
  diffSummary: string[];
  widens: boolean;
  source: "admin_mcp" | "web_api";
}

type Fail = { ok: false; code: string; message: string; validationErrors?: ChannelScopeValidationError[]; status: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/** Deterministic hash of the target layer's stored value (key order independent). */
export function channelScopeStateHash(layer: ChannelScopeLayer, employeeId: string | null, value: unknown): string {
  const body = JSON.stringify(stable({ layer, employeeId: employeeId ?? null, value: value ?? null }));
  return `cs1:${createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
}

function strip(policy: ChannelScopePolicy | null): Omit<ChannelScopePolicy, "updatedAt" | "updatedBy"> | null {
  if (!policy) return null;
  const { updatedAt: _a, updatedBy: _b, ...rest } = policy;
  void _a;
  void _b;
  return rest;
}

function sameIgnoringStamp(a: ChannelScopePolicy | null, b: ChannelScopePolicy | null): boolean {
  return JSON.stringify(stable(strip(a))) === JSON.stringify(stable(strip(b)));
}

function parseEmployeeId(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || !EMPLOYEE_ID_RE.test(raw.trim())) return { ok: false };
  return { ok: true, value: raw.trim() };
}

async function assertEmployeeInOrg(orgId: string, employeeId: string): Promise<boolean> {
  return Boolean(await getEmployee(employeeId, orgId));
}

function modeJa(p: ChannelScopePolicy | null): string {
  if (!p) return "未設定（継承）";
  if (p.mode === "registered_only") return "登録済みのみ";
  return p.includeSlackConnect ? "参加中すべて＋Slack Connect" : "参加中すべて（社内のみ）";
}

/** Does `after` cover more channels than `before`? (registered_only < all_joined < +Connect; allowlist removal) */
export function channelScopeWidens(before: ChannelScopePolicy | null, after: ChannelScopePolicy | null): boolean {
  const rank = (p: ChannelScopePolicy | null) => (!p || p.mode === "registered_only" ? 0 : p.includeSlackConnect ? 2 : 1);
  if (rank(after) > rank(before)) return true;
  if (after && before && after.includeSlackConnect && before.includeSlackConnect) {
    const a = after.connect.allowedExternalTeamIds;
    const b = before.connect.allowedExternalTeamIds;
    if (b.length > 0 && (a.length === 0 || a.some((t) => !b.includes(t)))) return true;
    if (before.connect.egress === "needs_approval_until_confirmed" && after.connect.egress === "matrix") return true;
  }
  return false;
}

/** Japanese diff card lines. `before`/`after` are effective policies of the target layer. */
export function buildChannelScopeDiff(input: {
  layer: ChannelScopeLayer;
  employeeLabel?: string | null;
  before: ChannelScopePolicy | null;
  beforeInvalid: boolean;
  after: ChannelScopePolicy | null;
  inheritedAfter?: ChannelScopePolicy | null;
}): string[] {
  const { before, after } = input;
  const lines: string[] = [];
  lines.push(
    input.layer === "org"
      ? "対象: テナント既定（全AI社員の既定値）"
      : `対象: AI社員ごとの上書き（${input.employeeLabel || "AI社員"}）`
  );
  if (input.beforeInvalid) lines.push("注意: 現在の保存値は不正なため、安全側の既定（登録済みのみ）として扱われています");
  if (after === null) {
    lines.push(`上書きを解除: ${modeJa(before)} → テナント既定を継承（${modeJa(input.inheritedAfter ?? null)}）`);
  } else {
    const b = before;
    if (!b || b.mode !== after.mode || b.includeSlackConnect !== after.includeSlackConnect) {
      lines.push(`範囲: ${modeJa(b)} → ${modeJa(after)}`);
    }
    if (after.mode === "all_joined" && after.includeSlackConnect) {
      const bc = b?.connect;
      const ac = after.connect;
      if (!bc || bc.egress !== ac.egress) {
        lines.push(
          `Connect への送信: ${bc ? (bc.egress === "matrix" ? "通常の判定" : "確定まで承認必須") + " → " : ""}${
            ac.egress === "matrix" ? "通常の判定（情報区分マトリクス）" : "人が確定するまで承認必須"
          }`
        );
      }
      if (!bc || bc.notifyApproverOnInvite !== ac.notifyApproverOnInvite) {
        lines.push(`招待時の承認者通知: ${ac.notifyApproverOnInvite ? "する" : "しない"}`);
      }
      const prev = bc?.allowedExternalTeamIds ?? [];
      const next = ac.allowedExternalTeamIds;
      const added = next.filter((t) => !prev.includes(t));
      const removed = prev.filter((t) => !next.includes(t));
      if (next.length === 0 && (prev.length > 0 || !bc)) lines.push("許可する外部 team: 制限なし（どの外部 team の Connect も範囲に入ります）");
      if (added.length && next.length) lines.push(`許可する外部 team 追加: ${added.join(", ")}`);
      if (removed.length && next.length) lines.push(`許可する外部 team 削除: ${removed.join(", ")}`);
    }
  }
  const effectiveAfter = after ?? input.inheritedAfter ?? null;
  if (channelScopeWidens(before, effectiveAfter)) {
    lines.push(
      effectiveAfter?.includeSlackConnect
        ? "⚠ 範囲が広がります。Slack Connect の自動参加分は、人が確定するまで送信が承認制です"
        : "⚠ 範囲が広がります（参加中の社内チャンネルが対象になります）"
    );
  }
  if (lines.length === 1) lines.push("変更はありません");
  return lines;
}

// ---------------------------------------------------------------------------
// channelScope.get
// ---------------------------------------------------------------------------

export async function handleChannelScopeGet(orgId: string, args: Record<string, unknown>) {
  const emp = parseEmployeeId(args.employeeId);
  if (!emp.ok) return { ok: false as const, code: "invalid_employee_id", message: "employeeId の形式が不正です" };
  const employeeId = emp.value;
  if (employeeId && !(await assertEmployeeInOrg(orgId, employeeId))) {
    return { ok: false as const, code: "employee_not_found", message: "AI社員が見つかりません" };
  }
  const flags = readChannelScopeFlags();
  if (!flags.enabled) {
    const effective = resolveEffectiveChannelScope({ flags });
    return {
      ok: true as const,
      enabled: false,
      flags,
      employeeId,
      effective: { policy: effective.policy, source: effective.source as ChannelScopeSource },
      orgPolicy: null,
      employeeOverride: null,
      beforeStateHash: null,
      memberships: null,
      unconfirmedConnect: [],
      message: FLAG_OFF_MESSAGE_JA,
    };
  }
  const [orgRaw, empRaw] = await Promise.all([
    getOrgChannelScopePolicyRaw(orgId),
    employeeId ? getEmployeeChannelScopeOverrideRaw(orgId, employeeId) : Promise.resolve(null),
  ]);
  const effective = resolveEffectiveChannelScope({ employeeOverride: empRaw, orgPolicy: orgRaw, flags });
  const layer: ChannelScopeLayer = employeeId ? "employee" : "org";
  const counts: Record<MembershipState, number> = { member: 0, out_of_scope: 0, left: 0, removed: 0 };
  let truncated = false;
  if (employeeId) {
    const rows = await listEmployeeChannelMemberships(orgId, { employeeId, limit: MEMBERSHIP_LIST_MAX });
    truncated = rows.length >= MEMBERSHIP_LIST_MAX;
    for (const r of rows) counts[r.state] += 1;
  }
  const unconfirmed = await listUnconfirmedConnectChannels(orgId, 50);
  return {
    ok: true as const,
    enabled: true,
    flags,
    employeeId,
    effective: {
      policy: effective.policy,
      source: effective.source,
      connectSuppressed: effective.connectSuppressed,
      invalidStoredPolicy: effective.invalidStoredPolicy,
    },
    orgPolicy: orgRaw,
    employeeOverride: employeeId ? empRaw : undefined,
    beforeStateHash: channelScopeStateHash(layer, employeeId, layer === "org" ? orgRaw : empRaw),
    memberships: employeeId ? { ...counts, truncated } : null,
    unconfirmedConnect: unconfirmed.map(publicChannel),
  };
}

function publicChannel(c: ChannelScopeChannel) {
  return {
    externalId: c.externalId,
    classification: c.classification,
    mixed: c.mixed,
    source: c.source ?? "manual",
    slackTeamId: c.slackTeamId ?? null,
    externalTeamIds: c.externalTeamIds ?? [],
    humanConfirmedAt: c.humanConfirmedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// channelScope.listMemberships
// ---------------------------------------------------------------------------

const CLASSIFICATIONS: ChannelClassification[] = ["internal", "shared_external", "unknown"];

export async function handleChannelScopeListMemberships(orgId: string, args: Record<string, unknown>) {
  const emp = parseEmployeeId(args.employeeId);
  if (!emp.ok) return { ok: false as const, code: "invalid_employee_id", message: "employeeId の形式が不正です" };
  const state = args.state;
  if (state !== undefined && (typeof state !== "string" || !MEMBERSHIP_STATES.includes(state as MembershipState))) {
    return { ok: false as const, code: "invalid_state", message: "state は member / left / removed / out_of_scope です" };
  }
  const classification = args.classification;
  if (classification !== undefined && (typeof classification !== "string" || !CLASSIFICATIONS.includes(classification as ChannelClassification))) {
    return { ok: false as const, code: "invalid_classification", message: "classification は internal / shared_external / unknown です" };
  }
  const limitRaw = args.limit;
  if (limitRaw !== undefined && (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MEMBERSHIP_LIST_MAX)) {
    return { ok: false as const, code: "invalid_limit", message: `limit は 1〜${MEMBERSHIP_LIST_MAX} の整数です` };
  }
  const limit = (limitRaw as number | undefined) ?? 100;
  if (emp.value && !(await assertEmployeeInOrg(orgId, emp.value))) {
    return { ok: false as const, code: "employee_not_found", message: "AI社員が見つかりません" };
  }
  if (!isChannelScopeEnabled()) {
    return { ok: true as const, enabled: false, memberships: [], count: 0, message: FLAG_OFF_MESSAGE_JA };
  }
  const rows = await listEmployeeChannelMemberships(orgId, {
    employeeId: emp.value ?? undefined,
    state: state as MembershipState | undefined,
    limit: classification ? MEMBERSHIP_LIST_MAX : limit,
  });
  const channels = await listChannelScopeChannels(orgId, "slack", rows.map((r) => r.externalId));
  const byId = new Map(channels.map((c) => [c.externalId, c]));
  const items = rows
    .map((m: EmployeeChannelMembership) => {
      const ch = byId.get(m.externalId) ?? null;
      return {
        employeeId: m.employeeId,
        externalId: m.externalId,
        via: m.via,
        state: m.state,
        inviterTeamId: m.inviterTeamId,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        updatedAt: m.updatedAt,
        classification: (ch?.classification ?? "unknown") as ChannelClassification,
        mixed: ch?.mixed ?? false,
        channelSource: ch?.source ?? null,
        humanConfirmedAt: ch?.humanConfirmedAt ?? null,
      };
    })
    .filter((x) => !classification || x.classification === classification)
    .slice(0, limit);
  return { ok: true as const, enabled: true, memberships: items, count: items.length };
}

// ---------------------------------------------------------------------------
// channelScope.patch — prepare (shared by Admin MCP and Web API)
// ---------------------------------------------------------------------------

const PATCH_INPUT_KEYS = new Set([
  "employeeId",
  "clearOverride",
  "mode",
  "includeSlackConnect",
  "connect",
  "beforeStateHash",
  "jobId",
  "approvalId",
]);

export async function prepareChannelScopePatch(
  orgId: string,
  args: Record<string, unknown>,
  source: ChannelScopeSnapshot["source"]
): Promise<{ ok: true; snapshot: ChannelScopeSnapshot; summary: string } | Fail> {
  if (!isChannelScopeEnabled()) {
    return { ok: false, code: "feature_disabled", message: FLAG_OFF_MESSAGE_JA, status: 403 };
  }
  const unknown = Object.keys(args).filter((k) => !PATCH_INPUT_KEYS.has(k));
  if (unknown.length) {
    return { ok: false, code: "validation_failed", message: `未対応の項目: ${unknown.join(", ")}`, status: 400 };
  }
  const emp = parseEmployeeId(args.employeeId);
  if (!emp.ok) return { ok: false, code: "invalid_employee_id", message: "employeeId の形式が不正です", status: 400 };
  const employeeId = emp.value;
  if (args.clearOverride !== undefined && typeof args.clearOverride !== "boolean") {
    return { ok: false, code: "validation_failed", message: "clearOverride は true/false です", status: 400 };
  }
  const clearOverride = args.clearOverride === true;
  if (clearOverride && !employeeId) {
    return { ok: false, code: "employee_required", message: "clearOverride には employeeId が必要です", status: 400 };
  }
  if (clearOverride && (args.mode !== undefined || args.includeSlackConnect !== undefined || args.connect !== undefined)) {
    return { ok: false, code: "validation_failed", message: "clearOverride と mode/includeSlackConnect/connect は同時に指定できません", status: 400 };
  }
  if (args.beforeStateHash !== undefined && typeof args.beforeStateHash !== "string") {
    return { ok: false, code: "validation_failed", message: "beforeStateHash は文字列です", status: 400 };
  }
  let employeeLabel: string | null = null;
  if (employeeId) {
    const employee = await getEmployee(employeeId, orgId);
    if (!employee) return { ok: false, code: "employee_not_found", message: "AI社員が見つかりません", status: 404 };
    employeeLabel = employee.displayName || employeeId;
  }

  const layer: ChannelScopeLayer = employeeId ? "employee" : "org";
  const orgRaw = await getOrgChannelScopePolicyRaw(orgId);
  const empRaw = employeeId ? await getEmployeeChannelScopeOverrideRaw(orgId, employeeId) : null;
  const targetRaw = layer === "org" ? orgRaw : empRaw;
  const beforeStateHash = channelScopeStateHash(layer, employeeId, targetRaw);
  if (typeof args.beforeStateHash === "string" && args.beforeStateHash !== beforeStateHash) {
    return { ok: false, code: "before_state_mismatch", message: "設定が変更されています。最新の状態を取得してからやり直してください。", status: 409 };
  }

  const parsedTarget = targetRaw == null ? null : validateChannelScopePolicy(targetRaw);
  const beforeInvalid = Boolean(parsedTarget && !parsedTarget.ok);
  const beforePolicy = parsedTarget && parsedTarget.ok ? parsedTarget.policy : null;
  const parsedOrg = orgRaw == null ? null : validateChannelScopePolicy(orgRaw);
  const orgPolicy = parsedOrg && parsedOrg.ok ? parsedOrg.policy : null;

  let after: ChannelScopePolicy | null = null;
  if (clearOverride) {
    if (empRaw == null) return { ok: false, code: "no_change", message: "上書きは設定されていません", status: 400 };
  } else {
    if (args.mode === undefined) return { ok: false, code: "validation_failed", message: "mode は必須です", status: 400 };
    // New employee override starts from the org default's connect settings (or the safe default).
    const base = beforePolicy ?? (layer === "employee" ? orgPolicy : null);
    const patch: Record<string, unknown> = { mode: args.mode };
    if (args.includeSlackConnect !== undefined) patch.includeSlackConnect = args.includeSlackConnect;
    if (args.connect !== undefined) patch.connect = args.connect;
    const result = applyChannelScopePatch(base, patch);
    if (!result.ok) {
      return { ok: false, code: "validation_failed", message: "入力値の検証に失敗しました", validationErrors: result.errors, status: 400 };
    }
    after = result.policy;
    if (after.includeSlackConnect && !isChannelScopeConnectEnabled()) {
      return { ok: false, code: "connect_disabled", message: CONNECT_OFF_MESSAGE_JA, status: 403 };
    }
    if (!beforeInvalid && targetRaw != null && sameIgnoringStamp(beforePolicy, after)) {
      return { ok: false, code: "no_change", message: "変更はありません", status: 400 };
    }
  }

  const effectiveBefore =
    layer === "employee" && empRaw == null ? orgPolicy : beforePolicy;
  const diffSummary = buildChannelScopeDiff({
    layer,
    employeeLabel,
    before: effectiveBefore,
    beforeInvalid,
    after,
    inheritedAfter: after === null ? orgPolicy : undefined,
  });
  const snapshot: ChannelScopeSnapshot = {
    layer,
    employeeId,
    before: targetRaw ?? null,
    beforeStateHash,
    after,
    diffSummary,
    widens: channelScopeWidens(effectiveBefore, after ?? orgPolicy),
    source,
  };
  const summary = [
    "チャンネル範囲設定を変更します（承認後に適用）。",
    "",
    "■ 変更内容:",
    ...diffSummary.map((d) => `  ${d}`),
  ].join("\n");
  return { ok: true, snapshot, summary };
}

/** Args stored on the ticket (approval.metadata.adminMutation). Server-built snapshot only. */
export function buildChannelScopeQueuedArgs(
  args: Record<string, unknown>,
  snapshot: ChannelScopeSnapshot
): Record<string, unknown> {
  return {
    employeeId: snapshot.employeeId,
    clearOverride: snapshot.after === null,
    ...(typeof args.jobId === "string" ? { jobId: args.jobId } : {}),
    [CHANNEL_SCOPE_SNAPSHOT_KEY]: snapshot,
  };
}

// ---------------------------------------------------------------------------
// Fulfill (after always_human approval)
// ---------------------------------------------------------------------------

export interface FulfillChannelScopeResult {
  ok: boolean;
  code?: string;
  message?: string;
}

function readSnapshot(args: Record<string, unknown>): ChannelScopeSnapshot | null {
  const raw = args[CHANNEL_SCOPE_SNAPSHOT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.layer !== "org" && s.layer !== "employee") return null;
  if (typeof s.beforeStateHash !== "string") return null;
  if (s.layer === "employee" && (typeof s.employeeId !== "string" || !EMPLOYEE_ID_RE.test(s.employeeId))) return null;
  if (s.layer === "org" && s.employeeId != null) return null;
  if (s.after === undefined) return null;
  if (s.after === null && s.layer !== "employee") return null;
  return s as unknown as ChannelScopeSnapshot;
}

export async function fulfillChannelScopePatch(
  approval: ApprovalRequest,
  args: Record<string, unknown>
): Promise<FulfillChannelScopeResult> {
  if (!isChannelScopeEnabled()) return { ok: false, code: "feature_disabled", message: FLAG_OFF_MESSAGE_JA };
  const snapshot = readSnapshot(args);
  if (!snapshot) return { ok: false, code: "missing_snapshot", message: "承認チケットに変更内容のスナップショットがありません" };
  const orgId = approval.orgId;
  const employeeId = snapshot.layer === "employee" ? snapshot.employeeId : null;
  if (employeeId && !(await assertEmployeeInOrg(orgId, employeeId))) {
    return { ok: false, code: "employee_not_found", message: "AI社員が見つかりません" };
  }

  const currentRaw = employeeId
    ? await getEmployeeChannelScopeOverrideRaw(orgId, employeeId)
    : await getOrgChannelScopePolicyRaw(orgId);
  const currentHash = channelScopeStateHash(snapshot.layer, employeeId, currentRaw);
  const auditBase = {
    approvalId: approval.id,
    layer: snapshot.layer,
    employeeId,
    filedBy: (approval.metadata?.adminRequester as { actorId?: string } | undefined)?.actorId ?? null,
    approvedBy: approval.resolvedBy ?? null,
    source: snapshot.source,
  };
  if (currentHash !== snapshot.beforeStateHash) {
    await appendAuditEvent({
      orgId,
      employeeId,
      credentialId: null,
      action: "channel_scope.patch_conflict",
      purpose: "admin.policy",
      summary: "チャンネル範囲設定の更新が競合しました（変更前の状態が一致しません）",
      metadata: { ...auditBase, expectedHash: snapshot.beforeStateHash, currentHash },
    });
    return { ok: false, code: "before_state_mismatch", message: "承認時点で設定が変更されていました。最新の状態で申請し直してください。" };
  }

  let toStore: ChannelScopePolicy | null = null;
  if (snapshot.after !== null) {
    const validation = validateChannelScopePolicy(snapshot.after);
    if (!validation.ok) return { ok: false, code: "validation_failed", message: "ポリシーの検証に失敗しました" };
    if (validation.policy.includeSlackConnect && !isChannelScopeConnectEnabled()) {
      return { ok: false, code: "connect_disabled", message: CONNECT_OFF_MESSAGE_JA };
    }
    toStore = { ...validation.policy, updatedAt: new Date().toISOString(), updatedBy: `approval:${approval.id}` };
  }

  const saved = employeeId
    ? await setEmployeeChannelScopeOverride(orgId, employeeId, toStore)
    : await setOrgChannelScopePolicy(orgId, toStore);
  if (!saved) return { ok: false, code: "save_failed", message: "設定の保存に失敗しました" };

  await appendAuditEvent({
    orgId,
    employeeId,
    credentialId: null,
    action: "channel_scope.patch",
    purpose: "admin.policy",
    summary:
      toStore === null
        ? "AI社員のチャンネル範囲の上書きを解除しました（人承認後）"
        : `チャンネル範囲設定を更新しました（${snapshot.layer === "org" ? "テナント既定" : "AI社員ごと"}・人承認後）`,
    metadata: {
      ...auditBase,
      widens: snapshot.widens,
      diff: snapshot.diffSummary,
      before: snapshot.before,
      after: toStore,
    },
  });
  return { ok: true, message: "チャンネル範囲設定を更新しました" };
}
