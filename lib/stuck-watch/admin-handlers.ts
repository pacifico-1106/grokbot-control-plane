/**
 * F7 Admin MCP handlers: stuckWatch.list | inspect | retry | resolve | classify
 */
import {
  appendAuditEvent,
  getApprovalById,
  getEmployee,
  listApprovals,
} from "@/lib/data";
import { listAuditEventsForStuckWatch } from "@/lib/data/audit";
import { getOrgStuckWatchPolicy } from "@/lib/data/stuck-watch-policy";
import { classifyInvokeFailure } from "@/lib/stuck-watch/classify";
import {
  getStuckWatchItem,
  listStuckWatchItems,
  stuckWatchKindFromItemId,
} from "@/lib/stuck-watch/items";
import {
  attemptAudienceLedgerRetry,
  finalizeAudienceLedgerFailure,
} from "@/lib/stuck-watch/audience-ledger";
import {
  canAutoRetryOpsFault,
  prepareOpsFaultRetryInvokeBody,
} from "@/lib/stuck-watch/retry-eligibility";
import { runW2FulfillRetry } from "@/lib/stuck-watch/w2-unfulfilled";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { parseInvokeSnapshot } from "@/lib/approvals/fulfill";
import type { FaultClass, StuckWatchItem } from "@/lib/types";

export type StuckWatchAdminResult = {
  ok: boolean;
  code?: string;
  message?: string;
  summaryJa?: string;
  nextStepJa?: string;
  item?: StuckWatchItem;
  items?: StuckWatchItem[];
  faultClass?: FaultClass;
  classified?: {
    faultClass: FaultClass;
    stuckHint: string;
    code: string;
  };
  retry?: Record<string, unknown>;
};

function denyExpectedGate(item: StuckWatchItem): StuckWatchAdminResult {
  return {
    ok: false,
    code: "expected_gate_no_retry",
    message: "正当ゲート（expected_gate）は自動再発火しません",
    summaryJa: item.summaryJa,
    nextStepJa:
      "承認待ち・権限外・ポリシー拒否は再試行できません。承認を進めるか stuckWatch.resolve で解決済みにしてください。",
    item,
    faultClass: "expected_gate",
  };
}

function denyConfigDrift(item: StuckWatchItem): StuckWatchAdminResult {
  return {
    ok: false,
    code: "config_drift_notify_fix",
    message: "config_drift は通知・修正のみ（自動リトライ不可）",
    summaryJa: item.summaryJa,
    nextStepJa:
      "設定不足です。parties.upsert / internalAudienceRule.patch / scopes 設定を修正してください。修正後に手動で再試行できます。",
    item,
    faultClass: "config_drift",
  };
}

export async function runStuckWatchList(
  orgId: string,
  args: Record<string, unknown>
): Promise<StuckWatchAdminResult> {
  const includeResolved = args.includeResolved === true;
  const kind =
    typeof args.kind === "string" && args.kind.trim()
      ? args.kind.trim()
      : null;
  let items = await listStuckWatchItems(orgId, { includeResolved });
  if (kind === "w1" || kind === "w1_mention_unanswered") {
    items = items.filter((item) => item.kind === "w1_mention_unanswered");
  } else if (kind === "w2" || kind === "w2_approved_unfulfilled") {
    items = items.filter((item) => item.kind === "w2_approved_unfulfilled");
  }
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(Math.max(1, Math.floor(args.limit)), 100)
      : 50;
  items = items.slice(0, limit);
  return {
    ok: true,
    items,
    summaryJa: `F7 Stuck Watch: ${items.length}件（open/notified/resolved 含む=${includeResolved})`,
    nextStepJa:
      items.length > 0
        ? "stuckWatch.inspect で詳細確認、ops_fault は stuckWatch.retry、正当ゲートは resolve のみ。"
        : "不当停止は見つかりませんでした。W1/W2 閾値は stuckWatch.get で確認できます。",
  };
}

