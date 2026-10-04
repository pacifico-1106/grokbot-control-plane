/**
 * comm.delete core: shared by the gateway (auto) and approval fulfill.
 *
 * Order (fail closed at each step, provider called last):
 *   1. surface support (LINE / Telegram → not_supported with the reason)
 *   2. ownership: the employee's OWN post record for exactly this target,
 *      same org (looked up within COMM_DELETE_RECORD_LOOKBACK_HOURS). Else
 *      post_not_found_or_not_owned — the same answer for "someone else's",
 *      "other org", "unknown" and "older than the lookback". Age is NOT
 *      checked before this point, so too_old cannot be used to probe
 *      whether someone else's post exists.
 *   3. already deleted by this employee → already_deleted (no provider call)
 *   4. own record older than COMM_DELETE_MAX_AGE_HOURS → too_old
 *   5. provider delete with the token that made the post
 *
 * Every attempt is audited (comm.delete.*) with ids and a target hash only.
 */
import { createHash } from "node:crypto";
import { appendAuditEvent } from "@/lib/data/audit";
import type { AuditAction } from "@/lib/types";
import { commDeleteMaxAgeHours, COMM_DELETE_RECORD_LOOKBACK_HOURS, COMM_DELETE_TOOL_ID } from "./config";
import { buildDeleteRecord, findOwnDeleteDone, findOwnPostRecord, type FoundPostRecord } from "./post-record";
import { deleteSlackPost } from "./slack";
import { commDeleteSurfaceSupport } from "./surfaces";
import type { CommDeleteTarget } from "./target";

export type CommDeleteStatus = "deleted" | "already_deleted" | "refused" | "failed" | "not_supported";

export type CommDeleteOutcome = {
  ok: boolean;
  status: CommDeleteStatus;
  code: string;
  httpStatus: number;
  messageJa: string;
  target: CommDeleteTarget;
  deletedVia?: "user" | "bot";
  delivery?: "slack" | "stub";
  reason?: string;
  source?: string;
  needed?: string;
  /** Only on too_old (the caller's own post). */
  maxAgeHours?: number;
};

export type CommDeleteContext = {
  orgId: string;
  employeeId: string;
  credentialId: string | null;
  purpose: string;
  jobId: string;
  approvalId?: string | null;
  phase: "invoke" | "approval.fulfill";
};

export const NOT_OWNED_MESSAGE_JA =
  "削除できる投稿が見つかりません。削除できるのは、この社員が Staffpass 経由で投稿し記録された自分の投稿だけです（他の人・他の社員・別の組織の投稿、記録のない投稿、期限を過ぎた投稿は削除できません）。";

export function commDeleteTargetHash(orgId: string, target: CommDeleteTarget): string {
  return createHash("sha256")
    .update(`${orgId}\n${target.surface}\n${target.channel}\n${target.messageId}`)
    .digest("hex");
}

export async function auditCommDelete(
  ctx: CommDeleteContext,
  action: Extract<AuditAction, `comm.delete.${string}`>,
  target: CommDeleteTarget | null,
  detail: Record<string, unknown>,
  summary: string
): Promise<void> {
  await appendAuditEvent({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    credentialId: ctx.credentialId,
    action,
    purpose: ctx.purpose,
    summary,
    metadata: {
      tool: COMM_DELETE_TOOL_ID,
      jobId: ctx.jobId,
      phase: ctx.phase,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
      ...(target
        ? {
            surface: target.surface,
            channel: target.channel,
            messageId: target.messageId,
            targetHash: commDeleteTargetHash(ctx.orgId, target),
          }
        : {}),
      ...detail,
    },
  }).catch(() => undefined);
}

function outcome(target: CommDeleteTarget, o: Omit<CommDeleteOutcome, "target">): CommDeleteOutcome {
  return { ...o, target };
}

function failureHttp(code: string): number {
  if (code === "slack_identity_unbound") return 409;
  if (code === "slack_token_missing" || code === "slack_conversation_bot_token_missing") return 503;
  return 502;
}

function failureMessage(code: string, needed?: string): string {
  switch (code) {
    case "slack_identity_unbound":
      return "この投稿は社員本人の Slack 名義で投稿されましたが、本人の Slack 連携がないため削除できません（Bot では代わりに削除しません）。";
    case "slack_token_missing":
    case "slack_conversation_bot_token_missing":
      return "組織の会話用 Slack Bot トークンがないため削除できません。";
    case "cant_delete_message":
      return "Slack がこの投稿の削除を許可しませんでした（投稿したトークンと別のトークン、またはワークスペースの設定による制限）。";
    case "missing_scope":
      return `Slack のスコープが不足しています${needed ? `（必要: ${needed}）` : ""}。`;
    default:
      return "Slack での削除に失敗しました。";
  }
}

function lookupScope(ctx: CommDeleteContext, target: CommDeleteTarget) {
  return {
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    target,
    sinceIso: new Date(Date.now() - COMM_DELETE_RECORD_LOOKBACK_HOURS * 3600_000).toISOString(),
  };
}

function withinWindow(postedAt: string, maxAgeHours: number): boolean {
  const t = new Date(postedAt).getTime();
  return Number.isFinite(t) && t >= Date.now() - maxAgeHours * 3600_000;
}

