/**
 * Employee-badge list / ack / whoami counts for operator notices.
 * Org and employee come from the credential only. Fail-closed: a DB error
 * is retryable, never "there are no notices". Cross-org ids are not_found.
 */
import { getApprovalById } from "@/lib/data/approvals";
import { isOperatorNoticesEnabledForOrg } from "@/lib/feature-flags";
import {
  isConfigChangeApproval,
  parseConfigChangeApplied,
} from "@/lib/config-change-request/core";
import {
  auditSecretDetectionBlocked,
  auditSecretDetectionSuspected,
} from "@/lib/security/secret-detection-audit";
import {
  checkPayloadScanLimits,
  detectSecretInPayload,
} from "@/lib/security/secret-detector";
import {
  OPERATOR_NOTICES_CONTENT_TRUST,
  OPERATOR_NOTICES_GUARD_JA,
  OPERATOR_NOTICES_SOURCE,
  OPERATOR_NOTICES_WHOAMI_RULE_JA,
  nextStepJa,
} from "./copy";
import { isNoticeId } from "./ids";
import {
  countVisibleNoticeStats,
  ensureDeliveredReceipt,
  getReceipt,
  listVisibleNotices,
  updateReceipt,
} from "./store";
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_CHARS,
  LIST_MAX_LIMIT,
  RECEIPT_NOTE_MAX,
  audienceScopeToWire,
  isNoticeReceiptState,
  type NoticeReceiptState,
  type OperatorNotice,
  type OperatorNoticeReceipt,
  type OperatorNoticeVersion,
} from "./types";
import { canAdvanceReceiptState, isNoticeUnread } from "./visibility";

export const NOTICES_LIST_TOOL = "staffpass_notices_list";
export const NOTICES_ACK_TOOL = "staffpass_notices_ack";

export type NoticesWhoami =
  | {
      unread: number;
      urgentUnread: number;
      pendingApply: number;
      ruleJa: string;
    }
  | {
      unread: "unknown";
      urgentUnread: "unknown";
      pendingApply: "unknown";
      ruleJa: string;
    };

export async function operatorNoticesWhoamiBlock(
  orgId: string,
  employeeId: string
): Promise<NoticesWhoami | null> {
  if (!isOperatorNoticesEnabledForOrg(orgId)) return null;
  const stats = await countVisibleNoticeStats(orgId, employeeId);
  if (!stats.ok) {
    return {
      unread: "unknown",
      urgentUnread: "unknown",
      pendingApply: "unknown",
      ruleJa: OPERATOR_NOTICES_WHOAMI_RULE_JA,
    };
  }
  return {
    unread: stats.unread,
    urgentUnread: stats.urgentUnread,
    pendingApply: stats.pendingApply,
    ruleJa: OPERATOR_NOTICES_WHOAMI_RULE_JA,
  };
}

function retryable(message: string) {
  return {
    ok: false as const,
    code: "operator_notices_unavailable",
    retryable: true,
    message,
    guardJa: OPERATOR_NOTICES_GUARD_JA,
  };
}

export function wireNotice(
  notice: OperatorNotice,
  receipt: OperatorNoticeReceipt | undefined,
  latest: OperatorNoticeVersion | undefined
) {
  const isCorrection =
    Boolean(latest && latest.kind === "correction" && receipt?.ackedVersion != null && receipt.ackedVersion < notice.version);
  return {
    noticeId: notice.id,
    seq: notice.seq,
    version: notice.version,
    isCorrection,
    ...(isCorrection ? { correctionNoteJa: latest?.changeNote ?? "訂正版です。前の版との差を確かめてください。" } : {}),
    severity: notice.severity,
    title: notice.title,
    effectiveAt: notice.effectiveAt,
    audience: audienceScopeToWire(notice.audienceScope),
    relatedFlags: notice.relatedFlags,
    applyMode: notice.applyMode,
    content: { changeSummary: notice.changeSummary, aiUsageChange: notice.aiUsageChange },
    inReplyTo: notice.relatesToItemIds.map((itemId) => ({ itemId })),
    yourState: receipt
      ? { state: receipt.state, ackedVersion: receipt.ackedVersion }
      : { state: "delivered", ackedVersion: null },
    nextStepJa: nextStepJa(notice.applyMode, receipt?.state ?? "delivered"),
  };
}

