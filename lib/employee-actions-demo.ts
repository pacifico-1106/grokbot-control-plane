/** Deterministic per-employee action log for demo / Staffpass UI. */

import type { BindingStatus, Employee, EmployeeBinding } from "./types";

export type EmployeeActionType =
  | "tool.invoke"
  | "approval"
  | "deny"
  | "health";

export type ActionLogFilter = "all" | "success" | "fail" | "approval";

export interface EmployeeActionEvent {
  id: string;
  employeeId: string;
  /** ISO timestamp (deterministic from seed). */
  timestamp: string;
  actionType: EmployeeActionType;
  purpose: string | null;
  summary: string;
  success: boolean;
  /** Optional tip tying action to cost / units (demo). */
  costTip?: string;
}

/** Fixed demo epoch so SSR/client and rebuilds stay stable. */
const ANCHOR_MS = Date.UTC(2026, 7, 22, 3, 0, 0); // 2026-08-22 12:00 JST

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function unit(seed: string, i: number): number {
  const x = Math.sin(hashSeed(`${seed}:${i}`) * 0.0001 + i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function tsAt(hoursAgo: number, minuteJitter: number): string {
  const ms = ANCHOR_MS - hoursAgo * 3600000 - minuteJitter * 60000;
  return new Date(ms).toISOString();
}

type Template = {
  actionType: EmployeeActionType;
  purpose: string | null;
  summary: string;
  success: boolean;
  costTip?: string;
  /** Hours before ANCHOR. */
  hoursAgo: number;
};

const SALES_TEMPLATES: Template[] = [
  {
    actionType: "tool.invoke",
    purpose: "commerce.quote",
    summary: "顧客A向け見積ドラフトを生成しました",
    success: true,
    costTip: "≈ 12 units",
    hoursAgo: 1.2,
  },
  {
    actionType: "approval",
    purpose: "commerce.quote",
    summary: "外部送信が承認待ちになりました",
    success: true,
    hoursAgo: 1.5,
  },
  {
    actionType: "tool.invoke",
    purpose: "sales.outreach",
    summary: "フォローメール下書きを作成しました",
    success: true,
    costTip: "≈ 8 units",
    hoursAgo: 3,
  },
  {
    actionType: "health",
    purpose: null,
    summary: "Grok Bot ヘルスチェック成功",
    success: true,
    hoursAgo: 4,
  },
  {
    actionType: "deny",
    purpose: "commerce.order",
    summary: "発注実行をポリシーにより拒否（要承認）",
    success: false,
    hoursAgo: 6,
  },
  {
    actionType: "tool.invoke",
    purpose: "tools.read",
    summary: "CRM 顧客リストを読み取りました",
    success: true,
    costTip: "≈ 3 units",
    hoursAgo: 8,
  },
  {
    actionType: "approval",
    purpose: "sales.outreach",
    summary: "一斉送信候補を人間承認へ回しました",
    success: true,
    hoursAgo: 12,
  },
  {
    actionType: "tool.invoke",
    purpose: "mail:draft",
    summary: "見積添付付きメール本文を整形",
    success: true,
    costTip: "≈ 6 units",
    hoursAgo: 18,
  },
  {
    actionType: "deny",
    purpose: "mail:send",
    summary: "未承認の外部送信をブロック",
    success: false,
    hoursAgo: 22,
  },
  {
    actionType: "health",
    purpose: null,
    summary: "credential 世代確認 OK",
    success: true,
    hoursAgo: 28,
  },
];

const OPS_TEMPLATES: Template[] = [
  {
    actionType: "health",
    purpose: null,
    summary: "ヘルスチェック失敗（credential_rejected）",
    success: false,
    hoursAgo: 0.5,
  },
  {
    actionType: "deny",
    purpose: "tools.invoke",
    summary: "要再連携のため invoke を fail-closed 拒否",
    success: false,
    hoursAgo: 1,
  },
  {
    actionType: "approval",
    purpose: "commerce.order",
    summary: "デモ用資材購入が承認待ち",
    success: true,
    hoursAgo: 2,
  },
  {
    actionType: "tool.invoke",
    purpose: "invoice.check",
    summary: "請求書 PDF の項目突合（キャッシュ）",
    success: true,
    costTip: "≈ 5 units",
    hoursAgo: 26,
  },
  {
    actionType: "tool.invoke",
    purpose: "ops.admin",
    summary: "社内資料フォルダを一覧",
    success: true,
    costTip: "≈ 2 units",
    hoursAgo: 30,
  },
  {
    actionType: "deny",
    purpose: "files.write",
    summary: "書き込みスコープ外のため拒否",
    success: false,
    hoursAgo: 36,
  },
  {
    actionType: "health",
    purpose: null,
    summary: "前回成功時のハートビート",
    success: true,
    hoursAgo: 48,
  },
  {
    actionType: "approval",
    purpose: "ops.admin",
    summary: "外部共有リンク発行を承認依頼",
    success: true,
    hoursAgo: 52,
  },
];

const GENERIC_TEMPLATES: Template[] = [
  {
    actionType: "tool.invoke",
    purpose: "tools.read",
    summary: "許可スコープ内の読み取りを実行",
    success: true,
    costTip: "≈ 4 units",
    hoursAgo: 2,
  },
  {
    actionType: "health",
    purpose: null,
    summary: "バインディング状態を確認",
    success: true,
    hoursAgo: 5,
  },
  {
    actionType: "approval",
    purpose: "approvals:request",
    summary: "リスク判定で人間承認へエスカレーション",
    success: true,
    hoursAgo: 9,
  },
  {
    actionType: "deny",
    purpose: "browser:use",
    summary: "未許可スコープのブラウザ操作を拒否",
    success: false,
    hoursAgo: 14,
  },
];

function templatesForEmployee(employee: Employee): Template[] {
  if (employee.id === "emp_sales") return SALES_TEMPLATES;
  if (employee.id === "emp_ops") return OPS_TEMPLATES;
  return GENERIC_TEMPLATES.map((t, i) => ({
    ...t,
    hoursAgo: t.hoursAgo + unit(`tpl-${employee.id}`, i) * 3,
    purpose:
      t.purpose ??
      (employee.allowedPurposes?.[0] ? employee.allowedPurposes[0] : null),
  }));
}

/**
 * Adjust demo events using durable binding status (fail-closed story).
 * linked → healthier successes; needs_reauth → health/deny failures front-loaded.
 */
function applyBindingAwareness(
  events: EmployeeActionEvent[],
  binding: EmployeeBinding | null | undefined
): EmployeeActionEvent[] {
  const status: BindingStatus = binding?.status ?? "unlinked";

  if (status === "linked") {
    return events.map((e) => {
      if (e.actionType === "health" && !e.success) {
        return {
          ...e,
          success: true,
          summary: "Grok Bot ヘルスチェック成功",
        };
      }
      return e;
    });
  }

  if (status === "needs_reauth" || status === "degraded") {
    const err = binding?.lastError || "needs_reauth";
    const extra: EmployeeActionEvent = {
      id: `${events[0]?.employeeId ?? "emp"}_binding_gate`,
      employeeId: events[0]?.employeeId ?? "",
      timestamp: tsAt(0.25, 7),
      actionType: "deny",
      purpose: "tools.invoke",
      summary: `binding=${status} のため実行ゲートが拒否（${err}）`,
      success: false,
    };
    return [extra, ...events].map((e) => {
      if (e.actionType === "tool.invoke" && e.success && unit(e.id, 1) > 0.55) {
        return {
          ...e,
          success: false,
          actionType: "deny" as const,
          summary: `要再連携中のためスキップ: ${e.summary}`,
          costTip: undefined,
        };
      }
      if (e.actionType === "health") {
        return {
          ...e,
          success: false,
          summary: `ヘルス失敗 · ${err}`,
        };
      }
      return e;
    });
  }

  if (status === "unlinked" || status === "revoked") {
    return [
      {
        id: `${events[0]?.employeeId ?? "emp"}_unbound`,
        employeeId: events[0]?.employeeId ?? "",
        timestamp: tsAt(0.1, 3),
        actionType: "deny",
        purpose: null,
        summary:
          status === "revoked"
            ? "取消済みバインディング — invoke 拒否（fail-closed）"
            : "未連携 — Grok Bot agent 未設定のため実行不可",
        success: false,
      },
      ...events.filter((e) => e.actionType !== "tool.invoke" || !e.success),
    ];
  }

  return events;
}

export function getEmployeeActionLog(
  employee: Employee,
  binding?: EmployeeBinding | null
): EmployeeActionEvent[] {
  const templates = templatesForEmployee(employee);
  const base: EmployeeActionEvent[] = templates.map((t, i) => {
    const jitter = Math.floor(unit(`min-${employee.id}`, i) * 17);
    return {
      id: `act_${employee.id}_${i}`,
      employeeId: employee.id,
      timestamp: tsAt(t.hoursAgo, jitter),
      actionType: t.actionType,
      purpose: t.purpose,
      summary: t.summary,
      success: t.success,
      costTip: t.costTip,
    };
  });

  const aware = applyBindingAwareness(base, binding);
  return aware.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

export function filterEmployeeActions(
  events: EmployeeActionEvent[],
  filter: ActionLogFilter
): EmployeeActionEvent[] {
  if (filter === "all") return events;
  if (filter === "success") return events.filter((e) => e.success);
  if (filter === "fail") return events.filter((e) => !e.success);
  // 承認関連: approval + deny (policy / human gate)
  return events.filter(
    (e) => e.actionType === "approval" || e.actionType === "deny"
  );
}

export const ACTION_TYPE_LABEL: Record<EmployeeActionType, string> = {
  "tool.invoke": "tool.invoke",
  approval: "approval",
  deny: "deny",
  health: "health",
};
