/**
 * F7 Employee MCP handlers: staffpass_stuck_list | staffpass_stuck_retry
 * Thin wrappers over admin stuck-watch listing / retry, scoped to calling employee badge.
 */
import { getStuckWatchItem } from "@/lib/stuck-watch/items";
import {
  runStuckWatchList,
  runStuckWatchRetry,
  type StuckWatchAdminResult,
} from "@/lib/stuck-watch/admin-handlers";
import type { StuckWatchItem } from "@/lib/types";

export type StuckWatchEmployeeResult = StuckWatchAdminResult;

function employeeNextStepJa(item: StuckWatchItem): string {
  if (item.faultClass === "expected_gate") {
    return "正当ゲート（承認待ち等）のため自動再発火しません。承認を進めるか管理者へ連絡してください。";
  }
  if (item.faultClass === "config_drift") {
    return "設定不足です。管理者に parties.upsert / internalAudienceRule.patch / scopes 設定の修正を依頼してください。";
  }
  return "ops_fault です。staffpass_stuck_retry で再試行できます（ゲートは再評価されます）。";
}

function mapItemForEmployee(item: StuckWatchItem): StuckWatchItem {
  return {
    ...item,
    nextStepJa: employeeNextStepJa(item),
  };
}

function denyCrossEmployee(itemId: string): StuckWatchEmployeeResult {
  return {
    ok: false,
    code: "item_not_owned",
    message: "この stuck 項目は呼び出し中の社員バッジに属していません",
    nextStepJa:
      "staffpass_stuck_list で自分の open 項目のみ確認できます。他社員の項目は管理者 MCP を利用してください。",
  };
}

export async function runEmployeeStuckList(
  orgId: string,
  employeeId: string,
  args: Record<string, unknown>
): Promise<StuckWatchEmployeeResult> {
  const result = await runStuckWatchList(orgId, args);
  if (!result.ok || !result.items) {
    return result;
  }
  const items = result.items
    .filter((item) => item.employeeId === employeeId)
    .map(mapItemForEmployee);
  return {
    ok: true,
    items,
    summaryJa: `F7 Stuck Watch（社員バッジ ${employeeId}）: ${items.length}件`,
    nextStepJa:
      items.length > 0
        ? "staffpass_stuck_retry で ops_fault の再試行。expected_gate は承認待ち、config_drift は管理者修正が必要です。"
        : "このバッジの不当停止は見つかりませんでした。",
  };
}

export async function runEmployeeStuckRetry(
  orgId: string,
  employeeId: string,
  args: Record<string, unknown>
): Promise<StuckWatchEmployeeResult> {
  const itemId = String(args.itemId || "").trim();
  if (!itemId) {
    return {
      ok: false,
      code: "item_id_required",
      message: "itemId が必要です",
      nextStepJa: "staffpass_stuck_list で itemId を取得してください。",
    };
  }

  const item = await getStuckWatchItem(orgId, itemId);
  if (!item) {
    return {
      ok: false,
      code: "item_not_found",
      message: "Stuck Watch 項目が見つかりません",
      nextStepJa: "staffpass_stuck_list で最新の open 項目を確認してください。",
    };
  }
  if (item.employeeId !== employeeId) {
    return denyCrossEmployee(itemId);
  }

  const result = await runStuckWatchRetry(orgId, args, employeeId);
  if (result.item) {
    const mapped = mapItemForEmployee(result.item);
    return {
      ...result,
      item: mapped,
      nextStepJa: mapped.nextStepJa,
    };
  }
  return result;
}