export async function runNoticesList(
  orgId: string,
  employeeId: string,
  args: Record<string, unknown>,
  opts: { recordDelivery?: boolean } = {}
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  if (!isOperatorNoticesEnabledForOrg(orgId)) {
    return { data: { ok: false, code: "feature_disabled", message: "OPERATOR_NOTICES_ENABLED is OFF" }, isError: true };
  }
  const recordDelivery = opts.recordDelivery !== false;
  const unreadOnly = args.unreadOnly !== false;
  const noticeId = typeof args.noticeId === "string" ? args.noticeId.trim() : "";
  if (noticeId && !isNoticeId(noticeId)) {
    return { data: { ok: false, code: "not_found" }, isError: true };
  }
  let limit = LIST_DEFAULT_LIMIT;
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(args.limit)));
  }

  const listed = await listVisibleNotices(orgId, employeeId, noticeId ? { noticeId } : {});
  if (!listed.ok) {
    if (listed.code === "feature_disabled") {
      return { data: { ok: false, code: "feature_disabled", message: "OPERATOR_NOTICES_ENABLED is OFF" }, isError: true };
    }
    return { data: retryable("operator notices could not be read; retry later"), isError: true };
  }
  if (noticeId && listed.notices.length === 0) {
    return { data: { ok: false, code: "not_found" }, isError: true };
  }

  const receipts = new Map(listed.receipts);
  const out: ReturnType<typeof wireNotice>[] = [];
  let unreadCount = 0;
  let chars = 0;
  let hasMore = false;

  for (const notice of listed.notices) {
    const latest = listed.versions.get(notice.id);
    const unread = isNoticeUnread(notice, receipts.get(notice.id) ?? null, latest ?? null);
    if (unread) unreadCount += 1;
    if (!noticeId && unreadOnly && !unread) continue;
    if (out.length >= limit) {
      hasMore = true;
      continue;
    }
    let receipt = receipts.get(notice.id);
    if (recordDelivery) {
      const delivered = await ensureDeliveredReceipt(orgId, employeeId, notice.id);
      if (!delivered.ok) {
        if (delivered.code === "unavailable") {
          return { data: retryable("operator notices could not be recorded; retry later"), isError: true };
        }
        continue;
      }
      receipts.set(notice.id, delivered.receipt);
      receipt = delivered.receipt;
    }
    const wired = wireNotice(notice, receipt, latest);
    const piece = JSON.stringify(wired);
    if (out.length > 0 && chars + piece.length > LIST_MAX_CHARS) {
      hasMore = true;
      continue;
    }
    chars += piece.length;
    out.push(wired);
  }

  return {
    data: {
      ok: true,
      source: OPERATOR_NOTICES_SOURCE,
      contentTrust: OPERATOR_NOTICES_CONTENT_TRUST,
      guardJa: OPERATOR_NOTICES_GUARD_JA,
      unreadCount,
      hasMore,
      notices: out,
    },
    isError: false,
  };
}

async function verifyConfigChangeEvidence(
  orgId: string,
  employeeId: string,
  noticeId: string,
  approvalId: string
): Promise<boolean> {
  const approval = await getApprovalById(approvalId, orgId);
  if (!approval || approval.orgId !== orgId) return false;
  if (approval.employeeId !== employeeId) return false;
  if (!isConfigChangeApproval(approval)) return false;
  const applied = parseConfigChangeApplied(approval.metadata);
  if (!applied?.ok) return false;
  const ref = approval.metadata?.noticeRef;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
  const rec = ref as Record<string, unknown>;
  return rec.noticeId === noticeId;
}