export async function executeCommDelete(ctx: CommDeleteContext, target: CommDeleteTarget): Promise<CommDeleteOutcome> {
  const support = commDeleteSurfaceSupport(target.surface);
  if (!support.supported) {
    await auditCommDelete(ctx, "comm.delete.refused", target, { code: "not_supported", reason: support.reason },
      `${target.surface} の投稿削除は未対応のため拒否`);
    return outcome(target, {
      ok: false, status: "not_supported", code: "not_supported", httpStatus: 422,
      messageJa: support.messageJa, reason: support.reason, source: support.source,
    });
  }

  const maxAgeHours = commDeleteMaxAgeHours();
  const scope = lookupScope(ctx, target);

  const record = await findOwnPostRecord(scope);
  if (!record.ok) {
    await auditCommDelete(ctx, "comm.delete.refused", target, { code: record.code }, "投稿記録を確認できないため削除を停止（fail-closed）");
    return outcome(target, {
      ok: false, status: "refused", code: record.code, httpStatus: 503,
      messageJa: "投稿の記録を確認できないため削除していません（fail-closed）。時間をおいて再実行してください。",
    });
  }
  if (!record.found) {
    await auditCommDelete(ctx, "comm.delete.refused", target, { code: "post_not_found_or_not_owned", lookbackHours: COMM_DELETE_RECORD_LOOKBACK_HOURS },
      "自分の記録済み投稿ではないため削除を拒否");
    return outcome(target, {
      ok: false, status: "refused", code: "post_not_found_or_not_owned", httpStatus: 404, messageJa: NOT_OWNED_MESSAGE_JA,
    });
  }
  const found: FoundPostRecord = record.found;
  const recordDetail = {
    postedVia: found.postedVia,
    recordSource: found.source,
    recordAuditId: found.auditId,
    ...(found.approvalId ? { postApprovalId: found.approvalId } : {}),
  };

  const done = await findOwnDeleteDone(scope);
  if (!done.ok) {
    await auditCommDelete(ctx, "comm.delete.refused", target, { code: done.code, ...recordDetail }, "削除履歴を確認できないため停止（fail-closed）");
    return outcome(target, {
      ok: false, status: "refused", code: done.code, httpStatus: 503,
      messageJa: "削除の履歴を確認できないため削除していません（fail-closed）。時間をおいて再実行してください。",
    });
  }
  if (done.found) {
    await auditCommDelete(ctx, "comm.delete.already_deleted", target,
      { code: "already_deleted", ...recordDetail, priorDeleteAuditId: done.found.auditId, deleteRecord: buildDeleteRecord(target) },
      "削除済みの投稿（再実行・何もしない）");
    return outcome(target, {
      ok: true, status: "already_deleted", code: "already_deleted", httpStatus: 200,
      messageJa: "この投稿はすでに削除されています。", deletedVia: found.postedVia,
    });
  }

  // Ownership is confirmed above; only now may the age be revealed.
  if (!withinWindow(found.postedAt, maxAgeHours)) {
    await auditCommDelete(ctx, "comm.delete.refused", target, { code: "too_old", maxAgeHours, ...recordDetail },
      `自分の投稿だが ${maxAgeHours} 時間を過ぎているため削除を拒否`);
    return outcome(target, {
      ok: false, status: "refused", code: "too_old", httpStatus: 403, maxAgeHours,
      messageJa: `この投稿は投稿から ${maxAgeHours} 時間を過ぎているため削除できません（削除できるのは ${maxAgeHours} 時間以内の自分の投稿です）。`,
    });
  }

  const deleted = await deleteSlackPost({
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    postedVia: found.postedVia,
    channel: target.channel,
    messageId: target.messageId,
  });
  if (deleted.ok) {
    await auditCommDelete(ctx, "comm.delete.succeeded", target,
      { code: "deleted", ...recordDetail, deletedVia: deleted.deletedVia, delivery: deleted.delivery, deleteRecord: buildDeleteRecord(target) },
      "自分の投稿を削除");
    return outcome(target, {
      ok: true, status: "deleted", code: "deleted", httpStatus: 200,
      messageJa: "投稿を削除しました。", deletedVia: deleted.deletedVia, delivery: deleted.delivery,
    });
  }
  if (deleted.gone) {
    await auditCommDelete(ctx, "comm.delete.already_deleted", target,
      { code: "already_deleted", providerError: deleted.error, ...recordDetail, deletedVia: deleted.deletedVia, deleteRecord: buildDeleteRecord(target) },
      "投稿はすでに存在しない（削除済み扱い）");
    return outcome(target, {
      ok: true, status: "already_deleted", code: "already_deleted", httpStatus: 200,
      messageJa: "この投稿はすでに削除されています（Slack 上に見つかりません）。", deletedVia: deleted.deletedVia,
    });
  }
  await auditCommDelete(ctx, "comm.delete.failed", target,
    { code: deleted.error, ...recordDetail, deletedVia: deleted.deletedVia, ...(deleted.needed ? { needed: deleted.needed } : {}) },
    "投稿の削除に失敗");
  return outcome(target, {
    ok: false, status: "failed", code: deleted.error, httpStatus: failureHttp(deleted.error),
    messageJa: failureMessage(deleted.error, deleted.needed), deletedVia: deleted.deletedVia,
    ...(deleted.needed ? { needed: deleted.needed } : {}),
  });
}

/**
 * Before an approval card is created: refuse unsupported surfaces and targets
 * that are not this employee's own recorded post, so a card is never shown
 * for someone else's post. Audits the refusal. Returns null when the
 * request may go to approval.
 */
export async function precheckCommDelete(ctx: CommDeleteContext, target: CommDeleteTarget): Promise<CommDeleteOutcome | null> {
  const support = commDeleteSurfaceSupport(target.surface);
  if (!support.supported) return executeCommDelete(ctx, target);
  const record = await findOwnPostRecord(lookupScope(ctx, target));
  if (record.ok && record.found && withinWindow(record.found.postedAt, commDeleteMaxAgeHours())) return null;
  // Same refusal / too_old / already_deleted (and audit) as the direct path.
  return executeCommDelete(ctx, target);
}