export async function runStuckWatchInspect(
  orgId: string,
  args: Record<string, unknown>
): Promise<StuckWatchAdminResult> {
  const itemId = String(args.itemId || "").trim();
  if (!itemId) {
    return {
      ok: false,
      code: "item_id_required",
      message: "itemId が必要です",
      nextStepJa: "stuckWatch.list で itemId を取得してください。",
    };
  }
  const item = await getStuckWatchItem(orgId, itemId);
  if (!item) {
    return {
      ok: false,
      code: "item_not_found",
      message: "Stuck Watch 項目が見つかりません",
      nextStepJa: "stuckWatch.list で最新の open 項目を確認してください。",
    };
  }
  const policy = await getOrgStuckWatchPolicy(orgId);
  return {
    ok: true,
    item,
    faultClass: item.faultClass,
    summaryJa: item.summaryJa,
    nextStepJa: item.nextStepJa,
    classified: {
      faultClass: item.faultClass,
      stuckHint: item.stuckHint,
      code: item.code || "unknown",
    },
    retry: {
      autoRetryAllowed:
        item.faultClass === "ops_fault" &&
        canAutoRetryOpsFault({
          faultClass: item.faultClass,
          policy,
          retryCount: Number(item.metadata.retryCount || 0),
        }),
      policyEnabled: policy.enabled,
      maxAutoRetries: policy.maxAutoRetries,
    },
  };
}

export async function runStuckWatchClassify(
  orgId: string,
  args: Record<string, unknown>
): Promise<StuckWatchAdminResult> {
  const itemId = String(args.itemId || "").trim();
  const code = String(args.code || "").trim();
  if (itemId) {
    const item = await getStuckWatchItem(orgId, itemId);
    if (!item) {
      return {
        ok: false,
        code: "item_not_found",
        message: "Stuck Watch 項目が見つかりません",
      };
    }
    return {
      ok: true,
      item,
      faultClass: item.faultClass,
      summaryJa: item.summaryJa,
      nextStepJa: item.nextStepJa,
      classified: {
        faultClass: item.faultClass,
        stuckHint: item.stuckHint,
        code: item.code || "unknown",
      },
    };
  }
  if (!code) {
    return {
      ok: false,
      code: "code_or_item_required",
      message: "itemId または code が必要です",
      nextStepJa: "stuckWatch.classify に itemId または invoke 失敗 code を渡してください。",
    };
  }
  const classified = classifyInvokeFailure({
    code,
    needs_approval: code === "needs_approval",
    approvedUnfulfilled: code === "approved_unfulfilled",
  });
  const summaryJa = `faultClass=${classified.faultClass} / stuckHint=${classified.stuckHint} / code=${code}`;
  const nextStepJa =
    classified.faultClass === "expected_gate"
      ? "正当ゲート — 自動再発火しません。承認または設定見直しが必要です。"
      : classified.faultClass === "config_drift"
        ? "設定不足 — 台帳・スコープ・紐づけを修正してください。"
        : "ops_fault — stuckWatch.retry で再試行可能（上限あり）。";
  return {
    ok: true,
    faultClass: classified.faultClass,
    summaryJa,
    nextStepJa,
    classified: { ...classified, code },
  };
}

export async function runStuckWatchResolve(
  orgId: string,
  args: Record<string, unknown>,
  actorId: string
): Promise<StuckWatchAdminResult> {
  const itemId = String(args.itemId || "").trim();
  if (!itemId) {
    return {
      ok: false,
      code: "item_id_required",
      message: "itemId が必要です",
    };
  }
  const item = await getStuckWatchItem(orgId, itemId);
  if (!item) {
    return {
      ok: false,
      code: "item_not_found",
      message: "Stuck Watch 項目が見つかりません",
    };
  }
  const note =
    typeof args.note === "string" && args.note.trim() ? args.note.trim() : null;
  const now = new Date().toISOString();
  await appendAuditEvent({
    orgId,
    employeeId: item.employeeId,
    credentialId: null,
    action: "stuck_watch.resolve",
    purpose: "stuck_watch",
    summary: `Stuck Watch 解決済み: ${item.id}`,
    metadata: {
      itemId: item.id,
      kind: item.kind,
      faultClass: item.faultClass,
      resolvedBy: actorId,
      note,
      resolvedAt: now,
    },
  });
  const resolved = { ...item, status: "resolved" as const, resolvedAt: now };
  return {
    ok: true,
    item: resolved,
    summaryJa: `解決済みにしました: ${item.summaryJa}`,
    nextStepJa: "同一 itemId は W1/W2 ウォッチから除外されます。再発生時は新しい検知になります。",
  };
}