export async function runNoticesAck(
  orgId: string,
  employeeId: string,
  args: Record<string, unknown>,
  credentialId: string | null
): Promise<{ data: Record<string, unknown>; isError: boolean }> {
  if (!isOperatorNoticesEnabledForOrg(orgId)) {
    return { data: { ok: false, code: "feature_disabled", message: "OPERATOR_NOTICES_ENABLED is OFF" }, isError: true };
  }
  const noticeId = typeof args.noticeId === "string" ? args.noticeId.trim() : "";
  const version = typeof args.version === "number" && Number.isInteger(args.version) ? args.version : NaN;
  const stateRaw = typeof args.state === "string" ? args.state.trim() : "";
  const note = typeof args.note === "string" ? args.note : undefined;
  const configChangeApprovalId =
    typeof args.configChangeApprovalId === "string" ? args.configChangeApprovalId.trim() : "";

  if (!isNoticeId(noticeId) || !Number.isInteger(version) || version < 1 || !isNoticeReceiptState(stateRaw)) {
    return { data: { ok: false, code: "invalid_args" }, isError: true };
  }
  const state = stateRaw as NoticeReceiptState;
  if (state === "delivered") {
    return { data: { ok: false, code: "invalid_args" }, isError: true };
  }
  if ((state === "declined" || state === "not_applicable") && !(note && note.trim())) {
    return { data: { ok: false, code: "note_required", messageJa: "declined / not_applicable には note（理由）が必要です" }, isError: true };
  }
  if (note && note.length > RECEIPT_NOTE_MAX) {
    return { data: { ok: false, code: "note_too_long", messageJa: `note は ${RECEIPT_NOTE_MAX} 文字以内です` }, isError: true };
  }

  if (note) {
    const oversized = checkPayloadScanLimits({ note }, { perString: true });
    const secret = oversized ?? detectSecretInPayload({ note });
    if (!secret.ok) {
      await auditSecretDetectionBlocked(
        {
          orgId,
          employeeId,
          credentialId,
          surface: "operator_notice_ack",
          tool: NOTICES_ACK_TOOL,
          jobId: noticeId,
        },
        secret
      );
      return {
        data: {
          ok: false,
          code: secret.code,
          pattern: secret.pattern,
          messageJa: secret.messageJa,
          nextStepJa: secret.nextStepJa,
        },
        isError: true,
      };
    }
    if (secret.suspected) {
      await auditSecretDetectionSuspected(
        { orgId, employeeId, credentialId, surface: "operator_notice_ack", tool: NOTICES_ACK_TOOL, jobId: noticeId },
        secret.suspected
      );
    }
  }

  const listed = await listVisibleNotices(orgId, employeeId, { noticeId });
  if (!listed.ok) {
    if (listed.code === "unavailable") return { data: retryable("operator notices could not be read; retry later"), isError: true };
    return { data: { ok: false, code: "feature_disabled", message: "OPERATOR_NOTICES_ENABLED is OFF" }, isError: true };
  }
  const notice = listed.notices[0];
  if (!notice) return { data: { ok: false, code: "not_found" }, isError: true };
  if (notice.version !== version) {
    return {
      data: {
        ok: false,
        code: "stale_version",
        currentVersion: notice.version,
        messageJa: "版が古いです。staffpass_notices_list で読み直してください。",
      },
      isError: true,
    };
  }

  const delivered = await ensureDeliveredReceipt(orgId, employeeId, noticeId);
  if (!delivered.ok) {
    if (delivered.code === "unavailable") return { data: retryable("operator notices could not be recorded; retry later"), isError: true };
    return { data: { ok: false, code: "not_found" }, isError: true };
  }
  const current = delivered.receipt;
  if (!canAdvanceReceiptState(current, state, notice.version)) {
    return {
      data: {
        ok: true,
        unchanged: true,
        yourState: { state: current.state, ackedVersion: current.ackedVersion },
        guardJa: OPERATOR_NOTICES_GUARD_JA,
      },
      isError: false,
    };
  }

  let nextState = state;
  let applyEvidence = current.applyEvidence;
  let configId = current.configChangeApprovalId;
  if (state === "applied") {
    if (notice.applyMode === "instructions_via_approval") {
      if (!configChangeApprovalId || !(await verifyConfigChangeEvidence(orgId, employeeId, noticeId, configChangeApprovalId))) {
        nextState = "needs_tenant_approval";
        applyEvidence = current.applyEvidence;
      } else {
        applyEvidence = "config_change_applied";
        configId = configChangeApprovalId;
      }
    } else if (notice.applyMode === "self_rules") {
      applyEvidence = "self_reported";
    }
  }

  const at = new Date().toISOString();
  const updated = await updateReceipt(orgId, employeeId, noticeId, {
    state: nextState,
    ackedVersion: notice.version,
    ackedAt: at,
    readAt: nextState === "read" || current.readAt ? current.readAt ?? at : current.readAt,
    readVersion: nextState === "read" || current.readVersion ? current.readVersion ?? notice.version : current.readVersion,
    applyEvidence,
    configChangeApprovalId: configId,
    note: note?.trim() ?? current.note,
  });
  if (!updated.ok) {
    if (updated.code === "unavailable") return { data: retryable("operator notices could not be recorded; retry later"), isError: true };
    return { data: { ok: false, code: "not_found" }, isError: true };
  }

  return {
    data: {
      ok: true,
      source: OPERATOR_NOTICES_SOURCE,
      contentTrust: OPERATOR_NOTICES_CONTENT_TRUST,
      guardJa: OPERATOR_NOTICES_GUARD_JA,
      noticeId,
      version: notice.version,
      yourState: { state: updated.receipt.state, ackedVersion: updated.receipt.ackedVersion },
      applyEvidence: updated.receipt.applyEvidence,
    },
    isError: false,
  };
}

/** Test helper: current receipt after ack. */
export async function __getAckedReceipt(orgId: string, employeeId: string, noticeId: string) {
  return getReceipt(orgId, employeeId, noticeId);
}