export async function runStuckWatchRetry(
  orgId: string,
  args: Record<string, unknown>,
  actorId: string
): Promise<StuckWatchAdminResult> {
  const itemId = String(args.itemId || "").trim();
  if (!itemId) {
    return {
      ok: false,
      code: "item_id_required",
      message: "itemId が必要です",
    };
  }
  const item = await getStuckWatchItem(orgId, itemId);
  if (!item) {
    return {
      ok: false,
      code: "item_not_found",
      message: "Stuck Watch 項目が見つかりません",
    };
  }
  if (item.status === "resolved") {
    return {
      ok: false,
      code: "already_resolved",
      message: "既に解決済みです",
      item,
      nextStepJa: "stuckWatch.list で open 項目を確認してください。",
    };
  }
  if (item.faultClass === "expected_gate") {
    return denyExpectedGate(item);
  }
  if (item.faultClass === "config_drift") {
    return denyConfigDrift(item);
  }

  const policy = await getOrgStuckWatchPolicy(orgId);
  const retryCount = Number(item.metadata.retryCount || 0);
  if (
    !canAutoRetryOpsFault({
      faultClass: item.faultClass,
      policy,
      retryCount,
    })
  ) {
    return {
      ok: false,
      code: "max_retries_or_disabled",
      message: "ポリシー上限または無効のため再試行できません",
      item,
      summaryJa: item.summaryJa,
      nextStepJa: "stuckWatch.patch で maxAutoRetries を確認するか、手動で対応してください。",
    };
  }

  const kind = stuckWatchKindFromItemId(itemId);

  if (kind === "w2_approved_unfulfilled" && item.approvalId) {
    const approval = await getApprovalById(item.approvalId, orgId);
    if (!approval) {
      return {
        ok: false,
        code: "approval_not_found",
        message: "承認チケットが見つかりません",
        item,
      };
    }
    const result = await runW2FulfillRetry(approval, policy);
    await appendAuditEvent({
      orgId,
      employeeId: item.employeeId,
      credentialId: null,
      action: "stuck_watch.retry",
      purpose: "stuck_watch",
      summary: `Admin MCP W2 retry: ${item.id}`,
      metadata: {
        itemId: item.id,
        kind: item.kind,
        faultClass: item.faultClass,
        actorId,
        retryCount: result.retryCount,
        fulfillmentOk: result.fulfillmentOk,
        manual: true,
      },
    }).catch(() => undefined);
    return {
      ok: result.ok,
      item,
      faultClass: item.faultClass,
      summaryJa: result.ok
        ? `W2 fulfill 再実行成功（retry ${result.retryCount}）`
        : `W2 fulfill 再実行未完了（retry ${result.retryCount}）`,
      nextStepJa: result.ok
        ? "stuckWatch.resolve で解決済みにできます。"
        : "再度 stuckWatch.inspect で状態を確認してください。",
      retry: result as unknown as Record<string, unknown>,
    };
  }

  if (kind === "w1_mention_unanswered") {
    const approvalId = item.approvalId;
    if (approvalId) {
      const approval = await getApprovalById(approvalId, orgId);
      if (approval && approval.status === "approved") {
        const w2 = await runW2FulfillRetry(approval, policy);
        await appendAuditEvent({
          orgId,
          employeeId: item.employeeId,
          credentialId: null,
          action: "stuck_watch.retry",
          purpose: "stuck_watch",
          summary: `Admin MCP W1→W2 retry: ${item.id}`,
          metadata: {
            itemId: item.id,
            approvalId,
            actorId,
            fulfillmentOk: w2.fulfillmentOk,
            manual: true,
          },
        }).catch(() => undefined);
        return {
          ok: w2.ok,
          item,
          summaryJa: w2.ok
            ? "関連承認の fulfill 再実行に成功しました"
            : "関連承認の fulfill 再実行は未完了です",
          nextStepJa: w2.ok
            ? "stuckWatch.resolve で解決済みにできます。"
            : "stuckWatch.inspect で継続確認してください。",
          retry: w2 as unknown as Record<string, unknown>,
        };
      }
    }

    const approvals = await listApprovals(orgId);
    const related = approvals.find(
      (row) =>
        row.jobId &&
        item.jobId &&
        row.jobId === item.jobId &&
        row.status === "approved"
    );
    if (related) {
      const w2 = await runW2FulfillRetry(related, policy);
      return {
        ok: w2.ok,
        item,
        summaryJa: w2.ok ? "jobId 一致の fulfill 再実行成功" : "fulfill 再実行未完了",
        nextStepJa: "stuckWatch.inspect で返信状態を確認してください。",
        retry: w2 as unknown as Record<string, unknown>,
      };
    }

    if (item.employeeId && item.jobId) {
      const employee = await getEmployee(item.employeeId, orgId);
      if (employee) {
        const approvalsAll = await listApprovals(orgId);
        const withSnapshot = approvalsAll.find(
          (row) =>
            row.jobId === item.jobId &&
            parseInvokeSnapshot(row.metadata)
        );
        const snapshot = withSnapshot
          ? parseInvokeSnapshot(withSnapshot.metadata)
          : null;
        if (snapshot) {
          const baseBody = prepareOpsFaultRetryInvokeBody({
            tool: snapshot.tool,
            purpose: snapshot.purpose,
            jobId: snapshot.jobId,
            employeeId: snapshot.employeeId,
            conversation: snapshot.conversation ?? undefined,
            args: snapshot.args,
          });

          let invoked: Awaited<ReturnType<typeof runGatewayInvoke>>;
          if (item.code === "egress_denied") {
            const ledger = await attemptAudienceLedgerRetry(
              {
                orgId,
                employeeId: item.employeeId,
                credentialId: employee.credentialId,
                body: baseBody,
                egress: (item.metadata.egress as
                  | { audience?: string; effectiveAudience?: string }
                  | undefined) ?? { audience: "unknown" },
                tool: snapshot.tool,
                purpose: snapshot.purpose,
                jobId: snapshot.jobId,
                force: true,
              },
              runGatewayInvoke
            );
            if (ledger.attempted && ledger.invokeResult) {
              if (
                !ledger.invokeResult.body.ok &&
                String(ledger.invokeResult.body.code) === "egress_denied"
              ) {
                const failed = await finalizeAudienceLedgerFailure(
                  {
                    orgId,
                    employeeId: item.employeeId,
                    tool: snapshot.tool,
                    jobId: snapshot.jobId,
                    purpose: snapshot.purpose,
                    code: "egress_denied",
                    itemId: item.id,
                    egress: ledger.invokeResult.body.egress as
                      | { audience?: string; effectiveAudience?: string }
                      | undefined,
                  },
                  ledger.invokeResult.body,
                  ledger.invokeResult.httpStatus
                );
                invoked = failed;
              } else {
                invoked = ledger.invokeResult;
              }
            } else {
              invoked = await runGatewayInvoke({
                employeeId: item.employeeId,
                credentialId: employee.credentialId,
                body: baseBody,
              });
            }
          } else {
            invoked = await runGatewayInvoke({
              employeeId: item.employeeId,
              credentialId: employee.credentialId,
              body: baseBody,
            });
          }
          await appendAuditEvent({
            orgId,
            employeeId: item.employeeId,
            credentialId: employee.credentialId,
            action: "stuck_watch.retry",
            purpose: "stuck_watch",
            summary: `Admin MCP W1 invoke retry: ${item.id}`,
            metadata: {
              itemId: item.id,
              jobId: item.jobId,
              actorId,
              httpStatus: invoked.httpStatus,
              ok: invoked.body.ok,
              manual: true,
            },
          }).catch(() => undefined);
          return {
            ok: invoked.body.ok === true,
            item,
            summaryJa: invoked.body.ok
              ? "ops_fault invoke 再試行が受理されました"
              : "invoke 再試行は拒否または要承認です",
            nextStepJa: invoked.body.needs_approval
              ? "要承認になりました。承認後に返信を確認してください。"
              : "stuckWatch.inspect で返信状態を確認してください。",
            retry: invoked.body,
          };
        }
      }
    }

    return {
      ok: false,
      code: "w1_no_retry_path",
      message: "W1 は notify 主体です。再試行可能な invoke/fulfill スナップショットがありません",
      item,
      summaryJa: item.summaryJa,
      nextStepJa:
        "Bot 側で comm.reply を再実行するか、関連承認を fulfill してください。expected_gate の場合は承認待ちです。",
    };
  }

  return {
    ok: false,
    code: "unsupported_kind",
    message: "未対応の stuck watch 種別です",
    item,
  };
}
